"""The «Claude» screen: what shapes Claude Code here (instructions, memory, MCP servers, skills, plugins, hooks) and
edits of the plain-text parts.

- Read: an overview built from Claude Code's own files. ~/.claude.json is read here and only server names, types,
  the command name with its package and the URL host leave the agent: MCP env values, full argument lists, URL
  paths and queries can hold keys. settings.local.json (Telegram token) stays denied (paths.is_denied).
- Write: only CLAUDE.md / CLAUDE.local.md (user, project, .claude/) and memory notes
  (~/.claude/projects/<dir>/memory/*.md). No symlinks, size cap, and a conflict check against the mtime the editor
  loaded, so an edit never silently overwrites a change Claude made meanwhile.
"""
import json
import os
import re
import stat
import time

from . import chats, paths, projects

MAX_DOC = 512 * 1024
MAX_SKILLS = 300
MAX_MEMORY = 200
DESC = 300
MEMORY_NAME_RE = re.compile(r'^[\w.-]{1,120}\.md$')
DOC_NAMES = ('CLAUDE.md', 'CLAUDE.local.md')


class CfgError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------ small readers
def _json(path):
    try:
        with paths.safe_open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _stat(path):
    try:
        st = os.stat(path)
        return {'exists': stat.S_ISREG(st.st_mode), 'size': st.st_size, 'mtime': int(st.st_mtime * 1000)}
    except OSError:
        return {'exists': False, 'size': 0, 'mtime': 0}


def frontmatter(path, limit=8192):
    """name/description/type from a leading --- block (skills, memory notes). Simple `key: value` lines only."""
    try:
        with paths.safe_open(path) as f:
            head = f.read(limit)
    except OSError:
        return {}
    if not head.startswith('---'):
        return {}
    end = head.find('\n---', 3)
    if end < 0:
        return {}
    out = {}
    for line in head[3:end].splitlines():
        m = re.match(r'^(name|description|type):\s*(.*)$', line.strip())
        if m:
            v = m.group(2).strip().strip('"\'')
            out[m.group(1)] = v[:DESC]
    return out


def _within(rp, root):
    return rp == root or rp.startswith(root + os.sep)


# ------------------------------------------------------------------ overview
def _instructions(ctx):
    P = paths.P
    user = os.path.join(P.claude_dir, 'CLAUDE.md')
    out = [dict(scope='user', path=user, **_stat(user))]
    if not ctx:
        return out
    # Claude Code reads CLAUDE.md files from the working folder up to the root; here: up to $HOME
    d, seen = ctx, []
    while _within(d, P.home):
        seen.append(d)
        if d == P.home:
            break
        d = os.path.dirname(d)
    for i, folder in enumerate(seen):
        for rel in ('CLAUDE.md', 'CLAUDE.local.md', os.path.join('.claude', 'CLAUDE.md')):
            p = os.path.join(folder, rel)
            if p == user:
                continue
            st = _stat(p)
            # the working folder's CLAUDE.md is listed even if missing: the editor creates it
            if st['exists'] or (i == 0 and rel == 'CLAUDE.md'):
                scope = 'local' if rel == 'CLAUDE.local.md' else 'project' if i == 0 else 'parent'
                out.append(dict(scope=scope, path=p, **st))
    return out


def _label_for(enc, known):
    for d in known:
        if chats.encode_dir(d) == enc:
            return projects.display_name(d), d
    return enc, None


def _memory(ctx, known):
    P = paths.P
    root = os.path.join(P.claude_dir, 'projects')
    groups, total = [], 0
    try:
        dirs = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return []
    for e in dirs:
        mem = os.path.join(e.path, 'memory')
        if not e.is_dir(follow_symlinks=False) or not os.path.isdir(mem) or os.path.islink(mem):
            continue
        files = []
        for f in sorted(os.scandir(mem), key=lambda x: (x.name != 'MEMORY.md', x.name)):
            if total >= MAX_MEMORY:
                break
            if not f.is_file(follow_symlinks=False) or not f.name.endswith('.md'):
                continue
            fm = frontmatter(f.path)
            st = f.stat(follow_symlinks=False)
            files.append({'name': f.name, 'path': f.path, 'size': st.st_size, 'mtime': int(st.st_mtime * 1000),
                          'title': fm.get('name'), 'description': fm.get('description'), 'type': fm.get('type')})
            total += 1
        if files:
            label, folder = _label_for(e.name, known)
            groups.append({'dir': mem, 'label': label, 'folder': folder, 'current': bool(ctx) and folder == ctx,
                           'files': files})
    groups.sort(key=lambda g: (not g['current'], g['label'].lower()))
    return groups


