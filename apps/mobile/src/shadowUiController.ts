/**
 * shadowUiController — Phase 3C2 observable controller store bridging the REAL
 * enrollment runtime + production controller + auth lifecycle into a single
 * `ShadowUiState` for the read-only shadow UI. Node-testable: every Expo/graph
 * dependency is injected through {@link ShadowUiControllerDeps}, with production
 * defaults wired to the accepted factory (`getProductionShadowController`,
 * `getShadowMobileEnrollmentRuntime`, the durable purge gate, auth subscriptions).
 *
 * It owns NO cache of its own — reads flow strictly through the accepted
 * `ShadowProjectionView` on the durable controller, and it is gated so projection
 * content is handed out ONLY while the authority is live (`online`/`offline`). A
 * revoke / expiry / account-switch / host-switch / signout synchronously blanks the
 * state to a locked `loading` phase BEFORE the async durable purge runs — so no
 * frame of a prior account's projects can ever render.
 *
 * The enrollment gate is driven from real runtime calls only:
 *   beginEnrollment(bootstrap) → parseBootstrap → confirming
 *   confirm()                  → requestEnrollment → awaiting-host (poll loop)
 *   [poll] approved            → build controller + connect → online
 *   cancel()/retry()           → runtime.reset() → unenrolled
 * There is NO local boolean that can force `online` — only a verified grant +
 * successful bootstrap/connect reaches it.
 */
import type { AccountEnrollmentMac, EnrollmentStatus, EnrollmentState } from './shadowEnrollmentClient';
import type { ProductionShadowController } from './shadowProductionControllerCore';
import type { ProjectView, SessionView, JobView, ApprovalView, QuestionView, ScheduleView } from './shadowProjectionSelectors';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import { deriveShadowUiState, projectionVisible, type ShadowUiState, type ShadowUiInputs } from './shadowUiModel';

/** The subset of `ShadowMobileEnrollmentRuntime` the gate drives (injectable for tests). */
export interface EnrollmentRuntimeLike {
  status(): EnrollmentStatus;
  restore(): Promise<EnrollmentStatus>;
  listAccountMacs(): Promise<{ ok: true; macs: AccountEnrollmentMac[] } | { ok: false; reason: string }>;
  startAccountEnrollment(hostDeviceId: string): Promise<{ ok: true; hostFingerprint: string; expiresAt: number } | { ok: false; reason: string }>;
  parseBootstrap(raw: string): Promise<{ ok: true; hostFingerprint: string; expiresAt: number } | { ok: false; reason: string }>;
  requestEnrollment(): Promise<{ ok: true } | { ok: false; reason: string }>;
  poll(): Promise<EnrollmentState>;
  reset(): Promise<void>;
  /** Phase 3C3: the CURRENT verified granted capabilities (fresh, never a snapshot). */
  verifiedApprovedCapabilities(): Promise<ShadowCapability[] | null>;
  /** Phase 3C3: set the capability set to request on the next enrollment (idle only). */
  setRequestedCapabilities(caps: readonly ShadowCapability[]): boolean;
}

export interface ShadowUiControllerDeps {
  isAuthed(): boolean;
  getRuntime(): Promise<EnrollmentRuntimeLike>;
  getController(): Promise<ProductionShadowController | null>;
  bootstrapController(): void;
  resetController(): void;
  awaitIdle(): Promise<void>;
  subscribeSession(cb: () => void): () => void;
  subscribeActiveHost(cb: () => void): () => void;
  now(): number;
  /** Poll interval while awaiting host approval (ms). */
  pollMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/** The read-only projection surface the screens consume (gated by authority). */
export interface ShadowUiProjection {
  projects(): ProjectView[];
  projectSessions(projectId: string): SessionView[];
  projectJobs(projectId: string): JobView[];
  session(sessionId: string): SessionView | undefined;
  job(jobId: string): JobView | undefined;
  pendingApprovals(): ApprovalView[];
  pendingQuestions(): QuestionView[];
  schedules(): ScheduleView[];
}

const EMPTY_PROJECTION: ShadowUiProjection = {
  projects: () => [], projectSessions: () => [], projectJobs: () => [],
  session: () => undefined, job: () => undefined,
  pendingApprovals: () => [], pendingQuestions: () => [], schedules: () => [],
};

const DEFAULT_POLL_MS = 2_500;

function loadingState(now: number, authed: boolean): ShadowUiState {
  return deriveShadowUiState({ authed, purgePending: true, enrollment: null, service: null, lastActivityAt: null, now });
}

export class ShadowUiController {
  private state: ShadowUiState;
  private readonly listeners = new Set<() => void>();
  private runtime: EnrollmentRuntimeLike | null = null;
  private controller: ProductionShadowController | null = null;
  /** Phase 3C3: cached CURRENT verified granted set (for rendering which actions show). The
      action controller re-checks fresh on every action; this is a display hint only. */
  private granted: ShadowCapability[] | null = null;
  private controllerUnsub: (() => void) | null = null;
  private pollHandle: unknown = null;
  private purgePending = false;
  private started = false;
  private disposed = false;
  private gen = 0; // bumped on identity change; discards stale async results
  private readonly unsubs: Array<() => void> = [];
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly pollMs: number;

