/**
 * shadow-controller-actions — Phase 3A2b1 Section C narrow, capability-gated, durable
 * product-idempotent controller ACTIONS. Each adapter maps ONE explicit shared method
 * to ONE real product Store seam through the durable {@link ShadowActionReceiptStore}:
 *
 *   controller.session.message       → session.message        (Store.claimIdempotentJob → one durable Job)
 *   controller.job.start             → job.start              (Store.claimIdempotentJob → one durable Job)
 *   controller.job.cancel            → job.cancel             (engine.cancel; state-idempotent on job.status)
 *   controller.approval.respond      → approval.respond       (Store.resolveApproval; state-idempotent on status)
 *   controller.question.answer       → question.answer        (answer + disable pending schedule; state-idempotent)
 *   controller.session.autopilot.set → session.autopilot.set  (Store.updateSession; state-idempotent boolean)
 *
 * There is NO generic dispatch: only these six closures over concrete product methods.
 * Every adapter validates ownership against the live Store immediately before the
 * transition, applies the idempotent product op, then commits a durable receipt whose
 * bounded completion is the REDACTED projection view of the resulting entity (so the
 * host projects it, carrying `commandId`, as the authoritative applied state).
 */
import type { Project, ChatSession, Job, Approval, Schedule, Effort } from './store.js';
import {
  buildJobView, buildSessionView, buildApprovalView, type ProjectionEntity,
} from './shadow-projection-schema.js';
import type { HostCommandExecution, ProductIdempotentActionAdapter, ProductIdempotentActionInput, ShadowCommandRegistryEntry } from './shadow-host-service.js';
import type { ShadowActionReceiptStore, ActionReceiptCompletion, ActionReceiptBinding } from './shadow-action-receipt.js';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';

// ── injected product seams (narrow, explicit — never arbitrary local API) ─────────
export interface ControllerActionStore {
  getProject(projectId: string): Project | undefined;
  getSession(sessionId: string): ChatSession | undefined;
  getJob(jobId: string): Job | undefined;
  listApprovals(): Approval[];
  listSchedules(): Schedule[];
  claimIdempotentJob(key: string, spec: { projectId: string; input: string; title?: string; effort?: Effort; sessionId?: string; intent?: unknown }): { job: Job; duplicate: boolean };
  /** Product-idempotent question answer: atomic schedule-disable + answer-Job under the command key. */
  claimIdempotentQuestionAnswer(key: string, input: { sessionId: string; sourceJobId: string; answer: string; answerDigest: string }): { job: Job; duplicate: boolean } | { conflict: string };
  resolveApproval(approvalId: string, status: 'approved' | 'denied'): Approval;
  updateSession(sessionId: string, patch: { autoPilot?: boolean }): ChatSession;
}

export interface ControllerActionEngine {
  /** Launch a freshly-claimed durable job exactly once (no-op if already running). */
  launchJob(jobId: string): void;
  /** Cancel a running job; returns true if a running job was cancelled (else already terminal). */
  cancelJob(jobId: string): boolean;
}

export interface ControllerActionDeps {
  store: ControllerActionStore;
  engine: ControllerActionEngine;
  receipts: ShadowActionReceiptStore;
  /**
   * TEST-ONLY crash hook, DEFAULT ABSENT (production passes nothing → zero branch side
   * effects). When provided, it is invoked AFTER the durable product commit (`apply`) but
   * BEFORE the shadow action receipt is written — the exact §2 boundary A window. Throwing
   * from it simulates a crash there; recovery must re-derive the same product state.
   */
  crashAfterProductCommit?: (method: string) => void;
}

// ── strict parsers (bounds ids/lengths/enums; reject prototype keys/binary) ────────
type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function rec(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const k of ['__proto__', 'constructor', 'prototype']) if (Object.prototype.hasOwnProperty.call(raw, k)) return null;
  return raw as Record<string, unknown>;
}
function id(v: unknown): string | null { return typeof v === 'string' && SAFE_ID.test(v) ? v : null; }
function boundedStr(v: unknown, max: number): string | null { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }

