// Install/update csagent on the target (DESIGN §7.7): compare MANIFEST hash, upload to a temp dir, verify sha256,
// swap atomically. Also checks python3 >= 3.8 and tmux.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '../transport/types';
import { execCollect, shq } from '../transport/types';

export interface Manifest {
  agent: string;
  /** the app release the bundle shipped with (package.json); missing in bundles before 0.7.11 */
  app?: string;
  protocol: number;
  files: Record<string, string>;
  hash: string;
}

export const REMOTE_DIR = '.local/lib/claudespace';
/** files run directly: csagent.py by the app, askpass.py by sudo (SUDO_ASKPASS, BACKLOG 11), openurl.py as BROWSER */
export const EXECUTABLE_FILES: readonly string[] = ['csagent.py', 'askpass.py', 'openurl.py'];

export function readBundledManifest(bundleDir: string): Manifest {
  return JSON.parse(readFileSync(join(bundleDir, 'MANIFEST.json'), 'utf8')) as Manifest;
}

export class InstallError extends Error {
  constructor(
    readonly reason: 'no-python' | 'old-python' | 'no-tmux' | 'newer' | 'verify' | 'upload' | 'other',
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

/** a vs b as x.y.z release numbers (a "-suffix" is ignored): <0, 0, >0; null if either is not one. */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const parse = (v: string | undefined) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(v ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * What to do with the agent on the VM. Several apps share it (the PC and the phone update at different times), so
 * an agent of a newer release stays: replacing it would undo the other app's update, and that app would put it
 * back on its next connection. Within one protocol a newer agent still serves an older app (new methods and
 * fields are additions; a breaking change raises PROTOCOL). A newer agent on another protocol: this app is too old.
 */
export function installPlan(
  installed: Manifest | null,
  bundled: Manifest,
): 'same' | 'install' | 'keep-newer' | 'app-too-old' {
  if (installed?.hash === bundled.hash) return 'same';
  if (!installed || (compareVersions(installed.app, bundled.app) ?? 0) <= 0) return 'install';
  return installed.protocol === bundled.protocol ? 'keep-newer' : 'app-too-old';
}

/** Ensure the bundled agent (or a newer one, see installPlan) is installed. installed: it (re)installed;
 * kept: the release of a newer agent left in place. */
export async function ensureAgent(
  t: Transport,
  bundleDir: string,
  progress: InstallProgress = () => undefined,
): Promise<{ installed: boolean; kept?: string; probe: ProbeResult }> {
  const bundled = readBundledManifest(bundleDir);
  const p = await probe(t);
  if (!p.python) throw new InstallError('no-python', 'На VM нет python3');
  if (!p.pythonOk) throw new InstallError('old-python', 'На VM python3 старше 3.8');
  if (!p.tmux) throw new InstallError('no-tmux', 'На VM нет tmux');
  const plan = installPlan(p.installed, bundled);
  if (plan === 'same') return { installed: false, probe: p };
  if (plan === 'keep-newer') return { installed: false, kept: p.installed?.app, probe: p };
  if (plan === 'app-too-old')
    throw new InstallError(
      'newer',
      `На VM стоит агент из ClaudeSpace ${p.installed?.app}, а это приложение старше и не может с ним работать. Обновите приложение.`,
    );

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

/** this app's id on the VM for one connection: the agent gets it as --app, terminals as CLAUDESPACE_APP */
export const APP_ID_RE = /^[0-9a-f]{16}$/;

export function agentCommand(tmuxSocket: string | null, appId: string | null = null): string {
  const env = tmuxSocket ? `CSAGENT_TMUX_SOCKET=${shq(tmuxSocket)} ` : '';
  const app = appId && APP_ID_RE.test(appId) ? ` --app ${appId}` : '';
  return `export LANG="\${LANG:-C.UTF-8}"; ${env}exec python3 -I ~/${REMOTE_DIR}/csagent.py serve --protocol 1${app}`;
}