  constructor(private readonly deps: ShadowUiControllerDeps) {
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.state = deriveShadowUiState({ authed: deps.isAuthed(), purgePending: false, enrollment: null, service: null, lastActivityAt: null, now: deps.now() });
  }

  // ── observable surface (React useSyncExternalStore) ────────────────────────
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): ShadowUiState => this.state;

  private emit(next: ShadowUiState): void {
    this.state = next;
    for (const fn of [...this.listeners]) { try { fn(); } catch { /* isolate a bad listener */ } }
  }

  /** Gated projection: content is handed out ONLY while the authority is live. */
  projection(): ShadowUiProjection {
    if (!this.controller || !projectionVisible(this.state.phase)) return EMPTY_PROJECTION;
    const view = this.controller.projection;
    return {
      projects: () => view.listProjects(),
      projectSessions: (id) => view.projectSessions(id),
      projectJobs: (id) => view.projectJobs(id),
      session: (id) => this.allSessions().find((s) => s.id === id),
      job: (id) => this.allJobs().find((j) => j.id === id),
      pendingApprovals: () => view.pendingApprovals(),
      pendingQuestions: () => view.pendingQuestions(),
      schedules: () => view.schedules(),
    };
  }

  private allSessions(): SessionView[] {
    // Sessions are stored per-project; the projection view exposes them by project.
    // For a by-id lookup we scan the current projects' sessions (bounded, read-only).
    if (!this.controller) return [];
    const out: SessionView[] = [];
    for (const p of this.controller.projection.listProjects()) out.push(...this.controller.projection.projectSessions(p.id));
    return out;
  }
  private allJobs(): JobView[] {
    if (!this.controller) return [];
    const out: JobView[] = [];
    for (const p of this.controller.projection.listProjects()) out.push(...this.controller.projection.projectJobs(p.id));
    return out;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubs.push(this.deps.subscribeSession(() => this.onIdentityChange()));
    this.unsubs.push(this.deps.subscribeActiveHost(() => this.onIdentityChange()));
    void this.refresh();
  }

  /**
   * Account switch / host switch / signout: synchronously blank to a locked
   * `loading` phase (zero stale flash) BEFORE the async durable purge, drop the
   * controller ref + poll loop, then re-resolve once the lifecycle chain (which
   * App.tsx also drives via reset+bootstrap) has settled.
   */
  onIdentityChange(): void {
    this.gen += 1;
    this.stopPoll();
    this.detachController();
    this.runtime = null; // the factory singleton is dropped on reset — re-fetch the fresh one
    this.purgePending = true;
    this.emit(loadingState(this.deps.now(), this.deps.isAuthed())); // synchronous locked gate
    void (async () => {
      const myGen = this.gen;
      try { await this.deps.awaitIdle(); } catch { /* keep locked; refresh re-gates */ }
      if (myGen !== this.gen || this.disposed) return;
      this.purgePending = false;
      await this.refresh();
    })();
  }

  private detachController(): void {
    if (this.controllerUnsub) { try { this.controllerUnsub(); } catch { /* best effort */ } this.controllerUnsub = null; }
    this.controller = null;
  }

