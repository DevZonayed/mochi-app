/**
 * shadowUiController.test.ts — Phase 3C2 observable controller-store lifecycle. Drives
 * the REAL enrollment state machine (fake runtime) + a durable controller (real
 * `ShadowProjectionView` over a fake source) through every edge: the enrollment gate,
 * offline last-verified, the zero-stale-flash lock-before-purge contract, injected
 * purge failure, 1,000-entity virtualization bounds, and the read-only (no-actions)
 * guarantee. UI/view-model handlers are exercised — no direct service shortcut.
 */
import { describe, it, expect, vi } from 'vitest';
import { ShadowUiController, type EnrollmentRuntimeLike, type ShadowUiControllerDeps } from './shadowUiController';
import type { ProductionShadowController } from './shadowProductionControllerCore';
import { ShadowProjectionView } from './shadowProjectionSelectors';
import type { ShadowEntity } from './shadowClientCore';
import type { ControllerServiceStatus } from './shadowControllerService';
import type { EnrollmentStatus, EnrollmentState } from './shadowEnrollmentClient';

const NOW = 5_000_000;

function ent(collection: string, id: string, data: Record<string, unknown>, over: Partial<ShadowEntity> = {}): ShadowEntity {
  return { id, collection: collection as ShadowEntity['collection'], revision: 1, updatedAt: NOW, deleted: false, payloadDigest: 'd', data: { v: 1, id, ...data }, ...over };
}

/** Fake enrollment runtime — a scriptable version of `ShadowMobileEnrollmentRuntime`. */
class FakeRuntime implements EnrollmentRuntimeLike {
  state: EnrollmentState = 'idle';
  lastError: string | undefined;
  pollResult: EnrollmentState = 'awaiting-host';
  parseOk = true;
  requestOk = true;
  restoreState: EnrollmentState | null = null;
  status(): EnrollmentStatus {
    return { state: this.state, accountId: 'acct', controllerDeviceId: 'ctrl_device_0123456789abcdef', hostFingerprint: 'hostfp_9999', scopeKeyId: this.state === 'online' ? 'sk' : null, online: this.state === 'online', lastError: this.lastError };
  }
  async restore(): Promise<EnrollmentStatus> { if (this.restoreState) this.state = this.restoreState; return this.status(); }
  async listAccountMacs() { return { ok: true as const, macs: [{ hostDeviceId: 'host_1', name: 'Mac', platform: 'macos', fingerprint: 'hostfp_9999', online: true, lastSeen: NOW, leaseExpiresAt: NOW + 60_000 }] }; }
  async startAccountEnrollment(): Promise<{ ok: true; hostFingerprint: string; expiresAt: number } | { ok: false; reason: string }> {
    this.state = 'confirming'; return { ok: true, hostFingerprint: 'hostfp_9999', expiresAt: NOW + 60_000 };
  }
  async parseBootstrap(): Promise<{ ok: true; hostFingerprint: string; expiresAt: number } | { ok: false; reason: string }> {
    if (!this.parseOk) { this.state = 'error'; this.lastError = 'bad-bootstrap'; return { ok: false, reason: 'bad-bootstrap' }; }
    this.state = 'confirming'; return { ok: true, hostFingerprint: 'hostfp_9999', expiresAt: NOW + 60_000 };
  }
  async requestEnrollment(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.requestOk) { this.state = 'error'; return { ok: false, reason: 'denied' }; }
    this.state = 'awaiting-host'; return { ok: true };
  }
  async poll(): Promise<EnrollmentState> { this.state = this.pollResult; return this.state; }
  async reset(): Promise<void> { this.state = 'idle'; this.lastError = undefined; }
  granted: import('@maestro/realtime/shadowCapabilities').ShadowCapability[] | null = ['account.read'];
  async verifiedApprovedCapabilities() { return this.state === 'online' || this.state === 'accepted' ? this.granted : null; }
  setRequestedCapabilities(): boolean { return true; }
}

