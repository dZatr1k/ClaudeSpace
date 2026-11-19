#!/usr/bin/env python3
"""Generate the agent bundle: resources/agent/{csagent.py, cclib/*.py, MANIFEST.json}.

  python3 agent/build_manifest.py            bundle into resources/agent (used by the app and the installer)
  python3 agent/build_manifest.py --install  also install into ~/.local/lib/claudespace (dev, same as the app does)
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import csagent  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'resources', 'agent')
# run directly: the agent by the app, askpass.py by sudo (SUDO_ASKPASS), openurl.py by Claude Code (BROWSER)
EXECUTABLE = ('csagent.py', 'askpass.py', 'openurl.py')


def bundle(dest):
    files = {}
    tmp = dest + '.tmp'
    shutil.rmtree(tmp, ignore_errors=True)
    for rel in csagent.agent_files(HERE):
        src = os.path.join(HERE, rel)
        dst = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o755 if rel in EXECUTABLE else 0o644)
        files[rel] = csagent.file_sha(dst)
    manifest = {'agent': csagent.AGENT_VERSION, 'protocol': csagent.PROTOCOL, 'files': files,
                'hash': csagent.manifest_hash(files)}
    with open(os.path.join(tmp, 'MANIFEST.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
        f.write('\n')
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(tmp, dest)
    return manifest


def install(src):
    """Same layout and permissions as the app's installer (docs/DESIGN.md §7.7)."""
    lib = os.path.join(os.path.expanduser('~'), '.local', 'lib')
    target = os.path.join(lib, 'claudespace')
    tmp = target + f'.tmp-{os.getpid()}'
    old = target + '.old'
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(src, tmp)
    for d, dirs, fs in os.walk(tmp):
        os.chmod(d, 0o700)
        for name in fs:
            os.chmod(os.path.join(d, name), 0o700 if name in EXECUTABLE else 0o600)
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(target):
        os.replace(target, old)
    os.replace(tmp, target)
    shutil.rmtree(old, ignore_errors=True)
    return target


if __name__ == '__main__':
    m = bundle(OUT)
    print(f"agent {m['agent']} protocol {m['protocol']} {m['hash'][:19]}… -> {os.path.relpath(OUT, ROOT)}")
    if '--install' in sys.argv:
        print('installed ->', install(OUT))
