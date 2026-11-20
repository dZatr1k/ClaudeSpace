// csagent protocol (docs/DESIGN.md §7): methods, params schemas, results, events.
import { z } from 'zod';
import type {
  Chat,
  ChatMessage,
  Doctor,
  DoctorWarning,
  GitDetails,
  Hello,
  Project,
  Session,
  SessionDetails,
  SystemStats,
  Usage,
} from './model';
import type { AskpassDone, AskpassRequest } from './askpass';
import { askpassReplySchema } from './askpass';

export const PROTOCOL = 1;

export const CHAT_ID_RE = /^[0-9a-f-]{36}$/;
export const SESSION_RE = /^[A-Za-z0-9_-]{1,32}$/;

const chatId = z.string().regex(CHAT_ID_RE);
/** model aliases `/model` accepts; the agent has the same list (CLAUDE_MODEL_RE) */
export const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku', 'opusplan', 'sonnet[1m]'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
const session = z.string().regex(SESSION_RE);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes('\0'));
/** id of one app installation (userData/client-id): whose «Диск ПК» mount it is (BACKLOG 13) */
const clientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const empty = z.object({}).strict();

export const methodSchemas = {
  ping: empty,
  list_active: empty,
  list_chats: z
    .object({ archived: z.boolean().optional(), limit: z.number().int().positive().optional() })
    .strict(),
  list_projects: z.object({ git: z.boolean().optional() }).strict(),
  list_dirs: empty,
  chat_preview: z.object({ chatId, messages: z.number().int().min(1).max(50).optional() }).strict(),
  project_preview: z.object({ path }).strict(),
  session_preview: z.object({ session }).strict(),
  new_session: z
    .object({
      cwd: path,
      resume: chatId.optional(),
      name: z.string().min(1).max(64).optional(),
      command: z.literal('claude').optional(),
    })
    .strict(),
  focus_window: z.object({ session, window: z.string().regex(/^[0-9]{1,4}$/) }).strict(),
  rename_session: z.object({ session, name: z.string().min(1).max(64) }).strict(),
  kill_session: z.object({ session }).strict(),
  archive_chat: z.object({ chatId }).strict(),
  restore_chat: z.object({ chatId }).strict(),
  rename_chat: z.object({ chatId, title: z.string().max(200).nullable() }).strict(),
  create_project: z.object({ path, gitInit: z.boolean().optional() }).strict(),
  usage: z.object({ maxAge: z.number().int().min(0).max(86400).optional() }).strict(),
  usage_report: z
    .object({
      days: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional(),
      maxAge: z.number().int().min(0).max(86400).optional(),
    })
    .strict(),
  doctor: z.object({ full: z.boolean().optional() }).strict(),
  system: z.object({ top: z.boolean().optional() }).strict(),
  mosh_list: empty,
  mosh_kill_stale: empty,
  resync: empty,
  // «Диск ПК» / reverse tunnel (BACKLOG 12): called by main (pclink.ts) only, not from the renderer
  winfs_status: empty,
  winfs_mount: z.object({ src: z.string().min(1).max(260), dst: path, client: clientId.optional() }).strict(),
  winfs_unmount: z
    .object({
      dst: path,
      onlyOwned: z.boolean().optional(),
      lazy: z.boolean().optional(),
      client: clientId.optional(),
    })
    .strict(),
  pc_tunnel_status: z
    .object({ port: z.number().int().min(1024).max(65535).optional(), banner: z.boolean().optional() })
    .strict(),
  list_ports: empty,
  // full-text search in chat transcripts (stage 6): results stream as search_hits / search_done events
  search_chats: z
    .object({
      searchId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(200).optional(),
      budgetSec: z.number().int().min(1).max(60).optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  search_cancel: z
    .object({
      searchId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/)
        .optional(),
    })
    .strict(),
  // sudo prompts in the app (BACKLOG 11): main only; the reply carries the password (never logged)
  askpass_enable: z.object({ enabled: z.boolean() }).strict(),
  askpass_reply: askpassReplySchema,
  // Files and Git panels (stage 5): read-only; uploads/downloads ask for a validated path, main copies over SFTP
  fs_list: z.object({ path }).strict(),
  fs_read: z.object({ path }).strict(),
  fs_upload_target: z.object({ dir: path, name: z.string().min(1).max(255) }).strict(),
  fs_download_source: z.object({ path }).strict(),
  git_status: z.object({ path }).strict(),
  git_diff: z
    .object({ path, file: path, staged: z.boolean().optional(), untracked: z.boolean().optional() })
    .strict(),
  git_log: z.object({ path, limit: z.number().int().min(1).max(200).optional() }).strict(),
  git_show: z.object({ path, hash: z.string().regex(/^[0-9a-f]{7,40}$/) }).strict(),
  // quick actions for a running chat: a fixed command typed into its Claude pane (no free text)
  // parallel tasks in git worktrees (<main>/.claude/worktrees/<name>)
  git_worktrees: z.object({ path }).strict(),
  worktree_create: z
    .object({ path, branch: z.string().min(1).max(60), base: z.string().min(1).max(60).optional() })
    .strict(),
  worktree_remove: z
    .object({ path, worktree: path, force: z.boolean().optional(), deleteBranch: z.boolean().optional() })
    .strict(),
  // the «Claude» screen: overview (secrets stay in the agent) and edits of CLAUDE.md / memory notes only
  claude_config: z.object({ path: path.optional() }).strict(),
  claude_doc_write: z
    .object({ path, text: z.string().max(512 * 1024), mtime: z.number().int().min(0).nullable() })
    .strict(),
  /** the phone scrolls a session's history in tmux copy-mode (its terminal keeps none) */
  pane_scroll: z
    .object({
      session,
      action: z.enum(['up', 'down', 'cancel']),
      lines: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  claude_send: z.discriminatedUnion('action', [
    z.object({ chatId, action: z.enum(['interrupt', 'compact', 'clear']) }).strict(),
    z.object({ chatId, action: z.literal('model'), model: z.enum(CLAUDE_MODELS) }).strict(),
  ]),
} as const;

/** Methods only main may call (they keep state in main: mount ownership, tunnel). */
export const MAIN_ONLY_METHODS: readonly string[] = [
  'winfs_status',
  'winfs_mount',
  'winfs_unmount',
  'pc_tunnel_status',
  'askpass_enable',
  'askpass_reply',
  // the renderer goes through main's file.upload / file.download, which validate first and copy over SFTP
  'fs_upload_target',
  'fs_download_source',
];

export type Method = keyof typeof methodSchemas;
export const METHODS = Object.keys(methodSchemas) as Method[];

export type MethodParams = { [M in Method]: z.input<(typeof methodSchemas)[M]> };

export interface MethodResults {
  ping: { now: number };
  list_active: { sessions: Session[] };
  list_chats: { chats: Chat[] };
  list_projects: { projects: Project[] };
  list_dirs: { dirs: string[] };
  chat_preview: { chat: Chat; tail: ChatMessage[] };
  project_preview: { project: Project; git: GitDetails | null; hasClaudeMd: boolean; entries: string[] };
  session_preview: SessionDetails;
  new_session: { session: string; window: string };
  focus_window: Record<string, never>;
  rename_session: { session: string };
  kill_session: Record<string, never>;
  archive_chat: { chat: Chat };
  restore_chat: { chat: Chat };
  rename_chat: { chat: Chat };
  create_project: { project: Project };
  usage: Usage;
  usage_report: UsageReport;
  doctor: Doctor;
  system: SystemStats;
  mosh_list: { servers: { pid: number; ageSec: number; current: boolean }[] };
  mosh_kill_stale: { killed: number };
  resync: Record<string, never>;
  winfs_status: { mounts: WinfsMount[]; sshfs: boolean; winfs: boolean };
  winfs_mount: { dst: string; src: string; owned: boolean; already: boolean; other?: boolean };
  winfs_unmount: { dst: string; unmounted: boolean; skipped?: 'manual' | 'other' | 'not_mounted' };
  pc_tunnel_status: { port: number; listening: boolean; banner: boolean | null };
  list_ports: { ports: VmPort[] };
  search_chats: { searchId: string };
  search_cancel: { cancelled: boolean };
  askpass_enable: { enabled: boolean; listening: boolean; socket: string };
  askpass_reply: Record<string, never>;
  fs_list: { path: string; entries: FsEntry[]; truncated: boolean };
  fs_read: FsFile;
  fs_upload_target: { path: string; exists: boolean };
  fs_download_source: { path: string; size: number };
  git_status: GitStatus;
  git_diff: { root: string; file: string; diff: string; truncated: boolean; binary: boolean };
  git_log: { root: string | null; commits: GitCommit[] };
  git_show: { root: string; hash: string; diff: string; truncated: boolean };
  claude_send: { pane: string; status: string; stashed?: boolean };
  pane_scroll: { inMode: boolean };
  claude_config: ClaudeConfig;
  git_worktrees: { main: string; current: string | null; worktrees: GitWorktree[] };
  worktree_create: { path: string; branch: string; base: string | null; created: boolean };
  worktree_remove: {
    path: string;
    removed: boolean;
    branch: string | null;
    branchDeleted: boolean;
    branchKept?: string;
  };
  claude_doc_write: { path: string; size: number; mtime: number };
}

/** one entry of a folder listing (Files panel); ~/.ssh and Claude's secrets never appear */
export interface FsEntry {
  name: string;
  type: 'dir' | 'file' | 'other';
  size: number;
  mtime: number;
  hidden: boolean;
  link: boolean;
}

export type FsFile = { path: string; size: number; mtime: number } & (
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'binary'; reason?: 'too_large' }
);

export type GitChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'conflict';

export interface GitFile {
  path: string;
  orig: string | null;
  staged: GitChange | null;
  unstaged: GitChange | null;
  untracked: boolean;
  conflict: boolean;
}

export type GitStatus =
  | { root: null }
  | {
      root: string;
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      files: GitFile[];
      truncated: boolean;
    };

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  at: number;
}

/** a TCP port some process of the user listens on, on the VM (BACKLOG 10) */
export interface VmPort {
  port: number;
  /** 127.0.0.1, 0.0.0.0, ::1, :: */
  addr: string;
  pid: number | null;
  /** process name: vite, http.server, node… */
  name: string | null;
  cwd: string | null;
  /** ~/projects/<name> the process runs in */
  project: string | null;
  projectPath: string | null;
  /** the kernel picked the port (listen on 0: test runners, helpers), not a dev server on a fixed port */
  ephemeral?: boolean;
}

/** an sshfs mount inside the VM home; owned = mounted by ClaudeSpace (agent), not by hand; client = which app
 * installation mounted it (BACKLOG 13), null for a mount made by an older version */
export interface WinfsMount {
  dst: string;
  src: string;
  owned: boolean;
  client?: string | null;
}

/** «Расход» charts (cclib/usage.py build_report): tokens include cache reads, as ccusage counts them */
export interface UsageDay {
  day: string;
  tokens: number;
  costUsd: number;
  models: Record<string, number>;
}
export interface UsageBlock {
  start: number;
  end: number;
  tokens: number;
  costUsd: number;
  active: boolean;
}
export type UsageReport =
  | {
      ok: true;
      days: number;
      daily: UsageDay[];
      /** top projects by tokens; folder null = the rest («другие») */
      projects: {
        folder: string | null;
        label: string | null;
        tokens: number;
        costUsd: number;
        chats: number;
      }[];
      models: { name: string; tokens: number; costUsd: number }[];
      blocks: UsageBlock[];
      active:
        | (UsageBlock & {
            tpm: number | null;
            costPerHour: number | null;
            leftMin: number;
            projectedTokens: number | null;
            projectedCostUsd: number | null;
            models: string[];
          })
        | null;
      totalTokens: number;
      totalCostUsd: number;
      at: number;
    }
  | { ok: false; days: number; error: string; at: number };

/** a linked worktree of a repo (not the main checkout); ours = under .claude/worktrees; dirty = changed files */
export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: number | null;
  sessions: string[];
  ours: boolean;
}

