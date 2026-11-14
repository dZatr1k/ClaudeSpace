// Install/update csagent on the target (DESIGN §7.7): compare MANIFEST hash, upload to a temp dir, verify sha256,
// swap atomically. Also checks python3 >= 3.8 and tmux.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '../transport/types';
import { execCollect, shq } from '../transport/types';

export interface Manifest {
  agent: string;
  protocol: number;
  files: Record<string, string>;
  hash: string;
}

export const REMOTE_DIR = '.local/lib/claudespace';
/** files run directly: csagent.py by the app, askpass.py by sudo (SUDO_ASKPASS, BACKLOG 11) */
export const EXECUTABLE_FILES: readonly string[] = ['csagent.py', 'askpass.py'];

export function readBundledManifest(bundleDir: string): Manifest {
  return JSON.parse(readFileSync(join(bundleDir, 'MANIFEST.json'), 'utf8')) as Manifest;
}

export class InstallError extends Error {
  constructor(
    readonly reason: 'no-python' | 'old-python' | 'no-tmux' | 'verify' | 'upload' | 'other',
    message: string,
  ) {
    super(message);
  }
}

export interface ProbeResult {
  python: string | null;
  pythonOk: boolean;
  tmux: string | null;
  installed: Manifest | null;
}

const PROBE = [
  'printf "py=%s\\n" "$(command -v python3)"',
  'printf "pyok=%s\\n" "$(python3 -I -c \'import sys; print(int(sys.version_info >= (3, 8)))\' 2>/dev/null)"',
  'printf "tmux=%s\\n" "$(command -v tmux)"',
  'echo "---"',
  `cat ~/${REMOTE_DIR}/MANIFEST.json 2>/dev/null`,
].join('; ');

export async function probe(t: Transport): Promise<ProbeResult> {
  const r = await execCollect(t, PROBE, 15000);
  const [head = '', body = ''] = r.stdout.split('---\n');
  const kv: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  let installed: Manifest | null;
  try {
    installed = body.trim() ? (JSON.parse(body) as Manifest) : null;
  } catch {
    installed = null;
  }
  return { python: kv.py || null, pythonOk: kv.pyok === '1', tmux: kv.tmux || null, installed };
}

const VERIFY_PY = `
import hashlib, json, os, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, 'MANIFEST.json')))
for rel, sha in m['files'].items():
    if hashlib.sha256(open(os.path.join(d, rel), 'rb').read()).hexdigest() != sha:
        print('BAD ' + rel); sys.exit(3)
print('OK')
`;

export type InstallProgress = (msg: string) => void;

/** Ensure the bundled agent is installed. Returns true if it (re)installed. */
export async function ensureAgent(
  t: Transport,
  bundleDir: string,
  progress: InstallProgress = () => undefined,
): Promise<{ installed: boolean; probe: ProbeResult }> {
  const bundled = readBundledManifest(bundleDir);
  const p = await probe(t);
  if (!p.python) throw new InstallError('no-python', 'На VM нет python3');
  if (!p.pythonOk) throw new InstallError('old-python', 'На VM python3 старше 3.8');
  if (!p.tmux) throw new InstallError('no-tmux', 'На VM нет tmux');
  if (p.installed?.hash === bundled.hash) return { installed: false, probe: p };

  const files = Object.keys(bundled.files);
  const sizes = files.reduce((n, f) => n + readFileSync(join(bundleDir, f)).length, 0);
  progress(`Установка агента (${Math.max(1, Math.round(sizes / 1024))} КБ)…`);
  const tmp = `.local/lib/claudespace.tmp-${randomBytes(4).toString('hex')}`;
  const mk = await execCollect(t, `mkdir -p -m 700 ~/${tmp}/cclib && chmod 700 ~/${tmp}`);
  if (mk.code !== 0) throw new InstallError('upload', `mkdir: ${mk.stderr.trim()}`);
  try {
    for (const rel of [...files, 'MANIFEST.json']) {
      const mode = EXECUTABLE_FILES.includes(rel) ? 0o700 : 0o600;
      await t.writeFile(`${tmp}/${rel}`, readFileSync(join(bundleDir, rel)), mode);
    }
  } catch (e) {
    await execCollect(t, `rm -rf ~/${tmp}`).catch(() => undefined);
    throw new InstallError('upload', `загрузка: ${(e as Error).message}`);
  }
  const name = tmp.split('/').pop() as string;
  const script = [
    'cd ~/.local/lib',
    `python3 -I -c ${shq(VERIFY_PY)} ${shq(name)}`,
    'rm -rf claudespace.old',
    '{ [ ! -e claudespace ] || mv claudespace claudespace.old; }',
    `mv ${shq(name)} claudespace`,
    'rm -rf claudespace.old',
  ].join(' && ');
  const r = await execCollect(t, script, 20000);
  if (r.code !== 0 || !r.stdout.includes('OK')) {
    await execCollect(t, `rm -rf ~/${tmp}`).catch(() => undefined);
    throw new InstallError(
      'verify',
      `проверка sha256 не прошла: ${(r.stdout + r.stderr).trim().slice(0, 200)}`,
    );
  }
  return { installed: true, probe: p };
}

export function agentCommand(tmuxSocket: string | null): string {
  const env = tmuxSocket ? `CSAGENT_TMUX_SOCKET=${shq(tmuxSocket)} ` : '';
  return `export LANG="\${LANG:-C.UTF-8}"; ${env}exec python3 -I ~/${REMOTE_DIR}/csagent.py serve --protocol 1`;
}
