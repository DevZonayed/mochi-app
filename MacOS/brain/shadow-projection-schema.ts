/**
 * shadow-projection-schema — Phase 3A2b1 Section B versioned PUBLIC projection
 * schemas. Each builder takes a REAL product Store entity (types imported from
 * `store.ts`) and emits a strict, versioned, allowlisted view carrying only known
 * safe fields — absent source fields are omitted, never invented. Every free-text
 * value is passed through the deterministic redactor (`shadow-projection-redact.ts`)
 * as defence-in-depth, and every id/string/timestamp/number/array is validated +
 * bounded. A malformed source row yields `null` (the driver skips it with a bounded
 * diagnostic) rather than throwing or poisoning the whole projection.
 *
 * The output of these builders becomes the encrypted event payload the host appends
 * and the controller decrypts into `ShadowEntity.data`. It NEVER contains tokens,
 * keys, cookies, env, raw tool args/commands, local secure paths, or `.env` contents.
 */
import { createHash } from 'node:crypto';
import type { ShadowCollection } from '@maestro/realtime';
import type { Project, ChatSession, Job, Approval, Schedule } from './store.js';
import { redactProjectionPayload, canonicalStringify, DEFAULT_REDACT_BOUNDS } from './shadow-projection-redact.js';

export const SHADOW_PROJECTION_SCHEMA_VERSION = 1 as const;

/** Per-projection bounds (in addition to the redactor's global bounds). */
export const PROJECTION_LIMITS = {
  maxTitleBytes: 512,
  maxSummaryBytes: 1024,
  maxChoices: 24,
  maxChoiceBytes: 256,
  maxEntitiesPerCollection: 5000,
} as const;

// Safe id grammar — matches the shared shadow protocol id grammar so ids round-trip
// through `assertSafeId` on the host core without rejection.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface ProjectionEntity {
  collection: ShadowCollection;
  entityId: string;
  /** Versioned safe payload (the controller reads this as `ShadowEntity.data`). */
  data: Record<string, unknown>;
}

// ── primitive validators/bounders ────────────────────────────────────────────

function safeId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const r = redactProjectionPayload(value, { ...DEFAULT_REDACT_BOUNDS, maxStringBytes: maxBytes });
  return typeof r.value === 'string' ? r.value : undefined;
}

function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function safeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4102444800000 ? Math.floor(value) : undefined;
}

function clampProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  // Store uses 0..1 or 0..100 historically; normalise to 0..1.
  const n = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, n));
}

function safeCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/**
 * Strict, fail-closed repo remote summary. Accepts ONLY an explicit http(s)/ssh/git
 * remote to a real hostname; returns a bounded credential-free `{ repoHost, repoPath }`
 * (no userinfo, no local/file paths, no query/fragment, no control chars). Any userinfo
 * (`user[:pass]@`) is DROPPED — never a credential-bearing URL. Anything that doesn't
 * parse to a hosted remote (a local path, `file://`, an IP/hostless authority, oversize,
 * control chars) yields `undefined` so the repo field is omitted entirely.
 */
