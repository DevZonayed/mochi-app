/**
 * shadowActionController — Phase 3C3 observable action layer over the accepted
 * `ProductionShadowController`. It runs the six canonical controller actions through the
 * PRODUCTION path (verified capability-gated `actions.*` → encrypted command → relay durable
 * queue → host executor/audit → state event) — ZERO direct REST. It adds only UX-layer
 * concerns: preflight, at-most-one-in-flight per exact target/action (duplicate taps
 * coalesce; a fresh intentional attempt gets a new command), truthful lifecycle receipts
 * reconciled from real events (never optimistic), an ambiguity timeout → `unknown`, and a
 * generation guard so a revoke/expiry/account/host change discards stale attempts.
 *
 * Node-testable: every dependency is injected; the production wiring lives in
 * `shadowActionRuntime.ts`.
 */
import type { ProductionShadowController } from './shadowProductionControllerCore';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import type { ActionFamilyKey } from './shadowActionCapabilities';
import {
  deriveReceipt, preflight, jobCancellable, approvalActionable, questionActionable,
  projectStartable, sessionMessageable, type ActionReceipt, type PreflightResult,
} from './shadowActionModel';
import { newIdempotencyKey } from './shadowActionIdempotency';

/** Default CSPRNG for the attempt idempotency key (production injects expo-crypto). */
function defaultRandomBytes(n: number): Uint8Array {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } };
  if (g.crypto?.getRandomValues) return g.crypto.getRandomValues(new Uint8Array(n));
  throw new Error('no CSPRNG available; inject newIdempotencyKey');
}

export type ActionIntent =
  | { family: 'start-job'; projectId: string; input: string; title?: string; sessionId?: string }
  | { family: 'cancel-job'; jobId: string }
  | { family: 'respond-approval'; approvalId: string; decision: 'approve' | 'deny' }
  | { family: 'answer-question'; sessionId: string; sourceJobId: string; answer: string }
  | { family: 'send-message'; sessionId: string; text: string }
  | { family: 'set-autopilot'; sessionId: string; enabled: boolean };

/** The exact primary target id for an intent (defines the at-most-one-in-flight key). */
export function targetId(intent: ActionIntent): string {
  switch (intent.family) {
    case 'start-job': return intent.projectId;
    case 'cancel-job': return intent.jobId;
    case 'respond-approval': return intent.approvalId;
    case 'answer-question': return intent.sessionId;
    case 'send-message': return intent.sessionId;
    case 'set-autopilot': return intent.sessionId;
  }
}
export function attemptKey(intent: ActionIntent): string { return `${intent.family}:${targetId(intent)}`; }

interface Attempt {
  key: string;
  /** The attempt's ONE opaque idempotency key (generated once; reused by coalesced duplicate
      taps; NEVER reused by a retry — a retry is a new intentional attempt with a new key). */
  idempotencyKey: string;
  commandId: string | null;   // null while preparing (before the command id lands)
  preparing: boolean;
  timedOut: boolean;
  gen: number;
  timer: unknown;
}

export interface ShadowActionDeps {
  /** The live production controller (null when offline/locked/not-content). */
  getController(): ProductionShadowController | null;
  /** The CURRENT verified approved capabilities (never a requested/static list); null when no grant. */
  getGranted(): Promise<readonly ShadowCapability[] | null>;
  isOnline(): boolean;
  isLocked(): boolean;
  now?(): number;
  /** ms with no terminal lifecycle before an in-flight command is reported `unknown`. */
  ambiguityMs?: number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(h: unknown): void;
  /** Mint a fresh opaque attempt idempotency key (production: expo-crypto CSPRNG). */
  newIdempotencyKey?(): string;
}

const DEFAULT_AMBIGUITY_MS = 20_000;

export class ShadowActionController {
  private readonly attempts = new Map<string, Attempt>();
  private readonly listeners = new Set<() => void>();
  private controllerUnsub: (() => void) | null = null;
  private boundController: ProductionShadowController | null = null;
  private gen = 0;
  private readonly now: () => number;
  private readonly ambiguityMs: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly newKey: () => string;

