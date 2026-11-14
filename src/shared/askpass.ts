// sudo password prompts in the app (BACKLOG 11): types shared by main and renderer. The password itself only
// travels renderer -> main (IPC 'askpass.reply') -> agent (askpass_reply) -> askpass.py; it is never stored or logged.
import { z } from 'zod';

/** where the app installs its askpass script on the VM (agent bundle, see agent/askpass.py) */
export const ASKPASS_SCRIPT = '$HOME/.local/lib/claudespace/askpass.py';
/** the line for the user's shell env (e.g. ~/.bashrc) — the app never edits dotfiles itself */
export const ASKPASS_ENV_LINE = `export SUDO_ASKPASS="${ASKPASS_SCRIPT}"`;
export const ASKPASS_MAX_PASSWORD = 1024;
export const ASKPASS_ID_RE = /^[0-9a-f]{16}$/;

/** agent event askpass_request: sudo on the VM wants a password */
export interface AskpassRequest {
  id: string;
  /** sudo's prompt, e.g. "[sudo] password for claude:" */
  prompt: string;
  /** the command line that asks for root (sudo's own cmdline), if known */
  command: string | null;
  cwd: string | null;
  /** tmux session the command runs in, if known */
  session: string | null;
  at: number;
}

/** agent event askpass_done: the prompt is over without the app's answer */
export interface AskpassDone {
  id: string;
  reason: 'timeout' | 'gone' | 'disabled' | 'disconnected' | (string & {});
}

export const askpassReplySchema = z
  .object({
    id: z.string().regex(ASKPASS_ID_RE),
    /** null = cancel */
    password: z
      .string()
      .min(0)
      .max(ASKPASS_MAX_PASSWORD)
      .refine((s) => !/[\0\r\n]/.test(s))
      .nullable(),
  })
  .strict();
export type AskpassReply = z.infer<typeof askpassReplySchema>;
