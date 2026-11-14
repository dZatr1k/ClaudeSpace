// PC <-> VM link state (BACKLOG 12): reverse tunnel for `win`/`winfs` and «Диск ПК» mounts. Types only.

export const TUNNEL_PORT = 2222;

export type TunnelState =
  /** setting is off */
  | 'off'
  /** local mode (dev on the VM): there is no PC to tunnel to */
  | 'local'
  /** no connection to the VM */
  | 'waiting'
  | 'starting'
  /** our forward holds VM 127.0.0.1:2222 */
  | 'ours'
  /** someone else's tunnel (an external `ssh -R`) holds the port and answers like sshd */
  | 'foreign'
  /** the port is taken but does not answer (stale/hung holder); we retry */
  | 'busy'
  | 'error';

export interface PcMountState {
  /** as configured: C:\Data */
  src: string;
  /** as configured: ~/winfs/V */
  dst: string;
  /** short name for the status bar: basename of dst (V) */
  label: string;
  mounted: boolean;
  /** mounted by ClaudeSpace (unmounted on quit); false = mounted by hand, never touched automatically */
  owned: boolean;
  busy: 'mount' | 'unmount' | null;
  error: string | null;
}

export interface PcLinkState {
  tunnel: TunnelState;
  detail: string | null;
  /** next automatic attempt to take the port over */
  nextTryAt: number | null;
  /** this PC's sshd (127.0.0.1:22), probed from the app */
  sshd: 'unknown' | 'ok' | 'down';
  /** open connections through our tunnel */
  conns: number;
  mounts: PcMountState[];
}

export const initialPcLinkState: PcLinkState = {
  tunnel: 'waiting',
  detail: null,
  nextTryAt: null,
  sshd: 'unknown',
  conns: 0,
  mounts: [],
};
