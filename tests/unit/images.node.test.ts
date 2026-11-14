import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { imageExt, uploadImage } from '../../src/main/images';
import { LocalTransport } from '../../src/main/transport/local';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('imageExt', () => {
  it('detects by magic bytes', () => {
    expect(imageExt(PNG)).toBe('png');
    expect(imageExt(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageExt(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(imageExt(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(imageExt(new TextEncoder().encode('#!/bin/sh\nrm -rf /'))).toBeNull();
    expect(imageExt(new Uint8Array())).toBeNull();
  });
});

describe('uploadImage', () => {
  it('writes the image under ~/.cache/claudespace/images (0600) and returns its absolute path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cs-img-'));
    homes.push(home);
    const t = new LocalTransport('/nonexistent', '/bin/bash', home);
    const r = await uploadImage(t, PNG, new Date(2026, 10, 14, 9, 5, 7));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toMatch(
      new RegExp(`^${home}/\\.cache/claudespace/images/20261114-090507-[0-9a-f]{6}\\.png$`),
    );
    expect(readFileSync(r.path)).toEqual(Buffer.from(PNG));
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.cache/claudespace/images')).mode & 0o777).toBe(0o700);
    t.close();
  });

  it('removes uploads older than a week', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cs-img-'));
    homes.push(home);
    const dir = join(home, '.cache/claudespace/images');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'old.png');
    writeFileSync(old, PNG);
    const weekAgo = Date.now() / 1000 - 9 * 86400;
    utimesSync(old, weekAgo, weekAgo);
    const t = new LocalTransport('/nonexistent', '/bin/bash', home);
    await uploadImage(t, PNG);
    expect(() => statSync(old)).toThrow();
    t.close();
  });

  it('refuses non-images, oversize data and no connection', async () => {
    const t = new LocalTransport('/nonexistent', '/bin/bash', tmpdir());
    expect(await uploadImage(t, new TextEncoder().encode('hello'))).toEqual({
      ok: false,
      error: expect.stringContaining('не PNG'),
    });
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(PNG);
    expect((await uploadImage(t, big)).ok).toBe(false);
    expect(await uploadImage(null, PNG)).toEqual({ ok: false, error: 'Нет связи с VM' });
    t.close();
  });
});
