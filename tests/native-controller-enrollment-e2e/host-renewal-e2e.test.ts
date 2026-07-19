/**
 * Phase 3A2a re-review HIGH-1 — PRODUCTION host lease renewal is atomic + crash-safe.
 * This drives the REAL `ShadowHostEnrollmentRuntime.renewLease()` (its durable intent
 * + atomic server renew-and-store-transitions), NOT any manual mint/upload helper,
 * against a real Fastify + PostgreSQL server and a real `ShadowControllerService`.
 *
 * Regression guard: under the OLD ordering (acquireLease → then mint/persist) a crash
 * after server acceptance permanently lost the transition. Here we crash exactly at
 * that boundary, restart a fresh runtime from the SAME persisted record, and prove the
 * renewal is recovered exactly once and the same mobile continues past its original
 * expiry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { getSessionUser } from '../../apps/server/src/auth.ts';
import { auth } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb } from '../../apps/server/src/db.ts';
import { submitEnrollmentRequest, pollEnrollment, signControllerPoll } from '../../apps/server/src/shadowEnrollmentService.ts';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { base64urlDecode } from '@maestro/realtime/shadowCrypto';
import { generateShadowIdentity, buildEnrollmentRequest, acceptEnrollmentGrant, decodeEnrollmentBootstrap, type ShadowIdentity } from '@maestro/realtime/shadowEnrollment';
import type { Fence } from '@maestro/realtime';
import type { ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import { ShadowHostEnrollmentRuntime, type HostEnrollmentRecord, type SecureVault } from '../../MacOS/brain/shadow-enrollment-host.ts';
import { ShadowControllerService } from '../../apps/mobile/src/shadowControllerService.ts';
import { ExpoSQLiteShadowStore } from '../../apps/mobile/src/shadowClient.ts';
import { openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const realFetch: ShadowFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>;
let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let token = '';

async function makeAccount(): Promise<void> {
  const res = await auth.api.signUpEmail({ body: { email: `hr${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`, password: 'pw-12345678', name: 'HR' } });
  token = res.token as string;
  const who = await getSessionUser({ authorization: `Bearer ${token}` });
  accountId = who!.userId;
}

/** Trivial reversible test vault (persistence, not real encryption — the runtime seals its own secrets). */
const vault: SecureVault = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => new TextEncoder().encode(`v1:${s}`),
  decryptString: (b) => new TextDecoder().decode(b).slice(3),
};

/** In-memory persistence; `save` DEEP-CLONES so a "restart" (new runtime) sees exactly the durable record. */
function makePersistence() {
  const state: { record: HostEnrollmentRecord | null } = { record: null };
  return {
    state,
    persistence: {
      load: () => (state.record ? JSON.parse(JSON.stringify(state.record)) as HostEnrollmentRecord : null),
      save: (r: HostEnrollmentRecord) => { state.record = JSON.parse(JSON.stringify(r)); },
    },
  };
}

function makeRuntime(persistence: ReturnType<typeof makePersistence>['persistence'], hostDeviceId: string): ShadowHostEnrollmentRuntime {
  return new ShadowHostEnrollmentRuntime({
    vault, persistence,
    session: { get: async () => ({ accountId, hostDeviceId, sessionToken: token, relayOrigin: origin }) },
    transport: { fetch: realFetch, allowInsecureLoopback: true },
  });
}

/** Upsert the host device (needed for registration) + construct + start the runtime. */
async function startHost(persistence: ReturnType<typeof makePersistence>['persistence'], hostDeviceId: string): Promise<ShadowHostEnrollmentRuntime> {
  await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
  const rt = makeRuntime(persistence, hostDeviceId);
  await rt.start();
  return rt;
}

interface Enrolled { controller: ShadowIdentity; controllerDeviceId: string; scopeKey: Uint8Array; scopeKeyId: string; fence: Fence; hostSigningPublicKey: Uint8Array; hostSigningKeyId: string }

