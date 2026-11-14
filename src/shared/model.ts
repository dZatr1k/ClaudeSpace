// Types shared by main and renderer (docs/DESIGN.md §8). The agent sends the same shapes (camelCase).

export type ClaudeStatus = 'busy' | 'waiting' | 'idle' | (string & {}); // unknown values must not break the UI
export type UiStatus = 'busy' | 'waiting' | 'idle' | 'none' | 'error' | 'offline';

export interface ClaudeProc {
  chatId: string;
  status: ClaudeStatus;
  pid: number;
  window: string | null;
  pane: string | null;
  name: string | null;
  statusAt: number;
}

export interface Session {
  name: string;
  attached: number;
  activity: number;
  windows: number;
  path: string;
  command: string;
  claude: ClaudeProc[];
}

export interface ChatOpen {
  session: string | null;
  window: string | null;
  status: ClaudeStatus;
  pid?: number;
}

export interface Chat {
  id: string;
  project: string | null;
  title: string;
  titleSource: 'custom' | 'alias' | 'ai' | 'summary' | 'prompt' | 'none';
  firstPrompt: string | null;
  prompts: number;
  promptsApprox: boolean;
  branch: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  firstAt: number | null;
  lastAt: number;
  sizeBytes: number;
  claudeVersion: string | null;
  archived: boolean;
  open: ChatOpen | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number | null;
}

export interface GitSummary {
  branch: string;
  dirty: boolean;
  aheadBehind: string;
}
export interface GitDetails extends GitSummary {
  changes: { status: string; file: string }[];
  log: { hash: string; subject: string; at: number }[];
}

/** tmux client attached to a session (`tmux list-clients`). */
export interface TmuxClient {
  tty: string;
  term: string;
  activity: number; // ms
  created: number; // ms
  size: string; // '120x40'
}

/** One Claude running in a session: chat + cheap facts from the transcript tail (DESIGN §7.4 session_preview). */
export interface SessionClaudeInfo {
  chatId: string;
  chat: Chat | null; // null: no transcript yet (new chat without prompts)
  lastPrompt: { text: string; at: number | null } | null;
  model: string | null;
  context: { tokens: number; output: number } | null; // usage of the last assistant message
}

export interface SessionDetails {
  session: Session;
  created: number | null; // ms, tmux session_created
  clients: TmuxClient[];
  git: GitSummary | null;
  claude: SessionClaudeInfo[];
}

export interface Project {
  path: string;
  name: string;
  isHome: boolean;
  git: GitSummary | null;
  lastAt: number;
  chatCount: number;
  liveSession: string | null;
  liveStatus: ClaudeStatus | null;
}

export interface Usage {
  ok: boolean;
  block: {
    tokens: number;
    costUsd: number;
    leftMin: number | null;
    models: string[];
    tpm: number | null;
  } | null;
  days: { day: string; tokens: number; costUsd: number }[];
  weekTokens: number;
  at: number;
  error?: string;
}

export interface DoctorField {
  key: string;
  label: string;
  level: 'ok' | 'warn' | 'fail';
  found: number;
  total: number;
  note?: string;
}
export interface Doctor {
  level: 'ok' | 'warn' | 'error';
  claudeVersion: string | null;
  knownGood: string | null;
  problems: string[];
  fields: DoctorField[];
  registry: { live: number; missing: string[] };
  tools: { name: string; ok: boolean; detail: string }[];
  checkedAt: number;
  message?: string;
}

export interface TopProcess {
  pid: number;
  cpu: number;
  mem: number;
  rssMb: number;
  command: string;
}

export interface SystemStats {
  load: [number, number, number];
  cpuPct: number;
  memPct: number;
  memUsedMb: number;
  memTotalMb: number;
  diskPct: number;
  uptimeSec: number;
  claudeVersion: string | null;
  tmuxService: string;
  moshCount: number;
  top?: TopProcess[];
}

export interface DoctorWarning {
  level: 'ok' | 'warn' | 'error';
  message: string;
}

export interface Hello {
  protocol: number;
  agent: string;
  hash: string | null;
  python: string;
  host: string;
  user: string;
  home: string;
  claudeVersion: string | null;
  tmux: string | null;
  capabilities: string[];
  warnings: string[];
}

// ---------------------------------------------------------------- app state
export type ConnStep = 'config' | 'auth' | 'hostkey' | 'agent';
export type NeedsUserReason =
  | 'agent-empty'
  | 'agent-down'
  | 'passphrase'
  | 'hostkey-new'
  | 'hostkey-mismatch'
  | 'auth-rejected'
  | 'config'
  | 'agent-missing-deps';

export type ConnState =
  | { kind: 'idle' }
  | { kind: 'connecting'; step: ConnStep; attempt: number; detail?: string }
  | {
      kind: 'needs-user';
      reason: NeedsUserReason;
      detail?: string;
      fingerprint?: string;
      host?: string;
    }
  | { kind: 'online'; since: number; rttMs: number | null; agent: string; host: string }
  | { kind: 'offline'; since: number; retryAt: number; attempt: number; error: string };

export type TabKind = 'tmux' | 'shell' | 'lazygit' | 'clone' | 'yazi';
export type TermState = 'connecting' | 'live' | 'detached' | 'offline' | 'ended' | 'error' | 'exited';

export interface Tab {
  id: string;
  kind: TabKind;
  session: string | null;
  chatId: string | null;
  cwd: string;
  title: string;
  term: TermState;
  error?: string;
  exitCode?: number | null;
  /** for kind 'clone': destination folder */
  dest?: string;
  /** for kind 'clone': repository URL */
  url?: string;
}

export interface WorkspaceLayout {
  sidebarWidth: number;
  sidebarOpen: boolean;
  rightWidth: number;
  rightOpen: boolean;
  rightTab: 'info' | 'files' | 'git' | 'ports';
  sidebarTab: 'projects' | 'chats' | 'archive';
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Workspace {
  version: 1;
  tabs: Pick<Tab, 'id' | 'kind' | 'session' | 'chatId' | 'cwd' | 'title'>[];
  activeTabId: string | null;
  layout: WorkspaceLayout;
  window: WindowBounds | null;
}

export type Selection =
  { kind: 'session'; name: string } | { kind: 'chat'; id: string } | { kind: 'project'; path: string } | null;

/** Last known lists (userData/cache/snapshot.json): shown greyed out until the first sync. */
export interface Snapshot {
  at: number;
  sessions: Session[];
  chats: Chat[];
  projects: Project[];
  system: SystemStats | null;
  doctor: DoctorWarning | null;
  usage: Usage | null;
  hello: Hello | null;
}
