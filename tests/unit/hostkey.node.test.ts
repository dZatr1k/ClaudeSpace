import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkHostKey,
  fingerprint,
  forgetHostKey,
  hostToken,
  keyTypeOf,
  parseKnownHosts,
  readKnownHosts,
  trustHostKey,
} from '../../src/main/ssh/hostkey';

function blob(type: string, payload: string): Buffer {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return Buffer.concat([len, t, Buffer.from(payload)]);
}
const A = blob('ssh-ed25519', 'key-A');
const B = blob('ssh-ed25519', 'key-B');
const R = blob('ssh-rsa', 'key-R');

function hashed(host: string): string {
  const salt = randomBytes(20);
  const h = createHmac('sha1', salt).update(host).digest();
  return `|1|${salt.toString('base64')}|${h.toString('base64')}`;
}

describe('known_hosts', () => {
  it('hostToken uses [host]:port for non-22', () => {
    expect(hostToken('vm', 22)).toBe('vm');
    expect(hostToken('1.2.3.4', 2222)).toBe('[1.2.3.4]:2222');
  });

  it('plain entries: match, mismatch, unknown', () => {
    const e = parseKnownHosts(`# comment\n203.0.113.10,vm ssh-ed25519 ${A.toString('base64')}\n`);
    expect(checkHostKey(e, '203.0.113.10', 22, A)).toBe('match');
    expect(checkHostKey(e, 'vm', 22, A)).toBe('match');
    expect(checkHostKey(e, '203.0.113.10', 22, B)).toBe('mismatch');
    expect(checkHostKey(e, 'other', 22, A)).toBe('unknown');
    // different key type for a known host: not a mismatch (ssh would ask), it's unknown
    expect(checkHostKey(e, 'vm', 22, R)).toBe('unknown');
  });

  it('[host]:port entries', () => {
    const e = parseKnownHosts(`[127.0.0.1]:2222 ssh-ed25519 ${A.toString('base64')}`);
    expect(checkHostKey(e, '127.0.0.1', 2222, A)).toBe('match');
    expect(checkHostKey(e, '127.0.0.1', 22, A)).toBe('unknown');
    expect(checkHostKey(e, '127.0.0.1', 2222, B)).toBe('mismatch');
  });

  it('hashed |1| entries (plain and with port)', () => {
    const e = parseKnownHosts(
      `${hashed('203.0.113.10')} ssh-ed25519 ${A.toString('base64')}\n${hashed('[vm]:2200')} ssh-ed25519 ${B.toString('base64')}`,
    );
    expect(checkHostKey(e, '203.0.113.10', 22, A)).toBe('match');
    expect(checkHostKey(e, '203.0.113.10', 22, B)).toBe('mismatch');
    expect(checkHostKey(e, 'vm', 2200, B)).toBe('match');
    expect(checkHostKey(e, 'vm', 22, B)).toBe('unknown');
  });

  it('wildcards, negation, markers', () => {
    const e = parseKnownHosts(
      `*.lan,!bad.lan ssh-ed25519 ${A.toString('base64')}\n@revoked * ssh-ed25519 ${B.toString('base64')}\n@cert-authority * ssh-ed25519 ${R.toString('base64')}`,
    );
    expect(checkHostKey(e, 'pc.lan', 22, A)).toBe('match');
    expect(checkHostKey(e, 'bad.lan', 22, A)).toBe('unknown');
    expect(checkHostKey(e, 'pc.lan', 22, B)).toBe('mismatch'); // revoked
  });

  it('keyTypeOf and fingerprint', () => {
    expect(keyTypeOf(A)).toBe('ssh-ed25519');
    expect(fingerprint(A)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it('TOFU file: trust, read back, forget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-kh-'));
    const f = join(dir, 'known_hosts');
    trustHostKey(f, '127.0.0.1', 2222, A);
    trustHostKey(f, 'vm', 22, B);
    const e = readKnownHosts([join(dir, 'missing'), f]);
    expect(checkHostKey(e, '127.0.0.1', 2222, A)).toBe('match');
    expect(checkHostKey(e, 'vm', 22, B)).toBe('match');
    forgetHostKey(f, '127.0.0.1', 2222);
    expect(readFileSync(f, 'utf8')).not.toContain('127.0.0.1');
    expect(checkHostKey(readKnownHosts([f]), 'vm', 22, B)).toBe('match');
    rmSync(dir, { recursive: true });
  });
});