def _mcp_target(cfg):
    """What to show for a server: the command and its package (first non-flag argument), or the URL's host.
    Never the env, the remaining arguments or the URL path/query (they can hold keys)."""
    url = cfg.get('url')
    if isinstance(url, str) and url:
        m = re.match(r'^([a-z][a-z0-9+.-]*://)([^/?#@]*@)?([^/?#]+)', url, re.I)
        return (m.group(1) + m.group(3)) if m else 'URL'
    cmd = cfg.get('command')
    if not isinstance(cmd, str) or not cmd:
        return ''
    parts = [os.path.basename(cmd)]
    for a in cfg.get('args') or []:
        if isinstance(a, str) and a and not a.startswith('-') and '=' not in a and len(a) <= 80:
            parts.append(a)
            break
    return ' '.join(parts)


def _mcp(ctx, root):
    P = paths.P
    out = []

    def add(servers, scope, source):
        if not isinstance(servers, dict):
            return
        for name, cfg in sorted(servers.items()):
            if not isinstance(cfg, dict):
                continue
            kind = cfg.get('type') or ('http' if cfg.get('url') else 'stdio')
            env = cfg.get('env') if isinstance(cfg.get('env'), dict) else {}
            out.append({'name': str(name)[:80], 'scope': scope, 'source': source, 'type': str(kind)[:16],
                        'target': _mcp_target(cfg), 'env': len(env)})

    cj = os.path.join(P.home, '.claude.json')
    d = _json(cj)
    add(d.get('mcpServers'), 'user', cj)
    pr = d.get('projects') if isinstance(d.get('projects'), dict) else {}
    for folder in dict.fromkeys(x for x in (ctx, root) if x):
        p = pr.get(folder)
        if isinstance(p, dict):
            add(p.get('mcpServers'), 'local', cj)
    if root:
        mj = os.path.join(root, '.mcp.json')
        add(_json(mj).get('mcpServers'), 'project', mj)
    return out


def _plugins():
    P = paths.P
    pdir = os.path.join(P.claude_dir, 'plugins')
    installed = _json(os.path.join(pdir, 'installed_plugins.json')).get('plugins')
    enabled = _json(os.path.join(P.claude_dir, 'settings.json')).get('enabledPlugins')
    enabled = enabled if isinstance(enabled, dict) else {}
    out = []
    if not isinstance(installed, dict):
        return out
    for key, recs in sorted(installed.items()):
        rec = recs[0] if isinstance(recs, list) and recs and isinstance(recs[0], dict) else None
        if not rec:
            continue
        path = rec.get('installPath') if isinstance(rec.get('installPath'), str) else None
        if path:
            rp = os.path.realpath(path)
            path = rp if _within(rp, pdir) else None
        name, _, market = str(key).partition('@')
        out.append({'id': str(key)[:120], 'name': name[:80], 'marketplace': market[:80],
                    'version': str(rec.get('version') or '')[:40], 'scope': str(rec.get('scope') or '')[:16],
                    'enabled': bool(enabled.get(key)), 'path': path,
                    'updatedAt': str(rec.get('lastUpdated') or '')[:40]})
    return out


def _skills(root, plugins):
    P = paths.P
    sources = [('user', None, os.path.join(P.claude_dir, 'skills'))]
    if root:
        sources.append(('project', None, os.path.join(root, '.claude', 'skills')))
    for pl in plugins:
        if pl['path'] and pl['enabled']:
            sources.append(('plugin', pl['name'], os.path.join(pl['path'], 'skills')))
    out = []
    for scope, plugin, base in sources:
        try:
            entries = sorted(os.scandir(base), key=lambda e: e.name)
        except OSError:
            continue
        for e in entries:
            if len(out) >= MAX_SKILLS:
                return out
            md = os.path.join(e.path, 'SKILL.md')
            if not e.is_dir() or not os.path.isfile(md) or paths.is_denied(md):
                continue
            fm = frontmatter(md)
            out.append({'name': (fm.get('name') or e.name)[:80], 'description': fm.get('description') or '',
                        'scope': scope, 'plugin': plugin, 'path': os.path.realpath(md)})
    return out


