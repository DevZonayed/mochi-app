/**
 * shadow-product-projection — Phase 3A2b1 Section B production driver that projects
 * the REAL product Store (all account projects/sessions/jobs/approvals/questions/
 * schedules) into the durable, hash-chained, encrypted host journal via the atomic
 * `ShadowHostCore.projectEntity`, then triggers an encrypted relay publish.
 *
 * Coherence guarantees (delegated to `projectEntity`'s atomic index+event tx):
 *   - only SEMANTIC changes emit an event (per-entity canonical digest compare);
 *   - monotonic per-entity revision, persisted across host restart (no dup events);
 *   - a deterministic tombstone is emitted exactly once when an entity that WAS
 *     projected disappears from the Store; a reappearance bumps the revision again.
 *
 * Driven by a single narrow post-durable-write Store hook + one bounded startup
 * reconcile — never a high-rate poll. Reconciles are serialized + burst-coalesced.
 * A listener/publish failure is logged (redacted) and never affects the Store.
 */
import type { ShadowCollection } from '@maestro/realtime';
import type { Fence } from '@maestro/realtime';
import type { ShadowHostCore } from './shadow-host.js';
import type { Project, ChatSession, Job, Approval, Schedule } from './store.js';
import {
  buildProjectView, buildSessionView, buildJobView, buildApprovalView, buildScheduleView, buildQuestionView,
  projectionDigest, tombstoneData, PROJECTION_LIMITS, type ProjectionEntity, type QuestionInput,
} from './shadow-projection-schema.js';

/** Narrow read surface the projection needs from the product Store (testable). */
export interface ProjectionStoreReader {
  listProjects(): Project[];
  listSessions(projectId?: string): ChatSession[];
  listJobs(projectId?: string, sessionId?: string): Job[];
  listApprovals(status?: 'pending' | 'approved' | 'denied'): Approval[];
  listSchedules(): Schedule[];
}

const PROJECTED_COLLECTIONS: readonly ShadowCollection[] = ['project', 'session', 'job', 'approval', 'question', 'schedule'];

export interface ShadowProductProjectionOptions {
  host: ShadowHostCore;
  fence: Fence;
  store: ProjectionStoreReader;
  now?: () => number;
  /** Encrypted relay publish, invoked after a reconcile that emitted ≥1 event. */
  publish?: () => Promise<void>;
  /** Redacted diagnostic sink (never receives a secret value). */
  log?: (message: string) => void;
}

export interface ReconcileResult {
  scanned: number;
  emitted: number;
  tombstoned: number;
  quarantined: number;
  truncated: boolean;
}

export class ShadowProductProjection {
  private readonly host: ShadowHostCore;
  private fence: Fence;
  private readonly store: ProjectionStoreReader;
  private readonly now: () => number;
  private readonly publishFn?: () => Promise<void>;
  private readonly log: (m: string) => void;
  private closed = false;
  private reconciling = false;
  private pending = false;

  constructor(opts: ShadowProductProjectionOptions) {
    this.host = opts.host;
    this.fence = opts.fence;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.publishFn = opts.publish;
    this.log = opts.log ?? (() => {});
  }

  /** Update the fence after a lease renewal / rotation. */
  setFence(fence: Fence): void { this.fence = fence; }

  /** The coarse durable-change listener to register with `Store.onDurableChange`. */
  onDurableChange = (): void => { void this.scheduleReconcile(); };

  /** Bounded startup reconcile — call once after construction/account switch. */
  async start(): Promise<ReconcileResult> {
    return this.scheduleReconcile();
  }

  /**
   * Serialize + burst-coalesce reconciles: if a reconcile is already running, mark a
   * follow-up and return the in-flight result; never run two scans concurrently.
   */
  async scheduleReconcile(): Promise<ReconcileResult> {
    if (this.closed) return { scanned: 0, emitted: 0, tombstoned: 0, quarantined: 0, truncated: false };
    if (this.reconciling) { this.pending = true; return { scanned: 0, emitted: 0, tombstoned: 0, quarantined: 0, truncated: false }; }
    this.reconciling = true;
    let last: ReconcileResult = { scanned: 0, emitted: 0, tombstoned: 0, quarantined: 0, truncated: false };
    try {
      do {
        this.pending = false;
        last = await this.reconcileOnce();
      } while (this.pending && !this.closed);
    } finally {
      this.reconciling = false;
    }
    return last;
  }

