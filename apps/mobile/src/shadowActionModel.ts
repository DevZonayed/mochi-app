/**
 * shadowActionModel — Phase 3C3 PURE action view-model (no react-native / expo). Maps the
 * REAL command lifecycle → a truthful UI receipt phase, decides per-target eligibility from
 * the projection, and runs the local preflight gate. No optimistic domain mutation: a
 * transport ACK is NOT success — only an APPLIED state event (reconciled via the shadow
 * delta) is `done`; an ambiguous/lost result is `unknown` ("Still checking with your Mac").
 */
import type { CommandLifecycleState, CommandLifecycleStatus } from '@maestro/realtime';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import type { JobView, ApprovalView, QuestionView, ProjectView, SessionView } from './shadowProjectionSelectors';
import type { ActionFamilyKey } from './shadowActionCapabilities';
import { grantAllows } from './shadowActionCapabilities';

/** The truthful, user-facing receipt phase for one action attempt. */
export type ActionReceiptPhase =
  | 'idle'        // nothing sent
  | 'preparing'   // locally validated, about to enqueue
  | 'sent'        // enqueued / sent to the Mac (pending-local | sent)
  | 'working'     // the Mac accepted + is executing (accepted | executing | awaiting-state-event)
  | 'done'        // the domain effect is reconciled (applied state event)
  | 'failed'      // the Mac rejected it (rejected | unauthorized | conflict | stale-epoch | expired | cancelled | revoked)
  | 'unknown';    // result lost / ambiguous / timed out — never claim success

/** Map a durable command lifecycle status → a receipt phase (transport ACK ≠ done). */
export function receiptPhaseForStatus(status: CommandLifecycleStatus | undefined): ActionReceiptPhase {
  switch (status) {
    case undefined: return 'idle';
    case 'pending-local': case 'sent': return 'sent';
    case 'accepted': case 'executing': case 'awaiting-state-event': return 'working';
    case 'applied': return 'done';
    case 'rejected': case 'unauthorized': case 'conflict': case 'stale-epoch':
    case 'expired': case 'cancelled': case 'revoked': return 'failed';
    default: return 'unknown';
  }
}

export const TERMINAL_RECEIPTS: ReadonlySet<ActionReceiptPhase> = new Set<ActionReceiptPhase>(['done', 'failed', 'unknown']);
export function isTerminalReceipt(p: ActionReceiptPhase): boolean { return TERMINAL_RECEIPTS.has(p); }

export interface ActionReceipt {
  phase: ActionReceiptPhase;
  /** Bounded, generic status line for the UI (never a raw reject reason / internal id). */
  message: string;
  /**
   * Whether a SAFE retry button is offered. Phase 3C3 F1: a retry only ever starts a NEW
   * intentional attempt (a fresh idempotency key), so it is offered ONLY for terminal
   * failures the host proved DID NOT apply (`rejected` / `cancelled`). An `unknown`
   * (possibly-applied, ambiguous) result is NEVER retryable — there is no resend path that
   * could double an already-applied create; the background reconcile drives it to
   * `done`/failed, so the UI shows passive "Still checking with your Mac". Permission/fence
   * failures (`unauthorized`/`revoked`/`expired`/`stale-epoch`/`conflict`) are NOT retryable
   * until the authority refreshes.
   */
  retryable: boolean;
}

/**
 * Terminal failure statuses whose host outcome is PROVEN not-applied (pre-effect rejection or
 * cancellation), so a fresh-key retry cannot double an effect. `unknown` is deliberately absent
 * (ambiguous → possibly applied → no resend). Permission/fence failures are absent (need refresh).
 */
const RETRYABLE_FAILURE_STATUS: ReadonlySet<CommandLifecycleStatus> = new Set<CommandLifecycleStatus>(['rejected', 'cancelled']);

const RECEIPT_COPY: Record<ActionReceiptPhase, string> = {
  idle: '',
  preparing: 'Preparing…',
  sent: 'Sent to your Mac',
  working: 'Your Mac is working on it',
  done: 'Done',
  failed: 'Your Mac couldn’t complete it',
  unknown: 'Still checking with your Mac',
};

