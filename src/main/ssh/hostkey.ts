// Host key verification: ~/.ssh/known_hosts (plain, [host]:port, |1|salt|hash hashed entries) + our own TOFU file.
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KnownHostEntry {
  hosts: string[] | null; // null for hashed entries
  hashed: { salt: Buffer; hash: Buffer } | null;
  keyType: string;
  key: string; // base64 blob
  marker: string | null;
}

export type HostKeyResult = 'match' | 'mismatch' | 'unknown';

/** The host pattern ssh uses: `host` for port 22, `[host]:port` otherwise. */
export function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let marker: string | null = null;
    if (parts[0]?.startsWith('@')) marker = parts.shift() ?? null;
    if (parts.length < 3) continue;
    const [hostField, keyType, key] = parts as [string, string, string];
    if (hostField.startsWith('|1|')) {
      const [, , salt, hash] = hostField.split('|');
      if (!salt || !hash) continue;
      out.push({
        hosts: null,
        hashed: { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') },
        keyType,
        key,
        marker,
      });
    } else {
      out.push({ hosts: hostField.split(','), hashed: null, keyType, key, marker });
    }
  }
  return out;
}

function globToRe(p: string): RegExp {
  return new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
}

export function entryMatches(e: KnownHostEntry, token: string): boolean {
  if (e.hashed) {
    const h = createHmac('sha1', e.hashed.salt).update(token).digest();
    return h.equals(e.hashed.hash);
  }
  let ok = false;
  for (const pat of e.hosts ?? []) {
    if (pat.startsWith('!')) {
      if (globToRe(pat.slice(1)).test(token)) return false;
    } else if (globToRe(pat).test(token)) ok = true;
  }
  return ok;
}

/** key type from an SSH public key blob (uint32 length + name). */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return '';
  const n = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + n).toString('ascii');
}

export function fingerprint(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/**
 * match: some entry for this host has this key. mismatch: entries for this host with the same key type exist,
 * none matches (or a @revoked entry matches). unknown: no entry for this host (or only other key types).
 */
export function checkHostKey(
  entries: KnownHostEntry[],
  host: string,
  port: number,
  blob: Buffer,
): HostKeyResult {
  const tokens = [hostToken(host, port)];
  const b64 = blob.toString('base64');
  const type = keyTypeOf(blob);
  let sameType = false;
  for (const e of entries) {
    if (!tokens.some((t) => entryMatches(e, t))) continue;
    if (e.marker === '@revoked' && e.key === b64) return 'mismatch';
    if (e.marker) continue;
    if (e.key === b64) return 'match';
    if (e.keyType === type) sameType = true;
  }
  return sameType ? 'mismatch' : 'unknown';
}

export function readKnownHosts(paths: string[]): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  for (const p of paths) {
    try {
      out.push(...parseKnownHosts(readFileSync(p, 'utf8')));
    } catch {
      /* missing file */
    }
  }
  return out;
}

/** TOFU: append to the app's own known_hosts (never to ~/.ssh/known_hosts). */
export function trustHostKey(file: string, host: string, port: number, blob: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${hostToken(host, port)} ${keyTypeOf(blob)} ${blob.toString('base64')}\n`, {
    mode: 0o600,
  });
}

/** Forget trusted keys for host:port in the app's file. */
export function forgetHostKey(file: string, host: string, port: number): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const token = hostToken(host, port);
  const keep = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !parseKnownHosts(l).some((e) => entryMatches(e, token)));
  writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
}
