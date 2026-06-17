/* Maestro mobile — live API client for the deployed maestro-server.

   React Native has fetch but no EventSource, so live updates use polling
   (api.poll) instead of SSE. Same shape/contract as the desktop client. */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type EngineId = 'claude' | 'codex';
export type ProjectKind = 'coding' | 'content' | 'research' | 'general';

export interface Workspace { id: string; name: string; budgetCap: number; createdAt: number }
export interface Project { id: string; workspaceId: string; name: string; template: string; instructions: string; color: string; kind?: ProjectKind; path?: string; repoUrl?: string; createdAt: number }
/** One structured block of an agent run (mirrors the desktop, image bytes stripped). */
export interface TranscriptItem {
  kind: 'text' | 'tool' | 'result' | 'ask' | 'review' | 'image';
  text: string;
  name?: string;
  toolStatus?: 'running' | 'done' | 'error';
  verdict?: 'approved' | 'needs-work';
  resolved?: boolean;
  durMs?: number;
  preview?: string;
  ask?: string;
  alt?: string;
  ts: number;
}
export interface Job {
  id: string; projectId: string; sessionId?: string; title: string; status: JobStatus; phase: string; progress: number;
  input: string; output: string | null; error: string | null; effort: Effort; cost: number; tokens: number; stage: string;
  engine?: EngineId; model?: string; goal?: boolean; transcript?: TranscriptItem[]; createdAt: number; updatedAt: number;
}

/** A chat thread inside a project. Each turn is a Job with this sessionId. */
export interface ChatSession {
  id: string; projectId: string; title: string;
  pinned?: boolean; archived?: number;
  branch?: string; importedFrom?: 'claude' | 'codex' | 'conductor';
  createdAt: number; updatedAt: number;
}

export type DiffLineKind = 'ctx' | 'add' | 'del' | 'hunk';
export interface DiffLine { t: DiffLineKind; n: string; c: string }
export interface DiffFile { path: string; lang: string; additions: number; deletions: number; binary: boolean; lines: DiffLine[] }
export interface JobDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  fileCount: number;
  truncated: boolean;
  base: string | null;
  reason?: string;
}
export interface Approval {
  id: string; projectId: string | null; kind: ApprovalKind; title: string; subtitle: string; detail: string; status: ApprovalStatus; jobId?: string | null; createdAt: number; resolvedAt: number | null;
}
export type AppEventKind =
  | 'job-done' | 'job-failed' | 'job-cancelled'
  | 'approval-created' | 'approval-resolved'
  | 'schedule-fired' | 'clone-done' | 'clone-failed'
  | 'research' | 'publish' | 'comm' | 'asset';
export interface AppEvent { id: string; ts: number; kind: AppEventKind; title: string; subtitle?: string; projectId?: string | null; jobId?: string | null }
export interface CostsData {
  today: number; thisMonth: number; projectedMonth: number;
  byDay: { day: string; total: number }[];
  byProject: { projectId: string; name: string; color: string; total: number; jobs: number }[];
  byEngine: { engine: string; total: number; jobs: number; tokens: number }[];
  includedCodexRuns: number; claudeRuns: number;
}
export interface EngineStatus { engine: EngineId; available: boolean; method: 'subscription' | 'apiKey' | 'none'; detail: string; reason: string }
export type EngineStatuses = Record<EngineId, EngineStatus>;

/** Operator defaults stored on the Mac (mirrors the desktop AppSettings). */
export interface AppSettings {
  defaultEffort: Effort;
  defaultEngine: EngineId | 'auto';
  openAtLogin: boolean;
  rescanCadence: 'daily' | 'weekly' | 'onchange';
  favoriteModels?: string[];
  feedbackRepo?: string;
}

