import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachName, imageExt, uploadAttachment, uploadImage } from '../../src/main/attach';
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
    const r = await uploadImage(t, PNG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toMatch(new RegExp(`^${home}/\\.cache/claudespace/images/img-[0-9a-f]{16}\\.png$`));
    expect(readFileSync(r.path)).toEqual(Buffer.from(PNG));
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.cache/claudespace/images')).mode & 0o777).toBe(0o700);
    // the same picture again: the same file, not a second copy
    const again = await uploadImage(t, PNG);
    expect(again).toEqual(r);
    expect(readdirSync(join(home, '.cache/claudespace/images'))).toHaveLength(1);
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

describe('attachName', () => {
  it('keeps letters of any script, digits, the extension; one «_» for runs of anything else', () => {
    expect(attachName('report.pdf')).toBe('report.pdf');
    expect(attachName('Резюме 2026 (final).PDF')).toBe('Резюме_2026_final.PDF');
    expect(attachName("it's $(id) `x`.md")).toBe('it_s_id_x.md');
    expect(attachName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
    expect(attachName('../../.bashrc')).toBe('bashrc');
    expect(attachName('archive.tar.gz')).toBe('archive.tar.gz');
    expect(attachName('Makefile')).toBe('Makefile');
    expect(attachName('???.txt')).toBe('file.txt');
    expect(attachName('')).toBe('file');
    expect(attachName('a'.repeat(300) + '.json')).toBe('a'.repeat(80) + '.json');
    expect(attachName('x.p d$f')).toBe('x.pdf');
  });
});

describe('uploadAttachment', () => {
  it('puts any file under ~/.cache/claudespace/files/<sha16>/<name> (0600), once per content', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cs-att-'));
    homes.push(home);
    const t = new LocalTransport('/nonexistent', '/bin/bash', home);
    const pdf = new TextEncoder().encode('%PDF-1.7\n%fake\n');
    const r = await uploadAttachment(t, 'Отчёт за май.pdf', pdf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toMatch(
      new RegExp(`^${home}/\\.cache/claudespace/files/[0-9a-f]{16}/Отчёт_за_май\\.pdf$`),
    );
    expect(readFileSync(r.path)).toEqual(Buffer.from(pdf));
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.cache/claudespace/files')).mode & 0o777).toBe(0o700);
    expect(await uploadAttachment(t, 'Отчёт за май.pdf', pdf)).toEqual(r);
    // an image goes to images/ whatever its name, so Claude Code attaches it as a picture
    const img = await uploadAttachment(t, 'scan.bin', PNG);
    expect(img.ok && img.path).toMatch(/\/images\/img-[0-9a-f]{16}\.png$/);
    t.close();
  });

  it('a name with shell characters stays a name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cs-att-'));
    homes.push(home);
    const t = new LocalTransport('/nonexistent', '/bin/bash', home);
    const r = await uploadAttachment(t, '"; touch $HOME/pwned; echo ".md', new TextEncoder().encode('# hi'));
    expect(r.ok).toBe(true);
    expect(() => statSync(join(home, 'pwned'))).toThrow();
    t.close();
  });

  it('removes old files and their empty folders', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cs-att-'));
    homes.push(home);
    const dir = join(home, '.cache/claudespace/files/0123456789abcdef');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'old.md');
    writeFileSync(old, '# old');
    const weekAgo = Date.now() / 1000 - 9 * 86400;
    utimesSync(old, weekAgo, weekAgo);
    const t = new LocalTransport('/nonexistent', '/bin/bash', home);
    await uploadAttachment(t, 'new.md', new TextEncoder().encode('# new'));
    expect(() => statSync(dir)).toThrow();
    t.close();
  });

  it('refuses oversize data and no connection', async () => {
    const t = new LocalTransport('/nonexistent', '/bin/bash', tmpdir());
    const big = new Uint8Array(101 * 1024 * 1024);
    expect(await uploadAttachment(t, 'big.log', big)).toEqual({ ok: false, error: 'Файл больше 100 МБ' });
    expect(await uploadAttachment(null, 'a.md', new Uint8Array([1]))).toEqual({
      ok: false,
      error: 'Нет связи с VM',
    });
    t.close();
  });
});
