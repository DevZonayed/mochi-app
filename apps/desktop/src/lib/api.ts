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
export interface Job {
  id: string;
  projectId: string;
  title: string;
  status: JobStatus;
  phase: string;
  progress: number;
  input: string;
  output: string | null;
  error: string | null;
  effort: Effort;
  cost: number;
  tokens: number;
  stage: string;
  engine?: EngineId;
  model?: string;
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
export type ProviderId = 'anthropic' | 'openai';
export interface ProviderConn {
  provider: ProviderId;
  method: 'subscription' | 'apiKey';
  status: string;
  detail: string;
  keyLast4?: string;
  createdAt: number;
}
export type EngineId = 'claude' | 'codex';
export interface Routing {
  master: EngineId;
  reviewer: EngineId | 'off';
  image: EngineId;
  video: EngineId;
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
}
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
  cloneRepo: (input: { url: string; name?: string; dirName?: string; instructions?: string; color?: string }) =>
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

  // Jobs — in the desktop app these EXECUTE on this Mac (Claude Code login)
  listJobs: (projectId?: string) =>
    call<Job[]>('listJobs', { projectId }, () => req<Job[]>('/api/jobs' + qp({ projectId }))),
  createJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    call<Job>('createJob', { ...input }, () =>
      req<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(input) })),
  getJob: (id: string) => call<Job>('getJob', { id }, () => req<Job>(`/api/jobs/${encodeURIComponent(id)}`)),
  runJob: (id: string, effort?: Effort, engine?: EngineId) =>
    call<Job>('runJob', { id, effort, engine }, () =>
      req<Job>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ ...(effort ? { effort } : {}), ...(engine ? { engine } : {}) }) })),
  createAndRunJob: (input: { projectId: string; input: string; title?: string; effort?: Effort; engine?: EngineId }) =>
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

  // Pairing (desktop-only — the code remotes must enter)
  getPairing: () =>
    call<PairingInfo>('getPairing', {}, () => Promise.reject(new ApiError(404, 'Pairing info is only available in the desktop app'))),

  /** Live updates: local core events in Electron, relay SSE in the browser. */
  subscribe(handlers: { onJob?: (job: Job) => void; onApproval?: (a: Approval) => void; onProject?: (p: Project) => void; onClone?: (e: CloneEvent) => void }): () => void {
    if (bridge?.onEvent) {
      return bridge.onEvent(({ name, data }) => {
        if (name === 'job' && handlers.onJob) handlers.onJob(data as Job);
        if (name === 'approval' && handlers.onApproval) handlers.onApproval(data as Approval);
        if (name === 'project' && handlers.onProject) handlers.onProject(data as Project);
        if (name === 'clone' && handlers.onClone) handlers.onClone(data as CloneEvent);
      });
    }
    if (typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(API_BASE + '/api/stream' + (remoteToken ? `?token=${encodeURIComponent(remoteToken)}` : ''));
    if (handlers.onJob) es.addEventListener('job', (e: MessageEvent) => { try { handlers.onJob!(JSON.parse(e.data) as Job); } catch { /* ignore */ } });
    if (handlers.onApproval) es.addEventListener('approval', (e: MessageEvent) => { try { handlers.onApproval!(JSON.parse(e.data) as Approval); } catch { /* ignore */ } });
    if (handlers.onProject) es.addEventListener('project', (e: MessageEvent) => { try { handlers.onProject!(JSON.parse(e.data) as Project); } catch { /* ignore */ } });
    if (handlers.onClone) es.addEventListener('clone', (e: MessageEvent) => { try { handlers.onClone!(JSON.parse(e.data) as CloneEvent); } catch { /* ignore */ } });
    return () => es.close();
  },
  /** Convenience: subscribe to job updates only. */
  subscribeJobs(onJob: (job: Job) => void): () => void {
    return this.subscribe({ onJob });
  },
};