  /**
   * Recompute the truthful snapshot from the REAL runtime + controller status. Builds
   * / connects the durable controller when a grant is live; drives the approval poll
   * loop while awaiting host; triggers the durable purge when authority is lost.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const myGen = this.gen;
    const authed = this.deps.isAuthed();
    if (!authed) { this.stopPoll(); this.detachController(); this.emit(this.derive(null, null)); return; }

    let runtime: EnrollmentRuntimeLike;
    try { runtime = await this.ensureRuntime(); } catch { this.emit(loadingState(this.deps.now(), authed)); return; }
    if (myGen !== this.gen || this.disposed) return;

    const status = runtime.status();

    // Authority lost (host revoke / integrity lock / explicit revoked) → durably purge,
    // synchronously blanking content (triggerPurge emits the locked gate).
    if (this.authorityLost(status)) { this.triggerPurge(); return; }

    if (this.grantLive(status.state)) {
      // A live grant MUST resolve to a real durable controller to show any content.
      if (!this.controller) {
        await this.acquireController(myGen);
        if (myGen !== this.gen || this.disposed) return;
      }
      if (!this.controller) {
        // Grant looks live but no controller could be built — a durable purge is pending
        // or the build is blocked. FAIL CLOSED: gate to locked/loading, never show cache.
        this.purgePending = true;
        this.emit(loadingState(this.deps.now(), this.deps.isAuthed()));
        return;
      }
      this.purgePending = false;
      // Refresh the display-only granted set (the action controller re-checks fresh per action).
      try { const g = await runtime.verifiedApprovedCapabilities(); if (myGen === this.gen && !this.disposed) this.granted = g; }
      catch { this.granted = null; }
      if (myGen !== this.gen || this.disposed) return;
    } else {
      if (this.controller) this.detachController();
      this.granted = null;
      // A clean, non-locked state (idle/unenrolled/confirming/…) clears any purge gate.
      this.purgePending = false;
    }

    // Awaiting host approval → ensure the poll loop is running (truthful wait).
    if (status.state === 'awaiting-host') this.startPoll();
    else this.stopPoll();

    this.emit(this.derive(status, this.controller?.status() ?? null));
  }

  private derive(enrollment: EnrollmentStatus | null, service: import('./shadowControllerService').ControllerServiceStatus | null): ShadowUiState {
    const inputs: ShadowUiInputs = {
      authed: this.deps.isAuthed(),
      purgePending: this.purgePending,
      enrollment,
      service,
      lastActivityAt: this.computeLastActivity(),
      granted: this.granted,
      now: this.deps.now(),
    };
    return deriveShadowUiState(inputs);
  }

  // ── Phase 3C3 action-layer accessors ──────────────────────────────────────────
  /** The live production controller ONLY when content is visible (online/offline). */
  liveController(): ProductionShadowController | null {
    return this.controller && projectionVisible(this.state.phase) ? this.controller : null;
  }
  /** The CURRENT verified granted capabilities, fresh from the runtime (never a snapshot). */
  async grantedCapabilities(): Promise<ShadowCapability[] | null> {
    if (!this.runtime) return null;
    try { return await this.runtime.verifiedApprovedCapabilities(); } catch { return null; }
  }
  isOnline(): boolean { return this.state.phase === 'online'; }
  isActionLocked(): boolean { return this.state.locked || this.purgePending || this.state.phase === 'revoked' || this.state.phase === 'repair'; }
  /** Set the capabilities to request on the NEXT enrollment (before scan). Idle-only. */
  async setRequestedCapabilities(caps: readonly ShadowCapability[]): Promise<boolean> {
    const rt = await this.ensureRuntime();
    return rt.setRequestedCapabilities(caps);
  }

  /** Max authoritative entity activity timestamp (offline marker), or null if unknown. */
  private computeLastActivity(): number | null {
    if (!this.controller) return null;
    let max = 0;
    for (const p of this.controller.projection.listProjects()) {
      if (typeof p.lastActivity === 'number' && p.lastActivity > max) max = p.lastActivity;
      if (typeof p.createdAt === 'number' && p.createdAt > max) max = p.createdAt;
    }
    return max > 0 ? max : null;
  }

  private grantLive(state: EnrollmentState): boolean {
    return state === 'accepted' || state === 'online';
  }
  private authorityLost(status: EnrollmentStatus): boolean {
    return status.state === 'revoked' || status.state === 'locked' || !!this.controller?.status().locked;
  }

