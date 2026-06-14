/* Maestro desktop — data client.

   In the ELECTRON APP every call routes over IPC to the local Maestro core in
   the main process: data + execution live on this Mac (Claude Code login, local
   store, local engine). In a BROWSER (the hosted web build) the same surface
   falls back to REST against the relay server, which mirrors the Mac's pushed
   state and forwards commands to it — the web app is a remote control. */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type ProjectKind = 'coding' | 'content' | 'research' | 'general';

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
  createdAt: number;
}
export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  sdkSessionId?: string;
  pinned?: boolean;
  primary?: RoleChoice;
  reviewer?: RoleChoice | 'off';
  createdAt: number;
  updatedAt: number;
}
export interface TranscriptItem {
  kind: 'text' | 'tool' | 'result' | 'ask' | 'review' | 'image';
  text: string;
  name?: string;
  toolStatus?: 'running' | 'done' | 'error';
  verdict?: 'approved' | 'needs-work';
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
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  engine: string;
  createdAt: number;
}
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
export interface PairingInfo {
  token: string;
  relayUrl: string;
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
export interface AppSettings {
  defaultEffort: Effort;
  defaultEngine: EngineId | 'auto';
  openAtLogin: boolean;
  rescanCadence: 'daily' | 'weekly' | 'onchange';
  favoriteModels?: string[];
}
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
  getProject: (id: string) =>
    call<Project>('getProject', { id }, () => req<Project>(`/api/projects/${encodeURIComponent(id)}`)),

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
  sendChat: (input: { projectId: string; text: string; sessionId?: string; engine?: EngineId; model?: string; modelKey?: string; reviewerKey?: string; effort?: Effort; plan?: boolean; goal?: boolean; images?: { name?: string; mime: string; dataB64: string }[]; files?: { name: string; mime?: string; kind: 'text' | 'file'; content?: string; dataB64?: string }[] }) =>
    call<{ session: ChatSession; job: Job }>('sendChat', { ...input }, () =>
      req<{ session: ChatSession; job: Job }>('/api/chat', { method: 'POST', body: JSON.stringify(input) })),
  renameSession: (id: string, title: string) =>
    call<ChatSession>('renameSession', { id, title }, () =>
      req<ChatSession>(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: 'POST', body: JSON.stringify({ title }) })),
  deleteSession: (id: string) =>
    call<{ ok: boolean }>('deleteSession', { id }, () => req<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST' })),
  pinSession: (id: string, pinned: boolean) =>
    call<ChatSession>('pinSession', { id, pinned }, () => req<ChatSession>(`/api/sessions/${encodeURIComponent(id)}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) })),
  deleteProject: (id: string) =>
    call<{ ok: boolean }>('deleteProject', { id }, () => req<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/delete`, { method: 'POST' })),

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

  // Approvals
  listApprovals: (status?: ApprovalStatus) =>
    call<Approval[]>('listApprovals', { status }, () => req<Approval[]>('/api/approvals' + qp({ status }))),
  approveApproval: (id: string) =>
    call<Approval>('approveApproval', { id }, () => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' })),
  denyApproval: (id: string) =>
    call<Approval>('denyApproval', { id }, () => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' })),

  // Schedules
  listSchedules: () => call<Schedule[]>('listSchedules', {}, () => req<Schedule[]>('/api/schedules')),
  createSchedule: (input: { title: string; projectId?: string; time?: string; cadence?: string }) =>
    call<Schedule>('createSchedule', { ...input }, () =>
      req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) })),
  // Wait-&-check: poke a chat with a one-shot follow-up after delayMs.
  scheduleCheck: (input: { projectId?: string | null; sessionId?: string; prompt?: string; delayMs: number }) =>
    call<Schedule>('scheduleCheck', { ...input }, () =>
      req<Schedule>('/api/schedules/check', { method: 'POST', body: JSON.stringify(input) })),
  toggleSchedule: (id: string, enabled: boolean) =>
    call<{ ok: boolean }>('toggleSchedule', { id, enabled }, () =>
      req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) })),
  deleteSchedule: (id: string) =>
    call<{ ok: boolean }>('deleteSchedule', { id }, () => req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/delete`, { method: 'POST' })),

  // Skills
  listSkills: () => call<Skill[]>('listSkills', {}, () => req<Skill[]>('/api/skills')),
  toggleSkill: (id: string) =>
    call<Skill>('toggleSkill', { id }, () => req<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' })),

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

  /** Live updates: local core events in Electron, relay SSE in the browser. */
  subscribe(handlers: { onJob?: (job: Job) => void; onApproval?: (a: Approval) => void; onProject?: (p: Project) => void; onClone?: (e: CloneEvent) => void; onAsset?: (a: Asset) => void; onBriefs?: (b: Brief[]) => void; onPublishDraft?: (d: PublishDraft) => void; onComms?: (s: CommsStatus) => void; onSession?: (s: ChatSession & { deleted?: boolean }) => void }): () => void {
    if (bridge?.onEvent) {
      return bridge.onEvent(({ name, data }) => {
        if (name === 'job' && handlers.onJob) handlers.onJob(data as Job);
        if (name === 'approval' && handlers.onApproval) handlers.onApproval(data as Approval);
        if (name === 'project' && handlers.onProject) handlers.onProject(data as Project);
        if (name === 'clone' && handlers.onClone) handlers.onClone(data as CloneEvent);
        if (name === 'asset' && handlers.onAsset) handlers.onAsset(data as Asset);
        if (name === 'briefs' && handlers.onBriefs) handlers.onBriefs(data as Brief[]);
        if (name === 'publishDraft' && handlers.onPublishDraft) handlers.onPublishDraft(data as PublishDraft);
        if (name === 'comms' && handlers.onComms) handlers.onComms(data as CommsStatus);
        if (name === 'session' && handlers.onSession) handlers.onSession(data as ChatSession & { deleted?: boolean });
      });
    }
    if (typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(API_BASE + '/api/stream' + (remoteToken ? `?token=${encodeURIComponent(remoteToken)}` : ''));
    if (handlers.onJob) es.addEventListener('job', (e: MessageEvent) => { try { handlers.onJob!(JSON.parse(e.data) as Job); } catch { /* ignore */ } });
    if (handlers.onApproval) es.addEventListener('approval', (e: MessageEvent) => { try { handlers.onApproval!(JSON.parse(e.data) as Approval); } catch { /* ignore */ } });
    if (handlers.onProject) es.addEventListener('project', (e: MessageEvent) => { try { handlers.onProject!(JSON.parse(e.data) as Project); } catch { /* ignore */ } });
    if (handlers.onClone) es.addEventListener('clone', (e: MessageEvent) => { try { handlers.onClone!(JSON.parse(e.data) as CloneEvent); } catch { /* ignore */ } });
    if (handlers.onAsset) es.addEventListener('asset', (e: MessageEvent) => { try { handlers.onAsset!(JSON.parse(e.data) as Asset); } catch { /* ignore */ } });
    if (handlers.onBriefs) es.addEventListener('briefs', (e: MessageEvent) => { try { handlers.onBriefs!(JSON.parse(e.data) as Brief[]); } catch { /* ignore */ } });
    if (handlers.onPublishDraft) es.addEventListener('publishDraft', (e: MessageEvent) => { try { handlers.onPublishDraft!(JSON.parse(e.data) as PublishDraft); } catch { /* ignore */ } });
    if (handlers.onComms) es.addEventListener('comms', (e: MessageEvent) => { try { handlers.onComms!(JSON.parse(e.data) as CommsStatus); } catch { /* ignore */ } });
    if (handlers.onSession) es.addEventListener('session', (e: MessageEvent) => { try { handlers.onSession!(JSON.parse(e.data) as ChatSession & { deleted?: boolean }); } catch { /* ignore */ } });
    return () => es.close();
  },
  /** Convenience: subscribe to job updates only. */
  subscribeJobs(onJob: (job: Job) => void): () => void {
    return this.subscribe({ onJob });
  },
};
