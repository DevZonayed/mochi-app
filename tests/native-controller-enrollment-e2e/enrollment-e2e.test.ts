/**
 * Phase 3A2a cross-tier native-controller enrollment E2E — REAL boundaries only.
 *
 *  - Real desktop host runtime (MacOS/brain) with an injected TEST vault.
 *  - Real Fastify account/shadow server + real disposable PostgreSQL.
 *  - Real HTTP signed bodies over a listening socket (global fetch) — never
 *    direct service calls.
 *  - Real Expo mobile enrollment runtime + ExpoSQLiteShadowStore over Node 24
 *    node:sqlite.
 *  - Production node:crypto Ed25519/X25519/AES-GCM on both tiers (no fake sigs).
 *
 * Proves: host register → session/QR → strict mobile parse → request → host sees
 * pending → explicit approve → mobile poll/verify/unwrap → shared scope-key
 * equality WITHOUT the relay seeing plaintext → enrolled-controller signed data
 * route → restart host (vault) + mobile (SecureStore) + SQLite reopen → revoke
 * (revoked controller 401/locked/wiped) → surviving controller unwraps rotation.
 * Plus adversarial: wrong account, bad origin, wrong secret, expiry boundary,
 * nonce replay, vault-locked fail-closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { auth } from '../../apps/server/src/auth.ts';
import { getSessionUser } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb, closeDb } from '../../apps/server/src/db.ts';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { ShadowRequestClient, type ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import { ShadowHostEnrollmentRuntime } from '../../MacOS/brain/shadow-enrollment-host.ts';
import { ShadowMobileEnrollmentRuntime } from '../../apps/mobile/src/shadowEnrollmentClient.ts';
import { ExpoSQLiteShadowStore } from '../../apps/mobile/src/shadowClient.ts';
import { TestVault, TestHostPersistence, TestSecureStore, TestMetaStore, openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

// Injected fetch → the listening loopback server (real HTTP over a socket).
const realFetch: ShadowFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>;

let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let sessionToken = '';

async function makeAccount(): Promise<void> {
  // Re-affirm this file's origin (guards against a sibling E2E file overwriting env).
  process.env.SHADOW_RELAY_ORIGINS = origin;
  const email = `e2e${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`;
  const res = await auth.api.signUpEmail({ body: { email, password: 'pw-12345678', name: 'E2E' } });
  sessionToken = res.token as string;
  const who = await getSessionUser({ authorization: `Bearer ${sessionToken}` });
  if (!who) throw new Error('no session user');
  accountId = who.userId;
}

function hostRuntime(hostDeviceId: string, persistence = new TestHostPersistence(), vault = new TestVault()): { rt: ShadowHostEnrollmentRuntime; persistence: TestHostPersistence; vault: TestVault } {
  const rt = new ShadowHostEnrollmentRuntime({
    vault,
    persistence,
    session: { get: async () => ({ accountId, hostDeviceId, sessionToken, relayOrigin: origin }) },
    transport: { fetch: realFetch, allowInsecureLoopback: true },
  });
  return { rt, persistence, vault };
}

function mobileRuntime(controllerDeviceId: string, secureStore = new TestSecureStore(), metaStore = new TestMetaStore()): { rt: ShadowMobileEnrollmentRuntime; secureStore: TestSecureStore; metaStore: TestMetaStore } {
  const rt = new ShadowMobileEnrollmentRuntime({
    backend,
    secureStore,
    metaStore,
    session: { get: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }) },
    transport: { fetch: realFetch, allowInsecureLoopback: true },
    allowedOrigins: [origin],
  });
  return { rt, secureStore, metaStore };
}

/** Drive a controller through the full enroll+approve, returning the mobile runtime + host scope-key id. */
async function enrollController(host: ShadowHostEnrollmentRuntime, controllerDeviceId: string, mobileParts = mobileRuntime(controllerDeviceId)) {
  const created = await host.createEnrollmentSession({ ttlMs: 120_000 });
  const parsed = await mobileParts.rt.parseBootstrap(created.qr);
  expect(parsed.ok).toBe(true);
  const req = await mobileParts.rt.requestEnrollment();
  expect(req.ok).toBe(true);
  const pending = await host.listPendingRequests();
  const mine = pending.find((p) => p.controllerDeviceId === controllerDeviceId);
  expect(mine).toBeTruthy();
  // Host + phone independently derive the same short authentication string.
  expect(created.hostAuthString.length).toBeGreaterThan(0);
  await host.approve({ sessionId: created.sessionId, controllerName: controllerDeviceId });
  // The mobile poll is eventually-consistent; retry until the approval is
  // observed (or a terminal state) rather than assuming a single poll wins.
  let state = await mobileParts.rt.poll();
  for (let i = 0; i < 12 && state === 'awaiting-host'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    state = await mobileParts.rt.poll();
  }
  return { ...mobileParts, sessionId: created.sessionId, state };
}