  constructor(private readonly deps: ShadowActionDeps) {
    this.now = deps.now ?? Date.now;
    this.ambiguityMs = deps.ambiguityMs ?? DEFAULT_AMBIGUITY_MS;
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.newKey = deps.newIdempotencyKey ?? (() => newIdempotencyKey(defaultRandomBytes));
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit(): void { for (const fn of [...this.listeners]) { try { fn(); } catch { /* isolate */ } } }

  /** Re-subscribe to the current controller's change stream so receipts reconcile on deltas. */
  private bind(): ProductionShadowController | null {
    const c = this.deps.getController();
    if (c !== this.boundController) {
      if (this.controllerUnsub) { try { this.controllerUnsub(); } catch { /* ignore */ } this.controllerUnsub = null; }
      this.boundController = c;
      if (c) this.controllerUnsub = c.onChange(() => this.emit());
    }
    return c;
  }

  /** Generation bump: a revoke/expiry/account/host/grant change discards all in-flight attempts. */
  reset(): void {
    this.gen += 1;
    for (const a of this.attempts.values()) if (a.timer) this.clearT(a.timer);
    this.attempts.clear();
    if (this.controllerUnsub) { try { this.controllerUnsub(); } catch { /* ignore */ } this.controllerUnsub = null; }
    this.boundController = null;
    this.emit();
  }

  /** Compute per-target eligibility from the live projection (never a stale/optimistic view). */
  private targetEligible(intent: ActionIntent, c: ProductionShadowController): boolean {
    const proj = c.projection;
    switch (intent.family) {
      case 'start-job': return projectStartable(proj.listProjects().find((p) => p.id === intent.projectId));
      case 'cancel-job': {
        for (const p of proj.listProjects()) { const j = proj.projectJobs(p.id).find((x) => x.id === intent.jobId); if (j) return jobCancellable(j); }
        return false;
      }
      case 'respond-approval': return approvalActionable(proj.pendingApprovals().find((a) => a.id === intent.approvalId));
      case 'answer-question': return questionActionable(proj.pendingQuestions().find((q) => q.sessionId === intent.sessionId && q.sourceJobId === intent.sourceJobId));
      case 'send-message': case 'set-autopilot': {
        for (const p of proj.listProjects()) { const s = proj.projectSessions(p.id).find((x) => x.id === intent.sessionId); if (s) return sessionMessageable(s); }
        return false;
      }
    }
  }

  /** Preflight WITHOUT sending — used to decide whether a control renders/enabled. */
  async check(intent: ActionIntent): Promise<PreflightResult> {
    const c = this.bind();
    const granted = await this.deps.getGranted();
    return preflight({
      online: this.deps.isOnline(), locked: this.deps.isLocked(), granted,
      family: familyKey(intent), targetEligible: !!c && this.targetEligible(intent, c),
    });
  }

  /**
   * Run an action. Duplicate taps while an attempt is non-terminal COALESCE (return the same
   * commandId). A fresh call after a terminal receipt starts a new attempt/commandId.
   */
  async run(intent: ActionIntent): Promise<{ ok: true; commandId: string | 'coalesced' } | { ok: false; reason: string }> {
    const key = attemptKey(intent);
    const existing = this.attempts.get(key);
    if (existing && !this.isTerminal(existing)) return { ok: true, commandId: existing.commandId ?? 'coalesced' };

    // Reserve the attempt SYNCHRONOUSLY so concurrent duplicate taps coalesce onto it
    // (before any async preflight/invoke) — and onto its ONE idempotency key. Removed if
    // preflight fails.
    const myGen = this.gen;
    const attempt: Attempt = { key, idempotencyKey: this.newKey(), commandId: null, preparing: true, timedOut: false, gen: myGen, timer: null };
    this.attempts.set(key, attempt);
    this.emit();

    const c = this.bind();
    const granted = await this.deps.getGranted();
    if (myGen !== this.gen) { this.attempts.delete(key); return { ok: false, reason: 'stale' }; }
    const pf = preflight({ online: this.deps.isOnline(), locked: this.deps.isLocked(), granted, family: familyKey(intent), targetEligible: !!c && this.targetEligible(intent, c) });
    if (!pf.ok) { if (this.attempts.get(key) === attempt) this.attempts.delete(key); this.emit(); return { ok: false, reason: pf.reason }; }
    if (!c) { this.attempts.delete(key); this.emit(); return { ok: false, reason: 'offline' }; }

    let res: { ok: true; commandId: string } | { ok: false; reason: string };
    try { res = await this.invoke(c, intent, attempt.idempotencyKey); }
    catch (e) { res = { ok: false, reason: (e as Error)?.message ?? 'send-failed' }; }

    if (myGen !== this.gen) { this.attempts.delete(key); return { ok: false, reason: 'stale' }; }
    if (!res.ok) { this.attempts.delete(key); this.emit(); return { ok: false, reason: res.reason }; }

    attempt.preparing = false;
    attempt.commandId = res.commandId;
    // Ambiguity timeout: if no terminal lifecycle lands, surface `unknown` (never success).
    attempt.timer = this.setT(() => { if (this.attempts.get(key) === attempt && attempt.gen === this.gen) { attempt.timedOut = true; this.emit(); } }, this.ambiguityMs);
    this.emit();
    return { ok: true, commandId: res.commandId };
  }

  /**
   * Retry — Phase 3C3 F1. A retry is ONLY a fresh intentional attempt (a NEW idempotency key),
   * offered EXCLUSIVELY for a terminal failure the host proved DID NOT apply (`rejected` /
   * `cancelled`; see `deriveReceipt.retryable`). It is REFUSED for an `unknown` (possibly-
   * applied → a new-key resend could double a create) and for permission/fence failures —
   * there is no fresh-key ambiguous retry path. When refused, the current receipt is left
   * intact (the background reconcile keeps checking).
   */
  async retry(intent: ActionIntent): Promise<{ ok: true; commandId: string | 'coalesced' } | { ok: false; reason: string }> {
    const key = attemptKey(intent);
    const a = this.attempts.get(key);
    if (!a) return this.run(intent); // no prior attempt → a fresh action
    if (!this.isTerminal(a)) return { ok: true, commandId: a.commandId ?? 'coalesced' }; // in-flight → coalesce
    if (!this.receipt(key).retryable) return { ok: false, reason: 'not-retryable' }; // unknown / permission → no unsafe resend
    if (a.timer) this.clearT(a.timer);
    this.attempts.delete(key); // proven no-effect → a brand-new attempt (new idempotency key)
    return this.run(intent);
  }

  private invoke(c: ProductionShadowController, intent: ActionIntent, idempotencyKey: string): Promise<{ ok: true; commandId: string } | { ok: false; reason: string }> {
    const a = c.actions;
    switch (intent.family) {
      case 'start-job': return a.startJob(intent.projectId, intent.input, { title: intent.title, sessionId: intent.sessionId }, idempotencyKey);
      case 'cancel-job': return a.cancelJob(intent.jobId, idempotencyKey);
      case 'respond-approval': return a.respondApproval(intent.approvalId, intent.decision, idempotencyKey);
      case 'answer-question': return a.answerQuestion(intent.sessionId, intent.sourceJobId, intent.answer, idempotencyKey);
      case 'send-message': return a.sendMessage(intent.sessionId, intent.text, idempotencyKey);
      case 'set-autopilot': return a.setAutopilot(intent.sessionId, intent.enabled, idempotencyKey);
    }
  }

  /** Value-stable receipt cache so React `useSyncExternalStore` snapshots are referentially
      stable until the receipt actually changes (avoids a render loop). */
  private readonly receiptCache = new Map<string, ActionReceipt>();
  private static readonly IDLE: ActionReceipt = deriveReceipt(undefined);

  /** The current truthful receipt for a target/action (stable ref; idle if no attempt). */
  receipt(key: string): ActionReceipt {
    const a = this.attempts.get(key);
    let next: ActionReceipt;
    if (!a) next = ShadowActionController.IDLE;
    else if (a.preparing) next = deriveReceipt(undefined, { preparing: true });
    else {
      const c = this.boundController ?? this.deps.getController();
      next = deriveReceipt(a.commandId && c ? c.commandStatus(a.commandId) : undefined, { timedOut: a.timedOut });
    }
    const prev = this.receiptCache.get(key);
    if (prev && prev.phase === next.phase && prev.message === next.message && prev.retryable === next.retryable) return prev;
    this.receiptCache.set(key, next);
    return next;
  }
  receiptFor(intent: ActionIntent): ActionReceipt { return this.receipt(attemptKey(intent)); }

  private isTerminal(a: Attempt): boolean {
    if (a.preparing) return false;
    const c = this.boundController ?? this.deps.getController();
    const r = deriveReceipt(a.commandId && c ? c.commandStatus(a.commandId) : undefined, { timedOut: a.timedOut });
    return r.phase === 'done' || r.phase === 'failed' || r.phase === 'unknown';
  }

  dispose(): void {
    for (const a of this.attempts.values()) if (a.timer) this.clearT(a.timer);
    this.attempts.clear();
    if (this.controllerUnsub) { try { this.controllerUnsub(); } catch { /* ignore */ } }
    this.listeners.clear();
  }
}

function familyKey(intent: ActionIntent): ActionFamilyKey { return intent.family; }
