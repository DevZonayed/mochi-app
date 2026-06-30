/* Maestro mobile — API client for the account server (api.nexalance.cloud).

   The phone signs in to an ACCOUNT (see auth.ts) and controls one of the account's
   HOSTS (Macs) at a time — the "active host". All reads/commands go through
   POST /api/cmd {hostId, method, params}; the per-host snapshot comes from
   GET /api/sync?host=; live updates ride the /ws/remote WebSocket (RN's global
   WebSocket — no SSE). Same data shapes/contract as the desktop client. */

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
export interface Project { id: string; workspaceId: string; name: string; template: string; instructions: string; color: string; kind?: ProjectKind; path?: string; repoUrl?: string; order?: number; hidden?: boolean; createdAt: number; updatedAt: number }
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
  /** tool only: the SDK's tool_use_id — used to route nested sub-agent events
      back to this chip so the UI can expand to show the sub-agent's transcript. */
  id?: string;
  /** tool only (sub-agent calls — Task/Agent): the sub-agent's own captured
      transcript (its tool calls, thinking, prose). Rendered inside an
      expandable section under the parent chip. Capped on the Mac side before
      it crosses the relay. */
  children?: TranscriptItem[];
  /** tool only (sub-agent calls): the sub-agent's FINAL text response,
      unpacked from the tool_result content so the collapsed chip can preview
      the answer and the expanded view can show it in full. */
  result?: string;
  ts: number;
}
export interface Job {
  id: string; projectId: string; sessionId?: string; title: string; status: JobStatus; phase: string; progress: number;
  input: string; output: string | null; error: string | null; effort: Effort; cost: number; tokens: number; stage: string;
  engine?: EngineId; model?: string; goal?: boolean; transcript?: TranscriptItem[]; createdAt: number; updatedAt: number;
}
export interface JobPage {
  jobs: Job[];
  total: number;
  hasMore: boolean;
  nextBefore: number | null;
  nextCursor?: string | null;
}
export interface JobPageInput {
  projectId?: string;
  sessionId?: string;
  before?: number;
  cursor?: string;
  limit?: number;
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

import { buildIceServers } from '@maestro/realtime';
import { createP2PLink } from './p2p/link';
import type { Signal } from './p2p/transport';
import {
  API_BASE, DEVICE_NAME, DEVICE_PLATFORM,
  getSessionToken, getDeviceId, getActiveHost, setSessionToken, setActiveHost,
} from './auth';
import { gotoRepair } from './navRef';

export { API_BASE, DEVICE_NAME, getDeviceId };

/* ── Device (host) listing — account-scoped ────────────────────────────────
   The account server tracks every device on the account. Hosts (Macs that can
   run jobs) are role==='host'; the phone picks one as its "active host". */
export interface Device { id: string; role: 'host' | 'remote'; name: string; platform: string; deckId?: string; online: boolean; lastSeen?: number }

/* Auth gate: when the server rejects our session (token expired / signed out
   elsewhere), drop the token and bounce to Login so the user can sign back in —
   instead of failing silently. Suppressed where a caller handles 401 itself. */
let authRedirectEnabled = true;
function handleUnauthorized(): void {
  setSessionToken(''); // clears the session; the active host is left for re-pick after re-login
  setActiveHost('');
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

/** Human label for a mutating command, keyed by host RPC method name. Read-only
    methods return null (no outbox entry). */
function describeMutation(method: string): string | null {
  const table: Record<string, string> = {
    createAndRunJob: 'Start job',
    runJob: 'Run job',
    cancelJob: 'Cancel job',
    deleteJob: 'Delete job',
    createJob: 'Create job',
    sendChat: 'Send message',
    approveApproval: 'Approve gate',
    denyApproval: 'Deny gate',
    approveAsset: 'Approve asset',
    cancelAsset: 'Cancel asset',
    generateAsset: 'Generate asset',
    createProject: 'Create project',
    deleteProject: 'Delete project',
    createWorkspace: 'Create workspace',
    toggleSchedule: 'Toggle schedule',
    deleteSchedule: 'Cancel scheduled',
    createSchedule: 'Queue message',
    updateSchedule: 'Update schedule',
    toggleSkill: 'Toggle skill',
    submitFeedback: 'Send feedback',
    setSettings: 'Update settings',
  };
  return table[method] ?? null;
}

function recordOutbox(desc: string, state: OutboxState, why?: string): void {
  outboxLog.unshift({ id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, desc, ts: Date.now(), state, why });
  if (outboxLog.length > OUTBOX_CAP) outboxLog.length = OUTBOX_CAP;
  notifyOutbox();
}

/* ── Account-level transport ───────────────────────────────────────────────
   Direct /api/* calls that are NOT host commands: device listing, the per-host
   snapshot sync, TURN credentials, WebRTC signaling, and the auth probe. Sends
   the account session as Bearer + this phone's device id. */

/** Hard ceiling for any account/cmd request. Without this, a stalled fetch
 *  (captive portal, dead connection that never resets, CDN hang) holds the
 *  pullSync inflight promise forever — every subsequent pullSync() reuses it,
 *  `settled` stays false, and screens like ProjectSessions render their skeleton
 *  infinitely with no way for the user to recover except killing the app.
 *  20s is "patient on slow cellular, prompt when truly dead." */
const ACCOUNT_REQ_TIMEOUT_MS = 20_000;

async function accountReq<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const hasBody = init?.body != null;
  // Per-request timeout via AbortController. Combine with any caller-supplied
  // signal so cancellation from the call site still works.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ACCOUNT_REQ_TIMEOUT_MS);
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) ac.abort();
    else callerSignal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const res = await fetch(API_BASE + path, {
      ...init,
      signal: ac.signal,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-maestro-device': DEVICE_NAME,
        'x-maestro-device-id': getDeviceId(),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { const b = (await res.json()) as { error?: string; message?: string }; detail = b?.error || b?.message || detail; }
      catch { /* non-JSON */ }
      if (res.status === 401 && authRedirectEnabled) handleUnauthorized();
      throw new ApiError(res.status, detail);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (e) {
    // Normalize an aborted fetch (our timeout OR caller cancellation) into a
    // status=0 ApiError so classifySyncError treats it as `network` — the
    // SyncErrorBanner shows "Couldn't reach the server" with a Retry CTA
    // instead of leaving the user stuck on the skeleton.
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      const reason = callerSignal?.aborted ? 'Request cancelled' : 'Request timed out';
      throw new ApiError(0, reason);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** No active host selected yet — surfaced like a 503 so screens fall through to
    their "pick a Mac / offline" state instead of hanging. */
export class NoHostError extends ApiError {
  constructor() { super(503, 'No Mac selected — choose one to control.'); }
}

/* ── Host command transport ────────────────────────────────────────────────
   EVERY command/mutation AND read goes through POST /api/cmd {hostId, method,
   params}; the server forwards it to the active host (the Mac) and returns its
   reply. 404 = cross-account, 503 = host offline, 504 = host timed out — the
   same status contract the screens already handle (was the relay's 503/etc). */
async function cmd<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const intent = describeMutation(method);
  const hostId = getActiveHost();
  if (!hostId) {
    if (intent) recordOutbox(intent, 'conflict', 'No Mac selected');
    throw new NoHostError();
  }
  try {
    const result = await accountReq<T>('/api/cmd', {
      method: 'POST',
      body: JSON.stringify({ hostId, method, params }),
    });
    if (intent) recordOutbox(intent, 'applied');
    return result;
  } catch (e) {
    // 503 = the Mac is offline, so nothing ran (a "conflict" with reality);
    // any other failure means the Mac refused or the request errored.
    if (intent) {
      const status = e instanceof ApiError ? e.status : 0;
      recordOutbox(intent, status === 503 || status === 504 ? 'conflict' : 'rejected', e instanceof Error ? e.message : 'request failed');
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

/* ── Snapshot → SyncDelta adapter ──────────────────────────────────────────
   The account server mirrors each host's FULL state (apps/desktop store.snapshot)
   in Redis and serves it via /api/sync?host=. The unified mobile store still
   speaks `SyncDelta`, so we adapt: every collection becomes a full upsert and the
   host's `tombstones` become the `deleted` ids. Since it's a full snapshot, the
   store's upsert-by-id reconciles cleanly on every pull. */
interface Tombstone { kind: 'project' | 'session' | 'job' | 'asset' | 'approval'; id: string; ts: number }
export interface SnapshotShape {
  projects?: Project[]; sessions?: ChatSession[]; jobs?: Job[];
  approvals?: Approval[]; assets?: Asset[]; events?: AppEvent[];
  tombstones?: Tombstone[]; at?: number;
}
export function snapshotToDelta(_host: string, snap: SnapshotShape | null): SyncDelta {
  const s = snap ?? {};
  const tomb = s.tombstones ?? [];
  const idsOf = (kind: Tombstone['kind']) => tomb.filter((t) => t.kind === kind).map((t) => t.id);
  return {
    at: s.at ?? Date.now(),
    host: { online: snap != null }, // a present snapshot ⇒ the host has mirrored state
    changed: {
      projects: s.projects ?? [], sessions: s.sessions ?? [], jobs: s.jobs ?? [],
      approvals: s.approvals ?? [], assets: s.assets ?? [], events: s.events ?? [],
    },
    deleted: {
      projects: idsOf('project'), sessions: idsOf('session'), jobs: idsOf('job'),
      approvals: idsOf('approval'), assets: idsOf('asset'),
    },
  };
}

export const api = {
  base: API_BASE,
  health: () => accountReq<{ ok: boolean; name: string; mode: string }>('/health'),

  /* ── Account-level (not host-scoped) ─────────────────────────────────── */

  /** Every device on the account. Hosts (Macs) are role==='host'. */
  listDevices: () => accountReq<Device[]>('/api/devices'),
  turnCredentials: () => accountReq<{ host: string | null; username: string | null; credential: string | null; ttl: number }>('/api/turn-credentials'),

  /** A read-only auth/connectivity probe (mirrors the old verifyPairing).
     'ok' = signed in + hosts reachable · 'invalid' = session rejected (401) ·
     'mac-offline' = signed in but the active host is offline/none ·
     'unreachable' = network/server down. */
  verifySession: async (): Promise<'ok' | 'invalid' | 'mac-offline' | 'unreachable'> => {
    authRedirectEnabled = false; // this probe handles 401 itself (don't bounce to Login)
    try {
      const devices = await accountReq<Device[]>('/api/devices');
      const host = getActiveHost();
      const active = host ? devices.find((d) => d.id === host) : devices.find((d) => d.role === 'host' && d.online);
      return active?.online ? 'ok' : 'mac-offline';
    } catch (e) {
      if (e instanceof ApiError) return e.status === 401 ? 'invalid' : 'unreachable';
      return 'unreachable';
    } finally {
      authRedirectEnabled = true;
    }
  },

  /* ── Host snapshot sync ──────────────────────────────────────────────── */

  /** Pull the active host's full mirrored snapshot and adapt it to the store's
      `SyncDelta` shape (full upsert, tombstones honored). The account server's
      /api/sync returns {host, snapshot}; there is no incremental delta, so
      `since` is ignored (kept for call-site compatibility). */
  sync: async (_since: number): Promise<SyncDelta> => {
    const hostId = getActiveHost();
    if (!hostId) throw new NoHostError();
    const { host, snapshot } = await accountReq<{ host: string; snapshot: SnapshotShape | null }>('/api/sync' + qp({ host: hostId }));
    return snapshotToDelta(host, snapshot);
  },

  /* ── Host commands (routed via /api/cmd to the active Mac) ───────────── */

  dashboard: () => cmd<DashboardData>('dashboard'),
  budget: () => cmd<BudgetData>('budget'),
  costs: () => cmd<CostsData>('costs'),
  listEvents: () => cmd<AppEvent[]>('listEvents'),
  engineStatus: () => cmd<EngineStatuses>('engineStatus'),

  listAssets: (projectId?: string) => cmd<Asset[]>('listAssets', { projectId }),
  approveAsset: (id: string) => cmd<Asset>('approveAsset', { id }),
  cancelAsset: (id: string) => cmd<Asset>('cancelAsset', { id }),

  listWorkspaces: () => cmd<Workspace[]>('listWorkspaces'),
  createWorkspace: (name: string, budgetCap?: number) => cmd<Workspace>('createWorkspace', { name, budgetCap }),

  listProjects: () => cmd<Project[]>('listProjects'),
  createProject: (input: { name: string; workspaceId?: string; template?: string; instructions?: string; color?: string; path?: string; kind?: ProjectKind }) =>
    cmd<Project>('createProject', input),
  /** Browse a folder on the Mac (read-only) for the new-project location picker. */
  browseDir: (path?: string) => cmd<DirListing>('browseDir', { path }),
  getProject: (id: string) => cmd<Project>('getProject', { id }),
  deleteProject: (id: string) => cmd<{ ok: boolean }>('deleteProject', { id }),

  listJobs: (projectId?: string, sessionId?: string) => cmd<Job[]>('listJobs', { projectId, sessionId }),
  listJobPage: (input: JobPageInput) => cmd<JobPage>('listJobPage', { ...input }),

  /** Chat sessions inside a project (the desktop's project → sessions tree). */
  listSessions: (projectId?: string) => cmd<ChatSession[]>('listSessions', { projectId }),
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
    cmd<{ session: ChatSession; job: Job }>('sendChat', input),
  createJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    cmd<Job>('createJob', input),
  getJob: (id: string) => cmd<Job>('getJob', { id }),
  runJob: (id: string, effort?: Effort) => cmd<Job>('runJob', { id, effort }),
  createAndRunJob: (input: { projectId: string; input: string; title?: string; effort?: Effort; engine?: EngineId }) =>
    cmd<Job>('createAndRunJob', input),
  cancelJob: (id: string) => cmd<Job>('cancelJob', { id }),
  /** Real git diff of a job's work (committed + uncommitted), computed on the Mac. */
  getJobDiff: (id: string) => cmd<JobDiff>('getJobDiff', { id }),

  listApprovals: (status?: ApprovalStatus) => cmd<Approval[]>('listApprovals', { status }),
  approveApproval: (id: string) => cmd<Approval>('approveApproval', { id }),
  denyApproval: (id: string) => cmd<Approval>('denyApproval', { id }),

  listSchedules: () => cmd<Schedule[]>('listSchedules'),
  toggleSchedule: (id: string, enabled: boolean) => cmd<{ ok: boolean }>('toggleSchedule', { id, enabled }),
  /** Create a schedule. With fireAt+sessionId+prompt it's a one-shot queued message;
      with everyMinutes or time+cadence it's a recurring schedule. */
  createSchedule: (input: { title: string; projectId?: string | null; time?: string; cadence?: string; fireAt?: number; sessionId?: string; prompt?: string; everyMinutes?: number; catchUp?: boolean }) =>
    cmd<Schedule>('createSchedule', input),
  updateSchedule: (id: string, patch: { title?: string; prompt?: string; time?: string; cadence?: string; everyMinutes?: number; catchUp?: boolean; enabled?: boolean; sessionId?: string; projectId?: string }) =>
    cmd<Schedule>('updateSchedule', { ...patch, id }),
  deleteSchedule: (id: string) => cmd<{ ok: boolean }>('deleteSchedule', { id }),

  listSkills: () => cmd<Skill[]>('listSkills'),
  toggleSkill: (id: string) => cmd<Skill>('toggleSkill', { id }),

  listTemplates: () => cmd<Template[]>('listTemplates'),
  /** Grouped, pickable models with per-provider runnable state (from the Mac). */
  listModels: (refresh = false) => cmd<ModelGroup[]>('listModels', refresh ? { refresh: true } : {}),

  /** Operator defaults, stored on the Mac (effort/engine the new-job composer inherits). */
  getSettings: () => cmd<AppSettings | null>('getSettings'),
  setSettings: (patch: Partial<AppSettings>) => cmd<AppSettings>('setSettings', patch),

  /** Send feedback from this phone — stored on the Mac (source: 'phone'). */
  submitFeedback: (input: { category: 'bug' | 'idea' | 'other'; message: string }) =>
    cmd<{ id: string }>('submitFeedback', { ...input, source: 'phone' }),

  /** Register this phone's Expo push token so the server can alert a CLOSED app. */
  registerPush: (token: string) => accountReq<{ ok: boolean; devices: number }>('/api/push/register', { method: 'POST', body: JSON.stringify({ token }) }),
  /** Drop this phone's push token (called on sign-out). */
  unregisterPush: (token: string) => accountReq<{ ok: boolean; devices: number }>('/api/push/unregister', { method: 'POST', body: JSON.stringify({ token }) }),

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

/** Live host events the server fans out over the /ws/remote stream (the same
    names the Mac emits). Plus the synthetic `hello` frame that carries the active
    host's full snapshot on connect. */
export type LiveEventName =
  | 'job' | 'session' | 'approval' | 'asset' | 'comms' | 'briefs'
  | 'schedule' | 'schedule-late' | 'git-status' | 'extension' | 'host' | 'hello'
  /** Reserved for missed-event replay frames (not emitted by the account server
      today, but the store still treats them as AppEvents if they ever arrive). */
  | 'replay';

/* ── Connection path ──────────────────────────────────────────────────────
   Which transport the live stream is on RIGHT NOW: 'p2p' (direct WebRTC) once the
   channel is open, else 'relay' (the /ws/remote WebSocket). Subscribable so a UI
   pill can reflect it. */
let connPath: 'p2p' | 'relay' = 'relay';
const connSubs = new Set<() => void>();
export function getConnPath(): 'p2p' | 'relay' { return connPath; }
export function subscribeConnPath(cb: () => void): () => void { connSubs.add(cb); return () => { connSubs.delete(cb); }; }
function setConnPath(p: 'p2p' | 'relay'): void {
  if (connPath === p) return;
  connPath = p;
  for (const cb of connSubs) { try { cb(); } catch { /* ignore */ } }
}

/** Send a WebRTC signal to a device on the account (default: the active host).
    POST /api/signal {toDeviceId, signal}; the server routes it and the peer's
    replies come back as `{type:'signal', fromDeviceId, signal}` on /ws/remote.
    Not a tracked mutation (no outbox noise). */
export async function postSignal(signal: unknown, toDeviceId?: string): Promise<void> {
  const to = toDeviceId || getActiveHost();
  if (!to) return; // no host to signal yet
  await accountReq('/api/signal', { method: 'POST', body: JSON.stringify({ toDeviceId: to, signal }) });
}

/** Build the /ws/remote URL for the active host, carrying the account session
    (?token=), this device's id (?did=), and the target host (?host=). */
function remoteWsUrl(hostId: string): string {
  const base = API_BASE.replace(/^http/, 'ws').replace(/\/$/, '');
  const q = qp({
    token: getSessionToken(),
    did: getDeviceId(),
    host: hostId,
    name: DEVICE_NAME,
    platform: DEVICE_PLATFORM,
  });
  return `${base}/ws/remote${q}`;
}

/** Open the account server's /ws/remote stream for the ACTIVE host and invoke
    `onEvent(name, data)` for each host event. Returns a disposer. Uses the global
    `WebSocket` (RN provides it natively — no EventSource/SSE). Auto-reconnects with
    backoff while open; re-reads the active host on each (re)connect so a host switch
    that flips this stream down reconnects to the new host.

    Frames:
    - {type:'hello', hostId, snapshot}        → onEvent('hello', snapshot) (full state)
    - {type:'event', name, data}              → onEvent(name, data)
    - {type:'signal', fromDeviceId, signal}   → feed the P2P answerer

    When the Mac's `p2pEnabled` flag is on a direct WebRTC channel is attempted;
    once open, host events arrive over P2P and the duplicate WS app-events are
    suppressed (commands stay on REST). P2P is native-only, so Expo Go / web simply
    keep using the WebSocket. The `since` arg is accepted for call-site
    compatibility but unused (the hello snapshot is a full catch-up). */
export function openLiveStream(onEvent: (name: LiveEventName, data: unknown) => void, _since: number = 0): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Only attempt P2P if the Mac enabled it; otherwise stay purely on the WebSocket.
  void api.getSettings().then((s) => { if (s?.p2pEnabled) link.start(); }).catch(() => { /* stay on WS */ });

  const scheduleReconnect = (): void => {
    if (stopped) return;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };

  function connect(): void {
    if (stopped) return;
    const hostId = getActiveHost();
    if (!hostId) { scheduleReconnect(); return; } // no host picked yet — try again soon
    let sock: WebSocket;
    try {
      sock = new WebSocket(remoteWsUrl(hostId));
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => { retryMs = 1000; };
    sock.onmessage = (e: { data: unknown }) => {
      let m: { type?: string; name?: string; data?: unknown; snapshot?: unknown; fromDeviceId?: string; signal?: unknown };
      try { m = JSON.parse(String(e.data)) as typeof m; } catch { return; }
      if (m.type === 'signal') {
        try { link.onRemoteSignal((m.signal ?? {}) as Signal); } catch { /* non-signal */ }
        return;
      }
      if (m.type === 'hello') {
        onEvent('hello', m.snapshot ?? null); // full snapshot → store does a full reconcile
        return;
      }
      if (m.type === 'event' && m.name) {
        if (!link.isActive()) onEvent(m.name as LiveEventName, m.data ?? null); // P2P up → events arrive over the channel
      }
    };
    sock.onerror = () => { /* 'close' follows */ };
    sock.onclose = () => { ws = null; scheduleReconnect(); };
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    link.stop();
    setConnPath('relay');
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
  };
}