/** Drive the REAL runtime enrollment (session → request → approve → poll → accept). */
async function enrollViaRuntime(rt: ShadowHostEnrollmentRuntime, controllerDeviceId: string): Promise<Enrolled> {
  const session = await rt.createEnrollmentSession({ ttlMs: 300_000 });
  const decoded = decodeEnrollmentBootstrap(session.qr, { allowedOrigins: [origin], nowMs: Date.now() });
  if (!decoded.ok) throw new Error(`bad bootstrap: ${decoded.reason}`);
  const bootstrap = decoded.value;
  await upsertDevice({ id: controllerDeviceId, userId: accountId, role: 'remote', name: 'Phone', platform: 'ios' });
  const controller = await generateShadowIdentity(node, controllerDeviceId);
  const { request } = await buildEnrollmentRequest(node, { controller, bootstrap, nowMs: Date.now() });
  await submitEnrollmentRequest({ accountId, sessionId: bootstrap.sessionId, request, presentedSecret: bootstrap.secret, nowMs: Date.now() });
  await rt.approve({ sessionId: bootstrap.sessionId });
  const nonce = `pn_${Date.now()}_${Math.floor(process.hrtime()[1])}`;
  const ts = Date.now();
  const signature = await signControllerPoll(node, controller.keys.signing.privateKey, accountId, bootstrap.sessionId, controllerDeviceId, nonce, ts);
  const poll = await pollEnrollment({ accountId, sessionId: bootstrap.sessionId, controllerDeviceId, nonce, timestampMs: ts, signature, nowMs: Date.now() });
  const gm = poll.grant as { grant: Record<string, unknown>; keyMaterial: Record<string, unknown> };
  const accepted = await acceptEnrollmentGrant(node, { controller, bootstrap, grant: gm.grant as never, keyMaterial: gm.keyMaterial as never, transcriptHash: base64urlDecode(request.transcriptHash), nowMs: Date.now() });
  const acc = accepted as { ok: true; scopeKey: Uint8Array; scopeKeyId: string; fence: Fence };
  expect(acc.ok).toBe(true);
  return { controller, controllerDeviceId, scopeKey: acc.scopeKey, scopeKeyId: acc.scopeKeyId, fence: acc.fence, hostSigningPublicKey: base64urlDecode(bootstrap.hostSigningPublicKey), hostSigningKeyId: bootstrap.hostSigningKeyId };
}

async function mobileFor(en: Enrolled, dbPath: string, leaseExpiresAt: number, now?: () => number): Promise<{ svc: ShadowControllerService; close: () => void }> {
  const opened = await openRealSQLite(dbPath);
  const store = new ExpoSQLiteShadowStore(opened.db as never, en.controllerDeviceId, en.fence.hostDeviceId, { fence: en.fence, controllerDeviceId: en.controllerDeviceId, leaseExpiresAt });
  const svc = new ShadowControllerService({
    backend: node, store, scopeKey: en.scopeKey, scopeKeyId: en.scopeKeyId,
    expectedAuthority: { fence: en.fence, controllerDeviceId: en.controllerDeviceId, leaseExpiresAt },
    hostSigningPublicKey: en.hostSigningPublicKey, hostSigningKeyId: en.hostSigningKeyId,
    controllerSigner: { keyId: en.controller.signingKeyId, sign: (b) => node.sign(en.controller.keys.signing.privateKey, b) },
    session: async () => ({ accountId, controllerDeviceId: en.controllerDeviceId, sessionToken: token, relayOrigin: origin }),
    transport: { fetch: realFetch, allowInsecureLoopback: true },
    ...(now ? { now } : {}),
  });
  await svc.load();
  return { svc, close: () => opened.raw.close() };
}

