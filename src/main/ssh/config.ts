// ~/.ssh/config on the PC: list of Host aliases (no wildcards) and the resolved settings for one of them.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import SSHConfig from 'ssh-config';

export interface ResolvedHost {
  host: string;
  hostname: string;
  user: string;
  port: number;
  identityFiles: string[];
}

export function defaultConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p.replace(/%d/g, homedir());
}

export function listHosts(text: string): string[] {
  const cfg = SSHConfig.parse(text);
  const out: string[] = [];
  for (const line of cfg) {
    if (line.type === SSHConfig.DIRECTIVE && line.param.toLowerCase() === 'host') {
      const vals = Array.isArray(line.value)
        ? line.value.map((v) => (typeof v === 'string' ? v : v.val))
        : [String(line.value)];
      for (const v of vals) if (v && !/[*?!]/.test(v) && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function resolveHost(text: string, host: string, defaultUser: string): ResolvedHost {
  const c = SSHConfig.parse(text).compute(host);
  const get = (k: string) => first(c[k] ?? c[k.toLowerCase()]);
  const idf = c.IdentityFile ?? c.identityfile;
  const ids = (Array.isArray(idf) ? idf : idf ? [idf] : []).map(expandHome);
  return {
    host,
    hostname: get('HostName') ?? host,
    user: get('User') ?? defaultUser,
    port: Number(get('Port') ?? 22) || 22,
    identityFiles: ids,
  };
}

export function readConfig(path = defaultConfigPath()): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function defaultIdentityFiles(): string[] {
  const d = join(homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => join(d, n));
}
