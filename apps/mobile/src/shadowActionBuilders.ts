/**
 * shadowActionBuilders — Phase 3A2b1 Section 7 mobile ACTION API (NO UI). Typed,
 * capability-gated command builders for a future UI layer: each refuses locally when
 * the controller's approved capability set lacks the required capability or the payload
 * is invalid, generates a stable idempotency/command id, and sends via the accepted
 * `ShadowControllerService` (which the host revalidates capability/fence at execution).
 *
 * The ONLY production form is `VerifiedShadowActionApi`: it holds NO capability array; it
 * derives the approved set DYNAMICALLY from a verified provider
 * (`verifiedApprovedCapabilities()`) on EVERY call, so a revoke/downgrade/lock/expiry/
 * re-enrollment is reflected on the very next action with no app restart, and any
 * unavailable/locked/tampered grant fails closed (sends NOTHING). There is deliberately NO
 * static-array constructor in this shipped module — a snapshot could stay elevated after a
 * revoke. (A static test helper lives in `shadowActionBuilders.testonly.ts`, which
 * production never imports.)
 *
 * The local check is a fast-fail UX guard AND a fail-closed gate — but the host is still
 * authoritative and re-checks the approved set from its own record before any effect.
 */
import { CONTROLLER_METHOD_CAPABILITY, type ShadowCapability, requiredCapabilityForMethod } from '@maestro/realtime/shadowCapabilities';

/** The minimal surface these builders need from `ShadowControllerService`. */
export interface ShadowActionSender {
  sendCommand(method: string, params: unknown, opts?: { idempotencyKey?: string }): Promise<{ commandId: string }>;
}

/**
 * The verified dynamic capability source (satisfied by `ShadowMobileEnrollmentRuntime`).
 * Returns the CURRENT verified approved set, or `null` when there is no usable grant
 * (revoked / locked / expired / tampered / not yet enrolled). Called on EACH action.
 */
export interface VerifiedCapabilityProvider {
  verifiedApprovedCapabilities(): Promise<ShadowCapability[] | null>;
}

export type ActionResult = { ok: true; commandId: string } | { ok: false; reason: string };

export type ControllerMethod = keyof typeof CONTROLLER_METHOD_CAPABILITY;
export type Draft = { ok: true; method: ControllerMethod; params: Record<string, unknown> } | { ok: false; reason: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const okId = (v: unknown): v is string => typeof v === 'string' && SAFE_ID.test(v);
const okText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const bad = (reason: string): Draft => ({ ok: false, reason });

// ── shared per-method param drafters (validate → {method, params}); reused by the API ──
export const draft = {
  message: (sessionId: string, text: string): Draft =>
    (!okId(sessionId) || !okText(text, 16_000)) ? bad('bad-params') : { ok: true, method: 'controller.session.message', params: { sessionId, text } },
  start: (projectId: string, input: string, opts?: { title?: string; sessionId?: string }): Draft => {
    if (!okId(projectId) || !okText(input, 16_000)) return bad('bad-params');
    if (opts?.sessionId && !okId(opts.sessionId)) return bad('bad-session');
    if (opts?.title && !okText(opts.title, 512)) return bad('bad-title');
    return { ok: true, method: 'controller.job.start', params: { projectId, input, title: opts?.title, sessionId: opts?.sessionId } };
  },
  cancel: (jobId: string): Draft =>
    !okId(jobId) ? bad('bad-params') : { ok: true, method: 'controller.job.cancel', params: { jobId } },
  approval: (approvalId: string, decision: 'approve' | 'deny'): Draft =>
    (!okId(approvalId) || (decision !== 'approve' && decision !== 'deny')) ? bad('bad-params') : { ok: true, method: 'controller.approval.respond', params: { approvalId, decision } },
  question: (sessionId: string, sourceJobId: string, answer: string): Draft =>
    (!okId(sessionId) || !okId(sourceJobId) || !okText(answer, 8_000)) ? bad('bad-params') : { ok: true, method: 'controller.question.answer', params: { sessionId, sourceJobId, answer } },
  autopilot: (sessionId: string, enabled: boolean): Draft =>
    (!okId(sessionId) || typeof enabled !== 'boolean') ? bad('bad-params') : { ok: true, method: 'controller.session.autopilot.set', params: { sessionId, enabled } },
};

export async function transmit(sender: ShadowActionSender, method: ControllerMethod, params: Record<string, unknown>, idempotencyKey?: string): Promise<ActionResult> {
  try {
    const { commandId } = await sender.sendCommand(method, params, idempotencyKey ? { idempotencyKey } : undefined);
    return { ok: true, commandId };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? 'send-failed' };
  }
}