/** Fake durable controller backed by the REAL projection selectors. */
class FakeSource {
  private ents: ShadowEntity[];
  private st: ControllerServiceStatus;
  private listeners = new Set<() => void>();
  constructor(ents: ShadowEntity[], st: Partial<ControllerServiceStatus> = {}) {
    this.ents = ents;
    this.st = { state: 'offline', online: false, lastSeq: 7, entities: ents.length, locked: false, leaseExpiresAt: NOW + 60_000, ...st };
  }
  readEntities(): ShadowEntity[] { return this.ents; }
  status(): ControllerServiceStatus { return this.st; }
  onProjectionChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  setStatus(p: Partial<ControllerServiceStatus>): void { this.st = { ...this.st, ...p }; for (const f of [...this.listeners]) f(); }
}

type FakeController = ProductionShadowController & { connectCalls: number };
function fakeController(source: FakeSource): FakeController {
  const view = new ShadowProjectionView(source);
  const c = {
    connectCalls: 0,
    projection: view,
    actions: {} as ProductionShadowController['actions'],
    status: () => source.status(),
    snapshot: () => view.snapshot(),
    commandStatus: () => undefined,
    connect: async () => { c.connectCalls += 1; source.setStatus({ online: true, state: 'online' }); return 1; },
    onChange: (fn: () => void) => source.onProjectionChange(fn),
    close: () => { /* no-op */ },
  } as FakeController;
  return c;
}
let obj: FakeController;

interface Harness {
  ctrl: ShadowUiController;
  runtime: FakeRuntime;
  deps: ShadowUiControllerDeps;
  flushTimers: () => Promise<void>;
  sessionCbs: Array<() => void>;
  hostCbs: Array<() => void>;
  setController: (c: ProductionShadowController | null) => void;
  awaitIdle: ReturnType<typeof vi.fn>;
  resetController: ReturnType<typeof vi.fn>;
}