function safeRepoSummary(raw: unknown): { repoHost: string; repoPath?: string } | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return undefined;
  // eslint-disable-next-line no-control-regex
  for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (c < 0x20 || c === 0x7f) return undefined; } // control chars
  let host: string | undefined;
  let path = '';
  const url = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^/]*)(\/[^?#\s]*)?/.exec(raw);
  if (url) {
    const scheme = url[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh' && scheme !== 'git') return undefined; // no file:// / other
    let authority = url[2];
    const at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1); // DROP userinfo (never emitted)
    host = authority.replace(/:\d{1,5}$/, ''); // strip :port
    path = url[3] ?? '';
  } else {
    // scp-like: [user@]host:owner/repo(.git) — no password ever present in this form.
    const scp = /^(?:[A-Za-z0-9._-]{1,64}@)?([A-Za-z0-9.-]{1,253}):([^?#\s]{1,256})$/.exec(raw);
    if (!scp) return undefined; // local path / bare path / unparseable → omit
    host = scp[1];
    path = '/' + scp[2].replace(/^\/+/, '');
  }
  // Host must be a real dotted hostname (rejects `localhost`, hostless, IPv6 brackets, bad chars).
  if (!host || !/^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))+$/.test(host) || host.includes('..')) return undefined;
  // Path: keep only owner/repo-ish characters; drop anything else (query/fragment already gone).
  let repoPath: string | undefined;
  if (path && path !== '/') {
    const cleaned = path.replace(/[^A-Za-z0-9._/-]/g, '');
    repoPath = cleaned.replace(/\/+$/, '').replace(/\.git$/, '').slice(0, 256) || undefined;
  }
  return { repoHost: host.slice(0, 253), repoPath };
}

// ── entity builders ──────────────────────────────────────────────────────────

const PROJECT_KINDS = ['coding', 'design', 'content', 'research', 'general', 'context'] as const;

export function buildProjectView(p: Project): ProjectionEntity | null {
  const id = safeId(p?.id);
  if (!id) return null;
  // Credential-free repo identity ONLY: host (+ owner/repo path) with userinfo dropped.
  // NEVER the raw repoUrl (may carry `user:pass@`) and NEVER the local `path` (a secure path).
  const repo = safeRepoSummary(p.repoUrl);
  const data = compact({
    v: SHADOW_PROJECTION_SCHEMA_VERSION,
    id,
    name: boundedText(p.name, PROJECTION_LIMITS.maxTitleBytes),
    kind: safeEnum(p.kind, PROJECT_KINDS),
    color: boundedText(p.color, 64),
    hidden: typeof p.hidden === 'boolean' ? p.hidden : undefined,
    // Already strictly sanitised by safeRepoSummary (hostname grammar / [A-Za-z0-9._/-] path,
    // no userinfo/control); emit directly — the generic free-text redactor would misread a
    // legitimate `/owner/repo` as a filesystem path and destroy it.
    repoHost: repo?.repoHost,
    repoPath: repo?.repoPath,
    createdAt: safeTimestamp(p.createdAt),
    lastActivity: safeTimestamp(p.updatedAt),
  });
  return { collection: 'project', entityId: id, data };
}

export function buildSessionView(s: ChatSession): ProjectionEntity | null {
  const id = safeId(s?.id);
  const projectId = safeId(s?.projectId);
  if (!id || !projectId) return null;
  const reviewer = s.reviewer === 'off' ? 'off' : (s.reviewer && typeof s.reviewer === 'object' ? safeEnum(s.reviewer.engine, ['claude', 'codex'] as const) : undefined);
  const data = compact({
    v: SHADOW_PROJECTION_SCHEMA_VERSION,
    id,
    projectId,
    title: boundedText(s.title, PROJECTION_LIMITS.maxTitleBytes),
    engine: s.primary && typeof s.primary === 'object' ? safeEnum(s.primary.engine, ['claude', 'codex'] as const) : undefined,
    model: boundedText(s.primary?.model, 128),
    autopilot: typeof s.autoPilot === 'boolean' ? s.autoPilot : undefined,
    reviewerEnabled: typeof s.reviewerEnabled === 'boolean' ? s.reviewerEnabled : undefined,
    reviewer,
    // Safe branch summary (no worktree absolute path — that's a local secure path).
    branch: boundedText(s.branch, 256),
    codename: boundedText(s.codename, 64),
    archived: typeof s.archived === 'number' ? true : undefined,
    createdAt: safeTimestamp(s.createdAt),
    lastActivity: safeTimestamp(s.updatedAt),
  });
  return { collection: 'session', entityId: id, data };
}

const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled', 'gated'] as const;

export function buildJobView(j: Job): ProjectionEntity | null {
  const id = safeId(j?.id);
  const projectId = safeId(j?.projectId);
  if (!id || !projectId) return null;
  const data = compact({
    v: SHADOW_PROJECTION_SCHEMA_VERSION,
    id,
    projectId,
    sessionId: j.sessionId ? safeId(j.sessionId) ?? undefined : undefined,
    title: boundedText(j.title, PROJECTION_LIMITS.maxTitleBytes),
    status: safeEnum(j.status, JOB_STATUSES),
    phase: boundedText(j.phase, 128),
    stage: boundedText(j.stage, 128),
    progress: clampProgress(j.progress),
    engine: safeEnum(j.engine, ['claude', 'codex'] as const),
    model: boundedText(j.model, 128),
    cost: safeCost(j.cost),
    // HIGH-1: raw `Job.error` / `Job.output` are NEVER projected — they carry filesystem
    // paths, stack traces, and connection-string credentials. Status/phase/stage/progress
    // (bounded enums/short strings, still redactor-scrubbed) convey job state safely.
    createdAt: safeTimestamp(j.createdAt),
    lastActivity: safeTimestamp(j.updatedAt),
  });
  return { collection: 'job', entityId: id, data };
}

const APPROVAL_KINDS = ['merge', 'budget', 'publish', 'deploy', 'review'] as const;
const APPROVAL_STATUSES = ['pending', 'approved', 'denied'] as const;

export function buildApprovalView(a: Approval): ProjectionEntity | null {
  const id = safeId(a?.id);
  if (!id) return null;
  const data = compact({
    v: SHADOW_PROJECTION_SCHEMA_VERSION,
    id,
    projectId: a.projectId ? safeId(a.projectId) ?? undefined : undefined,
    jobId: a.jobId ? safeId(a.jobId) ?? undefined : undefined,
    tool: safeEnum(a.kind, APPROVAL_KINDS),
    status: safeEnum(a.status, APPROVAL_STATUSES),
    title: boundedText(a.title, PROJECTION_LIMITS.maxTitleBytes),
    // Bounded human-safe summary from the subtitle ONLY — the `detail` field can
    // carry the raw command/args, so it is deliberately never projected.
    summary: boundedText(a.subtitle, PROJECTION_LIMITS.maxSummaryBytes),
    createdAt: safeTimestamp(a.createdAt),
    lastActivity: safeTimestamp(a.updatedAt),
  });
  return { collection: 'approval', entityId: id, data };
}

/** Normalised pending-question input the driver derives from a job + its auto-answer schedule. */
export interface QuestionInput {
  id: string;
  sessionId: string;
  sourceJobId?: string;
  question: string;
  choices?: string[];
  deadline?: number;
  status?: string;
  createdAt?: number;
}

const QUESTION_STATUSES = ['pending', 'answered', 'expired'] as const;

export function buildQuestionView(q: QuestionInput): ProjectionEntity | null {
  const id = safeId(q?.id);
  const sessionId = safeId(q?.sessionId);
  if (!id || !sessionId) return null;
  const choices = Array.isArray(q.choices)
    ? q.choices.slice(0, PROJECTION_LIMITS.maxChoices).map((c) => boundedText(c, PROJECTION_LIMITS.maxChoiceBytes)).filter((c): c is string => !!c)
    : undefined;
  const data = compact({
    v: SHADOW_PROJECTION_SCHEMA_VERSION,
    id,
    sessionId,
    sourceJobId: q.sourceJobId ? safeId(q.sourceJobId) ?? undefined : undefined,
    question: boundedText(q.question, PROJECTION_LIMITS.maxSummaryBytes),
    choices: choices && choices.length ? choices : undefined,
    deadline: safeTimestamp(q.deadline),
    status: safeEnum(q.status, QUESTION_STATUSES) ?? 'pending',
    createdAt: safeTimestamp(q.createdAt),
  });
  return { collection: 'question', entityId: id, data };
}

export function buildScheduleView(s: Schedule): ProjectionEntity | null {
  const id = safeId(s?.id);
  if (!id) return null;
  const data = compact({
    v: SHADOW_PROJECTION_SCHEMA_VERSION,
    id,
    projectId: s.projectId ? safeId(s.projectId) ?? undefined : undefined,
    title: boundedText(s.title, PROJECTION_LIMITS.maxTitleBytes),
    // Safe timing only; never the prompt / questionAsk / chatId payloads.
    time: boundedText(s.time, 64),
    cadence: boundedText(s.cadence, 64),
    kind: boundedText(s.kind, 64),
    enabled: typeof s.enabled === 'boolean' ? s.enabled : undefined,
    nextRun: safeTimestamp(s.nextRun ?? undefined),
    createdAt: safeTimestamp(s.createdAt),
    lastActivity: safeTimestamp(s.updatedAt),
  });
  return { collection: 'schedule', entityId: id, data };
}

/**
 * Canonical digest of a projected payload for host-side no-op detection. Bound to
 * the schema version + collection + entityId so a field change, a version bump, or
 * an id reuse across collections all produce a distinct digest.
 */
export function projectionDigest(collection: ShadowCollection, entityId: string, data: unknown): string {
  const canonical = canonicalStringify({ collection, entityId, data });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Deterministic tombstone payload for a deleted entity (distinct digest from any live view). */
export function tombstoneData(collection: ShadowCollection, entityId: string): Record<string, unknown> {
  return { v: SHADOW_PROJECTION_SCHEMA_VERSION, id: entityId, collection, tombstone: true };
}
