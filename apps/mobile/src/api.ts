/* Maestro mobile — live API client for the deployed maestro-server.

   React Native has fetch but no EventSource, so live updates use polling
   (api.poll) instead of SSE. Same shape/contract as the desktop client. */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type EngineId = 'claude' | 'codex';
export type ProjectKind = 'coding' | 'design' | 'content' | 'research' | 'general';

/** A folder/file entry from the Mac's read-only browser (new-project picker). */
export interface DirEntry { name: string; path: string; isDir: boolean; isRepo: boolean }
export interface DirListing { path: string; parent: string | null; home: string; entries: DirEntry[]; error?: string }

export interface Workspace { id: string; name: string; budgetCap: number; createdAt: number }
export interface Project { id: string; workspaceId: string; name: string; template: string; instructions: string; color: string; kind?: ProjectKind; path?: string; repoUrl?: string; order?: number; createdAt: number; updatedAt: number }
/** One structured block of an agent run (mirrors the desktop, image bytes stripped). */
export interface TranscriptItem {
  kind: 'text' | 'thinking' | 'tool' | 'result' | 'ask' | 'review' | 'image';
  text: string;
  name?: string;
  /** tool: secondary de-emphasized detail (e.g. raw shell command behind a Bash description). */
  cmd?: string;
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
  id: string; projectId: string | null; kind: ApprovalKind; title: string; subtitle: string; detail: string; status: ApprovalStatus; jobId?: string | null; createdAt: number; resolvedAt: number | null; updatedAt: number;
}

/** Delta-sync envelope (GET /api/sync?since=<ts>). Mirrors the relay's
    `SyncDelta` shape. Mobile feeds `at` back into the next pull as `since`. */
export interface SyncDelta {
  at: number;
  host: { online: boolean };
  changed: {
    projects: Project[]; sessions: ChatSession[]; jobs: Job[];
    approvals: Approval[]; assets: Asset[]; events: AppEvent[];
  };
  deleted: {
    projects: string[]; sessions: string[]; jobs: string[];
    approvals: string[]; assets: string[];
  };
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

/** A pickable model (mirrors the desktop catalog). `key` is the stable picker id. */
export interface ModelDescriptor { key: string; id: string; label: string; provider: string; family?: string; badge?: 'NEW'; tierNote?: string; external?: boolean }
export interface ModelGroup { provider: string; label: string; runnable: boolean; reason: string; models: ModelDescriptor[] }

/** Operator defaults stored on the Mac (mirrors the desktop AppSettings). */
export interface AppSettings {
  defaultEffort: Effort;
  defaultEngine: EngineId | 'auto';
  openAtLogin: boolean;
  rescanCadence: 'daily' | 'weekly' | 'onchange';
  favoriteModels?: string[];
  feedbackRepo?: string;
  /** Opt-in: phone tries a direct WebRTC channel to the Mac (mirrors desktop). */
  p2pEnabled?: boolean;
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
  /** Recurring: interval cadence (every N min) and catch-up for a missed daily slot. */
  everyMinutes?: number; catchUp?: boolean; lastFireLate?: boolean;
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
import { getStr, setStr, PAIR_TOKEN, DEVICE_ID } from './storage';
import { gotoRepair } from './navRef';
import { buildIceServers } from '@maestro/realtime';
import { createP2PLink } from './p2p/link';
import type { Signal } from './p2p/transport';

/* Pairing token — the relay refuses /api/* without the code shown in the
   Maestro desktop app (Settings → Devices). Stored locally on this phone. */
let pairToken = getStr(PAIR_TOKEN);
export function getPairToken(): string { return pairToken; }
export function setPairToken(token: string): void {
  pairToken = token.trim();
  setStr(PAIR_TOKEN, pairToken);
  freshDeviceId(); // (re-)pair → new identity so a prior kick (old id revoked) doesn't carry over
}
/** Re-read the token from storage after async hydration (see storage.hydrate). */
export function reloadPairToken(): void { pairToken = getStr(PAIR_TOKEN); }

/* Per-device identity — a stable id lets the Mac list + disconnect THIS phone. */
function mintDeviceId(): string {
  return `dev-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
export function getDeviceId(): string {
  let id = getStr(DEVICE_ID);
  if (!id) { id = mintDeviceId(); setStr(DEVICE_ID, id); }
  return id;
}
function freshDeviceId(): void { setStr(DEVICE_ID, mintDeviceId()); }

/* Re-pair gate: when the relay rejects our token (this device was kicked, or the
   code was regenerated), drop the token and bounce to Onboarding so the user can
   reconnect — instead of failing silently. Suppressed around verifyPairing's probe. */
let authRedirectEnabled = true;
function handleUnauthorized(): void {
  setPairToken(''); // clears token + mints a fresh device id for the next pair
  gotoRepair();
}

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
        'x-maestro-device-id': getDeviceId(),
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
      // Our token/device was rejected (kicked, or the code was regenerated) → drop
      // it and bounce to the enter-code screen so the user can reconnect.
      if (res.status === 401 && authRedirectEnabled) handleUnauthorized();
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
  createProject: (input: { name: string; workspaceId?: string; template?: string; instructions?: string; color?: string; path?: string; kind?: ProjectKind }) =>
    req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  /** Browse a folder on the Mac (read-only) for the new-project location picker. */
  browseDir: (path?: string) => req<DirListing>('/api/browse' + qp({ path })),
  getProject: (id: string) => req<Project>(`/api/projects/${encodeURIComponent(id)}`),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/delete`, { method: 'POST' }),

