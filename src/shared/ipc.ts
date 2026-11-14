// IPC between renderer and main: the only channels that exist (whitelist). Arguments are validated in main.
import { z } from 'zod';
import type { AgentErrorPayload, Method, MethodParams, MethodResults } from './protocol';
import type { ConnState, Snapshot, TabKind, Workspace } from './model';
import type { Settings, SettingsPatch } from './settings';
import type { PcLinkState } from './pclink';
import type { ForwardInfo } from './ports';
import type { AskpassRequest } from './askpass';
import { askpassReplySchema } from './askpass';
import type { UpdateState } from './update';
import type { IPC_CHANNEL_NAMES } from './channels';

/** largest file the Files panel uploads in one go (it travels through IPC in memory) */
export const FILE_UPLOAD_MAX = 100 * 1024 * 1024;
import { IPC_EVENT_NAMES } from './channels';

export const termOpenSchema = z
  .object({
    tabId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    kind: z.enum(['tmux', 'shell', 'lazygit', 'clone', 'yazi']),
    session: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional(),
    cwd: z.string().min(1).max(4096).optional(),
    url: z.string().min(1).max(2048).optional(),
    dest: z.string().min(1).max(4096).optional(),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(500),
  })
  .strict();
export type TermOpenArgs = z.infer<typeof termOpenSchema>;

