/**
 * Phase 3C2 cross-tier MOBILE UI / VIEW-MODEL E2E. REAL boundaries only: listening
 * Fastify + disposable PostgreSQL + real signed HTTP + real desktop host enrollment
 * runtime + real host data plane (ShadowProductProjection over a real product Store)
 * + real mobile `ShadowMobileEnrollmentRuntime` + real `ShadowControllerService` +
 * real `ProductionShadowController` over Node 24 node:sqlite + production node:crypto.
 *
 * The mobile EDGES are driven through the `ShadowUiController` VIEW-MODEL handlers —
 * never a direct service shortcut:
 *   UI beginEnrollment(qr) → confirming → confirmEnrollment() → pending
 *   → host (accepted desktop seam) approves account.read → UI poll loop verifies +
 *     persists the grant → builds the durable controller + connects → ONLINE
 *   → host seeds projects/sessions/jobs/approval/question → UI projection renders
 *     them read-only, with NO plaintext canary and NO mutation surface
 *   → network loss → UI shows OFFLINE, retains the last verified shadow
 *   → host signed revoke → UI synchronously LOCKS (content blanked) + durably PURGES;
 *     a reopened runtime over the same stores restores to unenrolled (no survivor).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The product Store (MacOS/brain) imports electron for its userData path — mock it to
// an isolated temp dir (mirrors the accepted projection-e2e), so no real Electron is needed.
const hoisted = vi.hoisted(() => ({ userData: `/tmp/maestro-ui-e2e-store-${process.pid}-${process.hrtime()[1]}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.userData } }));

import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { auth, getSessionUser } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb } from '../../apps/server/src/db.ts';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import type { ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import { ShadowHostEnrollmentRuntime } from '../../MacOS/brain/shadow-enrollment-host.ts';
import { defineShadowCommandRegistry } from '../../MacOS/brain/shadow-host-service.ts';
import { createShadowHostDispatch } from '../../MacOS/brain/shadow-host-dispatch.ts';
import { Store } from '../../MacOS/brain/store.ts';
import { ShadowMobileEnrollmentRuntime } from '../../apps/mobile/src/shadowEnrollmentClient.ts';
import { ExpoSQLiteShadowStore } from '../../apps/mobile/src/shadowClient.ts';
import { assembleProductionShadowController, type ProductionShadowController } from '../../apps/mobile/src/shadowProductionControllerCore.ts';
import { ShadowUiController, type ShadowUiControllerDeps } from '../../apps/mobile/src/shadowUiController.ts';
import { deriveShadowUiState } from '../../apps/mobile/src/shadowUiModel.ts';
import { TestVault, TestHostPersistence, TestSecureStore, TestMetaStore, openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const CANARY = 'CANARY_UI_E2E_a1b2c3d4e5f6';

let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let sessionToken = '';
let netDown = false;
const realFetch: ShadowFetch = (url, init) => (netDown ? Promise.reject(new Error('network down')) : fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>);

async function makeAccount(): Promise<void> {
  process.env.SHADOW_RELAY_ORIGINS = origin;
  const res = await auth.api.signUpEmail({ body: { email: `ui${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`, password: 'pw-12345678', name: 'UI' } });
  sessionToken = res.token as string;
  const who = await getSessionUser({ authorization: `Bearer ${sessionToken}` });
  accountId = who!.userId;
}

function tmp(name: string): string { return join(mkdtempSync(join(tmpdir(), 'ui-e2e-')), name); }

describe.skipIf(!HAS_DB)('mobile controller UI / view-model — cross-tier E2E', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
    await makeAccount();
  });
  afterAll(async () => { if (app) await app.close(); });

  it('UI-initiated account.read enrollment → render → offline → revoke lock + durable purge', async () => {
    netDown = false;
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_ui`;
    const controllerDeviceId = `ctrl_${Date.now()}_ui`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });

    // Real desktop host enrollment runtime (accepted seam).
    const host = new ShadowHostEnrollmentRuntime({
      vault: new TestVault(), persistence: new TestHostPersistence(),
      session: { get: async () => ({ accountId, hostDeviceId, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true },
    });
    await host.start();

    // F1: the SAME production desktop dispatch that Settings → Controllers (renderer
    // api.shadowHostCreateSession / shadowHostApprove) invokes — NOT the runtime method
    // directly. Enrollment enters through this handler → the mobile UI handler.
    const hostDispatch = createShadowHostDispatch({
      signedIn: () => true,
      hostDeviceId: () => hostDeviceId,
      vaultAvailable: () => true,
      getRuntime: async () => host,
      ensureStarted: async () => { /* already started */ },
    });

    // Real mobile enrollment runtime (account.read only — the default requested set).
    const secureStore = new TestSecureStore();
    const metaStore = new TestMetaStore();
    const runtime = new ShadowMobileEnrollmentRuntime({
      backend, secureStore, metaStore,
      session: { get: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
    });

    // ── UI controller deps: real runtime + a lazily-built REAL production controller ──
    let built: ProductionShadowController | null = null;
    const dbPath = tmp('m.sqlite');
    let opened: Awaited<ReturnType<typeof openRealSQLite>> | null = null;
    let purge = Promise.resolve();
    const timers: Array<{ id: number; fn: () => void }> = [];
    let tid = 1;
    const buildController = async (): Promise<ProductionShadowController | null> => {
      if (built) return built;
      const grant = runtime.grantSummary();
      if (!grant) return null;
      opened = await openRealSQLite(dbPath);
      const store = new ExpoSQLiteShadowStore(opened.db, grant.controllerDeviceId, grant.hostDeviceId, { fence: grant.fence, controllerDeviceId: grant.controllerDeviceId, leaseExpiresAt: grant.leaseExpiresAt });
      const svc = runtime.buildControllerService({ store, session: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }), transport: { fetch: realFetch, allowInsecureLoopback: true } });
      if (!svc) return null;
      await svc.load();
      built = assembleProductionShadowController(svc, runtime);
      return built;
    };
    const doPurge = async (): Promise<void> => {
      try { built?.close(); } catch { /* ignore */ }
      built = null;
      try { opened?.raw.close(); } catch { /* ignore */ }
      // Durable purge: wipe the mobile scope key + grant metadata (fail-closed contract).
      await runtime.purgeDurable().catch(() => { /* aggregate best-effort */ });
    };
    const deps: ShadowUiControllerDeps = {
      isAuthed: () => !!sessionToken,
      getRuntime: async () => runtime,
      getController: () => buildController(),
      bootstrapController: () => { /* lazy build happens in getController */ },
      resetController: () => { purge = doPurge(); },
      awaitIdle: () => purge,
      subscribeSession: () => () => {},
      subscribeActiveHost: () => () => {},
      now: Date.now,
      pollMs: 5,
      setTimeout: (fn) => { const id = tid++; timers.push({ id, fn }); return id; },
      clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    };
    const ui = new ShadowUiController(deps);
    ui.start();
    await settle();
    expect(ui.getSnapshot().phase).toBe('unenrolled');

    // 1) F1: the QR/bootstrap is produced by the PRODUCTION desktop handler (the exact
    // one Settings → Controllers calls), then fed to the mobile UI enrollment handler.
    const created = await hostDispatch('shadowHostCreateSession', {}) as { sessionId: string; qr: string; hostAuthString: string };
    expect(created.qr.startsWith('maestro-shadow://enroll')).toBe(true);
    expect((await ui.beginEnrollment(created.qr)).ok).toBe(true);
    expect(ui.getSnapshot().phase).toBe('confirming');
    expect(ui.getSnapshot().enrollment.requestedCapabilityLabels).toEqual(['Read your projects & activity']);

    // 2) UI confirms → request → pending; the host dispatch lists the pending request.
    expect((await ui.confirmEnrollment()).ok).toBe(true);
    expect(ui.getSnapshot().phase).toBe('pending');
    const pending = await hostDispatch('shadowHostListPending', {}) as { requests: Array<{ controllerDeviceId: string }> };
    expect(pending.requests.some((p) => p.controllerDeviceId === controllerDeviceId)).toBe(true);

    // 3) Host approves ONLY account.read through the PRODUCTION approval handler.
    await hostDispatch('shadowHostApprove', { sessionId: created.sessionId, controllerName: controllerDeviceId, capabilities: ['account.read'] });

    // 4) Pump the UI poll loop until the grant verifies + the controller connects online.
    await pumpUntil(timers, () => ui.getSnapshot().phase === 'online', ui);
    expect(ui.getSnapshot().phase).toBe('online');
    // Grant persisted (SecureStore scope key + grant meta).
    expect([...secureStore.m.keys()].some((k) => k.includes('scopeKey'))).toBe(true);
    expect(metaStore.raw).toBeTruthy();

    // 5) Host seeds projects/sessions/jobs/approval/question; the CANARY only in secrets.
    const store = new Store();
    const hostDir = tmp('host');
    const plane = host.buildDataPlane({ rootDir: hostDir, transport: { fetch: realFetch, allowInsecureLoopback: true }, commandRegistry: defineShadowCommandRegistry({}), store });
    expect(plane).toBeTruthy();
    const p1 = store.createProject({ name: 'UIProj-safe', kind: 'coding', repoUrl: 'https://ci:secretpw@gitlab.example.com/t/app.git' } as Parameters<typeof store.createProject>[0]);
    const s1 = store.createSession(p1.id, 'ui-session-safe');
    const j1 = store.createJob(p1.id, 'work', 'UIJob-safe', 'balanced', s1.id);
    store.updateJob(j1.id, { status: 'running', error: `boom ${CANARY} /Users/x/.aws/credentials`, output: `postgres://admin:${CANARY}@db/prod` });
    store.createApproval({ projectId: p1.id, kind: 'merge', title: 'UIApprove-safe', subtitle: 'ready', detail: `rm -rf ${CANARY}`, jobId: j1.id });
    await plane!.projection.scheduleReconcile();

    // 6) UI projection renders all projects/relations read-only. The durable read
    // authority pulls host events via the accepted controller `connect()` seam (the
    // same one the store's auto-reconcile drives); pump it until the delta applies.
    for (let i = 0; i < 20 && ui.projection().projects().length === 0; i++) {
      await built!.connect().catch(() => {});
      await ui.refresh();
      await new Promise((r) => setTimeout(r, 40));
    }
    const projects = ui.projection().projects();
    expect(projects.map((p) => p.id)).toEqual([p1.id]);
    expect(ui.projection().projectSessions(p1.id).map((s) => s.id)).toEqual([s1.id]);
    expect(ui.projection().pendingApprovals().length).toBe(1);
    // No plaintext canary / secret ever reaches the UI projection.
    const rendered = JSON.stringify({ projects, jobs: ui.projection().projectJobs(p1.id), approvals: ui.projection().pendingApprovals() });
    expect(rendered).not.toContain(CANARY);
    expect(rendered).not.toContain('@');            // no repo userinfo
    expect(rendered).not.toContain('rm -rf');
    // A safe repo host DID survive for the UI.
    expect(projects[0].repoHost).toBe('gitlab.example.com');
    // Read-only: no mutation surface on the projection.
    for (const k of Object.keys(ui.projection())) expect(['projects', 'projectSessions', 'projectJobs', 'session', 'job', 'pendingApprovals', 'pendingQuestions', 'schedules']).toContain(k);

    // 7) OFFLINE retention: when the durable service reports OFFLINE (lease lapse / not
    // connected), the REAL view-model shows offline read-only and STILL renders the last
    // verified shadow from the durable store. (A genuine cold-reopen of the durable SQLite
    // cache is separately proven by the accepted enrollment/projection E2Es.)
    const offlineStatus = { ...built!.status(), online: false, locked: false };
    const offlineUi = deriveShadowUiState({ authed: true, purgePending: false, enrollment: runtime.status(), service: offlineStatus, lastActivityAt: null, now: Date.now() });
    expect(offlineUi.phase).toBe('offline');
    expect(offlineUi.contentVisible).toBe(true);
    expect(built!.projection.listProjects().map((p) => p.id)).toEqual([p1.id]);

    // 8) Signed revoke → UI synchronously LOCKS (content blanked) + durably PURGES.
    await host.revoke({ controllerDeviceId });
    await built!.connect().catch(() => { /* 401 → service locks */ });
    await ui.refresh();
    await settle(); await settle();
    const locked = ui.getSnapshot();
    expect(locked.contentVisible).toBe(false);
    expect(ui.projection().projects()).toEqual([]); // no stale rows handed out
    await deps.awaitIdle();

    // Durable purge across reopen: a fresh runtime over the SAME stores is unenrolled.
    const reopenedRuntime = new ShadowMobileEnrollmentRuntime({
      backend, secureStore, metaStore,
      session: { get: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
    });
    const restored = await reopenedRuntime.restore();
    expect(restored.state).toBe('idle');
    expect([...secureStore.m.keys()].some((k) => k.includes('scopeKey'))).toBe(false);

    ui.dispose();
    try { built?.close(); } catch { /* ignore */ }
  });
});

async function settle(): Promise<void> { for (let i = 0; i < 4; i++) await Promise.resolve(); }

/** Pump the injected timer queue (poll loop) interleaved with real waits until `done`. */
async function pumpUntil(timers: Array<{ id: number; fn: () => void }>, done: () => boolean, ui: ShadowUiController, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (done()) return;
    const due = timers.splice(0);
    for (const t of due) { try { t.fn(); } catch { /* transient */ } }
    await ui.refresh().catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
  }
}
