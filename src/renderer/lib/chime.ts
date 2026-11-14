// Short two-note chime generated with WebAudio: no binary asset, no network (CSP stays default-src 'self').
import { invoke } from '../bridge';
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function note(ac: AudioContext, out: AudioNode, freq: number, at: number, dur: number, gain: number) {
  // sine + a quiet octave for a soft bell-like tone; fast attack, exponential decay
  for (const [mul, g] of [
    [1, 1],
    [2, 0.18],
  ] as const) {
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mul;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain * g, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}

/** volume 0..1; `kind` picks the interval: waiting = rising (a question), idle = falling (done). */
export function playChime(volume: number, kind: 'waiting' | 'idle' = 'waiting'): void {
  const v = Math.max(0, Math.min(1, volume));
  if (v === 0) return;
  const ac = audio();
  if (!ac) return;
  const master = ac.createGain();
  master.gain.value = 0.35 * v * v; // perceptual curve
  master.connect(ac.destination);
  const t0 = ac.currentTime + 0.01;
  const [a, b] = kind === 'waiting' ? [659.25, 987.77] : [987.77, 659.25]; // E5 / B5
  note(ac, master, a, t0, 0.35, 1);
  note(ac, master, b, t0 + 0.13, 0.6, 0.9);
  setTimeout(() => master.disconnect(), 1200);
}

// ---- the user's own sound file (from the PC, read by main; decoded here) --------------------------------------
let fileBuf: { key: string; buf: AudioBuffer | null; error?: string } | null = null;

async function loadFileSound(key: string): Promise<AudioBuffer | null> {
  if (fileBuf?.key === key) return fileBuf.buf;
  const ac = audio();
  if (!ac) return null;
  const r = await invoke('sound.load');
  let buf: AudioBuffer | null = null;
  let error = r.error;
  if (r.ok && r.data) {
    try {
      // copy: decodeAudioData detaches the buffer
      buf = await ac.decodeAudioData(r.data.slice().buffer as ArrayBuffer);
    } catch {
      error = 'не удалось декодировать';
    }
  }
  fileBuf = { key, buf, error };
  if (!buf) void invoke('diag.log', { text: `[notify] sound file ${r.path}: ${error ?? '?'} → chime` });
  return buf;
}

/**
 * Notification sound: the configured file (default ~/.claude/sounds/sound.wav on the PC), else the chime.
 * `soundFile` is the setting value; it keys the cache, so changing it reloads the file.
 */
export async function playNotifySound(
  volume: number,
  kind: 'waiting' | 'idle',
  soundFile: string,
): Promise<'file' | 'chime' | 'off'> {
  const v = Math.max(0, Math.min(1, volume));
  if (v === 0) return 'off';
  const ac = audio();
  const buf = ac ? await loadFileSound(soundFile).catch(() => null) : null;
  if (!ac || !buf) {
    playChime(v, kind);
    return 'chime';
  }
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = v * v;
  src.buffer = buf;
  src.connect(gain).connect(ac.destination);
  src.start();
  return 'file';
}
