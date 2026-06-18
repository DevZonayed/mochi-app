/* Maestro desktop — data client.

   In the ELECTRON APP every call routes over IPC to the local Maestro core in
   the main process: data + execution live on this Mac (Claude Code login, local
   store, local engine). In a BROWSER (the hosted web build) the same surface
   falls back to REST against the relay server, which mirrors the Mac's pushed
   state and forwards commands to it — the web app is a remote control. */

import type { SessionGitStatus, GithubConnection } from './git-types';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type ProjectKind = 'coding' | 'design' | 'content' | 'research' | 'general';

export interface Workspace {
  id: string;
  name: string;
  budgetCap: number;
  createdAt: number;
}
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  template: string;
  instructions: string;
  color: string;
  kind?: ProjectKind;
  path?: string;
  repoUrl?: string;
  /** Manual display order from drag-and-drop. Lower = earlier. */
  order?: number;
  createdAt: number;
}
export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  sdkSessionId?: string;
  pinned?: boolean;
  /** Archived (hidden from the active chat list, restorable). Timestamp it was archived; absent = active. */
  archived?: number;
  primary?: RoleChoice;
  reviewer?: RoleChoice | 'off';
  /** Set when this chat was imported from an external store (read-only history). */
  importedFrom?: ConvSource;
  externalId?: string;
  createdAt: number;
  updatedAt: number;
}
export type ConvSource = 'claude' | 'codex' | 'conductor';
/** A past conversation found on disk (Claude/Codex/Conductor) for a project. */
export interface ScannedConversation {
  source: ConvSource;
  externalId: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  filePath?: string;
  /** Already imported into this project (re-scan dedupe). */
  imported?: boolean;
}
export interface ConversationScan {
  available: Record<ConvSource, boolean>;
  path: string;
  conversations: ScannedConversation[];
}
export interface TranscriptItem {
  kind: 'text' | 'tool' | 'result' | 'ask' | 'review' | 'image';
  text: string;
  name?: string;
  toolStatus?: 'running' | 'done' | 'error';
  verdict?: 'approved' | 'needs-work';
  /** review only: the primary fixed the flagged findings → show as resolved. */
  resolved?: boolean;
  durMs?: number;
  /** file-writing tools only: capped snapshot of the written content (hover preview). */
  preview?: string;
  ask?: string;
  /** image only: the Asset id (resolved to bytes on the Mac via api.assetImage; never sent to the relay). */
  assetId?: string;
  /** image only: absolute Mac-local path (reveal-in-Finder/copy; stripped from the relay snapshot). */
  imagePath?: string;
  /** image only: alt text / the generation prompt. */
  alt?: string;
  width?: number;
  height?: number;
  ts: number;
}
/** An image attached to a user message (pasted/dropped/picked) — vision input.
    imagePath is Mac-local (stripped from the relay snapshot); the bytes are
    resolved on the desktop via api.assetImage(assetId). */
export interface ChatImage { assetId: string; imagePath?: string; mime: string; name?: string; width?: number; height?: number }

/** A non-image file attached to a message — text inlined for the agent, other
    files saved on the Mac. content/path are stripped from the relay snapshot. */
export interface ChatFile { name: string; kind: 'text' | 'file'; mime?: string; bytes?: number; content?: string; path?: string; preview?: string }

export interface Job {
  id: string;
  projectId: string;
  title: string;
  status: JobStatus;
  phase: string;
  progress: number;
  sessionId?: string;
  transcript?: TranscriptItem[];
  inputImages?: ChatImage[];
  inputFiles?: ChatFile[];
  input: string;
  output: string | null;
  error: string | null;
  effort: Effort;
  cost: number;
  tokens: number;
  stage: string;
  engine?: EngineId;
  model?: string;
  goal?: boolean;
  createdAt: number;
  updatedAt: number;
}
/** A long-lived process the agent started (a dev server, watcher, …) that outlives the
    chat turn. Tracked + stoppable; streamed live over the 'bg' event. */
export interface BgTask {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'stopped' | 'failed';
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
}
export interface Approval {
  id: string;
  projectId: string | null;
  kind: ApprovalKind;
  title: string;
  subtitle: string;
  detail: string;
  status: ApprovalStatus;
  jobId?: string | null;
  createdAt: number;
  resolvedAt: number | null;
}
export interface Schedule {
  id: string;
  projectId: string | null;
  title: string;
  time: string;
  cadence: string;
  enabled: boolean;
  nextRun: number | null;
  createdAt: number;
  fireAt?: number;
  sessionId?: string;
  prompt?: string;
  /** A user-scheduled chat message, an auto-continue queued when a Claude run is
      blocked by the usage limit, or an auto-answer countdown for an unanswered
      AskUserQuestion (fires the recommended option into the chat on timeout). */
  kind?: 'message' | 'auto-continue' | 'auto-answer';
  effort?: Effort;
  browser?: boolean;
  plan?: boolean;
  goal?: boolean;
  /** auto-answer only: armed time (base for the escalating-extend math), extend
      count, and whether it's paused past the 30-min cap (waits for a manual reply). */
  armedAt?: number;
  extends?: number;
  paused?: boolean;
  /** Interval cadence (every N minutes) — when set, fires on an interval, not a clock time. */
  everyMinutes?: number;
  /** Clock-mode catch-up: fire a missed daily/weekly slot later the same day. */
  catchUp?: boolean;
  /** True when the most recent fire was a late catch-up (drives the "ran late" notice). */
  lastFireLate?: boolean;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: string;
  version: string;
  enabled: boolean;
  createdAt: number;
}
/** A skill from the remote registry (curated/secure index scraped from skills.sh). */
export interface RegistrySkillSummary {
  id: string; name: string; description: string; tags: string[]; license: string;
  risk: string; source: string; directory: string; installCmd: string; rank: number;
  enabled?: boolean; disabledReason?: string | null; version?: string; sha256?: string | null;
  sourceRepo?: string | null; sourceStatus?: string | null;
  mirrorRepo?: string | null; forkStatus?: string | null; lastSyncAt?: string | null; auditStatus?: string | null;
}
/** A registry skill installed into a project (files in <project>/.claude/skills/). */
export interface InstalledSkill {
  id: string; slug: string; name: string; description?: string; risk?: string; source?: string;
  version?: string; sha256?: string; enabled?: boolean; disabledReason?: string | null;
  mirrorRepo?: string | null; auditStatus?: string | null; addedBy?: 'operator' | 'agent'; installedAt: number;
}
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  engine: string;
  createdAt: number;
}
/** A literal key/value pair — an env var or an HTTP header. */
export interface McpKv { key: string; value: string }
/** A custom MCP server connected via Settings → MCP servers (a Mac-local library).
    Secrets are referenced by env-var name (bearerTokenEnv / envPassthrough /
    headerEnv) and resolved on the Mac at spawn time — never stored. */
