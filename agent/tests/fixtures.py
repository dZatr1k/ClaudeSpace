"""Test fixtures: a fake HOME with transcripts, a session registry, "secrets", projects; a dedicated tmux socket;
a helper that drives csagent over stdin/stdout."""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CSAGENT = os.path.join(AGENT_DIR, 'csagent.py')
SECRET = 'TOP-SECRET-DO-NOT-READ'
TMUX_SOCKET = f'claudespace-test-py-{os.getpid()}'

ID_AI = '11111111-1111-4111-8111-111111111111'
ID_CUSTOM = '22222222-2222-4222-8222-222222222222'
ID_SUMMARY = '33333333-3333-4333-8333-333333333333'
ID_BIG = '44444444-4444-4444-8444-444444444444'
ID_CD = '55555555-5555-4555-8555-555555555555'
ID_ARCH = '66666666-6666-4666-8666-666666666666'
ID_EMPTY = '77777777-7777-4777-8777-777777777777'


def enc(d):
    import re
    return re.sub(r'[^A-Za-z0-9]', '-', d)


def line(**kw):
    return json.dumps(kw, ensure_ascii=False) + '\n'


def user(text, ts, cwd, sid, **kw):
    return line(type='user', message={'role': 'user', 'content': text}, timestamp=ts, cwd=cwd, sessionId=sid,
                gitBranch='main', version='2.1.300', **kw)


def assistant(text, ts, cwd, sid):
    return line(type='assistant', message={'role': 'assistant', 'content': [{'type': 'text', 'text': text}]},
                timestamp=ts, cwd=cwd, sessionId=sid)


class FakeHome:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix='cs-home-')
        self.home = os.path.realpath(self.root)
        h = self.home
        self.alpha = os.path.join(h, 'projects', 'Alpha')
        self.beta = os.path.join(h, 'projects', 'Beta')
        os.makedirs(os.path.join(self.alpha, 'sub'))
        os.makedirs(self.beta)
        with open(os.path.join(self.alpha, 'CLAUDE.md'), 'w') as f:
            f.write('# Alpha\n')
        subprocess.run(['git', 'init', '-q', '-b', 'main', self.alpha], check=True)
        # secrets the agent must never open
        cd = os.path.join(h, '.claude')
        os.makedirs(os.path.join(cd, 'sessions'))
        os.makedirs(os.path.join(h, '.ssh'))
        self.secrets = [os.path.join(cd, '.credentials.json'), os.path.join(cd, 'settings.local.json'),
                        os.path.join(cd, 'history.jsonl'), os.path.join(h, '.ssh', 'id_ed25519'),
                        os.path.join(h, '.ssh', 'config'), os.path.join(cd, 'sessions', '999.abcdef.key')]
        for p in self.secrets:
            with open(p, 'w') as f:
                f.write(json.dumps({'token': SECRET}) + '\n')
        # fake claude on PATH (for new_session)
        lb = os.path.join(h, '.local', 'bin')
        os.makedirs(lb)
        fake = os.path.join(lb, 'claude-1.0.0')
        with open(fake, 'w') as f:
            f.write('#!/bin/sh\n[ "$1" = --help ] && { echo "  -r, --resume [value]"; exit 0; }\n'
                    'echo "fake claude $*"\nexec sleep 600\n')
        os.chmod(fake, 0o755)
        os.symlink(fake, os.path.join(lb, 'claude'))
        self.write_chats()

    def chat_path(self, project, sid, archived=False):
        base = 'cc-menu-archive' if archived else 'projects'
        d = os.path.join(self.home, '.claude', base, enc(project))
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, sid + '.jsonl')

    def write_chats(self):
        a, b = self.alpha, self.beta
        with open(self.chat_path(a, ID_AI), 'w') as f:
            f.write(user('<command-name>/clear</command-name>', '2026-11-01T10:00:00Z', a, ID_AI))
            f.write(user('почини сборку', '2026-11-01T10:00:01Z', a, ID_AI))
            f.write(assistant('Готово, собрал.', '2026-11-01T10:01:00Z', a, ID_AI))
            f.write(line(type='ai-title', aiTitle='Починка сборки', sessionId=ID_AI))
            f.write(line(type='summary', summary='старое резюме', sessionId=ID_AI))
            f.write(line(type='cost-state', totalLinesAdded=12, totalLinesRemoved=3, sessionId=ID_AI))
        with open(self.chat_path(a, ID_CUSTOM), 'w') as f:
            f.write(user('первый запрос', '2026-11-02T10:00:00Z', a, ID_CUSTOM))
            f.write(line(type='ai-title', aiTitle='AI название', sessionId=ID_CUSTOM))
            f.write(line(type='custom-title', customTitle='Моё название', sessionId=ID_CUSTOM))
        with open(self.chat_path(b, ID_SUMMARY), 'w') as f:
            f.write(line(type='summary', summary='Резюме чата', sessionId=ID_SUMMARY))
            f.write(user('вопрос про beta', '2026-11-03T10:00:00Z', b, ID_SUMMARY))
        # > 2 MB: head + tail are read, middle skipped (prompts counted approximately)
        with open(self.chat_path(b, ID_BIG), 'w') as f:
            f.write(user('большой чат: начало', '2026-11-04T10:00:00Z', b, ID_BIG))
            pad = 'x' * 900
            for i in range(3000):
                f.write(user(f'запрос {i} {pad}', '2026-11-04T10:00:01Z', b, ID_BIG))
            f.write(line(type='ai-title', aiTitle='Большой чат', sessionId=ID_BIG))
        # chat that cd'ed into a subfolder: project is still Alpha (from the transcript dir name)
        with open(self.chat_path(a, ID_CD), 'w') as f:
            f.write(user('cd sub', '2026-11-05T10:00:00Z', os.path.join(a, 'sub'), ID_CD))
            f.write(user('и тут', '2026-11-05T10:00:05Z', a, ID_CD))
        with open(self.chat_path(a, ID_ARCH, archived=True), 'w') as f:
            f.write(user('архивный', '2026-10-01T10:00:00Z', a, ID_ARCH))
        with open(self.chat_path(a, ID_EMPTY), 'w') as f:      # no prompts, no title: hidden
            f.write(line(type='system', timestamp='2026-11-06T10:00:00Z', cwd=a, sessionId=ID_EMPTY))

    def register(self, pid, chat_id, status, tmux_target=None, cwd=None):
        with open(f'/proc/{pid}/stat') as f:
            proc_start = f.read().rsplit(')', 1)[1].split()[19]
        p = os.path.join(self.home, '.claude', 'sessions', f'{pid}.json')
        data = {'pid': pid, 'sessionId': chat_id, 'cwd': cwd or self.alpha, 'procStart': proc_start,
                'status': status, 'statusUpdatedAt': int(time.time() * 1000), 'name': 'alpha-x1',
                'version': '1.0.0'}
        if tmux_target:
            data['tmux'] = tmux_target
        tmp = p + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, p)
        return p

    def env(self):
        e = {k: v for k, v in os.environ.items() if not k.startswith(('XDG_', 'TMUX', 'CLAUDE'))}
        e.update(HOME=self.home, CSAGENT_TMUX_SOCKET=TMUX_SOCKET, LANG='C.UTF-8')
        return e

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def tmux(*args, env=None):
    return subprocess.run(['tmux', '-L', TMUX_SOCKET] + list(args), capture_output=True, text=True, env=env)