def _hooks(root, plugins):
    P = paths.P
    files = [('user', None, os.path.join(P.claude_dir, 'settings.json'))]
    if root:
        files.append(('project', None, os.path.join(root, '.claude', 'settings.json')))
    for pl in plugins:
        if pl['path'] and pl['enabled']:
            files.append(('plugin', pl['name'], os.path.join(pl['path'], 'hooks', 'hooks.json')))
    out = []
    for scope, plugin, path in files:
        hooks = _json(path).get('hooks')
        if not isinstance(hooks, dict):
            continue
        for event, groups in hooks.items():
            for g in groups if isinstance(groups, list) else []:
                if not isinstance(g, dict):
                    continue
                for h in g.get('hooks') or []:
                    if not isinstance(h, dict):
                        continue
                    out.append({'event': str(event)[:40], 'matcher': str(g.get('matcher') or '')[:120],
                                'type': str(h.get('type') or 'command')[:16],
                                'command': str(h.get('command') or h.get('prompt') or '')[:300],
                                'timeout': h.get('timeout') if isinstance(h.get('timeout'), (int, float)) else None,
                                'async': bool(h.get('async')), 'scope': scope, 'plugin': plugin, 'source': path})
    return out


def _git_root(d):
    while d and _within(d, paths.P.home):
        if os.path.exists(os.path.join(d, '.git')):
            return d
        if d == paths.P.home:
            break
        d = os.path.dirname(d)
    return None


def overview(ctx=None, known=()):
    """-> {folder, root, instructions, memory, mcp, skills, plugins, hooks}. ctx: the folder of the current chat or
    project (project-level files are looked up from there), None for user-level only."""
    if ctx:
        rp = os.path.realpath(ctx)
        ctx = rp if os.path.isdir(rp) and paths.within_home(rp) and not paths.is_denied(rp) else None
    root = (_git_root(ctx) or ctx) if ctx else None
    plugins = _plugins()
    return {'folder': ctx, 'root': root, 'instructions': _instructions(ctx),
            'memory': _memory(ctx, list(known) + ([ctx] if ctx else [])), 'mcp': _mcp(ctx, root),
            'skills': _skills(root, plugins), 'plugins': plugins, 'hooks': _hooks(root, plugins)}


# ------------------------------------------------------------------ edits
def editable(path):
    """realpath of a file the editor may write, else CfgError. The file itself may not exist yet; its folder must."""
    P = paths.P
    if not isinstance(path, str) or not path or '\0' in path or len(path) > 4096:
        raise CfgError('bad_request', 'неверный путь')
    full = os.path.abspath(os.path.expanduser(path))
    parent = os.path.realpath(os.path.dirname(full))
    name = os.path.basename(full)
    target = os.path.join(parent, name)
    if not paths.within_home(parent) or paths.is_denied(target) or paths.is_denied(parent):
        raise CfgError('not_allowed', 'путь вне домашней папки или закрыт')
    if os.path.islink(target):
        raise CfgError('not_allowed', 'это символическая ссылка: правьте сам файл')
    if not os.path.isdir(parent):
        raise CfgError('not_found', 'нет такой папки')
    mem_root = os.path.join(P.claude_dir, 'projects')
    if target == os.path.join(P.claude_dir, 'CLAUDE.md'):
        return target
    if (os.path.basename(parent) == 'memory' and os.path.dirname(os.path.dirname(parent)) == mem_root
            and MEMORY_NAME_RE.match(name)):
        return target
    inside_claude = _within(parent, P.claude_dir)
    if name in DOC_NAMES and not inside_claude:
        return target
    if name == 'CLAUDE.md' and os.path.basename(parent) == '.claude' and not inside_claude:
        return target
    raise CfgError('not_allowed', 'здесь можно править только CLAUDE.md и заметки памяти')


def write_doc(path, text, expect_mtime=None):
    """Write text to an editable file. expect_mtime: the mtime (ms) the editor loaded, None for a new file; a
    mismatch is a 'conflict' and nothing is written. -> {path, size, mtime}"""
    target = editable(path)
    if not isinstance(text, str):
        raise CfgError('bad_request', 'нет текста')
    data = text.encode('utf-8')
    if len(data) > MAX_DOC:
        raise CfgError('too_large', 'файл больше 512 КБ')
    st = _stat(target)
    if expect_mtime is None and st['exists']:
        raise CfgError('conflict', 'файл уже существует: откройте его заново')
    if expect_mtime is not None and (not st['exists'] or st['mtime'] != int(expect_mtime)):
        raise CfgError('conflict', 'файл изменился на VM, пока вы его правили')
    mode = 0o644
    try:
        mode = stat.S_IMODE(os.stat(target).st_mode)
    except OSError:
        pass
    tmp = f'{target}.{os.getpid()}.{int(time.time() * 1000)}.tmp'
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, target)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise CfgError('internal', f'не удалось записать: {e.strerror}')
    st = _stat(target)
    return {'path': target, 'size': st['size'], 'mtime': st['mtime']}