export type AssetKind = 'image' | 'video' | 'audio' | 'voiceover' | 'other';
export type AssetStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled' | 'approved';
export interface Asset {
  id: string; projectId: string | null; source: 'generated' | 'import'; kind: AssetKind; stage?: string;
  prompt?: string; model?: string; status: AssetStatus; url?: string; name?: string; bytes?: number; tint?: string;
  cost: number; durationS?: number; width?: number; height?: number; error: string | null; createdAt: number; updatedAt: number;
}
export interface Schedule {
  id: string; projectId: string | null; title: string; time: string; cadence: string; enabled: boolean;
  nextRun: number | null; lastRun?: number | null; createdAt: number;
  /** One-shot queued message: deliver `prompt` into `sessionId` at `fireAt`. */
  fireAt?: number; sessionId?: string; prompt?: string;
}
export interface Skill { id: string; name: string; description: string; category: string; kind: string; version: string; enabled: boolean; createdAt: number }
export interface Template { id: string; name: string; description: string; category: string; icon: string; engine: string; createdAt: number }
export interface BudgetData { cap: number; spent: number; byProject: { projectId: string; name: string; color: string; spent: number }[] }
export interface DashboardData {
  workspace: Workspace | null;
  greetingProjects: { id: string; name: string; color: string }[];
  gates: Approval[];
  activeJobs: Job[];
  recentlyCompleted: Job[];
  schedule: Schedule[];
  budget: BudgetData;
}

export const API_BASE = 'https://api.nexalance.cloud';

import EventSource from 'react-native-sse';
import { Platform } from 'react-native';

/** A human label for this device, sent so the Mac can show "iPhone connected". */
export const DEVICE_NAME = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Web remote';
import { getStr, setStr, PAIR_TOKEN } from './storage';

/* Pairing token — the relay refuses /api/* without the code shown in the
   Maestro desktop app (Settings → Devices). Stored locally on this phone. */
let pairToken = getStr(PAIR_TOKEN);
export function getPairToken(): string { return pairToken; }
export function setPairToken(token: string): void {
  pairToken = token.trim();
  setStr(PAIR_TOKEN, pairToken);
}
/** Re-read the token from storage after async hydration (see storage.hydrate). */
export function reloadPairToken(): void { pairToken = getStr(PAIR_TOKEN); }

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ── Outbox ──────────────────────────────────────────────────────────────
   The phone is a remote control: every action it takes runs ON the Mac. The
   Outbox is the real log of intents THIS session dispatched, with the Mac's
   verdict — applied (ran), conflict (Mac offline, nothing ran), or rejected
   (the Mac refused). In-memory so it works on native (no localStorage). */
export type OutboxState = 'applied' | 'rejected' | 'conflict';
export interface OutboxEntry { id: string; desc: string; ts: number; state: OutboxState; why?: string }

const outboxLog: OutboxEntry[] = [];
const outboxSubs = new Set<() => void>();
const OUTBOX_CAP = 50;

function notifyOutbox(): void { for (const cb of outboxSubs) { try { cb(); } catch { /* ignore */ } } }

/** Human label for a mutating request, derived from method + path. */
function describeMutation(method: string, path: string): string | null {
  const p = path.split('?')[0];
  const table: [RegExp, string][] = [
    [/^\/api\/jobs\/run$/, 'Start job'],
    [/^\/api\/jobs\/[^/]+\/run$/, 'Run job'],
    [/^\/api\/jobs\/[^/]+\/cancel$/, 'Cancel job'],
    [/^\/api\/jobs\/[^/]+\/delete$/, 'Delete job'],
    [/^\/api\/jobs$/, 'Create job'],
    [/^\/api\/approvals\/[^/]+\/approve$/, 'Approve gate'],
    [/^\/api\/approvals\/[^/]+\/deny$/, 'Deny gate'],
    [/^\/api\/assets\/[^/]+\/approve$/, 'Approve asset'],
    [/^\/api\/assets\/[^/]+\/cancel$/, 'Cancel asset'],
    [/^\/api\/assets\/generate$/, 'Generate asset'],
    [/^\/api\/projects$/, 'Create project'],
    [/^\/api\/projects\/[^/]+\/delete$/, 'Delete project'],
    [/^\/api\/workspaces$/, 'Create workspace'],
    [/^\/api\/schedules\/[^/]+\/toggle$/, 'Toggle schedule'],
    [/^\/api\/schedules\/[^/]+\/delete$/, 'Cancel scheduled'],
    [/^\/api\/schedules$/, 'Queue message'],
    [/^\/api\/skills\/[^/]+\/toggle$/, 'Toggle skill'],
    [/^\/api\/feedback$/, 'Send feedback'],
  ];
  for (const [re, label] of table) if (re.test(p)) return label;
  return null;
}