  private async ensureRuntime(): Promise<EnrollmentRuntimeLike> {
    if (this.runtime) return this.runtime;
    const rt = await this.deps.getRuntime();
    // Rehydrate persisted authority (restart-safe) without a network round-trip.
    try { await rt.restore(); } catch { /* a restore failure lands as locked/idle via status() */ }
    this.runtime = rt;
    return rt;
  }

  private async acquireController(myGen: number): Promise<void> {
    this.deps.bootstrapController();
    let controller: ProductionShadowController | null = null;
    try { controller = await this.deps.getController(); } catch { controller = null; }
    if (myGen !== this.gen || this.disposed) { try { controller?.close(); } catch { /* ignore */ } return; }
    if (!controller) return;
    this.controller = controller;
    this.controllerUnsub = controller.onChange(() => { void this.refresh(); });
    // Bring the durable read authority online (reconcile lease → pull events → ACKs).
    // A locked/denied authority throws → we stay offline read-only, never fabricate online.
    try { await controller.connect(); } catch { /* offline read-only */ }
  }

  private triggerPurge(): void {
    if (this.purgePending) return;
    this.purgePending = true;
    this.stopPoll();
    this.detachController();
    this.runtime = null; // reset drops the factory singleton — re-fetch the fresh one
    this.emit(loadingState(this.deps.now(), this.deps.isAuthed())); // synchronous locked gate
    this.deps.resetController();
    const myGen = this.gen;
    void (async () => {
      try { await this.deps.awaitIdle(); } catch { /* stay locked */ }
      if (myGen !== this.gen || this.disposed) return;
      // Do NOT assume success — refresh re-gates fail-closed if a controller still
      // cannot be built (purge incomplete keeps `purgePending` set → loading).
      await this.refresh();
    })();
  }

  // ── approval poll loop ───────────────────────────────────────────────────────
  private startPoll(): void {
    if (this.pollHandle || this.disposed) return;
    const tick = async () => {
      this.pollHandle = null;
      if (this.disposed || !this.runtime) return;
      const myGen = this.gen;
      let next: EnrollmentState = this.runtime.status().state;
      try { next = await this.runtime.poll(); } catch { /* transient; reschedule */ }
      if (myGen !== this.gen || this.disposed) return;
      await this.refresh();
      if (this.runtime.status().state === 'awaiting-host') this.pollHandle = this.setT(() => void tick(), this.pollMs);
      void next;
    };
    this.pollHandle = this.setT(() => void tick(), this.pollMs);
  }
  private stopPoll(): void {
    if (!this.pollHandle) return;
    this.clearT(this.pollHandle);
    this.pollHandle = null;
  }

  // ── enrollment gate actions (real runtime calls only) ─────────────────────────
  async beginEnrollment(bootstrap: string): Promise<{ ok: boolean; reason?: string }> {
    const rt = await this.ensureRuntime();
    const res = await rt.parseBootstrap(bootstrap);
    await this.refresh();
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  async listAccountMacs(): Promise<{ ok: true; macs: AccountEnrollmentMac[] } | { ok: false; reason: string }> {
    const rt = await this.ensureRuntime();
    return rt.listAccountMacs();
  }
  async beginAccountEnrollment(hostDeviceId: string): Promise<{ ok: boolean; reason?: string }> {
    const rt = await this.ensureRuntime();
    const res = await rt.startAccountEnrollment(hostDeviceId);
    await this.refresh();
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  async confirmEnrollment(): Promise<{ ok: boolean; reason?: string }> {
    const rt = await this.ensureRuntime();
    const res = await rt.requestEnrollment();
    await this.refresh();
    if (res.ok) this.startPoll();
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  async cancelEnrollment(): Promise<void> {
    const rt = await this.ensureRuntime();
    this.stopPoll();
    await rt.reset();
    await this.refresh();
  }
  /** From a terminal denied/expired: reset to a clean idle so the operator can re-scan. */
  async retryEnrollment(): Promise<void> { await this.cancelEnrollment(); }

  dispose(): void {
    this.disposed = true;
    this.stopPoll();
    this.detachController();
    for (const u of this.unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }
    this.listeners.clear();
  }
}
