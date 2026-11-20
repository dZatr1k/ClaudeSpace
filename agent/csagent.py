#!/usr/bin/env python3
"""csagent — ClaudeSpace agent on the VM (Python 3.8+ stdlib only).

  python3 -I csagent.py serve --protocol 1 [--app ID]

--app: the id of the app that started us (16 hex digits, new on every connection). With several apps on one VM, a sudo
prompt or a link from a terminal goes to the app whose terminal it came from (cclib/route.py).

JSON Lines over stdin/stdout (protocol: docs/DESIGN.md §7). stderr is a log. Exits on EOF of stdin.
No "run a command" method: tmux/git are called with argument lists; paths are validated to lie in $HOME;
chat ids are matched against the index; a process-wide audit hook refuses to open secrets (cclib/paths.py).
"""
import getpass
import hashlib
import json
import os
import platform
import re
import selectors
import shutil
import socket
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:          # -I (isolated, safe-path) does not put the script dir on sys.path
    sys.path.insert(0, HERE)

from cclib import (askpass, chats, claudecfg, claudeinput, doctor, files, gitview, netstat, openurl,  # noqa: E402
                   paths, projects, route, search, sessions, system, tmux, turns, usage, winfs, worktrees)

AGENT_VERSION = '0.4.0'
PROTOCOL = 1
MAX_FRAME = 4 * 1024 * 1024
POLL = {'sessions': 1.0, 'tmux': 2.0, 'chats': 3.0, 'projects': 30.0, 'system': 10.0, 'winfs': 5.0, 'ports': 3.0, 'askpass': 2.0}
WINDOW_RE = re.compile(r'^[0-9]{1,4}$')
SEARCH_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')
SLOW = {'usage', 'doctor', 'system', 'project_preview', 'session_preview', 'mosh_list', 'mosh_kill_stale',
        'create_project', 'winfs_mount', 'winfs_unmount', 'pc_tunnel_status', 'askpass_enable',
        'fs_list', 'fs_read', 'git_status', 'git_diff', 'git_log', 'git_show', 'claude_send',
        'claude_config', 'claude_doc_write', 'git_worktrees', 'worktree_create', 'worktree_remove',
        'usage_report'}
TUNNEL_PORT = 2222
CLAUDE_ACTION_RE = re.compile(r'^(interrupt|compact|clear|model)$')
SCROLL_RE = re.compile(r'^(up|down|cancel)$')
CLAUDE_MODEL_RE = re.compile(r'^(default|opus|sonnet|haiku|opusplan|sonnet\[1m\])$')


def log(*a):
    print('[csagent]', *a, file=sys.stderr, flush=True)


def now_ms():
    return int(time.time() * 1000)


def agent_files(base=HERE):
    """Files that make up the agent (relative paths), as in MANIFEST.json."""
    out = ['askpass.py', 'csagent.py', 'openurl.py']
    for name in sorted(os.listdir(os.path.join(base, 'cclib'))):
        if name.endswith('.py'):
            out.append('cclib/' + name)
    return out


def file_sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def manifest_hash(files):
    """files: {rel: sha256hex} -> 'sha256:<hex>' over sorted 'rel\\0sha\\n' lines."""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f'{rel}\0{files[rel]}\n'.encode())
    return 'sha256:' + h.hexdigest()


def own_hash():
    try:
        with open(os.path.join(HERE, 'MANIFEST.json'), encoding='utf-8') as f:
            return json.load(f).get('hash')
    except (OSError, ValueError):
        try:
            return manifest_hash({rel: file_sha(os.path.join(HERE, rel)) for rel in agent_files()})
        except OSError:
            return None


class AgentError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


# ------------------------------------------------------------------ params
def p_str(params, key, required=True, pattern=None, default=None, max_len=4096):
    v = params.get(key, default)
    if v is None:
        if required:
            raise AgentError('bad_request', f'нет параметра {key}')
        return None
    if not isinstance(v, str) or len(v) > max_len or '\0' in v:
        raise AgentError('bad_request', f'неверный параметр {key}')
    if pattern is not None and not pattern.match(v):
        raise AgentError('bad_request', f'неверный формат {key}', {key: v[:80]})
    return v


def p_int(params, key, default, lo, hi):
    v = params.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int):
        raise AgentError('bad_request', f'неверный параметр {key}')
    return max(lo, min(hi, v))


def p_bool(params, key, default):
    v = params.get(key, default)
    if not isinstance(v, bool):
        raise AgentError('bad_request', f'неверный параметр {key}')
    return v


def p_chat(params, key='chatId'):
    return p_str(params, key, pattern=paths.CHAT_ID_RE)


def p_session(params, key='session'):
    return p_str(params, key, pattern=paths.SESSION_RE)


def p_dir(params, key):
    raw = p_str(params, key)
    rp = projects.resolve_existing_dir(raw)
    if not rp:
        raise AgentError('not_allowed', 'папка не найдена или вне домашней папки', {key: raw[:200]})
    return rp