  private async reconcileOnce(): Promise<ReconcileResult> {
    const now = this.now();
    let scanned = 0, emitted = 0, tombstoned = 0, quarantined = 0, truncated = false;

    // Build the current live view per collection (bounded, deterministic).
    const live = new Map<ShadowCollection, Map<string, ProjectionEntity>>();
    for (const c of PROJECTED_COLLECTIONS) live.set(c, new Map());

    const add = (e: ProjectionEntity | null) => {
      if (!e) { quarantined++; return; }
      const bucket = live.get(e.collection)!;
      if (bucket.size >= PROJECTION_LIMITS.maxEntitiesPerCollection) { truncated = true; return; }
      bucket.set(e.entityId, e);
      scanned++;
    };

    try {
      for (const p of this.safeList(() => this.store.listProjects())) add(buildProjectView(p));
      for (const s of this.safeList(() => this.store.listSessions())) add(buildSessionView(s));
      for (const j of this.safeList(() => this.store.listJobs())) add(buildJobView(j));
      for (const a of this.safeList(() => this.store.listApprovals())) add(buildApprovalView(a));
      for (const s of this.safeList(() => this.store.listSchedules())) add(buildScheduleView(s));
      for (const q of this.deriveQuestions()) add(buildQuestionView(q));
    } catch (err) {
      this.log(`projection: store read failed (${errName(err)})`);
      return { scanned, emitted, tombstoned, quarantined, truncated };
    }
    if (truncated) this.log(`projection: entity cap ${PROJECTION_LIMITS.maxEntitiesPerCollection} hit — some entities not projected`);

    // Upserts: project each live entity (no-op when unchanged).
    for (const c of PROJECTED_COLLECTIONS) {
      for (const [entityId, entity] of live.get(c)!) {
        const digest = projectionDigest(c, entityId, entity.data);
        const r = this.tryProject({ collection: c, entityId, digest, op: 'upsert', payload: entity.data, now });
        if (r?.quarantined) quarantined++;
        else if (r?.appended) emitted++;
      }
    }

    // Tombstones: entities present + non-deleted in the index but gone from the Store.
    for (const c of PROJECTED_COLLECTIONS) {
      const liveIds = live.get(c)!;
      let indexed: Array<{ entityId: string; deleted: boolean }>;
      try { indexed = this.host.projectionIndexEntities(this.fence.scopeId, c); }
      catch { continue; }
      for (const row of indexed) {
        if (row.deleted) continue;
        if (liveIds.has(row.entityId)) continue;
        const data = tombstoneData(c, row.entityId);
        const digest = projectionDigest(c, row.entityId, data);
        const r = this.tryProject({ collection: c, entityId: row.entityId, digest, op: 'delete', payload: data, now });
        if (r?.quarantined) quarantined++;
        else if (r?.appended) { emitted++; tombstoned++; }
      }
    }

    if (emitted > 0 && this.publishFn) {
      try { await this.publishFn(); }
      catch (err) { this.log(`projection: publish failed (${errName(err)}) — will retry on next change`); }
    }
    return { scanned, emitted, tombstoned, quarantined, truncated };
  }

  private tryProject(input: { collection: ShadowCollection; entityId: string; digest: string; op: 'upsert' | 'delete'; payload: unknown; now: number }) {
    try {
      return this.host.projectEntity({ fence: this.fence, ...input });
    } catch (err) {
      // A single bad entity never aborts the whole reconcile.
      this.log(`projection: ${input.collection}/${input.entityId} skipped (${errName(err)})`);
      return null;
    }
  }

  private safeList<T>(fn: () => T[]): T[] {
    try { const r = fn(); return Array.isArray(r) ? r : []; }
    catch (err) { this.log(`projection: list failed (${errName(err)})`); return []; }
  }

  /**
   * Derive pending questions from the durable `auto-answer` schedule records (the
   * product's canonical pending-AskUserQuestion store: each carries the captured
   * question payload + sessionId + sourceJobId + deadline). Malformed payloads are
   * skipped, never projected raw.
   */
  private deriveQuestions(): QuestionInput[] {
    const out: QuestionInput[] = [];
    for (const s of this.safeList(() => this.store.listSchedules())) {
      if (s.kind !== 'auto-answer' || s.paused) continue;
      if (!s.sessionId || typeof s.questionAsk !== 'string') continue;
      const parsed = parseQuestionAsk(s.questionAsk);
      if (!parsed) continue;
      out.push({
        id: s.id,
        sessionId: s.sessionId,
        sourceJobId: s.sourceJobId,
        question: parsed.question,
        choices: parsed.choices,
        deadline: s.fireAt,
        status: 'pending',
        createdAt: s.armedAt ?? s.createdAt,
      });
    }
    return out;
  }

  close(): void {
    this.closed = true;
    this.pending = false;
  }
}

/** Extract the first question text + option labels from an AskUserQuestion payload JSON. */
function parseQuestionAsk(raw: string): { question: string; choices: string[] } | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const questions = (obj as { questions?: unknown }).questions;
  const first = Array.isArray(questions) ? questions[0] : (obj as { question?: unknown });
  if (!first || typeof first !== 'object') return null;
  const question = (first as { question?: unknown }).question;
  if (typeof question !== 'string' || question.length === 0) return null;
  const options = (first as { options?: unknown }).options;
  const choices = Array.isArray(options)
    ? options.map((o) => (o && typeof o === 'object' ? (o as { label?: unknown }).label : o)).filter((l): l is string => typeof l === 'string')
    : [];
  return { question, choices };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}