const tmp = (n: string) => join(mkdtempSync(join(tmpdir(), 'hr-e2e-')), n);
async function receipts(): Promise<number> { return (await getDb().selectFrom('shadow_lease_renewal_receipt').selectAll().where('account_id', '=', accountId).execute()).length; }
async function transitionsFor(controllerDeviceId: string): Promise<number> { return (await getDb().selectFrom('shadow_authority_transition').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', controllerDeviceId).execute()).length; }

describe.skipIf(!HAS_DB)('production host lease renewal — atomic + crash-safe (HIGH-1)', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
  });
  afterAll(async () => { if (app) await app.close(); });

  it('production renewLease() atomically extends the lease + stores one transition per controller', async () => {
    await makeAccount();
    process.env.SHADOW_RELAY_ORIGINS = origin;
    const { persistence, state } = makePersistence();
    const rt = await startHost(persistence, `host_${Date.now()}_hp`);
    const en = await enrollViaRuntime(rt, `ctrl_${Date.now()}_hp`);
    const r = await rt.renewLease();
    expect(r).toBeTruthy();
    expect(await receipts()).toBe(1);
    expect(await transitionsFor(en.controllerDeviceId)).toBe(1);
    expect(state.record!.pendingLeaseRenewal).toBeFalsy(); // intent cleared on success
  });

  it('crash AFTER server commit BEFORE local persist: restart replays exactly once; same mobile continues past original expiry', async () => {
    await makeAccount();
    process.env.SHADOW_RELAY_ORIGINS = origin;
    const { persistence, state } = makePersistence();
    const hostId = `host_${Date.now()}_cb`;
    const rt = await startHost(persistence, hostId);
    const en = await enrollViaRuntime(rt, `ctrl_${Date.now()}_cb`);

    // Deterministic mobile clock so "crossing the original expiry" does not race real wall-clock
    // under full-suite load (the test relied on a 1s real lease + a real 1.2s sleep).
    const base = Date.now();
    let clock = base;
    const originalExpiry = base + 1_000;
    const dbPath = tmp('m.sqlite');
    const { svc: mobile, close } = await mobileFor(en, dbPath, originalExpiry, () => clock);
    await mobile.connect();
    expect(mobile.status().leaseExpiresAt).toBe(originalExpiry);

    // Crash the host at the exact boundary the reviewer named.
    rt.debugSetRenewalCrashPointForTest('after-server-before-local');
    await expect(rt.renewLease()).rejects.toThrow(/crash-after-server-before-local/);
    // Server committed (receipt + transition), local did NOT persist, intent still durable.
    expect(await receipts()).toBe(1);
    expect(await transitionsFor(en.controllerDeviceId)).toBe(1);
    expect(state.record!.pendingLeaseRenewal).toBeTruthy();

    // Restart a FRESH runtime from the SAME persisted record; resume replays idempotently.
    const rt2 = await startHost(persistence, hostId);
    const resumed = await rt2.resumePendingRenewal();
    expect(resumed).toBeTruthy();
    expect(await receipts()).toBe(1); // exactly one — no duplicate renewal
    expect(await transitionsFor(en.controllerDeviceId)).toBe(1); // one per controller, no loss
    expect(state.record!.pendingLeaseRenewal).toBeFalsy(); // cleared after replay

    // The SAME mobile crosses its original 1s expiry (advance its clock deterministically to the
    // same +1.2s the test previously reached via a real sleep — no wall-clock race under load),
    // then fetches + verifies + applies the renewal transition exactly once.
    clock = originalExpiry + 200;
    expect(await mobile.fetchAndApplyTransitions()).toBe(1);
    expect(mobile.status().leaseExpiresAt).toBe(resumed!.leaseExpiresAt);
    expect(resumed!.leaseExpiresAt).toBeGreaterThan(originalExpiry);
    expect(mobile.isLocked()).toBe(false);

    // Close + reopen the SAME SQLite with the ORIGINAL grant bootstrap → renewed chain loads.
    close();
    const { svc: mobile2, close: close2 } = await mobileFor(en, dbPath, originalExpiry);
    expect(mobile2.status().leaseExpiresAt).toBe(resumed!.leaseExpiresAt);
    close2();
  });

  it('crash AFTER durable intent BEFORE server call: restart commits the renewal', async () => {
    await makeAccount();
    process.env.SHADOW_RELAY_ORIGINS = origin;
    const { persistence, state } = makePersistence();
    const hostId = `host_${Date.now()}_ci`;
    const rt = await startHost(persistence, hostId);
    const en = await enrollViaRuntime(rt, `ctrl_${Date.now()}_ci`);
    rt.debugSetRenewalCrashPointForTest('after-intent-before-server');
    await expect(rt.renewLease()).rejects.toThrow(/crash-after-intent-before-server/);
    expect(await receipts()).toBe(0); // never reached the server
    expect(state.record!.pendingLeaseRenewal).toBeTruthy();
    const rt2 = await startHost(persistence, hostId);
    expect(await rt2.resumePendingRenewal()).toBeTruthy();
    expect(await receipts()).toBe(1);
    expect(await transitionsFor(en.controllerDeviceId)).toBe(1);
  });

  it('crash AFTER local persist BEFORE intent clear: restart replay is idempotent', async () => {
    await makeAccount();
    process.env.SHADOW_RELAY_ORIGINS = origin;
    const { persistence, state } = makePersistence();
    const hostId = `host_${Date.now()}_cc`;
    const rt = await startHost(persistence, hostId);
    const en = await enrollViaRuntime(rt, `ctrl_${Date.now()}_cc`);
    rt.debugSetRenewalCrashPointForTest('after-local-before-clear');
    await expect(rt.renewLease()).rejects.toThrow(/crash-after-local-before-clear/);
    expect(await receipts()).toBe(1);
    expect(state.record!.pendingLeaseRenewal).toBeTruthy(); // not yet cleared
    const rt2 = await startHost(persistence, hostId);
    expect(await rt2.resumePendingRenewal()).toBeTruthy();
    expect(await receipts()).toBe(1); // idempotent
    expect(await transitionsFor(en.controllerDeviceId)).toBe(1);
    expect(state.record!.pendingLeaseRenewal).toBeFalsy();
  });

  it('duplicate concurrent renewLease() calls commit exactly one renewal', async () => {
    await makeAccount();
    process.env.SHADOW_RELAY_ORIGINS = origin;
    const { persistence } = makePersistence();
    const rt = await startHost(persistence, `host_${Date.now()}_dc`);
    const en = await enrollViaRuntime(rt, `ctrl_${Date.now()}_dc`);
    const [a, b] = await Promise.all([rt.renewLease(), rt.resumePendingRenewal().catch(() => null)]);
    expect(a).toBeTruthy();
    void b;
    expect(await receipts()).toBe(1);
    expect(await transitionsFor(en.controllerDeviceId)).toBe(1);
  });
});