/** The «Claude» screen (cclib/claudecfg.py). MCP: only name, type, command + package or URL host, env count. */
export interface ClaudeDoc {
  scope: 'user' | 'project' | 'local' | 'parent';
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
}
export interface ClaudeMemoryFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
  title?: string | null;
  description?: string | null;
  type?: string | null;
}
export interface ClaudeMemoryGroup {
  dir: string;
  label: string;
  folder: string | null;
  current: boolean;
  files: ClaudeMemoryFile[];
}
export interface ClaudeMcp {
  name: string;
  scope: 'user' | 'local' | 'project';
  source: string;
  type: string;
  target: string;
  env: number;
}
export interface ClaudeSkill {
  name: string;
  description: string;
  scope: 'user' | 'project' | 'plugin';
  plugin: string | null;
  path: string;
}
export interface ClaudePlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  path: string | null;
  updatedAt: string;
}
export interface ClaudeHook {
  event: string;
  matcher: string;
  type: string;
  command: string;
  timeout: number | null;
  async: boolean;
  scope: 'user' | 'project' | 'plugin';
  plugin: string | null;
  source: string;
}
export interface ClaudeConfig {
  folder: string | null;
  root: string | null;
  instructions: ClaudeDoc[];
  memory: ClaudeMemoryGroup[];
  mcp: ClaudeMcp[];
  skills: ClaudeSkill[];
  plugins: ClaudePlugin[];
  hooks: ClaudeHook[];
}