interface MessageParams { sessionId: string; text: string }
interface StartParams { projectId: string; input: string; title?: string; sessionId?: string }
interface CancelParams { jobId: string }
interface ApprovalParams { approvalId: string; decision: 'approve' | 'deny' }
interface QuestionParams { sessionId: string; sourceJobId: string; answer: string }
interface AutopilotParams { sessionId: string; enabled: boolean }

const parseMessage = (raw: unknown): ParseResult<MessageParams> => {
  const r = rec(raw); if (!r) return { ok: false, reason: 'bad-object' };
  const sessionId = id(r.sessionId); const text = boundedStr(r.text, 16_000);
  return sessionId && text ? { ok: true, value: { sessionId, text } } : { ok: false, reason: 'bad-message' };
};
const parseStart = (raw: unknown): ParseResult<StartParams> => {
  const r = rec(raw); if (!r) return { ok: false, reason: 'bad-object' };
  const projectId = id(r.projectId); const input = boundedStr(r.input, 16_000);
  const title = r.title === undefined ? undefined : boundedStr(r.title, 512) ?? undefined;
  const sessionId = r.sessionId === undefined ? undefined : id(r.sessionId) ?? undefined;
  if (r.sessionId !== undefined && sessionId === undefined) return { ok: false, reason: 'bad-session' };
  return projectId && input ? { ok: true, value: { projectId, input, title, sessionId } } : { ok: false, reason: 'bad-start' };
};
const parseCancel = (raw: unknown): ParseResult<CancelParams> => {
  const r = rec(raw); if (!r) return { ok: false, reason: 'bad-object' };
  const jobId = id(r.jobId); return jobId ? { ok: true, value: { jobId } } : { ok: false, reason: 'bad-cancel' };
};
const parseApproval = (raw: unknown): ParseResult<ApprovalParams> => {
  const r = rec(raw); if (!r) return { ok: false, reason: 'bad-object' };
  const approvalId = id(r.approvalId); const decision = r.decision === 'approve' || r.decision === 'deny' ? r.decision : null;
  return approvalId && decision ? { ok: true, value: { approvalId, decision } } : { ok: false, reason: 'bad-approval' };
};
const parseQuestion = (raw: unknown): ParseResult<QuestionParams> => {
  const r = rec(raw); if (!r) return { ok: false, reason: 'bad-object' };
  const sessionId = id(r.sessionId); const sourceJobId = id(r.sourceJobId); const answer = boundedStr(r.answer, 8_000);
  return sessionId && sourceJobId && answer ? { ok: true, value: { sessionId, sourceJobId, answer } } : { ok: false, reason: 'bad-question' };
};
const parseAutopilot = (raw: unknown): ParseResult<AutopilotParams> => {
  const r = rec(raw); if (!r) return { ok: false, reason: 'bad-object' };
  const sessionId = id(r.sessionId); const enabled = typeof r.enabled === 'boolean' ? r.enabled : null;
  return sessionId && enabled !== null ? { ok: true, value: { sessionId, enabled } } : { ok: false, reason: 'bad-autopilot' };
};

// ── receipt-guarded execution ──────────────────────────────────────────────────
function reject(code: string, message: string): HostCommandExecution { return { ok: false, code, message }; }
function completionOf(entity: ProjectionEntity): ActionReceiptCompletion {
  return { collection: entity.collection, op: 'upsert', entityId: entity.entityId, revision: 1, payload: entity.data };
}