  listJobs: (projectId?: string, sessionId?: string) => req<Job[]>('/api/jobs' + qp({ projectId, sessionId })),
  /** Delta sync — returns ONLY entities that have changed since `since` (a
      timestamp from a prior `at` in the same shape) + ids that were deleted.
      `since=0` is the cold-start case and returns the entire current state.
      Used by the unified `syncStore` instead of the per-collection list calls. */
  sync: (since: number) => req<SyncDelta>('/api/sync' + qp({ since: since > 0 ? String(since) : undefined })),

  /** Chat sessions inside a project (the desktop's project → sessions tree). */
  listSessions: (projectId?: string) => req<ChatSession[]>('/api/sessions' + qp({ projectId })),
  /** Send a chat turn. Omit sessionId to start a new session. The reply streams
      in via live `job` events; refetch the session's jobs to render it.
      Attachments piggy-back as `images[]` (vision input) and `files[]` (text
      inlined into the prompt, binary saved on the Mac) — mirrors the desktop
      composer's payload shape so the same Mac-side ingestor handles both. */
  sendChat: (input: {
    projectId: string; text: string; sessionId?: string; effort?: Effort; engine?: EngineId; modelKey?: string;
    images?: { name?: string; mime: string; dataB64: string }[];
    files?: { name: string; mime?: string; kind: 'text' | 'file'; content?: string; dataB64?: string }[];
  }) =>
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
  /** Create a schedule. With fireAt+sessionId+prompt it's a one-shot queued message;
      with everyMinutes or time+cadence it's a recurring schedule. */
  createSchedule: (input: { title: string; projectId?: string | null; time?: string; cadence?: string; fireAt?: number; sessionId?: string; prompt?: string; everyMinutes?: number; catchUp?: boolean }) =>
    req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) }),
  updateSchedule: (id: string, patch: { title?: string; prompt?: string; time?: string; cadence?: string; everyMinutes?: number; catchUp?: boolean; enabled?: boolean; sessionId?: string; projectId?: string }) =>
    req<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/delete`, { method: 'POST' }),

  listSkills: () => req<Skill[]>('/api/skills'),
  toggleSkill: (id: string) => req<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' }),

  listTemplates: () => req<Template[]>('/api/templates'),
  /** Grouped, pickable models with per-provider runnable state (from the Mac). */
  listModels: () => req<ModelGroup[]>('/api/models'),

  /** Operator defaults, stored on the Mac (effort/engine the new-job composer inherits). */
  getSettings: () => req<AppSettings | null>('/api/settings'),
  setSettings: (patch: Partial<AppSettings>) => req<AppSettings>('/api/settings', { method: 'POST', body: JSON.stringify(patch) }),
  turnCredentials: () => req<{ host: string | null; username: string | null; credential: string | null; ttl: number }>('/api/turn-credentials'),

  /** Send feedback from this phone — stored on the Mac (source: 'phone'). */
  submitFeedback: (input: { category: 'bug' | 'idea' | 'other'; message: string }) =>
    req<{ id: string }>('/api/feedback', { method: 'POST', body: JSON.stringify({ ...input, source: 'phone' }) }),

  /** Register this phone's Expo push token so the relay can alert a CLOSED app. */
  registerPush: (token: string) => req<{ ok: boolean; devices: number }>('/api/push/register', { method: 'POST', body: JSON.stringify({ token }) }),
  /** Drop this phone's push token (called on unpair). */
  unregisterPush: (token: string) => req<{ ok: boolean; devices: number }>('/api/push/unregister', { method: 'POST', body: JSON.stringify({ token }) }),

  /** Verify the current pair token against the relay (a read-only auth probe).
     'ok' = token works · 'invalid' = wrong code (401) · 'mac-offline' = no Mac
     reachable to validate against (503) · 'unreachable' = network/relay down. */
  verifyPairing: async (): Promise<'ok' | 'invalid' | 'mac-offline' | 'unreachable'> => {
    authRedirectEnabled = false; // this probe handles 401 itself (don't bounce to Onboarding)
    try {
      await req('/api/engine-status');
      return 'ok';
    } catch (e) {
      if (e instanceof ApiError) return e.status === 401 ? 'invalid' : e.status === 503 ? 'mac-offline' : 'invalid';
      return 'unreachable';
    } finally {
      authRedirectEnabled = true;
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
  | 'schedule' | 'schedule-late' | 'git-status' | 'extension' | 'host' | 'hello'
  /** One-shot replay frames for events missed while disconnected. The relay
      emits these on connect when `?since=<ts>` is set; payload mirrors an
      `AppEvent` from the Mac's event log. Treated like a live event by the
      sync store: the entity is upserted and `lastSync` bumps to `event.ts`. */
  | 'replay';

/* ── Connection path ──────────────────────────────────────────────────────
   Which transport the live stream is on RIGHT NOW: 'p2p' (direct WebRTC) once the
   channel is open, else 'relay'. Subscribable so a UI pill can reflect it. */
let connPath: 'p2p' | 'relay' = 'relay';
const connSubs = new Set<() => void>();
export function getConnPath(): 'p2p' | 'relay' { return connPath; }
export function subscribeConnPath(cb: () => void): () => void { connSubs.add(cb); return () => { connSubs.delete(cb); }; }
function setConnPath(p: 'p2p' | 'relay'): void {
  if (connPath === p) return;
  connPath = p;
  for (const cb of connSubs) { try { cb(); } catch { /* ignore */ } }
}

/** Send WebRTC signaling to the Mac. The relay tags it with this device's id and
    hands it to the host; the Mac's replies come back as SSE `signal` frames. Not a
    tracked mutation (no outbox noise). */
export async function postSignal(signal: unknown): Promise<void> {
  await req('/api/signal', { method: 'POST', body: JSON.stringify({ signal }) });
}

/** Open the relay's SSE stream (real-time, no polling) and invoke `onEvent(name,
    data)` for each host event. Returns a disposer. react-native-sse is an XHR-based
    EventSource that works in Expo Go (RN has no native EventSource) and reconnects
    automatically. The pairing token rides as a Bearer header.

    When the Mac's `p2pEnabled` flag is on, a direct WebRTC channel is attempted;
    once it's open, host events arrive over P2P and the duplicate SSE app-events are
    suppressed (commands stay on REST). The link is native-free until started, so
    Expo Go / web simply keep using SSE. */
export function openLiveStream(onEvent: (name: LiveEventName, data: unknown) => void, since: number = 0): () => void {
  const NAMES: LiveEventName[] = ['job', 'session', 'approval', 'asset', 'comms', 'briefs', 'schedule', 'schedule-late', 'git-status', 'extension', 'host', 'hello', 'replay'];

  const link = createP2PLink({
    postSignal: (s) => { void postSignal(s); },
    fetchIce: async () => {
      try {
        const t = await api.turnCredentials();
        return buildIceServers(t.host && t.username && t.credential ? { host: t.host, username: t.username, credential: t.credential } : undefined);
      } catch {
        return buildIceServers();
      }
    },
    onEvent: (name, data) => onEvent(name as LiveEventName, data),
    onActiveChange: (active) => setConnPath(active ? 'p2p' : 'relay'),
  });
  // Only attempt P2P if the Mac enabled it; otherwise stay purely on SSE.
  void api.getSettings().then((s) => { if (s?.p2pEnabled) link.start(); }).catch(() => { /* stay on SSE */ });

  // `?since=<ts>` asks the relay to replay any events with `ts > since` from
  // the snapshot's event log before going live — covers the burst missed
  // while backgrounded so a foreground transition picks up cleanly.
  const sinceQuery = since > 0 ? '&since=' + encodeURIComponent(String(since)) : '';
  const es = new EventSource(API_BASE + '/api/stream?device=' + encodeURIComponent(DEVICE_NAME) + '&did=' + encodeURIComponent(getDeviceId()) + sinceQuery, {
    headers: pairToken ? { Authorization: `Bearer ${pairToken}` } : undefined,
    // Keep the long-lived stream open; reconnect a few seconds after any drop.
    pollingInterval: 4000,
  });

  // Signaling rides the SSE stream as a `signal` frame → feed the answerer.
  const sigFn = (e: { type: string; data?: string | null }) => {
    try { link.onRemoteSignal((e.data ? JSON.parse(e.data) : {}) as Signal); } catch { /* non-JSON */ }
  };
  es.addEventListener('signal' as 'message', sigFn as (e: unknown) => void);

  const handlers = NAMES.map((name) => {
    const fn = (e: { type: string; data?: string | null }) => {
      let data: unknown = null;
      try { data = e.data ? JSON.parse(e.data) : null; } catch { /* non-JSON frame */ }
      if (!link.isActive()) onEvent(name, data); // P2P up → events arrive over the channel instead
    };
    // react-native-sse dispatches `event: <name>` frames to listeners by name.
    es.addEventListener(name as 'message', fn as (e: unknown) => void);
    return { name, fn };
  });
  return () => {
    link.stop();
    setConnPath('relay');
    try {
      es.removeEventListener('signal' as 'message', sigFn as (e: unknown) => void);
      for (const h of handlers) es.removeEventListener(h.name as 'message', h.fn as (e: unknown) => void);
      es.close();
    } catch { /* already closed */ }
  };
}
