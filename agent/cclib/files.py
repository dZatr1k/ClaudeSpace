"""Project files for the Files panel: list a folder, read a file for preview, validate upload/download targets.

Everything goes through the deny-list (paths.is_denied, and the process audit hook), so ~/.ssh, Claude credentials
and settings.local.json are never listed or read. Paths must resolve inside $HOME.
"""
import base64
import os
import stat

from . import paths

MAX_ENTRIES = 3000
MAX_TEXT = 512 * 1024
MAX_IMAGE = 8 * 1024 * 1024
IMAGE_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
}
NAME_FORBIDDEN = ('/', '\0')


class FilesError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def resolve(path, want='any'):
    """realpath inside $HOME, not denied, existing; want = 'any' | 'dir' | 'file'."""
    if not isinstance(path, str) or not path or '\0' in path or len(path) > 4096:
        raise FilesError('bad_request', 'неверный путь')
    rp = os.path.realpath(os.path.expanduser(path))
    if not paths.within_home(rp) or paths.is_denied(rp):
        raise FilesError('not_allowed', 'путь вне домашней папки или закрыт')
    try:
        st = os.stat(rp)
    except OSError:
        raise FilesError('not_found', 'нет такого файла или папки')
    if want == 'dir' and not stat.S_ISDIR(st.st_mode):
        raise FilesError('bad_request', 'это не папка')
    if want == 'file' and not stat.S_ISREG(st.st_mode):
        raise FilesError('bad_request', 'это не обычный файл')
    return rp


def list_dir(path):
    """-> {path, entries: [{name, type: dir|file|other, size, mtime, hidden, link}], truncated}"""
    rp = resolve(path, 'dir')
    out = []
    try:
        it = os.scandir(rp)
    except PermissionError:
        raise FilesError('not_allowed', 'нет доступа к папке')
    except OSError as e:
        raise FilesError('internal', str(e))
    truncated = False
    with it:
        for e in it:
            full = os.path.join(rp, e.name)
            if paths.is_denied(full):
                continue
            if len(out) >= MAX_ENTRIES:
                truncated = True
                break
            try:
                link = e.is_symlink()
                st = e.stat()  # follows links; a broken link raises
                kind = 'dir' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'other'
                size, mtime = (st.st_size if kind == 'file' else 0), int(st.st_mtime * 1000)
            except OSError:
                link, kind, size, mtime = True, 'other', 0, 0
            out.append({'name': e.name, 'type': kind, 'size': size, 'mtime': mtime,
                        'hidden': e.name.startswith('.'), 'link': link})
    out.sort(key=lambda x: (x['type'] != 'dir', x['name'].lower()))
    return {'path': rp, 'entries': out, 'truncated': truncated}


def read_file(path):
    """-> {path, size, mtime, kind: text|image|binary, text?, truncated?, mime?, data?(base64)}"""
    rp = resolve(path, 'file')
    st = os.stat(rp)
    base = {'path': rp, 'size': st.st_size, 'mtime': int(st.st_mtime * 1000)}
    mime = IMAGE_MIME.get(os.path.splitext(rp)[1].lower())
    try:
        if mime:
            if st.st_size > MAX_IMAGE:
                return dict(base, kind='binary', reason='too_large')
            with paths.safe_open(rp, 'rb') as f:
                return dict(base, kind='image', mime=mime, data=base64.b64encode(f.read()).decode('ascii'))
        with paths.safe_open(rp, 'rb') as f:
            raw = f.read(MAX_TEXT + 1)
    except PermissionError:
        raise FilesError('not_allowed', 'нет доступа к файлу')
    if b'\0' in raw[:8192]:
        return dict(base, kind='binary')
    truncated = len(raw) > MAX_TEXT
    raw = raw[:MAX_TEXT]
    if truncated:  # do not cut a UTF-8 sequence in half
        raw = raw[: len(raw.decode('utf-8', 'ignore').encode('utf-8'))]
    return dict(base, kind='text', text=raw.decode('utf-8', 'replace'), truncated=truncated)


def upload_target(dir_path, name):
    """Where an uploaded file goes: -> {path, exists}. The name is a plain file name (no folders)."""
    d = resolve(dir_path, 'dir')
    if (not isinstance(name, str) or not name or name in ('.', '..') or len(name) > 255
            or any(c in name for c in NAME_FORBIDDEN)):
        raise FilesError('bad_request', 'неверное имя файла')
    target = os.path.join(d, name)
    if paths.is_denied(target):
        raise FilesError('not_allowed', 'сюда записывать нельзя')
    if os.path.lexists(target) and not os.path.isfile(target):
        raise FilesError('bad_request', 'на этом месте папка или особый файл')
    return {'path': target, 'exists': os.path.exists(target)}


def download_source(path):
    """A file the app may copy to the PC: -> {path, size}"""
    rp = resolve(path, 'file')
    return {'path': rp, 'size': os.stat(rp).st_size}