/** Request timeouts (ms): 10 s, long ones 30–60 s (DESIGN §9 rpc.ts). */
export function methodTimeout(m: Method): number {
  if (m === 'doctor' || m === 'usage') return 60_000;
  if (m === 'winfs_mount') return 45_000;
  if (m === 'winfs_unmount') return 20_000;
  if (
    m === 'list_projects' ||
    m === 'project_preview' ||
    m === 'create_project' ||
    m === 'system' ||
    m === 'worktree_create' ||
    m === 'usage_report' ||
    m === 'worktree_remove'
  )
    return 30_000;
  return 10_000;
}

export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'exists'
  | 'chat_open'
  | 'not_allowed'
  | 'busy'
  | 'conflict'
  | 'dirty'
  | 'tmux_error'
  | 'timeout'
  | 'too_large'
  | 'internal'
  | 'offline'
  | 'closed';

export interface AgentErrorPayload {
  code: ErrorCode | (string & {});
  message: string;
  data?: unknown;
}

export interface AgentEvents {
  hello: Hello;
  active_changed: { sessions: Session[] };
  session_status: { session: string | null; chatId: string; status: string; prev: string | null; at: number };
  chats_changed: { full?: Chat[]; upsert?: Chat[]; remove?: string[] };
  projects_changed: { full: Project[] };
  system: SystemStats;
  doctor_warning: DoctorWarning;
  /** from the user's Claude Code hook (Stop / Notification): a turn finished or Claude needs input */
  turn_done: TurnDone;
  winfs_changed: { mounts: WinfsMount[] };
  ports_changed: { ports: VmPort[] };
  askpass_request: AskpassRequest;
  askpass_done: AskpassDone;
  search_hits: { searchId: string; hits: SearchHit[] };
  search_done: SearchDone;
}

