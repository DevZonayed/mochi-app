/**
 * TEST-ONLY static-array action API. Kept OUT of the production graph
 * (`shadowActionBuilders.ts` / `shadowProductionController*.ts` never import this file), so
 * the shipped iOS/Android bundle contains NO arbitrary-capability constructor — a snapshot
 * could stay elevated after a host revoke/downgrade. Unit tests that want to exercise the
 * builder/gate logic against a fixed set use this; production uses `VerifiedShadowActionApi`.
 */
import { requiredCapabilityForMethod, type ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import { draft, transmit, type ShadowActionSender, type ActionResult, type ControllerMethod, type Draft } from './shadowActionBuilders';

export class ShadowActionApi {
  private readonly caps: ReadonlySet<ShadowCapability>;
  constructor(private readonly sender: ShadowActionSender, approvedCapabilities: readonly ShadowCapability[]) {
    this.caps = new Set(approvedCapabilities);
  }

  can(method: ControllerMethod): boolean {
    const cap = requiredCapabilityForMethod(method);
    return cap !== null && this.caps.has(cap);
  }

  private dispatch(d: Draft): Promise<ActionResult> {
    if (!d.ok) return Promise.resolve({ ok: false, reason: d.reason });
    if (!this.can(d.method)) return Promise.resolve({ ok: false, reason: `capability-missing:${requiredCapabilityForMethod(d.method) ?? 'unknown'}` });
    return transmit(this.sender, d.method, d.params);
  }

  sendMessage(sessionId: string, text: string): Promise<ActionResult> { return this.dispatch(draft.message(sessionId, text)); }
  startJob(projectId: string, input: string, opts?: { title?: string; sessionId?: string }): Promise<ActionResult> { return this.dispatch(draft.start(projectId, input, opts)); }
  cancelJob(jobId: string): Promise<ActionResult> { return this.dispatch(draft.cancel(jobId)); }
  respondApproval(approvalId: string, decision: 'approve' | 'deny'): Promise<ActionResult> { return this.dispatch(draft.approval(approvalId, decision)); }
  answerQuestion(sessionId: string, sourceJobId: string, answer: string): Promise<ActionResult> { return this.dispatch(draft.question(sessionId, sourceJobId, answer)); }
  setAutopilot(sessionId: string, enabled: boolean): Promise<ActionResult> { return this.dispatch(draft.autopilot(sessionId, enabled)); }
}