# ------------------------------------------------------------------ agent
class Agent:
    def __init__(self, out=None, app_id=None):
        self.out = out or sys.stdout.buffer
        self.app_id = app_id
        self.out_lock = threading.Lock()
        self.state = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.due = {k: 0.0 for k in POLL}
        self.procs = []
        self.panes = {}
        self.tsess = []
        self.active = None          # last Session[] snapshot sent
        self.statuses = {}          # chatId -> (status, session)
        self.turns = turns.TurnTail()  # hook events: a turn finished / Claude needs input
        self.chat_models = None     # id -> Chat
        self.projects = None        # Project[]
        self.projects_dirty = True
        self.claude_ver = doctor.claude_version()
        self.last_git_force = time.time()
        self.winfs = None           # last winfs mount list sent
        self.ports = None           # last listening ports list sent
        self.port_scanner = netstat.PortScanner(paths.P.home, skip_ports=(TUNNEL_PORT,))
        self.searcher = search.Searcher(self.emit, log=log)
        router = route.Router()
        self.askpass = askpass.AskpassServer(self.emit, session_of=self._session_of_pane, log=log, app_id=app_id,
                                             router=router)
        self.openurl = openurl.OpenUrlServer(self.emit, log=log, app_id=app_id, router=router)
        self.methods = {
            'ping': self.m_ping, 'list_active': self.m_list_active, 'list_chats': self.m_list_chats,
            'list_projects': self.m_list_projects, 'list_dirs': self.m_list_dirs,
            'chat_preview': self.m_chat_preview, 'project_preview': self.m_project_preview,
            'session_preview': self.m_session_preview, 'new_session': self.m_new_session,
            'focus_window': self.m_focus_window, 'rename_session': self.m_rename_session,
            'kill_session': self.m_kill_session, 'archive_chat': self.m_archive_chat,
            'restore_chat': self.m_restore_chat, 'rename_chat': self.m_rename_chat,
            'create_project': self.m_create_project, 'usage': self.m_usage, 'doctor': self.m_doctor,
            'system': self.m_system, 'mosh_list': self.m_mosh_list, 'mosh_kill_stale': self.m_mosh_kill_stale,
            'resync': self.m_resync,
            'winfs_status': self.m_winfs_status, 'winfs_mount': self.m_winfs_mount,
            'winfs_unmount': self.m_winfs_unmount, 'pc_tunnel_status': self.m_pc_tunnel_status,
            'list_ports': self.m_list_ports,
            'askpass_enable': self.m_askpass_enable, 'askpass_reply': self.m_askpass_reply,
            'search_chats': self.m_search_chats, 'search_cancel': self.m_search_cancel,
            'fs_list': self.m_fs_list, 'fs_read': self.m_fs_read, 'fs_upload_target': self.m_fs_upload_target,
            'fs_download_source': self.m_fs_download_source,
            'git_status': self.m_git_status, 'git_diff': self.m_git_diff, 'git_log': self.m_git_log,
            'git_show': self.m_git_show,
            'claude_send': self.m_claude_send, 'usage_report': self.m_usage_report,
            'pane_scroll': self.m_pane_scroll,
            'git_worktrees': self.m_git_worktrees, 'worktree_create': self.m_worktree_create,
            'worktree_remove': self.m_worktree_remove,
            'claude_config': self.m_claude_config, 'claude_doc_write': self.m_claude_doc_write,
        }

    # -------------------------------------------------------------- output
    def send(self, obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
        with self.out_lock:
            try:
                self.out.write(data)
                self.out.flush()
            except (BrokenPipeError, ValueError, OSError):
                os._exit(0)

    def emit(self, event, data):
        self.send({'event': event, 'data': data})

    def hello(self):
        warnings = []
        if not tmux.available():
            warnings.append('tmux не найден')
        caps = ['git'] if shutil.which('git') else []
        if usage.ccusage_path():
            caps.append('usage')
        caps.append('mosh')
        self.emit('hello', {
            'protocol': PROTOCOL, 'agent': AGENT_VERSION, 'hash': own_hash(), 'python': platform.python_version(),
            'host': os.environ.get('CSAGENT_HOSTNAME') or socket.gethostname().split('.')[0], 'user': getpass.getuser(), 'home': paths.P.home,
            'claudeVersion': self.claude_ver, 'tmux': tmux.version(), 'tmuxStatus': tmux.status_layout(), 'capabilities': caps,
            'warnings': warnings,
        })

    # -------------------------------------------------------------- snapshots
    def refresh_procs(self):
        self.procs = sessions.live()

    def refresh_tmux(self):
        self.tsess = tmux.sessions()
        self.panes = tmux.panes()

    def build_active(self):
        by_sess = {}
        for pr in self.procs:
            pid = sessions.pane_id(pr)
            ps = self.panes.get(pid) if pid else None
            if ps:
                by_sess.setdefault(ps[0], []).append({
                    'chatId': pr['chatId'], 'status': pr['status'], 'pid': pr['pid'], 'window': ps[1], 'pane': pid,
                    'name': pr.get('name'), 'statusAt': pr.get('statusAt') or 0})
        out = []
        for s in sorted(self.tsess, key=lambda s: -s['activity']):
            out.append(dict(s, claude=sorted(by_sess.get(s['name'], []), key=lambda c: c['pid'])))
        return out

    def open_info(self):
        """chat id -> {session, window, status} for running chats."""
        res = {}
        for sid, pr in sessions.by_chat(self.procs).items():
            pid = sessions.pane_id(pr)
            ps = self.panes.get(pid) if pid else None
            res[sid] = {'session': ps[0] if ps else None, 'window': ps[1] if ps else None, 'status': pr['status'],
                        'pid': pr['pid']}
        return res

    def build_chats(self):
        raw = chats.visible(chats.load_index())
        opened = self.open_info()
        aliases = chats.load_titles()
        return {c['sid']: chats.to_model(c, opened.get(c['sid']), aliases) for c in raw}

    def live_by_project(self):
        res = {}
        for s in self.tsess:
            res.setdefault(s['path'], (s['name'], None))
        proj_of = {c['sid']: c.get('cwd') for c in chats.load_index() if not c.get('archived')}
        for sid, info in self.open_info().items():
            d = proj_of.get(sid)
            if d and info['session']:
                res[d] = (info['session'], info['status'])
        return res

    def build_projects(self, git=True):
        every = [c for c in chats.load_index() if not c.get('archived')]
        return projects.build(every, self.live_by_project(), git=git)

    # -------------------------------------------------------------- pollers
    def poll_sessions(self, force_tmux=False):
        with self.state:
            self.refresh_procs()
            t = time.time()
            if force_tmux or t >= self.due['tmux']:
                self.refresh_tmux()
                self.due['tmux'] = t + POLL['tmux']
            snap = self.build_active()
            if snap != self.active:
                self.active = snap
                self.emit('active_changed', {'sessions': snap})
                self.projects_dirty = True
            cur = {}
            for s in snap:
                for c in s['claude']:
                    cur[c['chatId']] = (c['status'], s['name'], c['statusAt'])
            for pr in self.procs:      # running outside tmux still has a status
                cur.setdefault(pr['chatId'], (pr['status'], None, pr.get('statusAt') or 0))
            for cid, (st, sess, at) in cur.items():
                prev = self.statuses.get(cid)
                if prev is None or prev[0] != st:
                    self.emit('session_status', {'session': sess, 'chatId': cid, 'status': st,
                                                 'prev': prev[0] if prev else None, 'at': at or now_ms()})
            self.statuses = {k: (v[0], v[1]) for k, v in cur.items()}
            if self.chat_models is not None:
                self._update_open_flags()

    def poll_turns(self):
        """Forward the Claude Code hook's turn events, with the tmux session the chat runs in (if any)."""
        evs = self.turns.read_new()
        if not evs:
            return
        with self.state:
            where = {c['chatId']: s['name'] for s in (self.active or []) for c in s['claude']}
        for ev in evs:
            self.emit('turn_done', dict(ev, session=where.get(ev['chatId'])))

    def _update_open_flags(self):
        opened = self.open_info()
        ups = []
        for cid, m in self.chat_models.items():
            o = opened.get(cid)
            if m['open'] != o:
                m = dict(m, open=o)
                self.chat_models[cid] = m
                ups.append(m)
        if ups:
            self.emit('chats_changed', {'upsert': ups, 'remove': []})

    def poll_chats(self, full=False):
        with self.state:
            models = self.build_chats()
            if full or self.chat_models is None:
                self.chat_models = models
                self.emit('chats_changed', {'full': list(models.values())})
                self.projects_dirty = True
                return
            ups = [m for cid, m in models.items() if self.chat_models.get(cid) != m]
            rem = [cid for cid in self.chat_models if cid not in models]
            self.chat_models = models
            if ups or rem:
                self.emit('chats_changed', {'upsert': ups, 'remove': rem})
                self.projects_dirty = True

    def poll_projects(self, force=False):
        with self.state:
            snap = self.build_projects()
            if force or snap != self.projects:
                self.projects = snap
                self.emit('projects_changed', {'full': snap})
            self.projects_dirty = False

    def poll_system(self):
        st = system.stats()
        self.emit('system', st)
        ver = st.get('claudeVersion')
        if ver != self.claude_ver:
            self.claude_ver = ver
            self.pool.submit(self.emit_doctor_warning)

    def poll_winfs(self, force=False):
        snap = winfs.status()
        if force or snap != self.winfs:
            self.winfs = snap
            self.emit('winfs_changed', {'mounts': snap})

    def poll_ports(self, force=False):
        with self.state:
            snap = self.port_scanner.scan()
            if force or snap != self.ports:
                self.ports = snap
                self.emit('ports_changed', {'ports': snap})

    def emit_doctor_warning(self):
        try:
            self.emit('doctor_warning', doctor.quick())
        except Exception as e:  # never kill the agent over doctor
            log('doctor failed:', e)

    def run_due(self):
        t = time.time()
        try:
            if t >= self.due['sessions']:
                self.due['sessions'] = t + POLL['sessions']
                self.poll_sessions()
                self.poll_turns()
            if t >= self.due['chats']:
                self.due['chats'] = t + POLL['chats']
                self.poll_chats()
            if self.projects_dirty or t >= self.due['projects']:
                self.due['projects'] = t + POLL['projects']
                self.poll_projects()
            if t >= self.due['system']:
                self.due['system'] = t + POLL['system']
                self.pool.submit(self._safe, self.poll_system)
            if t >= self.due['winfs']:
                self.due['winfs'] = t + POLL['winfs']
                self.poll_winfs()
            if t >= self.due['ports']:
                self.due['ports'] = t + POLL['ports']
                self.poll_ports()
            if t >= self.due['askpass']:
                self.due['askpass'] = t + POLL['askpass']
                self.askpass.check()
                self.openurl.check()
        except Exception:
            log('poll failed:', traceback.format_exc())

    def _safe(self, fn, *a):
        try:
            fn(*a)
        except Exception:
            log('task failed:', traceback.format_exc())

    def initial(self):
        # links from chats (BROWSER=openurl.py) open on the PC while the app is here; before the first snapshots,
        # so a link clicked right after (re)connecting is not lost
        self.openurl.enable(True)
        self.turns.start()  # only turns finished from now on; never replay history after a (re)connect
        with self.state:
            self.refresh_procs()
            self.refresh_tmux()
            self.due['tmux'] = time.time() + POLL['tmux']
            self.poll_sessions()
            self.poll_chats(full=True)
            self.poll_projects(force=True)
        self.poll_winfs(force=True)
        self.poll_ports(force=True)
        self.due['sessions'] = time.time() + POLL['sessions']
        self.due['chats'] = time.time() + POLL['chats']
        self.due['projects'] = time.time() + POLL['projects']
        self.due['system'] = 0
        self.due['winfs'] = time.time() + POLL['winfs']
        self.due['ports'] = time.time() + POLL['ports']
        self.due['askpass'] = time.time() + POLL['askpass']
        self.pool.submit(self.emit_doctor_warning)

    def soon(self, *what):
        for w in what:
            self.due[w] = 0

    # -------------------------------------------------------------- requests
    def handle_line(self, line):
        try:
            req = json.loads(line)
        except ValueError:
            self.send({'id': None, 'error': {'code': 'bad_request', 'message': 'неверный JSON'}})
            return
        if not isinstance(req, dict):
            self.send({'id': None, 'error': {'code': 'bad_request', 'message': 'ожидался объект'}})
            return
        rid = req.get('id')
        if not isinstance(rid, (int, str)) or isinstance(rid, bool):
            self.send({'id': None, 'error': {'code': 'bad_request', 'message': 'нет id'}})
            return
        method = req.get('method')
        params = req.get('params') or {}
        fn = self.methods.get(method) if isinstance(method, str) else None
        if not fn or not isinstance(params, dict):
            self.send({'id': rid, 'error': {'code': 'bad_request', 'message': f'неизвестный метод: {method}'}})
            return
        if method in SLOW:
            self.pool.submit(self.call, rid, method, fn, params)
        else:
            self.call(rid, method, fn, params)

    def call(self, rid, method, fn, params):
        try:
            res = fn(params)
            self.send({'id': rid, 'result': res})
        except AgentError as e:
            err = {'code': e.code, 'message': e.message}
            if e.data is not None:
                err['data'] = e.data
            self.send({'id': rid, 'error': err})
        except paths.DeniedError as e:
            self.send({'id': rid, 'error': {'code': 'not_allowed', 'message': f'запрещено: {e}'}})
        except tmux.TmuxError as e:
            self.send({'id': rid, 'error': {'code': 'tmux_error', 'message': f'tmux: {e}'}})
        except winfs.WinfsError as e:
            self.send({'id': rid, 'error': {'code': e.code, 'message': str(e)}})
        except Exception as e:
            log(f'{method} failed:', traceback.format_exc())
            self.send({'id': rid, 'error': {'code': 'internal', 'message': f'внутренняя ошибка: {e}'}})

    # -------------------------------------------------------------- methods
    def m_ping(self, p):
        return {'now': now_ms()}

    def m_list_active(self, p):
        with self.state:
            self.refresh_procs()
            self.refresh_tmux()
            return {'sessions': self.build_active()}

    def m_list_chats(self, p):
        archived = p_bool(p, 'archived', False)
        limit = p_int(p, 'limit', 100000, 1, 100000)
        with self.state:
            self.refresh_procs()
            ms = [m for m in self.build_chats().values() if m['archived'] == archived]
        ms.sort(key=lambda m: -m['lastAt'])
        return {'chats': ms[:limit]}

    def m_list_projects(self, p):
        git = p_bool(p, 'git', True)
        with self.state:
            return {'projects': self.build_projects(git=git)}

    def m_list_dirs(self, p):
        every = [c for c in chats.load_index() if not c.get('archived')]
        return {'dirs': [d for d, _ in projects.project_dirs(every)[0]]}

    def _chat_or_404(self, cid):
        c = chats.find(cid)
        if not c:
            raise AgentError('not_found', 'чат не найден', {'chatId': cid})
        return c

    def _chat_model(self, c):
        with self.state:
            self.refresh_procs()
            self.refresh_tmux()
            return chats.to_model(c, self.open_info().get(c['sid']))

    def m_chat_preview(self, p):
        cid = p_chat(p)
        n = p_int(p, 'messages', 6, 1, 50)
        c = self._chat_or_404(cid)
        return {'chat': self._chat_model(c), 'tail': chats.tail_dialog(c['path'], n)}

    def m_project_preview(self, p):
        d = p_dir(p, 'path')
        with self.state:
            proj = next((x for x in (self.projects or []) if x['path'] == d), None)
            if not proj:
                proj = next((x for x in self.build_projects() if x['path'] == d), None)
        if not proj:
            proj = {'path': d, 'name': projects.display_name(d), 'isHome': d == paths.P.home,
                    'git': projects.git_info(d), 'lastAt': int(os.stat(d).st_mtime * 1000), 'chatCount': 0,
                    'liveSession': None, 'liveStatus': None}
        return {'project': proj, 'git': projects.git_details(d) if d != paths.P.home else None,
                'hasClaudeMd': os.path.exists(os.path.join(d, 'CLAUDE.md')), 'entries': projects.entries(d)}

    def m_session_preview(self, p):
        """Facts for the «Сведения» panel of a tmux session: fresh Session, uptime, clients, git of its folder and,
        for every Claude in it, the chat (title as in the list), last prompt, model and context tokens."""
        name = p_session(p)
        if not tmux.has_session(name):
            raise AgentError('not_found', f'сессии «{name}» нет', {'session': name})
        with self.state:
            self.refresh_procs()
            self.refresh_tmux()
            s = next((x for x in self.build_active() if x['name'] == name), None)
            opened = self.open_info()
        if not s:
            raise AgentError('not_found', f'сессии «{name}» нет', {'session': name})
        info = tmux.session_info(name)
        rp = projects.resolve_existing_dir(s['path']) if s['path'] else None
        git = projects.git_info_cached(rp) if rp else None
        aliases = chats.load_titles()
        claude = []
        for c in s['claude']:
            raw = chats.find(c['chatId'])
            item = {'chatId': c['chatId'], 'chat': None, 'lastPrompt': None, 'model': None, 'context': None}
            if raw:
                item['chat'] = chats.to_model(raw, opened.get(c['chatId']), aliases)
                item.update(chats.tail_info(raw['path']))
            claude.append(item)
        return {'session': s, 'created': info['created'], 'clients': info['clients'], 'git': git, 'claude': claude}

    def m_new_session(self, p):
        cwd = p_dir(p, 'cwd')
        resume = p_str(p, 'resume', required=False, pattern=paths.CHAT_ID_RE)
        name = p_str(p, 'name', required=False, max_len=64)
        command = p_str(p, 'command', required=False, default='claude')
        if command != 'claude':
            raise AgentError('bad_request', 'поддерживается только command=claude')
        if not tmux.available():
            raise AgentError('tmux_error', 'tmux не найден на VM')
        if resume:
            self._chat_or_404(resume)
            with self.state:
                self.refresh_procs()
                self.refresh_tmux()
                o = self.open_info().get(resume)
            if o:
                # a second `claude --resume` on a running chat would corrupt the transcript
                raise AgentError('chat_open', 'чат уже открыт' + (f' в сессии «{o["session"]}»' if o['session']
                                                                  else ' вне tmux'), o)
        if name:
            name = tmux.sanitize(name, 32)
            if not name:
                raise AgentError('bad_request', 'пустое имя сессии')
            if tmux.has_session(name):
                raise AgentError('exists', f'сессия «{name}» уже есть', {'session': name})
        else:
            name = tmux.unique_name(cwd)
        window = tmux.new_session(name, cwd, tmux.claude_command(resume))
        self.soon('sessions', 'tmux')
        return {'session': name, 'window': window}

    def m_focus_window(self, p):
        name = p_session(p)
        window = p_str(p, 'window', pattern=WINDOW_RE)
        if not tmux.has_session(name):
            raise AgentError('not_found', f'сессии «{name}» нет', {'session': name})
        tmux.select_window(name, window)
        return {}

    def m_pane_scroll(self, p):
        """The phone scrolls a session's history (tmux copy-mode); a fixed set of tmux commands, no free text."""
        name = p_session(p)
        action = p_str(p, 'action', pattern=SCROLL_RE)
        lines = p_int(p, 'lines', 1, 1, 500)
        if not tmux.has_session(name):
            raise AgentError('not_found', f'сессии «{name}» нет', {'session': name})
        try:
            return {'inMode': tmux.scroll(name, action, lines)}
        except tmux.TmuxError as e:
            raise AgentError('internal', f'tmux: {e}')

    def m_claude_send(self, p):
        """Quick actions for a running chat: a fixed command typed into the pane where that Claude runs (not the
        window the tab happens to show). No free text: only these actions and model aliases."""
        chat = p_chat(p)
        action = p_str(p, 'action', pattern=CLAUDE_ACTION_RE)
        if action == 'model':
            model = p_str(p, 'model', pattern=CLAUDE_MODEL_RE)
            text = f'/model {model}'
        elif action != 'interrupt':
            text = '/' + action
        pr = sessions.by_chat(sessions.live()).get(chat)
        pane = sessions.pane_id(pr)
        if not pane or pane not in tmux.panes():
            raise AgentError('not_found', 'этот чат не запущен в tmux', {'chatId': chat})
        # typed text + Enter while Claude asks for permission would pick the first option (approve): commands only
        # at the empty prompt of an idle Claude; Esc (interrupt) is safe in any state
        if action != 'interrupt' and pr['status'] != 'idle':
            raise AgentError('busy', 'Claude сейчас занят: дождитесь ответа или прервите его', {'status': pr['status']})
        stashed = False
        try:
            if action == 'interrupt':
                tmux.send_keys(pane, 'Escape')
            else:
                # a draft in the input box would get the command appended: put it aside with Claude Code's stash
                # (Ctrl+S), Claude Code restores it by itself after the command
                if claudeinput.draft(tmux.capture(pane)):
                    tmux.send_keys(pane, 'C-s')
                    stashed = True
                    time.sleep(0.15)
                tmux.send_keys(pane, text, literal=True)
                time.sleep(0.15)    # let the input box take the text before Enter (the slash menu filters as it types)
                tmux.send_keys(pane, 'Enter')
        except tmux.TmuxError as e:
            raise AgentError('internal', f'tmux: {e}')
        return {'pane': pane, 'status': pr['status'], 'stashed': stashed}

    def m_rename_session(self, p):
        name = p_session(p)
        new = tmux.sanitize(p_str(p, 'name', max_len=64), 32)
        if not new:
            raise AgentError('bad_request', 'пустое имя')
        if not tmux.has_session(name):
            raise AgentError('not_found', f'сессии «{name}» нет', {'session': name})
        if new != name and tmux.has_session(new):
            raise AgentError('exists', f'имя «{new}» занято', {'session': new})
        tmux.rename(name, new)
        self.soon('sessions', 'tmux')
        return {'session': new}

    def m_kill_session(self, p):
        name = p_session(p)
        if not tmux.has_session(name):
            raise AgentError('not_found', f'сессии «{name}» нет', {'session': name})
        tmux.kill(name)
        self.soon('sessions', 'tmux')
        return {}

    def _is_open(self, cid):
        with self.state:
            self.refresh_procs()
            return any(pr['chatId'] == cid for pr in self.procs)

    def _move(self, p, to_archive):
        cid = p_chat(p)
        try:
            c = chats.move_chat(cid, to_archive, self._is_open)
        except chats.MoveError as e:
            raise AgentError(e.code, str(e), {'chatId': cid})
        self.soon('chats')
        return {'chat': self._chat_model(c)}

    def m_archive_chat(self, p):
        return self._move(p, True)

    def m_restore_chat(self, p):
        return self._move(p, False)

    def m_rename_chat(self, p):
        cid = p_chat(p)
        if 'title' not in p:
            raise AgentError('bad_request', 'нет параметра title')
        title = p_str(p, 'title', required=False, max_len=200)
        title = ' '.join(title.split()) if title else None
        self._chat_or_404(cid)
        chats.set_title(cid, title)
        self.soon('chats')
        return {'chat': self._chat_model(self._chat_or_404(cid))}

    def m_create_project(self, p):
        path = p_str(p, 'path')
        git_init = p_bool(p, 'gitInit', False)
        try:
            rp = projects.create_project(path, git_init)
        except ValueError as e:
            code, msg = e.args if len(e.args) == 2 else ('bad_request', str(e))
            raise AgentError(code, msg)
        with self.state:
            self.projects_dirty = True
            proj = next((x for x in self.build_projects() if x['path'] == rp), None)
        return {'project': proj or {'path': rp, 'name': projects.display_name(rp), 'isHome': False,
                                    'git': projects.git_info(rp), 'lastAt': now_ms(), 'chatCount': 0,
                                    'liveSession': None, 'liveStatus': None}}

    def m_usage(self, p):
        return usage.usage(p_int(p, 'maxAge', 60, 0, 86400))

    def m_usage_report(self, p):
        days = p_int(p, 'days', 7, 1, 30)
        chat_project = {c['sid']: c.get('cwd') for c in chats.load_index() if c.get('cwd')}
        return usage.report(days, chat_project, p_int(p, 'maxAge', 120, 0, 86400))

    def m_doctor(self, p):
        return doctor.full() if p_bool(p, 'full', False) else doctor.quick_model()

    def m_system(self, p):
        return system.stats(top=p_bool(p, 'top', False))

    def m_mosh_list(self, p):
        return {'servers': system.mosh_list()}

    def m_mosh_kill_stale(self, p):
        return {'killed': system.mosh_kill_stale()}

    def m_resync(self, p):
        with self.state:
            self.active = None
            self.statuses = {}
            self.refresh_procs()
            self.refresh_tmux()
            self.poll_sessions()
            self.poll_chats(full=True)
            self.poll_projects(force=True)
        self.poll_winfs(force=True)
        self.poll_ports(force=True)
        self.soon('system')
        return {}

    # ---- «Диск ПК» and the reverse tunnel (BACKLOG 12)
    def m_winfs_status(self, p):
        return {'mounts': winfs.status(), 'sshfs': bool(shutil.which('sshfs')),
                'winfs': os.access(winfs.winfs_path(), os.X_OK)}

    def m_winfs_mount(self, p):
        res = winfs.mount(p_str(p, 'src', max_len=260), p_str(p, 'dst', max_len=1024), client=p.get('client'))
        self.poll_winfs()
        return res

    def m_winfs_unmount(self, p):
        res = winfs.unmount(p_str(p, 'dst', max_len=1024), only_owned=p_bool(p, 'onlyOwned', True),
                            lazy=p_bool(p, 'lazy', False), client=p.get('client'))
        self.poll_winfs()
        return res

    def m_pc_tunnel_status(self, p):
        """Is 127.0.0.1:<port> on the VM taken (by someone else's tunnel, e.g. an external ssh -R) and does it answer like
        an SSH server? The banner check connects and reads 4 bytes, as win-tunnel-hold does."""
        port = p_int(p, 'port', TUNNEL_PORT, 1024, 65535)
        listening = netstat.is_listening(port)
        banner = None
        if listening and p_bool(p, 'banner', True):
            banner = False
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=4) as s:
                    s.settimeout(4)
                    banner = s.recv(4) == b'SSH-'
            except OSError:
                banner = False
        return {'port': port, 'listening': listening, 'banner': banner}

    # ---- listening ports for forwarding to the PC (BACKLOG 10)
    def m_list_ports(self, p):
        with self.state:
            return {'ports': self.port_scanner.scan()}

    # ---- full-text search through chat transcripts (stage 6): results stream as search_hits / search_done
    def m_search_chats(self, p):
        sid = p_str(p, 'searchId', pattern=SEARCH_ID_RE)
        q = p_str(p, 'query', max_len=search.MAX_QUERY).strip()
        if len(q) < 2:
            raise AgentError('bad_request', 'запрос короче 2 символов')
        self.searcher.start(sid, q, limit=p_int(p, 'limit', 50, 1, 200),
                            budget=float(p_int(p, 'budgetSec', 10, 1, 60)), archived=p_bool(p, 'archived', True))
        return {'searchId': sid}

    def m_search_cancel(self, p):
        sid = p_str(p, 'searchId', required=False, pattern=SEARCH_ID_RE)
        return {'cancelled': self.searcher.cancel(sid)}

    # ---- Files and Git panels (stage 5): read-only, through the deny-list; uploads only get a validated target
    @staticmethod
    def _wrap(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except (files.FilesError, gitview.GitError, claudecfg.CfgError) as e:
            raise AgentError(e.code, e.message)

    def m_fs_list(self, p):
        return self._wrap(files.list_dir, p_str(p, 'path'))

    def m_fs_read(self, p):
        return self._wrap(files.read_file, p_str(p, 'path'))

    def m_fs_upload_target(self, p):
        return self._wrap(files.upload_target, p_str(p, 'dir'), p_str(p, 'name', max_len=255))

    def m_fs_download_source(self, p):
        return self._wrap(files.download_source, p_str(p, 'path'))

    def m_git_status(self, p):
        return self._wrap(gitview.status, self._wrap(files.resolve, p_str(p, 'path'), 'dir'))

    def m_git_diff(self, p):
        d = self._wrap(files.resolve, p_str(p, 'path'), 'dir')
        return self._wrap(gitview.diff, d, p_str(p, 'file'), p_bool(p, 'staged', False),
                          p_bool(p, 'untracked', False))

    def m_git_log(self, p):
        d = self._wrap(files.resolve, p_str(p, 'path'), 'dir')
        return self._wrap(gitview.log, d, p_int(p, 'limit', 30, 1, 200))

    def m_git_show(self, p):
        d = self._wrap(files.resolve, p_str(p, 'path'), 'dir')
        return self._wrap(gitview.show, d, p_str(p, 'hash', pattern=gitview.HASH_RE))

    # ---- parallel tasks in git worktrees: list, create (branch + folder), remove (clean, no session inside)
    def m_git_worktrees(self, p):
        return self._wrap(worktrees.list_worktrees, self._wrap(files.resolve, p_str(p, 'path'), 'dir'))

    def m_worktree_create(self, p):
        d = self._wrap(files.resolve, p_str(p, 'path'), 'dir')
        res = self._wrap(worktrees.create, d, p_str(p, 'branch', max_len=60), p_str(p, 'base', required=False,
                                                                                     max_len=60))
        self.soon('projects')
        return res

    def m_worktree_remove(self, p):
        d = self._wrap(files.resolve, p_str(p, 'path'), 'dir')
        res = self._wrap(worktrees.remove, d, p_str(p, 'worktree'), p_bool(p, 'force', False),
                         p_bool(p, 'deleteBranch', False))
        self.soon('projects')
        return res

    # ---- the «Claude» screen: overview of instructions/memory/MCP/skills/plugins/hooks; edits of CLAUDE.md and memory
    def m_claude_config(self, p):
        ctx = p_str(p, 'path', required=False)
        known = [d for d, _ in projects.project_dirs([c for c in chats.load_index() if not c.get('archived')])[0]]
        return claudecfg.overview(ctx, known)

    def m_claude_doc_write(self, p):
        mtime = p.get('mtime')
        if mtime is not None and (isinstance(mtime, bool) or not isinstance(mtime, int) or mtime < 0):
            raise AgentError('bad_request', 'неверный mtime')
        return self._wrap(claudecfg.write_doc, p_str(p, 'path'), p_str(p, 'text', max_len=claudecfg.MAX_DOC + 1,
                                                                        required=False, default=''), mtime)

    # ---- sudo password prompts in the app (BACKLOG 11): main only; the password is never logged or echoed
    def _session_of_pane(self, pane):
        ps = self.panes.get(pane)
        return ps[0] if ps else None

    def m_askpass_enable(self, p):
        return self.askpass.enable(p_bool(p, 'enabled', True))

    def m_askpass_reply(self, p):
        rid = p.get('id')
        if not askpass.valid_id(rid):
            raise AgentError('bad_request', 'неверный параметр id')
        pw = p.get('password')
        # validated by hand: p_str would echo a bad value into the error
        if pw is not None and (not isinstance(pw, str) or len(pw) > askpass.MAX_PASSWORD
                               or any(ch in pw for ch in '\0\n\r')):
            raise AgentError('bad_request', 'неверный параметр password')
        ok = self.askpass.reply(rid, pw)
        del pw
        p.pop('password', None)
        if not ok:
            raise AgentError('not_found', 'запрос пароля уже закрыт', {'id': rid})
        return {}

    # -------------------------------------------------------------- loop
    def serve(self, stdin_fd=None):
        fd = sys.stdin.fileno() if stdin_fd is None else stdin_fd
        self.hello()
        self.initial()
        sel = selectors.DefaultSelector()
        sel.register(fd, selectors.EVENT_READ)
        buf = b''
        skipping = False
        while True:
            self.run_due()
            timeout = max(0.05, min(self.due.values()) - time.time()) if self.due else 1.0
            timeout = min(timeout, 1.0)
            if not sel.select(timeout):
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                break
            buf += data
            while True:
                nl = buf.find(b'\n')
                if nl < 0:
                    if len(buf) > MAX_FRAME:
                        if not skipping:
                            self.send({'id': None, 'error': {'code': 'too_large', 'message': 'кадр больше 4 МБ'}})
                        skipping, buf = True, b''
                    break
                line, buf = buf[:nl], buf[nl + 1:]
                if skipping:
                    skipping = False
                    continue
                if len(line) > MAX_FRAME:
                    self.send({'id': None, 'error': {'code': 'too_large', 'message': 'кадр больше 4 МБ'}})
                    continue
                if line.strip():
                    self.handle_line(line.decode('utf-8', 'replace'))
        self.searcher.cancel()
        self.askpass.shutdown()     # waiting sudo prompts exit 1: nobody is there to answer them
        self.openurl.shutdown()     # links fall back to the VM's own browser, if it has a desktop
        self.pool.shutdown(wait=True)
        try:      # the app is gone: do not leave our sshfs mounts behind a tunnel that no longer exists
            gone = winfs.cleanup()
            if gone:
                log('unmounted on exit:', ', '.join(gone))
        except Exception:
            log('winfs cleanup failed:', traceback.format_exc())
        with self.out_lock:
            try:
                self.out.flush()
            except OSError:
                pass


def ensure_user_path():
    """SSH exec runs a non-login shell: ~/.local/bin (claude, ccusage, node, lazygit…) is not on PATH. Everything the
    agent starts — ccusage, and a tmux server it may start, whose sessions then run `claude` — inherits this PATH."""
    cur = os.environ.get('PATH', '') or '/usr/local/bin:/usr/bin:/bin'
    parts = cur.split(os.pathsep)
    if paths.P.local_bin not in parts:
        os.environ['PATH'] = os.pathsep.join([paths.P.local_bin] + parts)


def main(argv):
    if len(argv) < 2 or argv[1] != 'serve':
        print(__doc__, file=sys.stderr)
        return 2
    if '--protocol' in argv:
        try:
            want = int(argv[argv.index('--protocol') + 1])
        except (IndexError, ValueError):
            want = PROTOCOL
        if want != PROTOCOL:
            log(f'protocol {want} requested, agent speaks {PROTOCOL}')
    app_id = None
    if '--app' in argv:
        i = argv.index('--app') + 1
        app_id = argv[i] if i < len(argv) and route.valid_app(argv[i]) else None
        if app_id is None:
            log('--app: not a valid app id, ignored')
    paths.install_guard()
    ensure_user_path()
    Agent(app_id=app_id).serve()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