/** a chat with matches of a full-text search (stage 6) */
export interface SearchHit {
  chatId: string;
  title: string;
  project: string | null;
  lastAt: number;
  archived: boolean;
  /** matches in this chat (snippets: at most 3) */
  count: number;
  matches: SearchMatch[];
}

export interface SearchMatch {
  role: 'user' | 'assistant';
  /** one line around the match, with … where cut */
  text: string;
  /** [start, end) of the match in text */
  match: [number, number];
  at: number | null;
}

export interface SearchDone {
  searchId: string;
  scanned: number;
  total: number;
  found: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  ms: number;
}

export interface TurnDone {
  ts: number;
  kind: 'done' | 'input';
  chatId: string | null;
  /** tmux session the chat runs in, if any */
  session: string | null;
  cwd: string | null;
  project: string | null;
  /** first line of Claude's answer (done) or the hook message (input) */
  body: string;
}
export type AgentEventName = keyof AgentEvents;
export type AgentEvent = { [K in AgentEventName]: { event: K; data: AgentEvents[K] } }[AgentEventName];

export const KNOWN_EVENTS: readonly AgentEventName[] = [
  'hello',
  'active_changed',
  'session_status',
  'chats_changed',
  'projects_changed',
  'system',
  'doctor_warning',
  'turn_done',
  'winfs_changed',
  'ports_changed',
  'askpass_request',
  'askpass_done',
  'search_hits',
  'search_done',
];

export function validateParams<M extends Method>(method: M, params: unknown): MethodParams[M] {
  return methodSchemas[method].parse(params ?? {}) as MethodParams[M];
}