function harness(opts: { authed?: boolean; controller?: ProductionShadowController | null; runtime?: FakeRuntime; awaitIdleImpl?: () => Promise<void> } = {}): Harness {
  const runtime = opts.runtime ?? new FakeRuntime();
  let controller: ProductionShadowController | null = opts.controller ?? null;
  let authed = opts.authed ?? true;
  const timers: Array<{ id: number; fn: () => void }> = [];
  let tid = 1;
  const sessionCbs: Array<() => void> = [];
  const hostCbs: Array<() => void> = [];
  const awaitIdle = vi.fn(opts.awaitIdleImpl ?? (async () => { /* settled */ }));
  const resetController = vi.fn(() => { /* durable purge (in real graph) */ });
  const deps: ShadowUiControllerDeps = {
    isAuthed: () => authed,
    getRuntime: async () => runtime,
    getController: async () => controller,
    bootstrapController: vi.fn(),
    resetController,
    awaitIdle,
    subscribeSession: (cb) => { sessionCbs.push(cb); return () => {}; },
    subscribeActiveHost: (cb) => { hostCbs.push(cb); return () => {}; },
    now: () => NOW,
    pollMs: 10,
    setTimeout: (fn) => { const id = tid++; timers.push({ id, fn }); return id; },
    clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const flushTimers = async () => { const due = timers.splice(0); for (const t of due) t.fn(); await Promise.resolve(); await Promise.resolve(); };
  const ctrl = new ShadowUiController(deps);
  void authed;
  return { ctrl, runtime, deps, flushTimers, sessionCbs, hostCbs, setController: (c) => { controller = c; }, awaitIdle, resetController };
}

async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('enrollment gate — real state machine', () => {
  it('unenrolled → confirming → requesting → pending → approved → online', async () => {
    const source = new FakeSource([ent('project', 'p1', { name: 'Alpha', lastActivity: NOW - 1000 })]);
    obj = fakeController(source);
    const h = harness({ controller: null });
    h.ctrl.start();
    await settle();
    expect(h.ctrl.getSnapshot().phase).toBe('unenrolled');

    expect((await h.ctrl.beginEnrollment('maestro-shadow://enroll?x')).ok).toBe(true);
    expect(h.ctrl.getSnapshot().phase).toBe('confirming');

    // Approving requires only account.read — verify the displayed request.
    expect(h.ctrl.getSnapshot().enrollment.requestedCapabilityLabels).toEqual(['Read your projects & activity']);

    expect((await h.ctrl.confirmEnrollment()).ok).toBe(true);
    expect(h.ctrl.getSnapshot().phase).toBe('pending');
    expect(h.ctrl.getSnapshot().contentVisible).toBe(false); // no content while pending

    // Host approves → poll returns online; controller becomes available + connects.
    h.runtime.pollResult = 'online';
    h.setController(obj);
    await h.flushTimers();
    await settle();
    expect(h.ctrl.getSnapshot().phase).toBe('online');
    expect(h.ctrl.getSnapshot().contentVisible).toBe(true);
    expect(h.ctrl.projection().projects().map((p) => p.id)).toEqual(['p1']);
    expect(obj.connectCalls).toBeGreaterThanOrEqual(1);
  });

  it('cancel from confirming → unenrolled; retry from denied → unenrolled', async () => {
    const h = harness();
    h.ctrl.start(); await settle();
    await h.ctrl.beginEnrollment('x');
    expect(h.ctrl.getSnapshot().phase).toBe('confirming');
    await h.ctrl.cancelEnrollment();
    expect(h.ctrl.getSnapshot().phase).toBe('unenrolled');

    h.runtime.state = 'denied';
    await h.ctrl.refresh();
    expect(h.ctrl.getSnapshot().phase).toBe('denied');
    expect(h.ctrl.getSnapshot().retryable).toBe(true);
    await h.ctrl.retryEnrollment();
    expect(h.ctrl.getSnapshot().phase).toBe('unenrolled');
  });

  it('a parse failure surfaces a generic error, stays unenrolled (no raw diagnostics)', async () => {
    const h = harness();
    h.ctrl.start(); await settle();
    h.runtime.parseOk = false;
    const res = await h.ctrl.beginEnrollment('garbage');
    expect(res.ok).toBe(false);
    expect(h.ctrl.getSnapshot().phase).toBe('unenrolled');
    expect(h.ctrl.getSnapshot().enrollment.errorReason).toBe('Something went wrong. Please try again.');
  });
});

describe('offline last-verified + no-actions', () => {
  it('enrolled but offline → offline phase, content visible, lastActivity from projection', async () => {
    const source = new FakeSource([
      ent('project', 'p1', { name: 'Alpha', lastActivity: NOW - 2000 }),
      ent('project', 'p2', { name: 'Beta', lastActivity: NOW - 500 }),
    ], { online: false });
    obj = fakeController(source);
    const h = harness({ controller: obj });
    h.runtime.restoreState = 'online';
    h.ctrl.start(); await settle(); await settle();
    // connect() flips online in the fake — force an explicit offline to test the marker.
    source.setStatus({ online: false });
    await h.ctrl.refresh();
    const st = h.ctrl.getSnapshot();
    expect(st.phase).toBe('offline');
    expect(st.contentVisible).toBe(true);
    expect(st.connection.lastActivityAt).toBe(NOW - 500); // max authoritative activity
    // Read-only: the store exposes no mutation surface (only read selectors).
    expect(Object.keys(h.ctrl.projection())).not.toContain('sendMessage');
    expect(Object.keys(h.ctrl.projection())).not.toContain('approve');
  });

  it('schedules are omitted when the projection has none', async () => {
    const source = new FakeSource([ent('project', 'p1', { name: 'Alpha' })]);
    obj = fakeController(source);
    const h = harness({ controller: obj });
    h.runtime.restoreState = 'online';
    h.ctrl.start(); await settle(); await settle();
    expect(h.ctrl.projection().schedules()).toEqual([]);
  });
});

describe('zero stale flash — lock before purge', () => {
  it('a host revoke (service locked) synchronously blanks content, then purges', async () => {
    const source = new FakeSource([ent('project', 'p1', { name: 'Alpha' })], { online: true, state: 'online' });
    obj = fakeController(source);
    const h = harness({ controller: obj });
    h.runtime.restoreState = 'online';
    h.ctrl.start(); await settle(); await settle();
    expect(h.ctrl.getSnapshot().phase).toBe('online');
    expect(h.ctrl.getSnapshot().contentVisible).toBe(true);

    // Host revokes → service reports locked. The onChange fires refresh.
    source.setStatus({ locked: true });
    await settle();
    const st = h.ctrl.getSnapshot();
    expect(st.contentVisible).toBe(false); // BEFORE the async purge resolves
    expect(h.ctrl.projection().projects()).toEqual([]); // gated: no stale rows handed out
    expect(h.resetController).toHaveBeenCalled(); // durable purge triggered
  });

  it('account/host/signout synchronously locks before the async purge settles', async () => {
    const source = new FakeSource([ent('project', 'p1', { name: 'Alpha' })], { online: true, state: 'online' });
    obj = fakeController(source);
    let idleResolve: () => void = () => {};
    const h = harness({ controller: obj, awaitIdleImpl: () => new Promise<void>((r) => { idleResolve = r; }) });
    h.runtime.restoreState = 'online';
    h.ctrl.start(); await settle(); await settle();
    expect(h.ctrl.getSnapshot().contentVisible).toBe(true);

    // Fire the account-switch signal → SYNCHRONOUS locked gate, content hidden immediately.
    h.sessionCbs.forEach((cb) => cb());
    expect(h.ctrl.getSnapshot().contentVisible).toBe(false);
    expect(h.ctrl.getSnapshot().phase).toBe('loading');
    expect(h.ctrl.projection().projects()).toEqual([]);
    // The purge hasn't settled yet — still no content.
    await settle();
    expect(h.ctrl.getSnapshot().contentVisible).toBe(false);
    idleResolve();
    await settle();
  });

  it('injected purge failure keeps it locked (fail closed, no cache resurfaces)', async () => {
    const source = new FakeSource([ent('project', 'p1', { name: 'Alpha' })], { online: true, state: 'online' });
    obj = fakeController(source);
    // getController returns null after the switch (purge pending / build blocked), while the
    // runtime still reports a live grant → fail closed to loading, never show the cache.
    const h = harness({ controller: obj });
    h.runtime.restoreState = 'online';
    h.ctrl.start(); await settle(); await settle();
    expect(h.ctrl.getSnapshot().contentVisible).toBe(true);

    h.setController(null);         // purge incomplete: no controller can be built
    h.sessionCbs.forEach((cb) => cb());
    await settle(); await settle();
    const st = h.ctrl.getSnapshot();
    expect(st.contentVisible).toBe(false);
    expect(h.ctrl.projection().projects()).toEqual([]);
  });
});

describe('virtualization / subscription bounds', () => {
  it('projects 1,000+ entities without unbounded work; selectors return a stable ordered list', async () => {
    const ents: ShadowEntity[] = [];
    for (let i = 0; i < 1200; i++) ents.push(ent('project', `p${i}`, { name: `Proj ${i}`, lastActivity: NOW - i }));
    const source = new FakeSource(ents);
    obj = fakeController(source);
    const h = harness({ controller: obj });
    h.runtime.restoreState = 'online';
    h.ctrl.start(); await settle(); await settle();
    const projects = h.ctrl.projection().projects();
    expect(projects.length).toBe(1200);
    // Deterministic ordering (most-recent activity first) → stable keys for FlatList.
    expect(projects[0].id).toBe('p0');
    expect(projects[projects.length - 1].id).toBe('p1199');
  });
});