export interface CustomMcpServer {
  id: string; name: string; enabled: boolean; transport: 'stdio' | 'http';
  command?: string; args?: string[]; env?: McpKv[]; envPassthrough?: string[]; cwd?: string;
  url?: string; bearerTokenEnv?: string; headers?: McpKv[]; headerEnv?: { key: string; valueEnv: string }[];
  skillIds: string[]; createdAt: number;
}
/** Form payload for creating/updating a custom MCP server (no id/createdAt). */
export type McpServerInput = Omit<CustomMcpServer, 'id' | 'createdAt'>;
export interface BudgetData {
  cap: number;
  spent: number;
  byProject: { projectId: string; name: string; color: string; spent: number }[];
}
export type ProviderId = 'anthropic' | 'openai' | 'fal' | 'github';
export interface ProviderConn {
  provider: ProviderId;
  method: 'subscription' | 'apiKey';
  status: string;
  detail: string;
  keyLast4?: string;
  createdAt: number;
}
export type EngineId = 'claude' | 'codex';
export interface RoleChoice { engine: EngineId; model?: string }
export interface Roles {
  primary: RoleChoice;
  reviewer: RoleChoice | 'off';
}
export interface Routing {
  master: EngineId;
  reviewer: EngineId | 'off';
  image: EngineId;
  video: EngineId;
  roles?: Roles;
}
export type ModelProviderId = 'claude' | 'codex' | 'cursor';
export interface ModelDescriptor {
  key: string;
  id: string;
  label: string;
  provider: ModelProviderId;
  family?: string;
  badge?: 'NEW';
  tierNote?: string;
  external?: boolean;
}
export interface ModelGroup {
  provider: ModelProviderId;
  label: string;
  runnable: boolean;
  reason: string;
  models: ModelDescriptor[];
}
export interface DevicePresence { connected: boolean; streams: number; lastSeen: number | null; name: string | null }
/** Whether the `gh` CLI is available (system or our managed download). */
export interface GhState { installed: boolean; source: 'system' | 'managed' | 'none'; version: string | null; path: string | null; supported: boolean }
/** Live frames during a GitHub OAuth sign-in: downloading gh, then the one-time code. */
export type GithubDevice =
  | { stage: 'downloading-cli'; pct: number }
  | { stage: 'code'; userCode: string; verificationUri: string };
export interface PairingInfo {
  token: string;
  relayUrl: string;
  /** Live remote-device presence (phone/web), reported by the relay. */
  devices?: DevicePresence;
}
export type AppEventKind =
  | 'job-done' | 'job-failed' | 'job-cancelled'
  | 'approval-created' | 'approval-resolved'
  | 'schedule-fired' | 'clone-done' | 'clone-failed'
  | 'research' | 'publish' | 'comm' | 'asset';
export interface AppEvent {
  id: string;
  ts: number;
  kind: AppEventKind;
  title: string;
  subtitle?: string;
  projectId?: string | null;
  jobId?: string | null;
}
/** A built-in notification chime (synthesised client-side; 'none' = silent). */
export type NotificationSound = 'chime' | 'ping' | 'marimba' | 'glass' | 'pop' | 'none';
/** Device-notification preferences (sounds play in the client via Web Audio). */
export interface NotificationSettings {
  enabled: boolean;
  onComplete: boolean;
  completeSound: NotificationSound;
  onAttention: boolean;
  attentionSound: NotificationSound;
  volume: number;
  onlyWhenUnfocused: boolean;
}
export interface AppSettings {
  defaultEffort: Effort;
  defaultEngine: EngineId | 'auto';
  openAtLogin: boolean;
  rescanCadence: 'daily' | 'weekly' | 'onchange';
  favoriteModels?: string[];
  /** Target repo ("owner/repo") feedback is escalated to as GitHub issues. */
  feedbackRepo?: string;
  /** Device-notification sound preferences. */
  notifications?: NotificationSettings;
}

