// Messages between the phone UI in the browser and main's core in the Vite dev server (src/main/mobileDev.ts). They
// travel as JSON over Vite's websocket, so bytes (terminal output, uploads) go as base64.
import type { ConnState } from './model';

export const WIRE = {
  invoke: 'cs:invoke',
  result: 'cs:result',
  event: 'cs:event',
  /** dev only: show a connection state the local transport cannot produce (host key prompt, offline) */
  simulate: 'cs:simulate',
} as const;

export interface WireInvoke {
  id: number;
  channel: string;
  args?: unknown;
}

export type WireResult = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export interface WireEvent {
  event: string;
  data: unknown;
}

export interface WireSimulate {
  state: ConnState | null;
}

const CHUNK = 0x8000;

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += CHUNK) s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