def kill_tmux_server():
    subprocess.run(['tmux', '-L', TMUX_SOCKET, 'kill-server'], capture_output=True)
    sock = os.path.join(os.environ.get('TMUX_TMPDIR') or '/tmp', f'tmux-{os.getuid()}', TMUX_SOCKET)
    try:
        os.unlink(sock)
    except OSError:
        pass


class AgentProc:
    """csagent serve in a subprocess. AUDIT: record every attempted open() into a file."""

    def __init__(self, fh, audit_log=None, env=None):
        self.fh = fh
        if audit_log:
            code = (
                'import sys, runpy\n'
                f'_log = open({audit_log!r}, "a", buffering=1)\n'
                'def _rec(ev, args):\n'
                '    if ev in ("open", "os.listdir", "os.scandir") and args and isinstance(args[0], (str, bytes)):\n'
                '        _log.write(repr(args[0]) + "\\n")\n'
                'sys.addaudithook(_rec)\n'
                f'sys.argv = [{CSAGENT!r}, "serve", "--protocol", "1"]\n'
                f'runpy.run_path({CSAGENT!r}, run_name="__main__")\n')
            cmd = [sys.executable, '-I', '-c', code]
        else:
            cmd = [sys.executable, '-I', CSAGENT, 'serve', '--protocol', '1']
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=dict(fh.env(), **(env or {})), cwd=fh.home)
        self.q = queue.Queue()
        self.events = []
        self.responses = {}
        self.cond = threading.Condition()
        self.next_id = 1
        self.t = threading.Thread(target=self._reader, daemon=True)
        self.t.start()
        self.stderr = []
        threading.Thread(target=self._err, daemon=True).start()

    def _reader(self):
        for raw in self.p.stdout:
            o = json.loads(raw)
            with self.cond:
                if 'event' in o:
                    self.events.append(o)
                else:
                    self.responses[o.get('id')] = o
                self.cond.notify_all()

    def _err(self):
        for raw in self.p.stderr:
            self.stderr.append(raw.decode('utf-8', 'replace'))

    def send_raw(self, data):
        self.p.stdin.write(data)
        self.p.stdin.flush()

    def call(self, method, params=None, timeout=15):
        rid = self.next_id
        self.next_id += 1
        self.send_raw((json.dumps({'id': rid, 'method': method, 'params': params or {}}) + '\n').encode())
        return self.wait_response(rid, timeout)

    def wait_response(self, rid, timeout=15):
        end = time.time() + timeout
        with self.cond:
            while rid not in self.responses:
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError(f'no response {rid}; stderr: {"".join(self.stderr)[-2000:]}')
                self.cond.wait(left)
            return self.responses.pop(rid)

    def wait_event(self, name, pred=lambda d: True, timeout=10, since=0):
        end = time.time() + timeout
        with self.cond:
            while True:
                for i, e in enumerate(self.events[since:], since):
                    if e['event'] == name and pred(e['data']):
                        return e['data'], i + 1
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError(f'no event {name}')
                self.cond.wait(left)

    def close(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            rc = self.p.wait(timeout=20)
            self.t.join(2)
            self.p.stdout.close()
            self.p.stderr.close()
            return rc
        except subprocess.TimeoutExpired:
            self.p.kill()
            return -9


def uuid4():
    return str(uuid.uuid4())