const tabId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const ipcSchemas = {
  'agent.call': z.object({ method: z.string(), params: z.unknown().optional() }).strict(),
  'conn.state': z.undefined(),
  'conn.retryNow': z.undefined(),
  'conn.disconnect': z.undefined(),
  'conn.passphrase': z.object({ passphrase: z.string().max(1024) }).strict(),
  'conn.trustHost': z.object({ accept: z.boolean() }).strict(),
  'conn.log': z.undefined(),
  'conn.debugDrop': z.undefined(),
  'conn.debugFreeze': z.undefined(),
  'conn.hosts': z.undefined(),
  'settings.get': z.undefined(),
  'settings.set': z.record(z.string(), z.unknown()),
  'workspace.get': z.undefined(),
  'workspace.save': z.unknown(),
  'snapshot.get': z.undefined(),
  'term.open': termOpenSchema,
  'term.write': z
    .object({ tabId, data: z.string().max(8 * 1024 * 1024), binary: z.boolean().optional() })
    .strict(),
  'term.resize': z
    .object({ tabId, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(500) })
    .strict(),
  'term.close': z.object({ tabId }).strict(),
  'term.ack': z.object({ tabId, bytes: z.number().int().min(0) }).strict(),
  'clipboard.write': z.object({ text: z.string().max(1024 * 1024) }).strict(),
  'diag.log': z.object({ text: z.string().max(8000) }).strict(),
  'sound.load': z.undefined(),
  'notify.show': z
    .object({
      title: z.string().max(200),
      body: z.string().max(500),
      session: z.string().max(200),
      chatId: z.string().max(100).optional(),
    })
    .strict(),
  'clipboard.read': z.undefined(),
  'image.pasteClipboard': z.undefined(),
  'file.download': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'file.upload': z
    .object({
      dir: z.string().min(1).max(4096),
      name: z.string().min(1).max(255),
      data: z.instanceof(Uint8Array).refine((d) => d.length <= FILE_UPLOAD_MAX),
      overwrite: z.boolean().optional(),
    })
    .strict(),
  'file.reveal': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'image.upload': z
    .object({ data: z.instanceof(Uint8Array).refine((d) => d.length <= 20 * 1024 * 1024) })
    .strict(),
  'launch.rdp': z.undefined(),
  'launch.vscode': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'launch.openExternal': z.object({ url: z.string().url().max(4096) }).strict(),
  'app.info': z.undefined(),
  'app.toggleFullscreen': z.undefined(),
  'app.splash': z.object({ on: z.boolean() }).strict(),
  'app.toggleDevTools': z.undefined(),
  'pclink.state': z.undefined(),
  'pclink.mount': z.object({ dst: z.string().min(1).max(1024) }).strict(),
  'pclink.unmount': z.object({ dst: z.string().min(1).max(1024) }).strict(),
  'pclink.reconnect': z.undefined(),
  'ports.state': z.undefined(),
  'ports.forward': z.object({ vmPort: z.number().int().min(1).max(65535) }).strict(),
  'ports.close': z.object({ vmPort: z.number().int().min(1).max(65535) }).strict(),
  'ports.open': z.union([
    z.object({ vmPort: z.number().int().min(1).max(65535) }).strict(),
    z.object({ url: z.string().min(1).max(4096) }).strict(),
  ]),
  'askpass.pending': z.undefined(),
  'askpass.reply': askpassReplySchema,
  'update.state': z.undefined(),
  'update.check': z.undefined(),
  'update.install': z.undefined(),
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export const IPC_CHANNELS = Object.keys(ipcSchemas) as IpcChannel[];
// compile-time check: the preload whitelist (channels.ts) lists exactly these channels
type _SameChannels = [IpcChannel] extends [(typeof IPC_CHANNEL_NAMES)[number]]
  ? [(typeof IPC_CHANNEL_NAMES)[number]] extends [IpcChannel]
    ? true
    : never
  : never;
export const _channelsOk: _SameChannels = true;

export interface AppInfo {
  version: string;
  platform: string;
  dev: boolean;
  agentVersion: string;
  agentHash: string;
  protocol: number;
  userData: string;
}

export interface SshHostsInfo {
  configPath: string;
  found: boolean;
  hosts: string[];
  resolved: {
    host: string;
    hostname: string;
    user: string;
    port: number;
    identityFile: string | null;
  } | null;
}

export type AgentCallResult<M extends Method> =
  { ok: true; result: MethodResults[M] } | { ok: false; error: AgentErrorPayload };

export interface IpcContract {
  'agent.call': { args: { method: Method; params?: MethodParams[Method] }; result: AgentCallResult<Method> };
  'conn.state': { args: undefined; result: ConnState };
  'conn.retryNow': { args: undefined; result: void };
  'conn.disconnect': { args: undefined; result: void };
  'conn.passphrase': { args: { passphrase: string }; result: void };
  'conn.trustHost': { args: { accept: boolean }; result: void };
  'conn.log': { args: undefined; result: string[] };
  'conn.debugDrop': { args: undefined; result: void };
  'conn.debugFreeze': { args: undefined; result: void };
  'conn.hosts': { args: undefined; result: SshHostsInfo };
  'settings.get': { args: undefined; result: Settings };
  'settings.set': { args: SettingsPatch; result: Settings };
  'workspace.get': { args: undefined; result: Workspace | null };
  'workspace.save': { args: Workspace; result: void };
  'snapshot.get': { args: undefined; result: Snapshot | null };
  'term.open': { args: TermOpenArgs; result: { ok: true } | { ok: false; error: string } };
  'term.write': { args: { tabId: string; data: string; binary?: boolean }; result: void };
  'term.resize': { args: { tabId: string; cols: number; rows: number }; result: void };
  'term.close': { args: { tabId: string }; result: void };
  'term.ack': { args: { tabId: string; bytes: number }; result: void };
  'clipboard.write': { args: { text: string }; result: void };
  'diag.log': { args: { text: string }; result: void };
  'sound.load': { args: undefined; result: { ok: boolean; path: string; data?: Uint8Array; error?: string } };
  'notify.show': {
    args: { title: string; body: string; session: string; chatId?: string };
    result: { ok: boolean };
  };
  'clipboard.read': { args: undefined; result: string };
  /** upload the clipboard image to the VM; none = the clipboard holds no image */
  'image.pasteClipboard': {
    args: undefined;
    result: { ok: true; path: string } | { ok: false; error: string } | { ok: false; none: true };
  };
  /** Files panel: copy a VM file to the PC (save dialog); cancelled = the user closed the dialog */
  'file.download': {
    args: { path: string };
    result: { ok: true; saved: string } | { ok: false; cancelled: true } | { ok: false; error: string };
  };
  /** Files panel: put a file from the PC into a VM folder; exists = ask before overwriting */
  'file.upload': {
    args: { dir: string; name: string; data: Uint8Array; overwrite?: boolean };
    result: { ok: true; path: string } | { ok: false; exists: true } | { ok: false; error: string };
  };
  /** show a file this app just downloaded in Explorer */
  'file.reveal': { args: { path: string }; result: void };
  /** upload dropped image bytes to the VM */
  'image.upload': {
    args: { data: Uint8Array };
    result: { ok: true; path: string } | { ok: false; error: string };
  };
  'launch.rdp': { args: undefined; result: { ok: boolean; error?: string; notConfigured?: boolean } };
  'launch.vscode': { args: { path: string }; result: { ok: boolean; error?: string } };
  'launch.openExternal': { args: { url: string }; result: void };
  'app.info': { args: undefined; result: AppInfo };
  'app.toggleFullscreen': { args: undefined; result: void };
  /** startup splash shown/hidden: the caption buttons take its background colour */
  'app.splash': { args: { on: boolean }; result: void };
  'app.toggleDevTools': { args: undefined; result: void };
  'pclink.state': { args: undefined; result: PcLinkState };
  'pclink.mount': { args: { dst: string }; result: { ok: boolean; error?: string } };
  'pclink.unmount': { args: { dst: string }; result: { ok: boolean; error?: string } };
  'pclink.reconnect': { args: undefined; result: void };
  'ports.state': { args: undefined; result: ForwardInfo[] };
  'ports.forward': { args: { vmPort: number }; result: PortOpenResult };
  'ports.close': { args: { vmPort: number }; result: void };
  'ports.open': { args: { vmPort: number } | { url: string }; result: PortOpenResult };
  'askpass.pending': { args: undefined; result: AskpassRequest[] };
  'askpass.reply': {
    args: { id: string; password: string | null };
    result: { ok: boolean; error?: string };
  };
  'update.state': { args: undefined; result: UpdateState };
  'update.check': { args: undefined; result: UpdateState };
  'update.install': { args: undefined; result: { ok: boolean } };
}

export type PortOpenResult =
  { ok: true; vmPort: number; localPort: number; url: string } | { ok: false; error: string };

/** Events main -> renderer. */
export interface IpcEvents {
  'conn.state': ConnState;
  'agent.event': { event: string; data: unknown };
  'term.data': { tabId: string; data: Uint8Array };
  'term.exit': { tabId: string; code: number | null; signal: string | null };
  'theme.dark': boolean;
  'settings.changed': Settings;
  'notify.click': { session: string; chatId?: string };
  'pclink.state': PcLinkState;
  'ports.state': ForwardInfo[];
  'update.state': UpdateState;
}
export type IpcEventName = keyof IpcEvents;
export const IPC_EVENTS: readonly IpcEventName[] = IPC_EVENT_NAMES;

export type { TabKind };