function makeAdapter(
  receipts: ShadowActionReceiptStore,
  method: string,
  apply: (input: ProductIdempotentActionInput) => HostCommandExecution,
  crashAfterProductCommit?: (method: string) => void,
): ProductIdempotentActionAdapter {
  return {
    execute: async (input) => {
      const binding: ActionReceiptBinding = {
        accountId: input.accountId, scopeId: input.scopeId, controllerDeviceId: input.controllerDeviceId,
        idempotencyKey: input.idempotencyKey, method, canonicalPayloadDigest: input.canonicalPayloadDigest,
      };
      const prior = receipts.lookup(binding);
      if (prior.status === 'hit') return { ok: true, completion: prior.completion };
      if (prior.status === 'conflict') return reject('conflict', prior.reason);
      const outcome = apply(input);
      if (!outcome.ok) return outcome;
      // §2 boundary A: the durable product commit is done; a crash HERE (before the shadow
      // receipt) must recover via the idempotent product seam on replay. TEST-ONLY hook.
      crashAfterProductCommit?.(method);
      // The product op above is idempotent, so committing the receipt AFTER it is
      // crash-safe (replay re-derives the same target state). A cross-process CONFLICTING
      // commit is surfaced as a rejection — never projected as our own success.
      const committed = receipts.commit(binding, outcome.completion as ActionReceiptCompletion, input.now);
      if (committed.status === 'conflict') return reject('conflict', committed.reason);
      return { ok: true, completion: committed.completion };
    },
  };
}

/**
 * Build the FROZEN production registry of capability-gated product-idempotent actions.
 * Composes with read-only/health entries elsewhere. Only these six methods are ever
 * mutating-registrable; anything else (shell/file/git/provider/settings/delete/unknown)
 * is absent and rejected before dispatch.
 */