function recordOutbox(desc: string, state: OutboxState, why?: string): void {
  outboxLog.unshift({ id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, desc, ts: Date.now(), state, why });
  if (outboxLog.length > OUTBOX_CAP) outboxLog.length = OUTBOX_CAP;
  notifyOutbox();
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects the empty body (FST_ERR_CTP_EMPTY_JSON_BODY) on bodyless POSTs.
  const hasBody = init?.body != null;
  const method = (init?.method ?? 'GET').toUpperCase();
  const intent = method === 'GET' ? null : describeMutation(method, path);
  try {
    const res = await fetch(API_BASE + path, {
      ...init,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(pairToken ? { authorization: `Bearer ${pairToken}` } : {}),
        'x-maestro-device': DEVICE_NAME,
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
    if (intent) recordOutbox(intent, 'applied');
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (e) {
    // 503 = the Mac is offline, so nothing ran (a "conflict" with reality);
    // any other failure means the Mac refused or the request errored.
    if (intent) {
      const status = e instanceof ApiError ? e.status : 0;
      recordOutbox(intent, status === 503 ? 'conflict' : 'rejected', e instanceof Error ? e.message : 'request failed');
    }
    throw e;
  }
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
  health: () => req<{ ok: boolean; name: string; version: string; engine: string }>('/health'),

  dashboard: (workspaceId?: string) => req<DashboardData>('/api/dashboard' + qp({ workspaceId })),
  budget: (workspaceId?: string) => req<BudgetData>('/api/budget' + qp({ workspaceId })),
  costs: () => req<CostsData>('/api/costs'),
  listEvents: () => req<AppEvent[]>('/api/events'),
  engineStatus: () => req<EngineStatuses>('/api/engine-status'),

  listAssets: (projectId?: string) => req<Asset[]>('/api/assets' + qp({ projectId })),
  approveAsset: (id: string) => req<Asset>(`/api/assets/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  cancelAsset: (id: string) => req<Asset>(`/api/assets/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, budgetCap?: number) => req<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, budgetCap }) }),

  listProjects: (workspaceId?: string) => req<Project[]>('/api/projects' + qp({ workspaceId })),
  createProject: (input: { name: string; workspaceId?: string; template?: string; instructions?: string; color?: string }) =>
    req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => req<Project>(`/api/projects/${encodeURIComponent(id)}`),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/delete`, { method: 'POST' }),

  listJobs: (projectId?: string, sessionId?: string) => req<Job[]>('/api/jobs' + qp({ projectId, sessionId })),

  /** Chat sessions inside a project (the desktop's project → sessions tree). */
  listSessions: (projectId?: string) => req<ChatSession[]>('/api/sessions' + qp({ projectId })),
  /** Send a chat turn. Omit sessionId to start a new session. The reply streams
      in via live `job` events; refetch the session's jobs to render it. */
  sendChat: (input: { projectId: string; text: string; sessionId?: string; effort?: Effort; engine?: EngineId }) =>
    req<{ session: ChatSession; job: Job }>('/api/chat', { method: 'POST', body: JSON.stringify(input) }),
  createJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    req<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(input) }),
  getJob: (id: string) => req<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  runJob: (id: string, effort?: Effort) => req<Job>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(effort ? { effort } : {}) }),
  createAndRunJob: (input: { projectId: string; input: string; title?: string; effort?: Effort; engine?: EngineId }) =>
    req<Job>('/api/jobs/run', { method: 'POST', body: JSON.stringify(input) }),
  cancelJob: (id: string) => req<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  /** Real git diff of a job's work (committed + uncommitted), computed on the Mac. */
  getJobDiff: (id: string) => req<JobDiff>(`/api/jobs/${encodeURIComponent(id)}/diff`),

  listApprovals: (status?: ApprovalStatus) => req<Approval[]>('/api/approvals' + qp({ status })),
  approveApproval: (id: string) => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  denyApproval: (id: string) => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' }),

  listSchedules: () => req<Schedule[]>('/api/schedules'),
  toggleSchedule: (id: string, enabled: boolean) => req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  /** Create a schedule. With fireAt+sessionId+prompt it's a one-shot queued message. */
  createSchedule: (input: { title: string; projectId?: string | null; time?: string; cadence?: string; fireAt?: number; sessionId?: string; prompt?: string }) =>
    req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) }),
  deleteSchedule: (id: string) => req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/delete`, { method: 'POST' }),

  listSkills: () => req<Skill[]>('/api/skills'),
  toggleSkill: (id: string) => req<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' }),

  listTemplates: () => req<Template[]>('/api/templates'),

  /** Operator defaults, stored on the Mac (effort/engine the new-job composer inherits). */
  getSettings: () => req<AppSettings | null>('/api/settings'),
  setSettings: (patch: Partial<AppSettings>) => req<AppSettings>('/api/settings', { method: 'POST', body: JSON.stringify(patch) }),

  /** Send feedback from this phone — stored on the Mac (source: 'phone'). */
  submitFeedback: (input: { category: 'bug' | 'idea' | 'other'; message: string }) =>
    req<{ id: string }>('/api/feedback', { method: 'POST', body: JSON.stringify({ ...input, source: 'phone' }) }),

  /** Verify the current pair token against the relay (a read-only auth probe).
     'ok' = token works · 'invalid' = wrong code (401) · 'mac-offline' = no Mac
     reachable to validate against (503) · 'unreachable' = network/relay down. */
  verifyPairing: async (): Promise<'ok' | 'invalid' | 'mac-offline' | 'unreachable'> => {
    try {
      await req('/api/engine-status');
      return 'ok';
    } catch (e) {
      if (e instanceof ApiError) return e.status === 401 ? 'invalid' : e.status === 503 ? 'mac-offline' : 'invalid';
      return 'unreachable';
    }
  },

  /** The phone's outbox — intents dispatched this session, newest first. */
  outbox: (): OutboxEntry[] => outboxLog.slice(),
  /** Subscribe to outbox changes; returns an unsubscribe. */
  onOutbox(cb: () => void): () => void {
    outboxSubs.add(cb);
    return () => { outboxSubs.delete(cb); };
  },

  /** Poll a fetcher every ms; returns a cleanup that stops polling. Fallback for
      screens not yet on the live stream, or when SSE is unavailable. */
  poll(fetchOnce: () => void, ms = 4000): () => void {
    fetchOnce();
    const t = setInterval(fetchOnce, ms);
    return () => clearInterval(t);
  },
};