export type FeedbackCategory = 'bug' | 'idea' | 'other';
export type FeedbackStatus = 'new' | 'triaged' | 'done';
export type FeedbackSource = 'desktop' | 'web' | 'phone';
export interface FeedbackContext { screen?: string; appVersion?: string; platform?: string; projectId?: string | null }
export interface Feedback {
  id: string;
  category: FeedbackCategory;
  message: string;
  status: FeedbackStatus;
  source: FeedbackSource;
  context?: FeedbackContext;
  issueUrl?: string;
  issueNumber?: number;
  createdAt: number;
  updatedAt: number;
}
/** Per-project .continuum memory: the durable STATE + checkpoint chain (newest first). */
export interface ProjectMemory { state: string; checkpoints: { id: number; summary: string }[] }
/** A note anchored to a specific element of a live design (by CSS selector). */
export interface DesignComment {
  id: string;
  projectId: string;
  selector: string;
  label: string;
  note: string;
  status: 'open' | 'resolved';
  createdAt: number;
}
/** A connected Chrome profile on the local browser-extension control channel. */
export interface ExtensionPeer { clientId: string; profile: string; active: boolean }
export interface ExtensionStatus { running: boolean; port: number; token: string; peers: ExtensionPeer[] }
export interface CostsData {
  today: number;
  thisMonth: number;
  projectedMonth: number;
  byDay: { day: string; total: number }[];
  byProject: { projectId: string; name: string; color: string; total: number; jobs: number }[];
  byEngine: { engine: string; total: number; jobs: number; tokens: number }[];
  includedCodexRuns: number;
  claudeRuns: number;
}
export interface DashboardData {
  workspace: Workspace | null;
  greetingProjects: { id: string; name: string; color: string }[];
  gates: Approval[];
  activeJobs: Job[];
  recentlyCompleted: Job[];
  schedule: Schedule[];
  budget: BudgetData;
}
export interface EngineStatus {
  engine: EngineId;
  available: boolean;
  method: 'subscription' | 'apiKey' | 'none';
  detail: string;
  reason: string;
}
export type EngineStatuses = Record<EngineId, EngineStatus>;
export type AssetKind = 'image' | 'video' | 'audio' | 'voiceover' | 'other';
export type AssetStage = 'broll' | 'avatar' | 'voice' | 'music';
export type AssetStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled' | 'approved';
export interface Asset {
  id: string;
  projectId: string | null;
  source: 'generated' | 'import';
  kind: AssetKind;
  stage?: AssetStage;
  prompt?: string;
  model?: string;
  status: AssetStatus;
  url?: string;
  localPath?: string;
  name?: string;
  bytes?: number;
  tint?: string;
  cost: number;
  durationS?: number;
  width?: number;
  height?: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MediaRate { key: string; label: string; kind: AssetKind; stage: AssetStage; rate: number; perSecond?: boolean; blurb: string }
export interface Brief {
  id: string; topic: string; headline: string; hook: string; titles: string[]; platforms: string[];
  confidence: number; sources: string[]; status: 'ready' | 'sent-to-studio' | 'raw'; jobId: string; createdAt: number;
}
export interface ResearchRun { id: string; topic: string; jobId: string; status: 'running' | 'done' | 'failed'; briefCount: number; at: number }
export type PublishStatus = 'draft' | 'approved' | 'scheduled' | 'exported' | 'published-manual';
export interface PublishDraft {
  id: string; assetId: string; caption: string; platforms: string[]; scheduledAt: number | null;
  status: PublishStatus; provenance: string; exportedPaths: string[]; createdAt: number; updatedAt: number;
}
export interface PublishLedgerRow { id: string; draftId: string; at: number; platforms: string[]; action: 'exported' | 'published-manual'; ok: boolean; hash: string; paths: string[] }
export interface ChatPermissions { startJobs: boolean; receiveReports: boolean; approveGates: boolean }
export interface ChatBinding { chatId: string; name: string; kind: 'dm' | 'group'; projectId: string | null; permissions: ChatPermissions; boundAt: number }
export interface PendingChat { chatId: string; name: string; kind: 'dm' | 'group'; firstText: string; at: number }
export interface CommEvent { id: string; dir: 'in' | 'out'; chatId: string; chatName: string; payload: string; status: 'received' | 'sent' | 'failed'; at: number }
export interface CommsStatus {
  telegram: { connected: boolean; botUsername: string | null; tokenLast4: string | null; messagesToday: number; bindings: number; pending: number };
  whatsapp: { connected: false };
}
export interface RepoInfo { branch: string | null; remote: string | null; isRepo: boolean }
export interface FolderInspect { ok: boolean; path: string; info: RepoInfo; error?: string }
export type CloneEvent =
  | { phase: 'start'; url: string }
  | { phase: 'progress'; line: string }
  | { phase: 'done'; projectId: string; dir: string; branch: string | null }
  | { phase: 'failed'; error: string };

const RAW_BASE =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE ??
  'https://api.nexalance.cloud';

/** Relay server base URL (browser fallback only; no trailing slash). */
export const API_BASE = RAW_BASE.replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ── Local core bridge (Electron) ─────────────────────────────────────── */
interface Bridge {
  localEngine?: boolean;
  call?: (method: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  onEvent?: (cb: (e: { name: string; data: unknown }) => void) => () => void;
  pickFolder?: () => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  revealPath?: (p: string) => Promise<{ ok: boolean; error?: string }>;
  importAsset?: (projectId: string | null) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  assetImage?: (assetId: string) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  readFile?: (projectId: string, p: string) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  listDir?: (projectId: string, p?: string) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  listProjectFiles?: (projectId: string) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  runCommand?: (projectId: string, command: string) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  killCommand?: (runId: string) => Promise<{ ok: boolean }>;
  onCmdOutput?: (cb: (p: CmdOutput) => void) => () => void;
}
export interface DirEntry { name: string; path: string; kind: 'file' | 'dir' | 'other' }
export interface CmdOutput { runId: string; stream: 'out' | 'err' | 'exit' | string; chunk: string; code?: number }
const bridge: Bridge | undefined =
  typeof window !== 'undefined' ? (window as unknown as { maestro?: Bridge }).maestro : undefined;

/** True when running inside the desktop app (local core owns everything). */
export const IS_LOCAL = Boolean(bridge?.call);

/* ── Remote pairing token (browser builds only) ───────────────────────
   The relay requires the Mac's pairing token on every /api/* call. Web
   remotes pick it up from ?token=… once (then it's persisted + stripped)
   or from localStorage; it rides as a Bearer header / SSE query param. */
const TOKEN_KEY = 'maestro.remote.token';
function bootstrapRemoteToken(): string {
  if (IS_LOCAL || typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl.trim());
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.toString());
    }
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
let remoteToken = bootstrapRemoteToken();
export function getRemoteToken(): string { return remoteToken; }
export function setRemoteToken(token: string): void {
  remoteToken = token.trim();
  try { localStorage.setItem(TOKEN_KEY, remoteToken); } catch { /* storage unavailable */ }
}

const REGISTRY_ADMIN_TOKEN_KEY = 'maestro.registry.admin.token';
export function getRegistryAdminToken(): string {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(REGISTRY_ADMIN_TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setRegistryAdminToken(token: string): void {
  try { localStorage.setItem(REGISTRY_ADMIN_TOKEN_KEY, token.trim()); } catch { /* storage unavailable */ }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects the empty body (FST_ERR_CTP_EMPTY_JSON_BODY) on bodyless POSTs.
  const hasBody = init?.body != null;
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(remoteToken ? { authorization: `Bearer ${remoteToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function reqRegistryAdmin<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getRegistryAdminToken();
  const hasBody = init?.body != null;
  return req<T>(path, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

/** Route to the local core when in Electron, otherwise run the REST fallback. */
async function call<T>(method: string, params: Record<string, unknown>, rest: () => Promise<T>): Promise<T> {
  if (bridge?.call) {
    const r = await bridge.call(method, params);
    if (r.ok) return r.data as T;
    throw new ApiError(r.status ?? 500, r.error ?? 'failed');
  }
  return rest();
}

const qp = (params: Record<string, string | undefined>): string => {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  return q ? `?${q}` : '';
};

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
  currentVersion: string;
  channel: 'stable' | 'beta';
  canInstall: boolean;      // win/linux + signed mac: can restart-to-install
  manualDownload: boolean;  // mac-unsigned: open the download page instead
  releasesUrl: string;
  platform: string;
}
export interface UpdateNotes { version: string; notes: string; url: string }

// Engine binaries (native CLIs) downloaded on demand rather than bundled.
export type EngineKind = 'codex' | 'claude';
export interface EngineState {
  id: EngineKind;
  installed: boolean;
  source: 'managed' | 'system' | 'none';
  version: string | null;
  path: string | null;
  supported: boolean;
}
export interface EngineDownloadProgress {
  engine: EngineKind;
  phase: 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'done' | 'error';
  received?: number;
  total?: number;
  pct?: number;
}

const updateUnavailable = (): Promise<never> => Promise.reject(new ApiError(501, 'Updates run in the desktop app'));

export const api = {
  base: API_BASE,
  health: () =>
    call('health', {}, () => req<{ ok: boolean; name: string; version: string; engine: string }>('/health')),

  // Aggregates
  dashboard: (workspaceId?: string) =>
    call<DashboardData>('dashboard', { workspaceId }, () => req<DashboardData>('/api/dashboard' + qp({ workspaceId }))),
  budget: (workspaceId?: string) =>
    call<BudgetData>('budget', { workspaceId }, () => req<BudgetData>('/api/budget' + qp({ workspaceId }))),
  costs: () => call<CostsData>('costs', {}, () => req<CostsData>('/api/costs')),
  listEvents: () => call<AppEvent[]>('listEvents', {}, () => req<AppEvent[]>('/api/events')),
  engineStatus: () => call<EngineStatuses>('engineStatus', {}, () => req<EngineStatuses>('/api/engine-status')),

  // Settings
  getSettings: () => call<AppSettings>('getSettings', {}, () => req<AppSettings>('/api/settings')),
  setSettings: (patch: Partial<AppSettings>) =>
    call<AppSettings>('setSettings', { ...patch }, () =>
      req<AppSettings>('/api/settings', { method: 'POST', body: JSON.stringify(patch) })),

  // Workspaces
  listWorkspaces: () => call<Workspace[]>('listWorkspaces', {}, () => req<Workspace[]>('/api/workspaces')),
  createWorkspace: (name: string, budgetCap?: number) =>
    call<Workspace>('createWorkspace', { name, budgetCap }, () =>
      req<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, budgetCap }) })),
  setBudgetCap: (workspaceId: string, cap: number) =>
    call<{ ok: boolean; cap: number }>('setBudgetCap', { workspaceId, cap }, () =>
      req<{ ok: boolean; cap: number }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/budget`, { method: 'POST', body: JSON.stringify({ cap }) })),

  // Projects
  listProjects: (workspaceId?: string) =>
    call<Project[]>('listProjects', { workspaceId }, () => req<Project[]>('/api/projects' + qp({ workspaceId }))),
  createProject: (input: { name: string; workspaceId?: string; template?: string; instructions?: string; color?: string; kind?: ProjectKind; path?: string; repoUrl?: string }) =>
    call<Project>('createProject', { ...input }, () =>
      req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) })),
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'instructions' | 'color' | 'kind' | 'path' | 'repoUrl' | 'template'>>) =>
    call<Project>('updateProject', { id, ...patch }, () =>
      req<Project>(`/api/projects/${encodeURIComponent(id)}/update`, { method: 'POST', body: JSON.stringify(patch) })),
  reorderProjects: (ids: string[]) =>
    call<Project[]>('reorderProjects', { ids }, () =>
      req<Project[]>('/api/projects/reorder', { method: 'POST', body: JSON.stringify({ ids }) })),
  getProject: (id: string) =>
    call<Project>('getProject', { id }, () => req<Project>(`/api/projects/${encodeURIComponent(id)}`)),
  // Per-project .continuum memory (STATE.md + checkpoint chain).
  getProjectMemory: (id: string) =>
    call<ProjectMemory>('getProjectMemory', { id }, () => req<ProjectMemory>(`/api/projects/${encodeURIComponent(id)}/memory`)),
  setProjectMemory: (id: string, state: string) =>
    call<{ ok: true }>('setProjectMemory', { id, state }, () => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/memory`, { method: 'POST', body: JSON.stringify({ state }) })),
  /** Commit a referable snapshot of the project (design + attachments). */
  snapshotProject: (id: string, message?: string) =>
    call<{ ok: boolean; hash?: string; reason?: string }>('snapshotProject', { id, message }, () => req<{ ok: boolean; hash?: string; reason?: string }>(`/api/projects/${encodeURIComponent(id)}/snapshot`, { method: 'POST', body: JSON.stringify({ message }) })),
  // Per-element design comments (Mochi-style commenting over the live preview). Desktop-only.
  listDesignComments: (id: string) =>
    call<{ comments: DesignComment[] }>('listDesignComments', { id }, () => Promise.reject(new Error('desktop only'))),
  addDesignComment: (id: string, input: { selector: string; label: string; note: string }) =>
    call<{ comment: DesignComment }>('addDesignComment', { id, ...input }, () => Promise.reject(new Error('desktop only'))),
  setDesignCommentStatus: (id: string, commentId: string, status: 'open' | 'resolved') =>
    call<{ ok: true }>('setDesignCommentStatus', { id, commentId, status }, () => Promise.reject(new Error('desktop only'))),
  deleteDesignComment: (id: string, commentId: string) =>
    call<{ ok: true }>('deleteDesignComment', { id, commentId }, () => Promise.reject(new Error('desktop only'))),

  // Local browser-extension control channel (desktop-only).
  extensionStatus: () =>
    call<ExtensionStatus>('extensionStatus', {}, () => Promise.reject(new Error('desktop only'))),
  extensionSetActive: (clientId: string) =>
    call<ExtensionStatus>('extensionSetActive', { clientId }, () => Promise.reject(new Error('desktop only'))),
  /** Hand off a design to code: copy its folder into a NEW coding project (lives in both tabs). Desktop-only. */
  copyDesignToCode: (id: string, name?: string) =>
    call<Project>('copyDesignToCode', { id, name }, () => Promise.reject(new Error('desktop only'))),

  // Coding agent: clone a repo / open a folder / inspect git (desktop owns git)
  gitAvailable: () => call<{ available: boolean }>('gitAvailable', {}, () => Promise.resolve({ available: false })),
  cloneRepo: (input: { url: string; dest: string; name?: string; dirName?: string; instructions?: string; color?: string }) =>
    call<Project>('cloneRepo', { ...input }, () =>
      req<Project>('/api/projects/clone', { method: 'POST', body: JSON.stringify(input) })),
  getProjectRepo: (id: string) =>
    call<RepoInfo>('getProjectRepo', { id }, () => req<RepoInfo>(`/api/projects/${encodeURIComponent(id)}/repo`)),
  /** Native folder picker — desktop only; resolves null in the browser. */
  pickFolder: async (): Promise<FolderInspect | null> => {
    if (!bridge?.pickFolder) return null;
    const r = await bridge.pickFolder();
    if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'failed');
    return (r.data as FolderInspect | null) ?? null;
  },
  /** Reveal a local path in Finder — desktop only; no-op in the browser. */
  revealPath: async (p: string): Promise<void> => { if (bridge?.revealPath) await bridge.revealPath(p); },
  /** Resolve a generated-image Asset to a data URL for inline display — desktop only; null on web/phone. */
  assetImage: async (assetId: string): Promise<string | null> => {
    if (!bridge?.assetImage) return null;
    const r = await bridge.assetImage(assetId);
    if (!r.ok) return null;
    return (r.data as { dataUrl?: string })?.dataUrl ?? null;
  },
  /** Read a file's text — desktop only, confined to the project folder; null in the browser. */
  readFile: async (projectId: string, p: string): Promise<{ path: string; text: string; bytes: number; truncated: boolean } | null> => {
    if (!bridge?.readFile) return null;
    const r = await bridge.readFile(projectId, p);
    if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'read failed');
    return r.data as { path: string; text: string; bytes: number; truncated: boolean };
  },
  /** List a directory inside the project — desktop only; null in the browser. */
  listDir: async (projectId: string, p?: string): Promise<{ path: string; entries: DirEntry[] } | null> => {
    if (!bridge?.listDir) return null;
    const r = await bridge.listDir(projectId, p);
    if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'list failed');
    return r.data as { path: string; entries: DirEntry[] };
  },
  /** Flat project file index (relative paths) for fast @-mention file search. */
  listProjectFiles: async (projectId: string): Promise<string[]> => {
    if (!bridge?.listProjectFiles) return [];
    try { const r = await bridge.listProjectFiles(projectId); const d = r?.data as { files?: string[] } | undefined; return r?.ok && Array.isArray(d?.files) ? d!.files : []; }
    catch { return []; }
  },
  /** Run / Terminal — run a shell command in the project folder (desktop only). */
  runCommand: async (projectId: string, command: string): Promise<{ runId: string } | null> => {
    if (!bridge?.runCommand) return null;
    const r = await bridge.runCommand(projectId, command);
    if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'run failed');
    return r.data as { runId: string };
  },
  killCommand: async (runId: string): Promise<void> => { await bridge?.killCommand?.(runId); },
  onCmdOutput: (cb: (p: CmdOutput) => void): (() => void) => (bridge?.onCmdOutput ? bridge.onCmdOutput(cb) : () => {}),

  // Media Studio (real fal generation, on the Mac's fal key)
  mediaRates: () => call<MediaRate[]>('mediaRates', {}, () => req<MediaRate[]>('/api/media/rates')),
  listAssets: (filter?: { projectId?: string; status?: AssetStatus }) =>
    call<Asset[]>('listAssets', { ...filter }, () => req<Asset[]>('/api/assets' + qp({ projectId: filter?.projectId, status: filter?.status }))),
  getAsset: (id: string) => call<Asset>('getAsset', { id }, () => req<Asset>(`/api/assets/${encodeURIComponent(id)}`)),
  generateAsset: (input: { projectId?: string | null; modelKey: string; prompt: string; durationS?: number; voice?: string; imageUrl?: string; aspect?: string }) =>
    call<Asset>('generateAsset', { ...input }, () => req<Asset>('/api/assets/generate', { method: 'POST', body: JSON.stringify(input) })),
  /** Regenerate an image. No instruction → re-roll the original prompt; with an
      instruction ("add a balloon in the sky") → edit the source image, keeping the
      rest. jobId appends the result to that chat turn so it shows inline. */
  regenerateImage: (input: { assetId: string; jobId?: string; instruction?: string; prompt?: string }) =>
    call<{ ok: boolean; assetId?: string }>('regenerateImage', { ...input }, () => req<{ ok: boolean; assetId?: string }>('/api/assets/regenerate', { method: 'POST', body: JSON.stringify(input) })),
  cancelAsset: (id: string) => call<Asset>('cancelAsset', { id }, () => req<Asset>(`/api/assets/${encodeURIComponent(id)}/cancel`, { method: 'POST' })),
  approveAsset: (id: string) => call<Asset>('approveAsset', { id }, () => req<Asset>(`/api/assets/${encodeURIComponent(id)}/approve`, { method: 'POST' })),
  deleteAsset: (id: string) => call<{ ok: boolean }>('deleteAsset', { id }, () => req<{ ok: boolean }>(`/api/assets/${encodeURIComponent(id)}/delete`, { method: 'POST' })),

  // Trends (real web research → content briefs)
  runResearch: (topic: string) => call<ResearchRun>('runResearch', { topic }, () => req<ResearchRun>('/api/research/run', { method: 'POST', body: JSON.stringify({ topic }) })),
  listBriefs: () => call<Brief[]>('listBriefs', {}, () => req<Brief[]>('/api/briefs')),
  listResearchRuns: () => call<ResearchRun[]>('listResearchRuns', {}, () => req<ResearchRun[]>('/api/research-runs')),
  markBriefSent: (id: string) => call<Brief>('markBriefSent', { id }, () => req<Brief>(`/api/briefs/${encodeURIComponent(id)}/sent`, { method: 'POST' })),

  // Publishing (local export pipeline)
  listPublishDrafts: () => call<PublishDraft[]>('listPublishDrafts', {}, () => req<PublishDraft[]>('/api/publish/drafts')),
  listPublishLedger: () => call<PublishLedgerRow[]>('listPublishLedger', {}, () => req<PublishLedgerRow[]>('/api/publish/ledger')),
  createDraft: (input: { assetId: string; caption?: string; platforms?: string[] }) =>
    call<PublishDraft>('createDraft', { ...input }, () => req<PublishDraft>('/api/publish/drafts', { method: 'POST', body: JSON.stringify(input) })),
  updateDraft: (id: string, patch: { caption?: string; platforms?: string[]; scheduledAt?: number | null; status?: PublishStatus }) =>
    call<PublishDraft>('updateDraft', { id, ...patch }, () => req<PublishDraft>(`/api/publish/drafts/${encodeURIComponent(id)}/update`, { method: 'POST', body: JSON.stringify(patch) })),
  scheduleDraft: (id: string, scheduledAt: number) =>
    call<PublishDraft>('scheduleDraft', { id, scheduledAt }, () => req<PublishDraft>(`/api/publish/drafts/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify({ scheduledAt }) })),
  exportDraft: (id: string) => call<PublishDraft>('exportDraft', { id }, () => req<PublishDraft>(`/api/publish/drafts/${encodeURIComponent(id)}/export`, { method: 'POST' })),
  markPublished: (id: string) => call<PublishDraft>('markPublished', { id }, () => req<PublishDraft>(`/api/publish/drafts/${encodeURIComponent(id)}/published`, { method: 'POST' })),
  deleteDraft: (id: string) => call<{ ok: boolean }>('deleteDraft', { id }, () => req<{ ok: boolean }>(`/api/publish/drafts/${encodeURIComponent(id)}/delete`, { method: 'POST' })),
  // Feedback (collected from any surface; stored + triaged on the Mac)
  listFeedback: () => call<Feedback[]>('listFeedback', {}, () => req<Feedback[]>('/api/feedback')),
  submitFeedback: (input: { category: FeedbackCategory; message: string; source?: FeedbackSource; context?: FeedbackContext }) =>
    call<Feedback>('submitFeedback', { ...input }, () =>
      req<Feedback>('/api/feedback', { method: 'POST', body: JSON.stringify({ ...input, source: input.source ?? 'web' }) })),
  updateFeedback: (id: string, status: FeedbackStatus) =>
    call<Feedback>('updateFeedback', { id, status }, () =>
      req<Feedback>(`/api/feedback/${encodeURIComponent(id)}/update`, { method: 'POST', body: JSON.stringify({ status }) })),
  deleteFeedback: (id: string) =>
    call<{ ok: boolean }>('deleteFeedback', { id }, () => req<{ ok: boolean }>(`/api/feedback/${encodeURIComponent(id)}/delete`, { method: 'POST' })),
  /** Escalate feedback to a GitHub issue — desktop-only (spends the Mac's GitHub token). */
  feedbackCreateIssue: (id: string, repo?: string) =>
    call<{ feedback: Feedback; issueUrl?: string; issueNumber?: number }>('feedbackCreateIssue', { id, repo }, () => Promise.reject(new ApiError(403, 'Filing GitHub issues is only available in the desktop app'))),

  // Comms (Telegram bot)
  commsStatus: () => call<CommsStatus>('commsStatus', {}, () => req<CommsStatus>('/api/comms/status')),
  listChatBindings: () => call<ChatBinding[]>('listChatBindings', {}, () => req<ChatBinding[]>('/api/comms/bindings')),
  listPendingChats: () => call<PendingChat[]>('listPendingChats', {}, () => req<PendingChat[]>('/api/comms/pending')),
  listCommEvents: () => call<CommEvent[]>('listCommEvents', {}, () => req<CommEvent[]>('/api/comms/events')),
  connectTelegram: (token: string) => call<{ username: string }>('connectTelegram', { token }, () => req<{ username: string }>('/api/comms/telegram/connect', { method: 'POST', body: JSON.stringify({ token }) })),
  disconnectTelegram: () => call<{ ok: boolean }>('disconnectTelegram', {}, () => req<{ ok: boolean }>('/api/comms/telegram/disconnect', { method: 'POST' })),
  bindChat: (input: { chatId: string; name?: string; projectId?: string | null; permissions?: Partial<ChatPermissions> }) =>
    call<ChatBinding>('bindChat', { ...input }, () => req<ChatBinding>('/api/comms/bind', { method: 'POST', body: JSON.stringify(input) })),
  unbindChat: (chatId: string) => call<{ ok: boolean }>('unbindChat', { chatId }, () => req<{ ok: boolean }>('/api/comms/unbind', { method: 'POST', body: JSON.stringify({ chatId }) })),
  setChatPermissions: (chatId: string, permissions: Partial<ChatPermissions>) =>
    call<ChatBinding>('setChatPermissions', { chatId, permissions }, () => req<ChatBinding>('/api/comms/permissions', { method: 'POST', body: JSON.stringify({ chatId, permissions }) })),

  /** Native import picker — desktop only; resolves the imported asset or null. */
  importAsset: async (projectId: string | null): Promise<Asset | null> => {
    if (!bridge?.importAsset) return null;
    const r = await bridge.importAsset(projectId);
    if (!r.ok) throw new ApiError(r.status ?? 500, r.error ?? 'failed');
    return (r.data as Asset | null) ?? null;
  },

  // Chat sessions — conversations with the agent inside a project
  listSessions: (projectId?: string) =>
    call<ChatSession[]>('listSessions', { projectId }, () => req<ChatSession[]>('/api/sessions' + qp({ projectId }))),
  sendChat: (input: { projectId: string; text: string; sessionId?: string; engine?: EngineId; model?: string; modelKey?: string; reviewerKey?: string; effort?: Effort; plan?: boolean; goal?: boolean; browser?: boolean; images?: { name?: string; mime: string; dataB64: string }[]; files?: { name: string; mime?: string; kind: 'text' | 'file'; content?: string; dataB64?: string }[] }) =>
    call<{ session: ChatSession; job: Job }>('sendChat', { ...input }, () =>
      req<{ session: ChatSession; job: Job }>('/api/chat', { method: 'POST', body: JSON.stringify(input) })),
  renameSession: (id: string, title: string) =>
    call<ChatSession>('renameSession', { id, title }, () =>
      req<ChatSession>(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: 'POST', body: JSON.stringify({ title }) })),
  deleteSession: (id: string) =>
    call<{ ok: boolean }>('deleteSession', { id }, () => req<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST' })),
  pinSession: (id: string, pinned: boolean) =>
    call<ChatSession>('pinSession', { id, pinned }, () => req<ChatSession>(`/api/sessions/${encodeURIComponent(id)}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) })),
  archiveSession: (id: string, archived: boolean) =>
    call<ChatSession>('archiveSession', { id, archived }, () => req<ChatSession>(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ archived }) })),
  deleteProject: (id: string) =>
    call<{ ok: boolean }>('deleteProject', { id }, () => req<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/delete`, { method: 'POST' })),

  // Conversation sync — scan the project's folder for past Claude/Codex/Conductor
  // conversations and import the selected ones as read-only chats. Desktop-only
  // (reads local agent stores), so the relay/web build rejects.
  scanConversations: (projectId: string) =>
    call<ConversationScan>('scanConversations', { projectId }, () => Promise.reject(new ApiError(501, 'Conversation sync runs in the desktop app'))),
  importConversations: (projectId: string, items: { source: ConvSource; externalId: string; filePath?: string; title?: string; createdAt?: number; updatedAt?: number }[]) =>
    call<{ imported: number; sessions: ChatSession[] }>('importConversations', { projectId, items }, () => Promise.reject(new ApiError(501, 'Conversation sync runs in the desktop app'))),

  // Jobs — in the desktop app these EXECUTE on this Mac (Claude Code login)
  listJobs: (projectId?: string, sessionId?: string) =>
    call<Job[]>('listJobs', { projectId, sessionId }, () => req<Job[]>('/api/jobs' + qp({ projectId, sessionId }))),
  createJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    call<Job>('createJob', { ...input }, () =>
      req<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(input) })),
  getJob: (id: string) => call<Job>('getJob', { id }, () => req<Job>(`/api/jobs/${encodeURIComponent(id)}`)),
  runJob: (id: string, effort?: Effort, engine?: EngineId) =>
    call<Job>('runJob', { id, effort, engine }, () =>
      req<Job>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ ...(effort ? { effort } : {}), ...(engine ? { engine } : {}) }) })),
  createAndRunJob: (input: { projectId: string; input: string; title?: string; effort?: Effort; engine?: EngineId; model?: string }) =>
    call<Job>('createAndRunJob', { ...input }, () =>
      req<Job>('/api/jobs/run', { method: 'POST', body: JSON.stringify(input) })),
  cancelJob: (id: string) =>
    call<Job>('cancelJob', { id }, () => req<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })),
  deleteJob: (id: string) =>
    call<{ ok: boolean }>('deleteJob', { id }, () => req<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/delete`, { method: 'POST' })),

  // Background tasks (long-lived processes the agent started — dev servers, watchers)
  listBgTasks: (projectId?: string) =>
    call<BgTask[]>('listBgTasks', { projectId }, () => req<BgTask[]>('/api/bg' + qp({ projectId }))),
  bgOutput: (id: string, tailKB?: number) =>
    call<{ record: BgTask; output: string }>('bgOutput', { id, tailKB }, () => req<{ record: BgTask; output: string }>(`/api/bg/${encodeURIComponent(id)}/output` + qp({ tailKB: tailKB != null ? String(tailKB) : undefined }))),
  stopBgTask: (id: string) =>
    call<BgTask>('stopBgTask', { id }, () => req<BgTask>(`/api/bg/${encodeURIComponent(id)}/stop`, { method: 'POST' })),

  // Approvals
  listApprovals: (status?: ApprovalStatus) =>
    call<Approval[]>('listApprovals', { status }, () => req<Approval[]>('/api/approvals' + qp({ status }))),
  approveApproval: (id: string) =>
    call<Approval>('approveApproval', { id }, () => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' })),
  denyApproval: (id: string) =>
    call<Approval>('denyApproval', { id }, () => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' })),

  // Schedules
  listSchedules: () => call<Schedule[]>('listSchedules', {}, () => req<Schedule[]>('/api/schedules')),
  createSchedule: (input: { title: string; projectId?: string; time?: string; cadence?: string; everyMinutes?: number; catchUp?: boolean; prompt?: string; sessionId?: string; effort?: Effort; browser?: boolean }) =>
    call<Schedule>('createSchedule', { ...input }, () =>
      req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) })),
  // Wait-&-check: poke a chat with a one-shot follow-up after delayMs.
  scheduleCheck: (input: { projectId?: string | null; sessionId?: string; prompt?: string; delayMs: number }) =>
    call<Schedule>('scheduleCheck', { ...input }, () =>
      req<Schedule>('/api/schedules/check', { method: 'POST', body: JSON.stringify(input) })),
  // Scheduled message: send a real chat message into a session at an absolute time
  // (fireAt = ms timestamp), carrying composer effort/browser/plan/goal.
  scheduleMessage: (input: { projectId: string; sessionId?: string; prompt: string; fireAt: number; effort?: Effort; browser?: boolean; plan?: boolean; goal?: boolean }) =>
    call<Schedule>('scheduleMessage', { ...input }, () =>
      req<Schedule>('/api/schedules/message', { method: 'POST', body: JSON.stringify(input) })),
  // Answer a surfaced AskUserQuestion — cancels its countdown, resumes the session
  // with the choice tagged so the model treats it as the direct answer.
  answerQuestion: (input: { sessionId: string; answer: string }) =>
    call<Job>('answerQuestion', { ...input }, () =>
      req<Job>('/api/questions/answer', { method: 'POST', body: JSON.stringify(input) })),
  // Extend an AskUserQuestion countdown by the next escalating step (or pause past the cap).
  extendQuestion: (sessionId: string) =>
    call<Schedule>('extendQuestion', { sessionId }, () =>
      req<Schedule>('/api/questions/extend', { method: 'POST', body: JSON.stringify({ sessionId }) })),
  toggleSchedule: (id: string, enabled: boolean) =>
    call<{ ok: boolean }>('toggleSchedule', { id, enabled }, () =>
      req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) })),
  updateSchedule: (id: string, patch: { title?: string; prompt?: string; time?: string; cadence?: string; everyMinutes?: number; catchUp?: boolean; enabled?: boolean; effort?: Effort; browser?: boolean; sessionId?: string; projectId?: string }) =>
    call<Schedule>('updateSchedule', { id, ...patch }, () =>
      req<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })),
  deleteSchedule: (id: string) =>
    call<{ ok: boolean }>('deleteSchedule', { id }, () => req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/delete`, { method: 'POST' })),

  // Skills
  listSkills: () => call<Skill[]>('listSkills', {}, () => req<Skill[]>('/api/skills')),
  // Skill registry: search the curated/secure index + install into a project.
  searchSkills: (q: string, limit = 30) =>
    call<{ count: number; mode?: string; results: RegistrySkillSummary[] }>(
      'searchSkills',
      { q, limit },
      () => req<{ count: number; mode?: string; results: RegistrySkillSummary[] }>('/registry/skills' + qp({ q, limit: String(limit) })),
    ),
  skillRegistryMeta: () =>
    call<{ count: number; total?: number; uniqueRepos?: number; generatedAt: string; source: string; note: string; semantic?: boolean }>(
      'skillRegistryMeta',
      {},
      () => req<{ count: number; total?: number; uniqueRepos?: number; generatedAt: string; source: string; note: string; semantic?: boolean }>('/registry/meta'),
    ),
  registryGetSkill: (id: string) =>
    call<RegistrySkillSummary & { rawBase?: string; skillPath?: string; branch?: string; excerpt?: string }>(
      'registryGetSkill',
      { id },
      () => req<RegistrySkillSummary & { rawBase?: string; skillPath?: string; branch?: string; excerpt?: string }>('/registry/skill' + qp({ id })),
    ),
  registrySkillContent: (id: string) =>
    call<{ id: string; name: string; skillMd: string; sha256?: string; enabled?: boolean }>(
      'registrySkillContent',
      { id },
      () => req<{ id: string; name: string; skillMd: string; sha256?: string; enabled?: boolean }>('/registry/skill/content' + qp({ id })),
    ),
  registryAdminListSkills: (input: { q?: string; includeDisabled?: boolean; limit?: number } = {}) =>
    reqRegistryAdmin<{ count: number; mode: string; results: RegistrySkillSummary[] }>(
      '/registry/admin/skills' + qp({
        q: input.q,
        includeDisabled: input.includeDisabled === undefined ? undefined : String(input.includeDisabled),
        limit: input.limit === undefined ? undefined : String(input.limit),
      }),
    ),
  registryAdminAddSkill: (input: { url?: string; owner?: string; repo?: string; skill?: string; skillMd?: string; name?: string; description?: string }) =>
    reqRegistryAdmin<RegistrySkillSummary>('/registry/admin/skills', { method: 'POST', body: JSON.stringify(input) }),
  registryAdminPatchSkill: (id: string, patch: { enabled?: boolean; disabledReason?: string; name?: string; description?: string; tags?: string[] }) =>
    reqRegistryAdmin<RegistrySkillSummary>('/registry/admin/skill' + qp({ id }), { method: 'PATCH', body: JSON.stringify(patch) }),
  registryAdminRescanSkill: (id: string) =>
    reqRegistryAdmin<RegistrySkillSummary>('/registry/admin/skill/rescan' + qp({ id }), { method: 'POST' }),
  registryAdminSyncSources: (input: { dryRun?: boolean; includeFresh?: boolean; limit?: number } = {}) =>
    reqRegistryAdmin<{ dryRun: boolean; mode: 'upstream-source'; includeFresh: boolean; repos: number; attempted: number; results: { skillId: string; repo: string; status: string; sourceRepo: string; sha256?: string; commitSha?: string | null; error?: string }[] }>(
      '/registry/admin/sync/sources',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  listProjectSkills: (projectId: string) =>
    call<{ skills: InstalledSkill[] }>('listProjectSkills', { id: projectId }, () => Promise.reject(new Error('desktop only'))),
  addSkillToProject: (projectId: string, skill: { skillId: string; name?: string; description?: string; risk?: string; source?: string; version?: string; disabledReason?: string | null; mirrorRepo?: string | null; auditStatus?: string | null }) =>
    call<{ skill: InstalledSkill }>('addSkillToProject', { projectId, ...skill }, () => Promise.reject(new Error('desktop only'))),
  removeSkillFromProject: (projectId: string, skillId: string) =>
    call<{ ok: boolean }>('removeSkillFromProject', { projectId, skillId }, () => Promise.reject(new Error('desktop only'))),
  /** Enable/disable a project skill without uninstalling it (renames SKILL.md on disk). */
  setProjectSkillEnabled: (projectId: string, skillId: string, enabled: boolean) =>
    call<{ ok: boolean; skill: InstalledSkill | null }>('setProjectSkillEnabled', { projectId, skillId, enabled }, () => Promise.reject(new Error('desktop only'))),
  toggleSkill: (id: string) =>
    call<Skill>('toggleSkill', { id }, () => req<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' })),

  // Custom MCP servers — a Mac-local library (the Mac owns all config/execution),
  // so these are desktop-only (no relay fallback). Enabled servers are merged into
  // every agent run, and any skills attached to a server are surfaced when it's active.
  listMcpServers: () =>
    call<CustomMcpServer[]>('listMcpServers', {}, () => Promise.reject(new Error('desktop only'))),
  addMcpServer: (input: McpServerInput) =>
    call<CustomMcpServer>('addMcpServer', { ...input }, () => Promise.reject(new Error('desktop only'))),
  updateMcpServer: (id: string, input: McpServerInput) =>
    call<CustomMcpServer>('updateMcpServer', { id, ...input }, () => Promise.reject(new Error('desktop only'))),
  setMcpServerEnabled: (id: string, enabled: boolean) =>
    call<CustomMcpServer>('setMcpServerEnabled', { id, enabled }, () => Promise.reject(new Error('desktop only'))),
  removeMcpServer: (id: string) =>
    call<{ ok: boolean }>('removeMcpServer', { id }, () => Promise.reject(new Error('desktop only'))),

  // Templates
  listTemplates: () => call<Template[]>('listTemplates', {}, () => req<Template[]>('/api/templates')),

  // Providers — local CLI logins (Claude Code / Codex) + locally-encrypted keys
  listProviders: (workspaceId?: string) =>
    call<ProviderConn[]>('listProviders', { workspaceId }, () => req<ProviderConn[]>('/api/providers' + qp({ workspaceId }))),
  connectProvider: (provider: ProviderId, apiKey: string, model?: string, workspaceId?: string) =>
    call<ProviderConn>('connectProvider', { provider, apiKey, model, workspaceId }, () =>
      req<ProviderConn>(`/api/providers/${provider}/connect`, { method: 'POST', body: JSON.stringify({ apiKey, model, workspaceId }) })),
  disconnectProvider: (provider: ProviderId, workspaceId?: string) =>
    call<{ ok: boolean }>('disconnectProvider', { provider, workspaceId }, () =>
      req<{ ok: boolean }>(`/api/providers/${provider}/disconnect`, { method: 'POST', body: JSON.stringify({ workspaceId }) })),

  // Codex ChatGPT OAuth via the bundled CLI — desktop-only (drives a local binary
  // + system browser, so there is no relay fallback).
  codexLogin: () => call<{ ok: boolean; method: string }>('codexLogin', {}, () => {
    throw new ApiError(501, 'Signing into Codex is only available in the desktop app.');
  }),
  codexLoginCancel: () => call<{ ok: boolean }>('codexLoginCancel', {}, () => Promise.resolve({ ok: true })),
  codexLogout: () => call<{ ok: boolean }>('codexLogout', {}, () => {
    throw new ApiError(501, 'Signing out of Codex is only available in the desktop app.');
  }),

  // Engine binaries (Codex / Claude) — downloaded on demand into userData rather
  // than bundled. Desktop-only (a remote can't install a binary on your Mac).
  enginesStatus: () => call<Record<EngineKind, EngineState>>('enginesStatus', {}, () => {
    throw new ApiError(501, 'Engine setup is only available in the desktop app.');
  }),
  installEngine: (engine: EngineKind) =>
    call<{ ok: boolean; path: string; version: string; source: string }>('installEngine', { engine }, () => {
      throw new ApiError(501, 'Engine downloads are only available in the desktop app.');
    }),
  cancelEngineInstall: (engine: EngineKind) =>
    call<{ ok: boolean }>('cancelEngineInstall', { engine }, () => Promise.resolve({ ok: true })),

  // GitHub connection + per-session PR lifecycle (desktop-only on the relay).
  githubStatus: () => call<GithubConnection>('githubStatus', {}, () => req<GithubConnection>('/api/github/status')),
  importGithubFromCli: () => call<ProviderConn>('importGithubFromCli', {}, () => req<ProviderConn>('/api/github/import-cli', { method: 'POST' })),
  // OAuth sign-in via the gh CLI device flow (downloads gh on first use). Long-lived;
  // resolves with the live connection once authorized. Listen on onGithubDevice for the
  // one-time code + download progress.
  githubLogin: () => call<GithubConnection>('githubLogin', {}, () => req<GithubConnection>('/api/github/login', { method: 'POST' })),
  githubLoginCancel: () => call<{ ok: boolean }>('githubLoginCancel', {}, () => req<{ ok: boolean }>('/api/github/login/cancel', { method: 'POST' })),
  ghCliState: () => call<GhState>('ghCliState', {}, () => req<GhState>('/api/github/cli-state')),
  getSessionGitStatus: (sessionId: string, withPr = true) =>
    call<SessionGitStatus>('getSessionGitStatus', { sessionId, withPr }, () => req<SessionGitStatus>(`/api/sessions/${sessionId}/git-status`)),
  refreshSessionGitStatus: (sessionId: string) =>
    call<SessionGitStatus>('refreshSessionGitStatus', { sessionId }, () => req<SessionGitStatus>(`/api/sessions/${sessionId}/git-status/refresh`, { method: 'POST' })),
  pushSession: (sessionId: string) =>
    call<{ ok: boolean; reason?: string }>('pushSession', { sessionId }, () => req<{ ok: boolean; reason?: string }>(`/api/sessions/${sessionId}/push`, { method: 'POST' })),
  createSessionPR: (sessionId: string, title?: string, body?: string, base?: string) =>
    call<{ ok: boolean; url?: string; number?: number; reason?: string }>('createSessionPR', { sessionId, title, body, base }, () =>
      req<{ ok: boolean; url?: string; number?: number; reason?: string }>(`/api/sessions/${sessionId}/pr`, { method: 'POST', body: JSON.stringify({ title, body, base }) })),
  mergeSessionPR: (sessionId: string, method?: 'merge' | 'squash' | 'rebase') =>
    call<{ ok: boolean; reason?: string }>('mergeSessionPR', { sessionId, method }, () =>
      req<{ ok: boolean; reason?: string }>(`/api/sessions/${sessionId}/merge`, { method: 'POST', body: JSON.stringify({ method }) })),
  resolveSession: (sessionId: string) =>
    call<{ ok: boolean; conflicts: string[]; reason?: string }>('resolveSession', { sessionId }, () =>
      req<{ ok: boolean; conflicts: string[]; reason?: string }>(`/api/sessions/${sessionId}/resolve`, { method: 'POST' })),
  archiveSessionWorktree: (sessionId: string, deleteBranch?: boolean) =>
    call<{ ok: boolean }>('archiveSessionWorktree', { sessionId, deleteBranch }, () =>
      req<{ ok: boolean }>(`/api/sessions/${sessionId}/archive-worktree`, { method: 'POST', body: JSON.stringify({ deleteBranch }) })),

  // Engine routing (which engine plays which role)
  getRouting: () => call<Routing>('getRouting', {}, () => req<Routing>('/api/routing')),
  setRouting: (patch: Partial<Routing>) =>
    call<Routing>('setRouting', { ...patch }, () =>
      req<Routing>('/api/routing', { method: 'POST', body: JSON.stringify(patch) })),

  // Model registry (provider-owned catalog) + per-role (primary/reviewer) model defaults
  listModels: () => call<ModelGroup[]>('listModels', {}, () => req<ModelGroup[]>('/api/models')),
  getRoles: () => call<Roles>('getRoles', {}, async () => {
    const r = await req<Routing>('/api/routing');
    return r.roles ?? { primary: { engine: 'claude', model: 'opus' }, reviewer: 'off' };
  }),
  setRoles: (patch: { primaryKey?: string; reviewerKey?: string }) =>
    call<Roles>('setRoles', { ...patch }, () =>
      req<Roles>('/api/roles', { method: 'POST', body: JSON.stringify(patch) })),

  // Pairing (desktop-only — the code remotes must enter)
  getPairing: () =>
    call<PairingInfo>('getPairing', {}, () => Promise.reject(new ApiError(404, 'Pairing info is only available in the desktop app'))),

  /** Auto-update — desktop only; `undefined` in web/phone remotes (updates are
      about this Mac's own binary, so they're never exposed over the relay). */
  update: IS_LOCAL ? {
    status: () => call<UpdateStatus>('update.status', {}, updateUnavailable),
    check: () => call<UpdateStatus>('update.check', {}, updateUnavailable),
    install: () => call<{ ok: boolean }>('update.install', {}, updateUnavailable),
    openReleases: () => call<{ ok: boolean }>('update.openReleases', {}, updateUnavailable),
    setChannel: (channel: 'stable' | 'beta') => call<UpdateStatus>('update.setChannel', { channel }, updateUnavailable),
    notes: (version?: string) => call<UpdateNotes>('update.notes', { version }, updateUnavailable),
    onUpdate: (cb: (s: UpdateStatus) => void): (() => void) =>
      bridge?.onEvent ? bridge.onEvent(({ name, data }) => { if (name === 'update') cb(data as UpdateStatus); }) : () => {},
  } : undefined,

  /** Live updates: local core events in Electron, relay SSE in the browser. */
  subscribe(handlers: { onJob?: (job: Job) => void; onApproval?: (a: Approval) => void; onProject?: (p: Project) => void; onClone?: (e: CloneEvent) => void; onAsset?: (a: Asset) => void; onBriefs?: (b: Brief[]) => void; onPublishDraft?: (d: PublishDraft) => void; onComms?: (s: CommsStatus) => void; onSession?: (s: ChatSession & { deleted?: boolean }) => void; onFeedback?: (f: Feedback & { deleted?: boolean }) => void; onBg?: (t: BgTask) => void; onGitStatus?: (s: SessionGitStatus) => void; onEngineDownload?: (p: EngineDownloadProgress) => void; onSchedule?: (s: Schedule) => void; onDevices?: (d: DevicePresence) => void; onGithubDevice?: (d: GithubDevice) => void }): () => void {
    if (bridge?.onEvent) {
      return bridge.onEvent(({ name, data }) => {
        if (name === 'devices' && handlers.onDevices) handlers.onDevices(data as DevicePresence);
        if (name === 'engine-download' && handlers.onEngineDownload) handlers.onEngineDownload(data as EngineDownloadProgress);
        if (name === 'bg' && handlers.onBg) handlers.onBg(data as BgTask);
        if (name === 'job' && handlers.onJob) handlers.onJob(data as Job);
        if (name === 'approval' && handlers.onApproval) handlers.onApproval(data as Approval);
        if (name === 'project' && handlers.onProject) handlers.onProject(data as Project);
        if (name === 'clone' && handlers.onClone) handlers.onClone(data as CloneEvent);
        if (name === 'asset' && handlers.onAsset) handlers.onAsset(data as Asset);
        if (name === 'briefs' && handlers.onBriefs) handlers.onBriefs(data as Brief[]);
        if (name === 'publishDraft' && handlers.onPublishDraft) handlers.onPublishDraft(data as PublishDraft);
        if (name === 'comms' && handlers.onComms) handlers.onComms(data as CommsStatus);
        if (name === 'session' && handlers.onSession) handlers.onSession(data as ChatSession & { deleted?: boolean });
        if (name === 'feedback' && handlers.onFeedback) handlers.onFeedback(data as Feedback & { deleted?: boolean });
        if (name === 'git-status' && handlers.onGitStatus) handlers.onGitStatus(data as SessionGitStatus);
        if (name === 'schedule' && handlers.onSchedule) handlers.onSchedule(data as Schedule);
        if (name === 'github-device' && handlers.onGithubDevice) handlers.onGithubDevice(data as GithubDevice);
      });
    }
    if (typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(API_BASE + '/api/stream' + (remoteToken ? `?token=${encodeURIComponent(remoteToken)}` : ''));
    if (handlers.onBg) es.addEventListener('bg', (e: MessageEvent) => { try { handlers.onBg!(JSON.parse(e.data) as BgTask); } catch { /* ignore */ } });
    if (handlers.onJob) es.addEventListener('job', (e: MessageEvent) => { try { handlers.onJob!(JSON.parse(e.data) as Job); } catch { /* ignore */ } });
    if (handlers.onApproval) es.addEventListener('approval', (e: MessageEvent) => { try { handlers.onApproval!(JSON.parse(e.data) as Approval); } catch { /* ignore */ } });
    if (handlers.onProject) es.addEventListener('project', (e: MessageEvent) => { try { handlers.onProject!(JSON.parse(e.data) as Project); } catch { /* ignore */ } });
    if (handlers.onClone) es.addEventListener('clone', (e: MessageEvent) => { try { handlers.onClone!(JSON.parse(e.data) as CloneEvent); } catch { /* ignore */ } });
    if (handlers.onAsset) es.addEventListener('asset', (e: MessageEvent) => { try { handlers.onAsset!(JSON.parse(e.data) as Asset); } catch { /* ignore */ } });
    if (handlers.onBriefs) es.addEventListener('briefs', (e: MessageEvent) => { try { handlers.onBriefs!(JSON.parse(e.data) as Brief[]); } catch { /* ignore */ } });
    if (handlers.onPublishDraft) es.addEventListener('publishDraft', (e: MessageEvent) => { try { handlers.onPublishDraft!(JSON.parse(e.data) as PublishDraft); } catch { /* ignore */ } });
    if (handlers.onComms) es.addEventListener('comms', (e: MessageEvent) => { try { handlers.onComms!(JSON.parse(e.data) as CommsStatus); } catch { /* ignore */ } });
    if (handlers.onSession) es.addEventListener('session', (e: MessageEvent) => { try { handlers.onSession!(JSON.parse(e.data) as ChatSession & { deleted?: boolean }); } catch { /* ignore */ } });
    if (handlers.onFeedback) es.addEventListener('feedback', (e: MessageEvent) => { try { handlers.onFeedback!(JSON.parse(e.data) as Feedback & { deleted?: boolean }); } catch { /* ignore */ } });
    if (handlers.onGitStatus) es.addEventListener('git-status', (e: MessageEvent) => { try { handlers.onGitStatus!(JSON.parse(e.data) as SessionGitStatus); } catch { /* ignore */ } });
    if (handlers.onSchedule) es.addEventListener('schedule', (e: MessageEvent) => { try { handlers.onSchedule!(JSON.parse(e.data) as Schedule); } catch { /* ignore */ } });
    if (handlers.onGithubDevice) es.addEventListener('github-device', (e: MessageEvent) => { try { handlers.onGithubDevice!(JSON.parse(e.data) as GithubDevice); } catch { /* ignore */ } });
    return () => es.close();
  },
  /** Convenience: subscribe to job updates only. */
  subscribeJobs(onJob: (job: Job) => void): () => void {
    return this.subscribe({ onJob });
  },
};