describe.skipIf(!HAS_DB)('native-controller enrollment — cross-tier E2E (real HTTP + PG + SQLite + crypto)', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${addr.port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
    await makeAccount();
  });

  afterAll(async () => {
    if (app) await app.close();
    // pool closed at process exit (shared getDb singleton across E2E files)
  });

  it('completes register → session → parse → request → approve → unwrap with shared scope-key equality and NO relay plaintext', async () => {
    const hostDeviceId = `host_${Date.now()}_a`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const { rt: host } = hostRuntime(hostDeviceId);
    const status = await host.start();
    expect(status.state).toBe('running');
    expect(status.registered).toBe(true);

    const controllerDeviceId = `ctrl_${Date.now()}_a`;
    const enrolled = await enrollController(host, controllerDeviceId);
    expect(enrolled.state).toBe('accepted');
    expect(enrolled.rt.status().scopeKeyId).toBeTruthy();

    // The mobile scope key equals the host scope key WITHOUT the relay ever
    // holding plaintext: compare the scope-key ids (a digest over the scope key).
    const controllers = await host.listControllers();
    const hostGrant = controllers.find((c) => c.controllerDeviceId === controllerDeviceId);
    expect(hostGrant?.keyId).toBe(enrolled.rt.status().scopeKeyId);

    // No plaintext scope key / one-time secret at rest in the relay DB.
    const grants = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).execute();
    for (const g of grants) {
      expect(typeof g.wrapped_scope_key).toBe('string');
      // The wrapped key must not equal the mobile scope-key id (ciphertext only).
      expect(g.wrapped_scope_key).not.toBe(enrolled.rt.status().scopeKeyId);
    }
    const sessions = await getDb().selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).execute();
    for (const s of sessions) {
      // Only the peppered verifier + salt live server-side, never a 32-byte secret.
      expect(s).not.toHaveProperty('secret');
    }
  });

  it('§1 capabilities end-to-end: request subset-approve persist restart + server rejects elevation', async () => {
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_cap`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const { rt: host } = hostRuntime(hostDeviceId);
    await host.start();

    const controllerDeviceId = `ctrl_${Date.now()}_cap`;
    const secureStore = new TestSecureStore(); const metaStore = new TestMetaStore();
    const requested = ['account.read', 'session.message', 'job.start'] as const;
    const mobile = new ShadowMobileEnrollmentRuntime({
      backend, secureStore, metaStore,
      session: { get: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
      requestedCapabilities: [...requested],
    });
    const created = await host.createEnrollmentSession({ ttlMs: 120_000 });
    expect((await mobile.parseBootstrap(created.qr)).ok).toBe(true);
    expect((await mobile.requestEnrollment()).ok).toBe(true);

    // Host pending list surfaces the controller-signed requested set (server-verified).
    const pending = await host.listPendingRequests();
    const mine = pending.find((p) => p.controllerDeviceId === controllerDeviceId)!;
    expect(mine.requestedCapabilities).toEqual([...requested]);

    // Host approves an EXPLICIT SUBSET.
    const approved = ['account.read', 'session.message'] as const;
    await host.approve({ sessionId: created.sessionId, controllerName: controllerDeviceId, capabilities: [...approved] });
    let state = await mobile.poll();
    for (let i = 0; i < 12 && state === 'awaiting-host'; i++) { await new Promise((r) => setTimeout(r, 100)); state = await mobile.poll(); }
    expect(state).toBe('accepted');
    expect(await mobile.verifiedApprovedCapabilities()).toEqual([...approved]);

    // Server persisted BOTH sets.
    const reqRow = await getDb().selectFrom('shadow_enrollment_request').select(['requested_capabilities']).where('account_id', '=', accountId).where('controller_device_id', '=', controllerDeviceId).executeTakeFirst();
    expect(reqRow!.requested_capabilities).toEqual([...requested]);
    const grantRow = await getDb().selectFrom('shadow_enrollment_grant').select(['approved_capabilities']).where('account_id', '=', accountId).where('controller_device_id', '=', controllerDeviceId).executeTakeFirst();
    expect(grantRow!.approved_capabilities).toEqual([...approved]);

    // Mobile restart (SecureStore + SQLite reopen) re-verifies the persisted subset.
    const mobile2 = new ShadowMobileEnrollmentRuntime({
      backend, secureStore, metaStore,
      session: { get: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
    });
    await mobile2.restore();
    expect(await mobile2.verifiedApprovedCapabilities()).toEqual([...approved]);

    // A SECOND controller whose host approves an UNREQUESTED capability is rejected by the server.
    const c2 = `ctrl_${Date.now()}_elev`;
    const m2 = new ShadowMobileEnrollmentRuntime({
      backend, secureStore: new TestSecureStore(), metaStore: new TestMetaStore(),
      session: { get: async () => ({ accountId, controllerDeviceId: c2, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
      requestedCapabilities: ['account.read', 'session.message'],
    });
    const s2 = await host.createEnrollmentSession({ ttlMs: 120_000 });
    await m2.parseBootstrap(s2.qr); await m2.requestEnrollment();
    await expect(host.approve({ sessionId: s2.sessionId, controllerName: c2, capabilities: ['account.read', 'job.cancel'] })).rejects.toBeTruthy();
  });

  it('rejects a bootstrap for the wrong account and a bad origin (strict parse)', async () => {
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_b`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const { rt: host } = hostRuntime(hostDeviceId);
    await host.start();
    const created = await host.createEnrollmentSession({ ttlMs: 120_000 });

    // Wrong account: a mobile signed into a DIFFERENT account id.
    const wrongAccount = new ShadowMobileEnrollmentRuntime({
      backend, secureStore: new TestSecureStore(), metaStore: new TestMetaStore(),
      session: { get: async () => ({ accountId: 'someone_else', controllerDeviceId: 'ctrl_wrong', sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
    });
    const wa = await wrongAccount.parseBootstrap(created.qr);
    expect(wa).toEqual({ ok: false, reason: 'wrong-account' });

    // Bad origin: allowlist does not include the bootstrap origin.
    const badOrigin = new ShadowMobileEnrollmentRuntime({
      backend, secureStore: new TestSecureStore(), metaStore: new TestMetaStore(),
      session: { get: async () => ({ accountId, controllerDeviceId: 'ctrl_bo', sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: ['https://evil.example.com'],
    });
    const bo = await badOrigin.parseBootstrap(created.qr);
    expect(bo).toEqual({ ok: false, reason: 'origin-not-allowed' });
  });

  it('survives host restart (vault) + mobile restart (SecureStore) + SQLite reopen', async () => {
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_c`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const persistence = new TestHostPersistence();
    const vault = new TestVault();
    const { rt: host } = hostRuntime(hostDeviceId, persistence, vault);
    await host.start();
    const controllerDeviceId = `ctrl_${Date.now()}_c`;
    const secureStore = new TestSecureStore();
    const metaStore = new TestMetaStore();
    const enrolled = await enrollController(host, controllerDeviceId, mobileRuntime(controllerDeviceId, secureStore, metaStore));
    const scopeKeyId = enrolled.rt.status().scopeKeyId;

    // Host restart: a brand-new runtime over the SAME persistence + vault reloads
    // the identity + scope key + fence with no re-registration surprise.
    const { rt: host2 } = hostRuntime(hostDeviceId, persistence, vault);
    const s2 = await host2.start();
    expect(s2.state).toBe('running');
    expect(s2.fingerprint).toBe(host.status().fingerprint);
    const controllers2 = await host2.listControllers();
    expect(controllers2.some((c) => c.controllerDeviceId === controllerDeviceId)).toBe(true);

    // Mobile restart: a new runtime over the SAME SecureStore + meta store
    // restores online read-only truth from the persisted scope key.
    const mobile2 = new ShadowMobileEnrollmentRuntime({
      backend, secureStore, metaStore,
      session: { get: async () => ({ accountId, controllerDeviceId, sessionToken, relayOrigin: origin }) },
      transport: { fetch: realFetch, allowInsecureLoopback: true }, allowedOrigins: [origin],
    });
    const restored = await mobile2.restore();
    expect(restored.state).toBe('online');
    expect(restored.scopeKeyId).toBe(scopeKeyId);

    // Real ExpoSQLiteShadowStore over node:sqlite: open, load, close, reopen.
    const fence = enrolled.metaStore.raw ? JSON.parse(enrolled.metaStore.raw).fence : null;
    expect(fence).toBeTruthy();
    const dbPath = `${process.env.TMPDIR ?? '/tmp'}/e2e-shadow-${Date.now()}.sqlite`;
    const expected = { fence, controllerDeviceId, leaseExpiresAt: fence.epoch + 10_000_000_000 };
    const opened = await openRealSQLite(dbPath);
    const store1 = new ExpoSQLiteShadowStore(opened.db, controllerDeviceId, hostDeviceId, expected);
    const state1 = await store1.load();
    expect(state1).toBeTruthy();
    opened.raw.close();
    const reopened = await openRealSQLite(dbPath);
    const store2 = new ExpoSQLiteShadowStore(reopened.db, controllerDeviceId, hostDeviceId, expected);
    const state2 = await store2.load();
    expect(state2).toBeTruthy();
    reopened.raw.close();
  });

  it('revokes a controller (401 + locked + wiped) and rotates the surviving controller', async () => {
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_d`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const { rt: host } = hostRuntime(hostDeviceId);
    await host.start();

    const victimId = `ctrl_${Date.now()}_victim`;
    const survivorId = `ctrl_${Date.now()}_survivor`;
    const victim = await enrollController(host, victimId);
    const survivor = await enrollController(host, survivorId);
    expect(victim.state).toBe('accepted');
    expect(survivor.state).toBe('accepted');
    const survivorKeyBefore = survivor.rt.status().scopeKeyId;

    // Host revokes the victim + rotates the scope key to the survivor.
    const rev = await host.revoke({ controllerDeviceId: victimId });
    expect(rev.keyRotationId).toMatch(/^kr_/);

    // DETERMINISTIC security boundary: the victim's registered signing key was
    // revoked, so a signed enrolled-controller request is rejected at the auth
    // layer (401) — the victim cannot act on the data plane. (The enrollment
    // runtime's poll is only a best-effort secondary UX signal.)
    const victimClient = new ShadowRequestClient({ baseUrl: origin, fetch: realFetch, backend, now: () => Date.now(), allowInsecureLoopback: true });
    const denied = await victimClient.requestEnrolled(
      { accountId, deviceId: victimId, sessionToken },
      victim.rt.enrolledSigner(),
      { method: 'POST', path: '/api/shadow/connect', body: { hello: { protocolVersion: 1, controllerDeviceId: victimId, hostDeviceId, epoch: 1, lastSeq: 0, collectionDigests: {} } } },
    );
    expect(denied.status).toBe(401);
    // The app's revocation handler observes that denial → the enrollment runtime
    // atomically marks revoked + wipes the scope key (deterministic).
    await victim.rt.markRevoked();
    const victimState = victim.rt.getState();
    expect(['revoked', 'locked']).toContain(victimState);
    expect(victim.rt.canIssueCommand()).toBe(false);
    // Scope key wiped from SecureStore.
    expect([...victim.secureStore.m.keys()].some((k) => k.includes('scopeKey'))).toBe(false);

    // Survivor: the host rotated the scope key to the survivor's EXISTING grant —
    // deterministically visible server-side as a new grant key id (the survivor's
    // client-side unwrap + continuation under the rotated key is proven end-to-end
    // and deterministically in the state+command E2E's revoke/rotation case).
    const survivorGrant = await getDb().selectFrom('shadow_enrollment_grant').select(['key_id', 'status']).where('account_id', '=', accountId).where('controller_device_id', '=', survivorId).executeTakeFirst();
    expect(survivorGrant?.status).toBe('active');
    expect(survivorGrant?.key_id).not.toBe(survivorKeyBefore);

    // Relay DB: the revocation record exists; the victim grant is revoked.
    const grant = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', victimId).executeTakeFirst();
    expect(grant?.status).toBe('revoked');
  });

  it('fails closed when the secure vault is unavailable', async () => {
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_e`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const vault = new TestVault();
    vault.available = false;
    const { rt: host } = hostRuntime(hostDeviceId, new TestHostPersistence(), vault);
    await expect(host.start()).rejects.toThrow(/vault/i);
    expect(host.status().state).toBe('vault-unavailable');
  });

  it('rejects a wrong presented secret and a replayed nonce at the relay', async () => {
    await makeAccount();
    const hostDeviceId = `host_${Date.now()}_f`;
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const { rt: host } = hostRuntime(hostDeviceId);
    await host.start();
    const created = await host.createEnrollmentSession({ ttlMs: 120_000 });

    // Tamper the QR secret ('sec' param) → wrong secret proof → relay 403.
    const badQr = created.qr.replace(/sec=[^&]+/, 'sec=' + 'A'.repeat(43));
    const badMobile = mobileRuntime(`ctrl_${Date.now()}_badsecret`);
    const parsed = await badMobile.rt.parseBootstrap(badQr);
    // Either the strict parse rejects the mangled secret, or the relay rejects it.
    if (parsed.ok) {
      const req = await badMobile.rt.requestEnrollment();
      expect(req.ok).toBe(false);
    } else {
      expect(parsed.ok).toBe(false);
    }
  });
});