/**
 * PRODUCTION capability-gated action API. Holds NO capability array — it queries the
 * verified provider on EVERY call, so a revoke/downgrade/lock/expiry/re-enrollment (which
 * flips `verifiedApprovedCapabilities()` to a smaller set or `null`) is honored on the
 * next action with no restart. Fails closed (sends nothing) when the set is `null` or
 * lacks the required capability. Same typed six-method surface as {@link ShadowActionApi}.
 */
export class VerifiedShadowActionApi {
  constructor(private readonly sender: ShadowActionSender, private readonly provider: VerifiedCapabilityProvider) {}

  /** Resolve + check the CURRENT verified capability for `method` (fresh each call). */
  async can(method: ControllerMethod): Promise<boolean> {
    const cap = requiredCapabilityForMethod(method);
    if (cap === null) return false;
    const caps = await this.provider.verifiedApprovedCapabilities();
    return caps !== null && caps.includes(cap);
  }

  private async dispatch(d: Draft, idempotencyKey?: string): Promise<ActionResult> {
    if (!d.ok) return { ok: false, reason: d.reason };
    const cap = requiredCapabilityForMethod(d.method);
    // Re-derive the verified set on THIS call — never a snapshot.
    const caps = await this.provider.verifiedApprovedCapabilities();
    if (caps === null) return { ok: false, reason: 'capability-unavailable' }; // no/locked/revoked/tampered grant → send nothing
    if (cap === null || !caps.includes(cap)) return { ok: false, reason: `capability-missing:${cap ?? 'unknown'}` };
    // The attempt-stable idempotency key (Phase 3C3 F1) is passed through UNCHANGED so a retry of
    // the SAME logical attempt is exactly-once at the host; the same canonical method+payload is
    // preserved for a same-key retry (a host payload-digest conflict rejects a mismatched mutation).
    return transmit(this.sender, d.method, d.params, idempotencyKey);
  }

  sendMessage(sessionId: string, text: string, idempotencyKey?: string): Promise<ActionResult> { return this.dispatch(draft.message(sessionId, text), idempotencyKey); }
  startJob(projectId: string, input: string, opts?: { title?: string; sessionId?: string }, idempotencyKey?: string): Promise<ActionResult> { return this.dispatch(draft.start(projectId, input, opts), idempotencyKey); }
  cancelJob(jobId: string, idempotencyKey?: string): Promise<ActionResult> { return this.dispatch(draft.cancel(jobId), idempotencyKey); }
  respondApproval(approvalId: string, decision: 'approve' | 'deny', idempotencyKey?: string): Promise<ActionResult> { return this.dispatch(draft.approval(approvalId, decision), idempotencyKey); }
  answerQuestion(sessionId: string, sourceJobId: string, answer: string, idempotencyKey?: string): Promise<ActionResult> { return this.dispatch(draft.question(sessionId, sourceJobId, answer), idempotencyKey); }
  setAutopilot(sessionId: string, enabled: boolean, idempotencyKey?: string): Promise<ActionResult> { return this.dispatch(draft.autopilot(sessionId, enabled), idempotencyKey); }
}
