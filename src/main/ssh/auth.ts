// Authentication material: ssh-agent (Windows named pipe / SSH_AUTH_SOCK) or a key file, optionally with a
// passphrase that is kept in memory only (never written anywhere).
import { existsSync, readFileSync } from 'node:fs';
import { createAgent, utils } from 'ssh2';
import type { ParsedKey } from 'ssh2';
import { fingerprint } from './hostkey';

export const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

export function agentPath(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'win32') return WINDOWS_AGENT_PIPE;
  return env.SSH_AUTH_SOCK || null;
}

export type AgentProbe =
  { state: 'ok'; keys: number } | { state: 'empty' } | { state: 'down'; error: string };

export function probeAgent(path: string | null, timeoutMs = 3000): Promise<AgentProbe> {
  if (!path) return Promise.resolve({ state: 'down', error: 'SSH_AUTH_SOCK не задан' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: AgentProbe) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => finish({ state: 'down', error: 'агент не ответил' }), timeoutMs);
    try {
      createAgent(path).getIdentities((err, keys) => {
        clearTimeout(timer);
        if (err) finish({ state: 'down', error: err.message });
        else if (!keys || keys.length === 0) finish({ state: 'empty' });
        else finish({ state: 'ok', keys: keys.length });
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ state: 'down', error: String(e) });
    }
  });
}

export type KeyProbe =
  | { state: 'none' }
  | { state: 'plain'; path: string; data: Buffer; fingerprint: string }
  | { state: 'encrypted'; path: string; data: Buffer }
  | { state: 'decrypted'; path: string; data: Buffer; passphrase: string; fingerprint: string }
  | { state: 'wrong-passphrase'; path: string }
  | { state: 'invalid'; path: string; error: string };

function pubFingerprint(k: ParsedKey): string {
  return fingerprint(k.getPublicSSH());
}

export function probeKey(paths: string[], passphrase: string | null): KeyProbe {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      continue;
    }
    const parsed = utils.parseKey(data);
    if (!(parsed instanceof Error)) {
      const k = Array.isArray(parsed) ? parsed[0] : parsed;
      return { state: 'plain', path, data, fingerprint: k ? pubFingerprint(k) : '' };
    }
    if (/passphrase/i.test(parsed.message)) {
      if (passphrase == null) return { state: 'encrypted', path, data };
      const dec = utils.parseKey(data, passphrase);
      if (dec instanceof Error) return { state: 'wrong-passphrase', path };
      const k = Array.isArray(dec) ? dec[0] : dec;
      return { state: 'decrypted', path, data, passphrase, fingerprint: k ? pubFingerprint(k) : '' };
    }
    return { state: 'invalid', path, error: parsed.message };
  }
  return { state: 'none' };
}
