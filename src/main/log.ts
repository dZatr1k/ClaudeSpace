// Main-process log: userData/logs/main.log (rotation 5 x 1 MB) + an in-memory ring for the connection screen.
// Never log passwords, keys or terminal contents.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const RING = 200;
const MAX = 1024 * 1024;
let dir: string | null = null;
const ring: string[] = [];

export function initLog(logDir: string): void {
  dir = logDir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    dir = null;
  }
}

function rotate(file: string) {
  try {
    if (!existsSync(file) || statSync(file).size < MAX) return;
    for (let i = 4; i >= 1; i--) {
      const a = `${file}.${i}`;
      if (existsSync(a)) {
        if (i === 4) unlinkSync(a);
        else renameSync(a, `${file}.${i + 1}`);
      }
    }
    renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  ring.push(line);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  if (dir) {
    const f = join(dir, 'main.log');
    rotate(f);
    try {
      appendFileSync(f, line + '\n');
    } catch {
      /* ignore */
    }
  }
}

export function recentLog(): string[] {
  return ring.slice();
}