export function buildControllerActionRegistryEntries(deps: ControllerActionDeps): Record<string, ShadowCommandRegistryEntry> {
  const { store, engine, receipts, crashAfterProductCommit } = deps;
  const mk = (method: string, apply: (input: ProductIdempotentActionInput) => HostCommandExecution) => makeAdapter(receipts, method, apply, crashAfterProductCommit);

  const messageAdapter = mk('controller.session.message', (input) => {
    const p = input.params as MessageParams;
    const session = store.getSession(p.sessionId);
    if (!session) return reject('not-found', 'session not found');
    if (!store.getProject(session.projectId)) return reject('not-found', 'project not found');
    // Stable controller idempotency → ONE durable Job before any launch; duplicate → same job, no relaunch.
    const key = `shadow:${input.controllerDeviceId}:${input.idempotencyKey}`;
    input.assertAuthority(); // HIGH-2: fail closed at the linearization point — no await before the mutation.
    const { job, duplicate } = store.claimIdempotentJob(key, { projectId: session.projectId, input: p.text, title: p.text.slice(0, 60), sessionId: session.id });
    if (!duplicate) engine.launchJob(job.id); // post-commit launch (external)
    const view = buildJobView(store.getJob(job.id) ?? job);
    return view ? { ok: true, completion: completionOf(view) } : reject('project-error', 'job projection failed');
  });

  const startAdapter = mk('controller.job.start', (input) => {
    const p = input.params as StartParams;
    if (!store.getProject(p.projectId)) return reject('not-found', 'project not found');
    if (p.sessionId && !store.getSession(p.sessionId)) return reject('not-found', 'session not found');
    const key = `shadow:${input.controllerDeviceId}:${input.idempotencyKey}`;
    input.assertAuthority(); // HIGH-2 linearization guard.
    const { job, duplicate } = store.claimIdempotentJob(key, { projectId: p.projectId, input: p.input, title: p.title ?? p.input.slice(0, 60), sessionId: p.sessionId });
    if (!duplicate) engine.launchJob(job.id); // post-commit launch (external)
    const view = buildJobView(store.getJob(job.id) ?? job);
    return view ? { ok: true, completion: completionOf(view) } : reject('project-error', 'job projection failed');
  });

  const cancelAdapter = mk('controller.job.cancel', (input) => {
    const p = input.params as CancelParams;
    const job = store.getJob(p.jobId);
    if (!job) return reject('not-found', 'job not found');
    // State-idempotent: cancel only advances a non-terminal job; a duplicate on an
    // already-terminal job is a no-op that returns the same completion.
    const terminal = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
    if (!terminal) { input.assertAuthority(); engine.cancelJob(p.jobId); } // HIGH-2 guard before the external/durable cancel
    const view = buildJobView(store.getJob(p.jobId) ?? job);
    return view ? { ok: true, completion: completionOf(view) } : reject('project-error', 'job projection failed');
  });

  const approvalAdapter = mk('controller.approval.respond', (input) => {
    const p = input.params as ApprovalParams;
    const approval = store.listApprovals().find((a) => a.id === p.approvalId);
    if (!approval) return reject('not-found', 'approval not found');
    const want = p.decision === 'approve' ? 'approved' : 'denied';
    if (approval.status !== 'pending' && approval.status !== want) return reject('conflict', `approval already ${approval.status}`);
    if (approval.status === 'pending') { input.assertAuthority(); store.resolveApproval(p.approvalId, want); } // HIGH-2 guard
    const view = buildApprovalView(store.listApprovals().find((a) => a.id === p.approvalId) ?? approval);
    return view ? { ok: true, completion: completionOf(view) } : reject('project-error', 'approval projection failed');
  });

  const questionAdapter = mk('controller.question.answer', (input) => {
    const p = input.params as QuestionParams;
    // Product-idempotent at the STORE boundary: one atomic claim binds the command key to
    // the disabled schedule + the deterministic answer Job. A crash after this product
    // effect but before the shadow receipt replays to the SAME Job (`duplicate:true`) —
    // never "question not pending". A conflicting new answer / already-answered question rejects.
    const key = `shadow:${input.controllerDeviceId}:${input.idempotencyKey}`;
    input.assertAuthority(); // HIGH-2 guard before the atomic durable claim.
    const res = store.claimIdempotentQuestionAnswer(key, { sessionId: p.sessionId, sourceJobId: p.sourceJobId, answer: p.answer, answerDigest: input.canonicalPayloadDigest });
    if ('conflict' in res) return res.conflict === 'session-not-found' ? reject('not-found', 'session not found') : reject('conflict', res.conflict);
    if (!res.duplicate) engine.launchJob(res.job.id); // launch only a freshly-claimed Job; boot recovery covers a crash before launch
    const view = buildJobView(res.job);
    return view ? { ok: true, completion: completionOf(view) } : reject('project-error', 'answer projection failed');
  });

  const autopilotAdapter = mk('controller.session.autopilot.set', (input) => {
    const p = input.params as AutopilotParams;
    if (!store.getSession(p.sessionId)) return reject('not-found', 'session not found');
    input.assertAuthority(); // HIGH-2 guard before the durable update.
    const session = store.updateSession(p.sessionId, { autoPilot: p.enabled });
    const view = buildSessionView(session);
    return view ? { ok: true, completion: completionOf(view) } : reject('project-error', 'session projection failed');
  });

  const cap = (c: ShadowCapability) => c;
  return {
    'controller.session.message': { effectMode: 'product-idempotent', requiredCapability: cap('session.message'), parse: parseMessage, adapter: messageAdapter },
    'controller.job.start': { effectMode: 'product-idempotent', requiredCapability: cap('job.start'), parse: parseStart, adapter: startAdapter },
    'controller.job.cancel': { effectMode: 'product-idempotent', requiredCapability: cap('job.cancel'), parse: parseCancel, adapter: cancelAdapter },
    'controller.approval.respond': { effectMode: 'product-idempotent', requiredCapability: cap('approval.respond'), parse: parseApproval, adapter: approvalAdapter },
    'controller.question.answer': { effectMode: 'product-idempotent', requiredCapability: cap('question.answer'), parse: parseQuestion, adapter: questionAdapter },
    'controller.session.autopilot.set': { effectMode: 'product-idempotent', requiredCapability: cap('session.autopilot.set'), parse: parseAutopilot, adapter: autopilotAdapter },
  };
}