/**
 * Derive the UI receipt. `state` is the durable lifecycle (or undefined). `timedOut`
 * escalates a non-terminal in-flight command to `unknown` after the controller's bound.
 * We never surface `rejectReason` verbatim (bounded generic copy only).
 */
export function deriveReceipt(state: CommandLifecycleState | undefined, opts?: { timedOut?: boolean; preparing?: boolean }): ActionReceipt {
  if (opts?.preparing && !state) return { phase: 'preparing', message: RECEIPT_COPY.preparing, retryable: false };
  let phase = receiptPhaseForStatus(state?.status);
  if (opts?.timedOut && (phase === 'sent' || phase === 'working')) phase = 'unknown';
  // Phase 3C3 F1: `unknown` is NEVER retryable (possibly-applied → no resend). A `failed`
  // is retryable ONLY for a proven-not-applied status (`rejected`/`cancelled`); a fresh-key
  // retry of those cannot double an effect. Everything else → no button.
  const retryable = phase === 'failed' && !!state && RETRYABLE_FAILURE_STATUS.has(state.status);
  return { phase, message: RECEIPT_COPY[phase], retryable };
}

// ── target eligibility (from the projection only) ────────────────────────────────

const CANCELLABLE_JOB = new Set(['running', 'pending', 'queued', 'starting']);
/** A job is cancellable iff its projected status is a live/non-terminal one. */
export function jobCancellable(job: Pick<JobView, 'status'> | undefined | null): boolean {
  return !!job && typeof job.status === 'string' && CANCELLABLE_JOB.has(job.status);
}
export function approvalActionable(a: Pick<ApprovalView, 'status'> | undefined | null): boolean {
  return !!a && (a.status ?? 'pending') === 'pending';
}
export function questionActionable(q: Pick<QuestionView, 'status' | 'sourceJobId'> | undefined | null): boolean {
  // Answerable only when pending AND the projection carries the source job id the command needs.
  return !!q && (q.status ?? 'pending') === 'pending' && typeof q.sourceJobId === 'string' && q.sourceJobId.length > 0;
}
export function projectStartable(p: Pick<ProjectView, 'id'> | undefined | null): boolean {
  return !!p && typeof p.id === 'string' && p.id.length > 0;
}
export function sessionMessageable(s: Pick<SessionView, 'id' | 'archived'> | undefined | null): boolean {
  return !!s && typeof s.id === 'string' && s.id.length > 0 && s.archived !== true;
}

// ── preflight gate ───────────────────────────────────────────────────────────────

export interface ActionPreflight {
  online: boolean;
  locked: boolean;          // revoked / repair / purge-pending (fail-closed)
  granted: readonly ShadowCapability[] | null;  // current verified grant (never requested/static)
  family: ActionFamilyKey;
  targetEligible: boolean;
}
export type PreflightResult = { ok: true } | { ok: false; reason: 'offline' | 'locked' | 'no-grant' | 'capability' | 'target' };

/**
 * The action gate. Fail-closed order: locked (revoked/repair/purge) → offline (read-only,
 * no enqueue) → a verified grant exists → the exact capability is granted → the target is
 * still eligible. A control is RENDERED only when this would pass on capability+eligibility;
 * offline disables it (no dead button).
 */
export function preflight(p: ActionPreflight): PreflightResult {
  if (p.locked) return { ok: false, reason: 'locked' };
  if (!p.online) return { ok: false, reason: 'offline' };
  if (!p.granted) return { ok: false, reason: 'no-grant' };
  if (!grantAllows(p.granted, p.family)) return { ok: false, reason: 'capability' };
  if (!p.targetEligible) return { ok: false, reason: 'target' };
  return { ok: true };
}

/** Bounded generic copy for a blocked preflight (never leaks internals). */
export function blockedMessage(reason: 'offline' | 'locked' | 'no-grant' | 'capability' | 'target'): string {
  switch (reason) {
    case 'offline': return 'Offline — reconnect to your Mac to run actions.';
    case 'locked': return 'Access ended — reconnect to continue.';
    case 'no-grant': case 'capability': return 'This device doesn’t have permission for this action.';
    case 'target': return 'This isn’t available anymore.';
  }
}