/** Live host events the relay fans out over SSE (the same names the Mac emits). */
export type LiveEventName =
  | 'job' | 'session' | 'approval' | 'asset' | 'comms' | 'briefs'
  | 'schedule' | 'git-status' | 'extension' | 'host' | 'hello';

/** Open the relay's SSE stream (real-time, no polling) and invoke `onEvent(name,
    data)` for each host event. Returns a disposer. react-native-sse is an XHR-based
    EventSource that works in Expo Go (RN has no native EventSource) and reconnects
    automatically. The pairing token rides as a Bearer header. */
export function openLiveStream(onEvent: (name: LiveEventName, data: unknown) => void): () => void {
  const NAMES: LiveEventName[] = ['job', 'session', 'approval', 'asset', 'comms', 'briefs', 'schedule', 'git-status', 'extension', 'host', 'hello'];
  const es = new EventSource(API_BASE + '/api/stream?device=' + encodeURIComponent(DEVICE_NAME), {
    headers: pairToken ? { Authorization: `Bearer ${pairToken}` } : undefined,
    // Keep the long-lived stream open; reconnect a few seconds after any drop.
    pollingInterval: 4000,
  });
  const handlers = NAMES.map((name) => {
    const fn = (e: { type: string; data?: string | null }) => {
      let data: unknown = null;
      try { data = e.data ? JSON.parse(e.data) : null; } catch { /* non-JSON frame */ }
      onEvent(name, data);
    };
    // react-native-sse dispatches `event: <name>` frames to listeners by name.
    es.addEventListener(name as 'message', fn as (e: unknown) => void);
    return { name, fn };
  });
  return () => {
    try {
      for (const h of handlers) es.removeEventListener(h.name as 'message', h.fn as (e: unknown) => void);
      es.close();
    } catch { /* already closed */ }
  };
}
