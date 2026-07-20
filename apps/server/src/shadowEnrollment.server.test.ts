/**
 * Phase 3A1 — real PostgreSQL enrollment state machine + signed shadow request
 * auth + atomic revocation. All crypto is real (node:crypto Ed25519/X25519); no
 * primitive is mocked. Gated on TEST_DATABASE_URL (a disposable PostgreSQL DB).
 */
process.env.SHADOW_RELAY_ORIGINS = 'https://relay.test';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { runMigrations, getDb, closeDb, type DB } from './db.js';
import * as m0001 from './migrations/0001_devices.js';
import * as m0002 from './migrations/0002_shadow_relay.js';
import * as m0003 from './migrations/0003_shadow_enrollment.js';
import * as m0004 from './migrations/0004_shadow_transition.js';
import * as m0005 from './migrations/0005_shadow_lease_renewal_receipt.js';
import * as m0006 from './migrations/0006_shadow_capabilities.js';
import * as m0007 from './migrations/0007_shadow_capability_limit_8.js';
import * as m0008 from './migrations/0008_shadow_pending_enrollment_unique.js';
import * as m0009 from './migrations/0009_shadow_grant_active_unique.js';
import { upsertDevice } from './accountDevices.js';
import { buildAccountServer } from './accountServer.js';
import { auth, migrateAuth } from './auth.js';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import {
  base64urlEncode,
  base64urlDecode,
} from '@maestro/realtime/shadowCrypto';
import {
  generateShadowIdentity,
  materializeIdentity,
  buildEnrollmentRequest,
  approveEnrollment as hostApproveEnrollment,
  acceptEnrollmentGrant,
  signDeviceRevocation,
  type ShadowIdentity,
  type EnrollmentBootstrap,
  SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME,
  SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
} from '@maestro/realtime/shadowEnrollment';
import {
  registerHostIdentity,
  createEnrollmentSession,
  submitEnrollmentRequest,
  approveEnrollment,
  denyEnrollment,
  cancelEnrollment,
  pollEnrollment,
  revokeEnrolledController,
  listEnrollmentSessions,
  listEnrolledControllers,
  signHostRegistration,
  signHostRotation,
  signControllerPoll,
  computeEnrollmentVerifier,
  listAccountEnrollmentMacs,
  createAccountEnrollmentChallenge,
} from './shadowEnrollmentService.js';
import { acquireShadowLease } from './shadowRelay.js';
import { shadowRequestProofBytes } from './shadowRequestAuth.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const RELAY_ORIGIN = 'https://relay.test';

const ALL_TABLES = [
  'shadow_revocation_record', 'shadow_request_nonce', 'shadow_enrollment_grant', 'shadow_enrollment_request',
  'shadow_enrollment_session', 'shadow_registered_key', 'shadow_host_identity',
  'shadow_transport', 'shadow_command', 'shadow_blob_capability', 'shadow_blob', 'shadow_chunk',
  'shadow_snapshot', 'shadow_cursor', 'shadow_event', 'shadow_revoked_controller', 'shadow_lease',
] as const;

async function resetDb(): Promise<void> {
  for (const t of ALL_TABLES) await getDb().schema.dropTable(t).ifExists().execute();
  await runMigrations();
  for (const t of ALL_TABLES) await getDb().deleteFrom(t as never).execute();
  await getDb().deleteFrom('device').execute();
}

async function resetTo0007Db(): Promise<void> {
  for (const t of ALL_TABLES) await getDb().schema.dropTable(t).ifExists().execute();
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007]) await m.up(getDb());
  await getDb().deleteFrom('device').execute();
}

async function resetTo0008Db(): Promise<void> {
  for (const t of ALL_TABLES) await getDb().schema.dropTable(t).ifExists().execute();
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008]) await m.up(getDb());
  await getDb().deleteFrom('device').execute();
}

async function grantIndexDefinitions(): Promise<Array<{ indexname: string; indexdef: string }>> {
  const result = await sql<{ indexname: string; indexdef: string }>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'shadow_enrollment_grant'
      AND indexname IN ('shadow_enrollment_grant_controller_idx', 'shadow_enrollment_active_grant_controller_idx')
    ORDER BY indexname
  `.execute(getDb());
  return result.rows;
}

async function expectCanonicalGrantIndex(): Promise<void> {
  const indexes = await grantIndexDefinitions();
  expect(indexes).toHaveLength(1);
  expect(indexes[0]?.indexname).toBe('shadow_enrollment_grant_controller_idx');
  expect(indexes[0]?.indexdef).toContain('CREATE UNIQUE INDEX shadow_enrollment_grant_controller_idx');
  expect(indexes[0]?.indexdef).toContain('ON public.shadow_enrollment_grant');
  expect(indexes[0]?.indexdef).toContain('(account_id, scope_id, controller_device_id)');
  expect(indexes[0]?.indexdef).toContain("WHERE (status = 'active'::text)");
}

async function grantRowsJson(accountId: string): Promise<unknown[]> {
  const result = await sql`
    SELECT row_to_json(g)::text AS row_json
    FROM (
      SELECT *
      FROM shadow_enrollment_grant
      WHERE account_id = ${accountId}
      ORDER BY grant_id
    ) g
  `.execute(getDb());
  return result.rows;
}

async function makeRegisteredHost(accountId: string, hostDeviceId: string): Promise<ShadowIdentity> {
  await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
  const host = await generateShadowIdentity(backend, hostDeviceId);
  const registrationSignature = await signHostRegistration(backend, host.keys.signing.privateKey, accountId, hostDeviceId, host.signingPublicKey, host.agreementPublicKey);
  await registerHostIdentity({
    accountId, hostDeviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey),
    registrationSignature, nowMs: Date.now(),
  });
  return host;
}

function bootstrapFor(host: ShadowIdentity, accountId: string, sessionId: string, secret: Uint8Array, expiresAt: number): EnrollmentBootstrap {
  return {
    scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION, sessionId, accountId,
    hostDeviceId: host.deviceId, hostSigningKeyId: host.signingKeyId,
    hostSigningPublicKey: base64urlEncode(host.signingPublicKey), hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey),
    relayOrigin: RELAY_ORIGIN, secret: base64urlEncode(secret), expiresAt,
  };
}

interface EnrollResult {
  controller: ShadowIdentity;
  sessionId: string;
  fence: { accountId: string; scopeId: string; hostDeviceId: string; epoch: number; leaseId: string };
  hostScopeKey: Uint8Array;
  grantMsg: unknown;
  keyMaterial: unknown;
  bootstrap: EnrollmentBootstrap;
  transcriptHash: Uint8Array;
}

/** Full happy-path enrollment through explicit host approval, using real crypto. */
async function fullEnroll(accountId: string, host: ShadowIdentity, controllerDeviceId: string, sessionId = 'es_flow'): Promise<EnrollResult> {
  const now = Date.now();
  const secret = backend.randomBytes(32);
  const salt = backend.randomBytes(16);
  const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
  const session = await createEnrollmentSession({
    accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId,
    secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now,
  });
  const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
  const controller = await generateShadowIdentity(backend, controllerDeviceId);
  const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });
  await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: base64urlEncode(presentedSecret), nowMs: now });

  // Host acquires a lease → real fence, then produces a signed grant + wrapped key.
  const lease = await acquireShadowLease({ accountId, hostDeviceId: host.deviceId, scopeId: `account:${accountId}`, requestedLeaseId: `lease_${sessionId}`, ttlMs: 120_000 });
  const transcriptHash = base64urlDecode(request.transcriptHash);
  const approval = await hostApproveEnrollment(backend, {
    host, fence: lease.fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey),
    transcriptHash, sessionId, nowMs: now, ttlMs: 120_000,
  });
  await approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs: now });
  return { controller, sessionId, fence: lease.fence, hostScopeKey: approval.scopeKey, grantMsg: approval.grant, keyMaterial: approval.keyMaterial, bootstrap, transcriptHash };
}

async function buildPendingRequest(accountId: string, host: ShadowIdentity, controllerDeviceId: string, sessionId: string, now = Date.now()) {
  const secret = backend.randomBytes(32);
  const salt = backend.randomBytes(16);
  const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
  const session = await createEnrollmentSession({
    accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId,
    secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now,
  });
  const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
  const controller = await generateShadowIdentity(backend, controllerDeviceId);
  const built = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });
  return { controller, request: built.request, presentedSecret: base64urlEncode(built.presentedSecret), session, now };
}

/** Enroll an additional controller against an EXISTING host/lease fence. Returns its grantId. */
async function enrollAnother(accountId: string, host: ShadowIdentity, controllerDeviceId: string, fence: EnrollResult['fence'], sessionId: string): Promise<{ controller: ShadowIdentity; grantId: string }> {
  const now = Date.now();
  const secret = backend.randomBytes(32); const salt = backend.randomBytes(16);
  const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
  const session = await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now });
  const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
  const controller = await generateShadowIdentity(backend, controllerDeviceId);
  const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });
  await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: base64urlEncode(presentedSecret), nowMs: now });
  const approval = await hostApproveEnrollment(backend, { host, fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash: base64urlDecode(request.transcriptHash), sessionId, nowMs: now, ttlMs: 120_000 });
  const view = await approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs: now });
  return { controller, grantId: view.grantId };
}

async function approvePendingWithFence(accountId: string, host: ShadowIdentity, pending: Awaited<ReturnType<typeof buildPendingRequest>>, fence: EnrollResult['fence']) {
  const approval = await hostApproveEnrollment(backend, {
    host,
    fence,
    controllerDeviceId: pending.controller.deviceId,
    controllerAgreementPublicKey: base64urlDecode(pending.request.agreementPublicKey),
    transcriptHash: base64urlDecode(pending.request.transcriptHash),
    sessionId: pending.session.sessionId,
    nowMs: pending.now,
    ttlMs: 120_000,
  });
  return approveEnrollment({
    accountId,
    hostDeviceId: host.deviceId,
    sessionId: pending.session.sessionId,
    grant: approval.grant,
    keyMaterial: approval.keyMaterial,
    nowMs: pending.now,
  });
}

// ── Signed request proof helper ───────────────────────────────────────────
// Attach the account id to an identity for the signing helper.
type IdentityWithAccount = ShadowIdentity & { __accountId?: string };

let nonceCounter = 0;
async function signHeaders(identity: IdentityWithAccount, method: string, url: string, body: string): Promise<Record<string, string>> {
  const timestampMs = Date.now();
  const nonce = `n_${Date.now()}_${nonceCounter++}`;
  const bytes = shadowRequestProofBytes({ method, rawUrl: url, rawBody: body, accountId: identity.__accountId ?? '', deviceId: identity.deviceId, keyId: identity.signingKeyId, timestampMs, nonce });
  const signature = base64urlEncode(await backend.sign(identity.keys.signing.privateKey, bytes));
  return {
    'x-maestro-device-id': identity.deviceId,
    'x-maestro-shadow-key-id': identity.signingKeyId,
    'x-maestro-shadow-timestamp': String(timestampMs),
    'x-maestro-shadow-nonce': nonce,
    'x-maestro-shadow-signature': signature,
    'content-type': 'application/json',
  };
}

describe.skipIf(!HAS_DB)('shadow enrollment — migration + host identity + state machine', () => {
  beforeEach(async () => { await resetDb(); });

  it('applies the enrollment migration idempotently and survives reopen', async () => {
    await runMigrations();
    await runMigrations(); // twice, no error
    await getDb().insertInto('shadow_request_nonce').values({ account_id: 'a', device_id: 'd', nonce: 'x', expires_at_ms: Date.now() + 1000, created_at: new Date() }).execute();
    // A brand-new connection (fresh pool) sees the migrated tables + data.
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const freshDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    try {
      await runMigrations(); // migrator is idempotent on the reopened schema too
      const row = await freshDb.selectFrom('shadow_request_nonce').selectAll().where('account_id', '=', 'a').executeTakeFirst();
      expect(row?.nonce).toBe('x');
    } finally {
      await freshDb.destroy();
    }
  });

  it('registers a host identity (TOFU), is idempotent, and requires a rotation signature to replace keys', async () => {
    const accountId = 'acct-tofu';
    const host = await makeRegisteredHost(accountId, 'host-tofu');
    // Idempotent re-register with same keys.
    const sig = await signHostRegistration(backend, host.keys.signing.privateKey, accountId, host.deviceId, host.signingPublicKey, host.agreementPublicKey);
    const again = await registerHostIdentity({ accountId, hostDeviceId: host.deviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: sig, nowMs: Date.now() });
    expect(again.rotated).toBe(false);

    // Different keys without a rotation signature → 409.
    const host2 = await generateShadowIdentity(backend, host.deviceId);
    const sig2 = await signHostRegistration(backend, host2.keys.signing.privateKey, accountId, host.deviceId, host2.signingPublicKey, host2.agreementPublicKey);
    await expect(registerHostIdentity({ accountId, hostDeviceId: host.deviceId, signingPublicKey: base64urlEncode(host2.signingPublicKey), agreementPublicKey: base64urlEncode(host2.agreementPublicKey), registrationSignature: sig2, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 409 });

    // With a valid rotation signature by the CURRENT key → rotates.
    const rot = await signHostRotation(backend, host.keys.signing.privateKey, accountId, host.deviceId, host2.signingPublicKey, host2.agreementPublicKey);
    const rotated = await registerHostIdentity({ accountId, hostDeviceId: host.deviceId, signingPublicKey: base64urlEncode(host2.signingPublicKey), agreementPublicKey: base64urlEncode(host2.agreementPublicKey), registrationSignature: sig2, rotationSignature: rot, nowMs: Date.now() });
    expect(rotated.rotated).toBe(true);
    // Old signing key is retired.
    const old = await getDb().selectFrom('shadow_registered_key').selectAll().where('account_id', '=', accountId).where('key_id', '=', host.signingKeyId).executeTakeFirst();
    expect(old?.status).toBe('revoked');
  });

  it('rejects a host registration with a forged self-signature', async () => {
    const accountId = 'acct-forge';
    await upsertDevice({ id: 'host-forge', userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const host = await generateShadowIdentity(backend, 'host-forge');
    const other = await generateShadowIdentity(backend, 'host-forge');
    const badSig = await signHostRegistration(backend, other.keys.signing.privateKey, accountId, host.deviceId, host.signingPublicKey, host.agreementPublicKey);
    await expect(registerHostIdentity({ accountId, hostDeviceId: host.deviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: badSig, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('runs the full happy enrollment flow and both tiers derive the SAME scope key', async () => {
    const accountId = 'acct-happy';
    const host = await makeRegisteredHost(accountId, 'host-happy');
    const r = await fullEnroll(accountId, host, 'ctrl-happy');
    // Controller unwraps the grant → identical scope key (round-trip).
    const accepted = await acceptEnrollmentGrant(backend, { controller: r.controller, bootstrap: r.bootstrap, grant: r.grantMsg as never, keyMaterial: r.keyMaterial as never, transcriptHash: r.transcriptHash, nowMs: Date.now() });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(Buffer.from(accepted.scopeKey)).toEqual(Buffer.from(r.hostScopeKey));
    // Controller is now a registered remote device with active signing key.
    const key = await getDb().selectFrom('shadow_registered_key').selectAll().where('account_id', '=', accountId).where('device_id', '=', 'ctrl-happy').where('purpose', '=', 'sign').executeTakeFirst();
    expect(key?.status).toBe('active');
  });

  it('rejects a fresh pending request for a controller that already has an active grant', async () => {
    const accountId = 'acct-active-duplicate';
    const host = await makeRegisteredHost(accountId, 'host-active-duplicate');
    await fullEnroll(accountId, host, 'ctrl-active-duplicate', 'es_active_duplicate_1');

    const now = Date.now();
    const sessionId = 'es_active_duplicate_2';
    const secret = backend.randomBytes(32);
    const salt = backend.randomBytes(16);
    const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
    const session = await createEnrollmentSession({
      accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId,
      secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now,
    });
    const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
    const controller = await generateShadowIdentity(backend, 'ctrl-active-duplicate');
    const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });

    await expect(submitEnrollmentRequest({
      accountId, sessionId, request, presentedSecret: base64urlEncode(presentedSecret), idempotencyKey: `idem_${request.nonce}`, nowMs: now,
    })).rejects.toMatchObject({ statusCode: 409, message: 'controller already enrolled' });

    const pending = await getDb().selectFrom('shadow_enrollment_request')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    const sessionAfter = await getDb().selectFrom('shadow_enrollment_session')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    expect(pending).toBeUndefined();
    expect(sessionAfter?.status).toBe('pending');
  });

  it('allows exactly one pending request per account/controller under competing session concurrency', async () => {
    const accountId = 'acct-pending-concurrent';
    const hostA = await makeRegisteredHost(accountId, 'host-pending-concurrent-a');
    const hostB = await makeRegisteredHost(accountId, 'host-pending-concurrent-b');
    const controllerDeviceId = 'ctrl-pending-concurrent';
    const a = await buildPendingRequest(accountId, hostA, controllerDeviceId, 'es_pending_concurrent_a');
    const b = await buildPendingRequest(accountId, hostB, controllerDeviceId, 'es_pending_concurrent_b');

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const submitA = (async () => { await barrier; return submitEnrollmentRequest({ accountId, sessionId: 'es_pending_concurrent_a', request: a.request, presentedSecret: a.presentedSecret, idempotencyKey: `idem_${a.request.nonce}`, nowMs: a.now }); })();
    const submitB = (async () => { await barrier; return submitEnrollmentRequest({ accountId, sessionId: 'es_pending_concurrent_b', request: b.request, presentedSecret: b.presentedSecret, idempotencyKey: `idem_${b.request.nonce}`, nowMs: b.now }); })();
    release();

    const results = await Promise.allSettled([submitA, submitB]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409, message: 'controller already enrolled' });
    const rows = await getDb().selectFrom('shadow_enrollment_request')
      .select(['account_id', 'session_id', 'controller_device_id', 'status'])
      .where('account_id', '=', accountId)
      .where('controller_device_id', '=', controllerDeviceId)
      .execute();
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('keeps pending uniqueness account-scoped without cross-tenant leakage', async () => {
    const hostA = await makeRegisteredHost('acct-pending-tenant-a', 'host-pending-tenant-a');
    const hostB = await makeRegisteredHost('acct-pending-tenant-b', 'host-pending-tenant-b');
    const a = await buildPendingRequest('acct-pending-tenant-a', hostA, 'ctrl-shared-name', 'es_pending_tenant_a');
    const b = await buildPendingRequest('acct-pending-tenant-b', hostB, 'ctrl-shared-name', 'es_pending_tenant_b');
    await expect(submitEnrollmentRequest({ accountId: 'acct-pending-tenant-a', sessionId: 'es_pending_tenant_a', request: a.request, presentedSecret: a.presentedSecret, idempotencyKey: `idem_${a.request.nonce}`, nowMs: a.now })).resolves.toMatchObject({ status: 'pending' });
    await expect(submitEnrollmentRequest({ accountId: 'acct-pending-tenant-b', sessionId: 'es_pending_tenant_b', request: b.request, presentedSecret: b.presentedSecret, idempotencyKey: `idem_${b.request.nonce}`, nowMs: b.now })).resolves.toMatchObject({ status: 'pending' });
    const count = await getDb().selectFrom('shadow_enrollment_request').select(sql<number>`count(*)`.as('count')).where('controller_device_id', '=', 'ctrl-shared-name').executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(2);
  });

  it('coalesces exact idempotent replay but rejects competing pending sessions before grant', async () => {
    const accountId = 'acct-pending-replay';
    const host = await makeRegisteredHost(accountId, 'host-pending-replay');
    const first = await buildPendingRequest(accountId, host, 'ctrl-pending-replay', 'es_pending_replay_1');
    const inserted = await submitEnrollmentRequest({ accountId, sessionId: 'es_pending_replay_1', request: first.request, presentedSecret: first.presentedSecret, idempotencyKey: `idem_${first.request.nonce}`, nowMs: first.now });
    const replay = await submitEnrollmentRequest({ accountId, sessionId: 'es_pending_replay_1', request: first.request, presentedSecret: first.presentedSecret, idempotencyKey: `idem_${first.request.nonce}`, nowMs: first.now });
    expect(inserted.status).toBe('pending');
    expect(replay.coalesced).toBe(true);

    const second = await buildPendingRequest(accountId, host, 'ctrl-pending-replay', 'es_pending_replay_2');
    await expect(submitEnrollmentRequest({ accountId, sessionId: 'es_pending_replay_2', request: second.request, presentedSecret: second.presentedSecret, idempotencyKey: `idem_${second.request.nonce}`, nowMs: second.now })).rejects.toMatchObject({ statusCode: 409, message: 'controller already enrolled' });
    const sessionAfter = await getDb().selectFrom('shadow_enrollment_session').select(['status']).where('account_id', '=', accountId).where('session_id', '=', 'es_pending_replay_2').executeTakeFirst();
    expect(sessionAfter?.status).toBe('pending');
  });

  it('allows re-enrollment after pending expiry, after active revoke, but not while active', async () => {
    const accountId = 'acct-pending-lifecycle';
    const host = await makeRegisteredHost(accountId, 'host-pending-lifecycle');
    const first = await buildPendingRequest(accountId, host, 'ctrl-pending-lifecycle-expired', 'es_pending_lifecycle_expired', Date.now());
    await submitEnrollmentRequest({ accountId, sessionId: 'es_pending_lifecycle_expired', request: first.request, presentedSecret: first.presentedSecret, idempotencyKey: `idem_${first.request.nonce}`, nowMs: first.now });
    await getDb().updateTable('shadow_enrollment_session')
      .set({ expires_at_ms: first.now - 1 })
      .where('account_id', '=', accountId)
      .where('session_id', '=', 'es_pending_lifecycle_expired')
      .execute();
    const second = await buildPendingRequest(accountId, host, 'ctrl-pending-lifecycle-expired', 'es_pending_lifecycle_after_denied');
    await expect(submitEnrollmentRequest({ accountId, sessionId: 'es_pending_lifecycle_after_denied', request: second.request, presentedSecret: second.presentedSecret, idempotencyKey: `idem_${second.request.nonce}`, nowMs: second.now })).resolves.toMatchObject({ status: 'pending' });
    const expiredRequest = await getDb().selectFrom('shadow_enrollment_request').select(['status']).where('account_id', '=', accountId).where('session_id', '=', 'es_pending_lifecycle_expired').executeTakeFirst();
    const expiredSession = await getDb().selectFrom('shadow_enrollment_session').select(['status']).where('account_id', '=', accountId).where('session_id', '=', 'es_pending_lifecycle_expired').executeTakeFirst();
    expect(expiredRequest?.status).toBe('denied');
    expect(expiredSession?.status).toBe('cancelled');

    const enrolled = await fullEnroll(accountId, host, 'ctrl-pending-lifecycle-active', 'es_pending_lifecycle_active');
    const activeDup = await buildPendingRequest(accountId, host, 'ctrl-pending-lifecycle-active', 'es_pending_lifecycle_active_dup');
    await expect(submitEnrollmentRequest({ accountId, sessionId: 'es_pending_lifecycle_active_dup', request: activeDup.request, presentedSecret: activeDup.presentedSecret, idempotencyKey: `idem_${activeDup.request.nonce}`, nowMs: activeDup.now })).rejects.toMatchObject({ statusCode: 409, message: 'controller already enrolled' });

    const rev = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence: enrolled.fence, controllerDeviceId: enrolled.controller.deviceId, revokedAt: Date.now(), keyRotationId: 'kr_pending_lifecycle' });
    await revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: enrolled.fence.scopeId, controllerDeviceId: enrolled.controller.deviceId, revocation: rev, effectiveSeq: 1, nowMs: Date.now() });
    const afterRevoke = await buildPendingRequest(accountId, host, 'ctrl-pending-lifecycle-active', 'es_pending_lifecycle_after_revoke');
    await expect(submitEnrollmentRequest({ accountId, sessionId: 'es_pending_lifecycle_after_revoke', request: afterRevoke.request, presentedSecret: afterRevoke.presentedSecret, idempotencyKey: `idem_${afterRevoke.request.nonce}`, nowMs: afterRevoke.now })).resolves.toMatchObject({ status: 'pending' });
  });

  it('0008 migrates old-schema duplicate pending rows deterministically and reapplies idempotently', async () => {
    await resetTo0007Db();
    const accountId = 'acct-old-dup';
    const host = await makeRegisteredHost(accountId, 'host-old-dup');
    const now = new Date('2026-07-20T00:00:00.000Z');
    for (const sid of ['es_old_dup_keep', 'es_old_dup_cancel']) {
      await getDb().insertInto('shadow_enrollment_session').values({
        account_id: accountId, session_id: sid, host_device_id: host.deviceId, host_signing_key_id: host.signingKeyId,
        relay_origin: RELAY_ORIGIN, secret_salt: base64urlEncode(backend.randomBytes(16)), secret_verifier: base64urlEncode(backend.randomBytes(32)),
        expected_fingerprint: null, status: 'consumed', created_at_ms: 1, expires_at_ms: 9_999_999_999_999, created_at: now, updated_at: now,
      }).execute();
    }
    await getDb().insertInto('shadow_enrollment_request').values([
      { account_id: accountId, session_id: 'es_old_dup_keep', controller_device_id: 'ctrl-old-dup', controller_signing_key_id: 'sign_keep', controller_agreement_key_id: 'agree_keep', signing_public_key: base64urlEncode(backend.randomBytes(32)), agreement_public_key: base64urlEncode(backend.randomBytes(32)), nonce: 'nonce_keep', requested_at_ms: 1, transcript_hash: base64urlEncode(backend.randomBytes(32)), signature: base64urlEncode(backend.randomBytes(64)), status: 'pending', requested_capabilities: JSON.stringify(['account.read']), created_at: now, updated_at: now },
      { account_id: accountId, session_id: 'es_old_dup_cancel', controller_device_id: 'ctrl-old-dup', controller_signing_key_id: 'sign_cancel', controller_agreement_key_id: 'agree_cancel', signing_public_key: base64urlEncode(backend.randomBytes(32)), agreement_public_key: base64urlEncode(backend.randomBytes(32)), nonce: 'nonce_cancel', requested_at_ms: 2, transcript_hash: base64urlEncode(backend.randomBytes(32)), signature: base64urlEncode(backend.randomBytes(64)), status: 'pending', requested_capabilities: JSON.stringify(['account.read']), created_at: new Date(now.getTime() + 1), updated_at: now },
    ]).execute();

    await m0008.up(getDb());
    await m0008.up(getDb());
    const requests = await getDb().selectFrom('shadow_enrollment_request').select(['session_id', 'status']).where('account_id', '=', accountId).orderBy('session_id').execute();
    expect(requests).toEqual([
      { session_id: 'es_old_dup_cancel', status: 'denied' },
      { session_id: 'es_old_dup_keep', status: 'pending' },
    ]);
    const cancelled = await getDb().selectFrom('shadow_enrollment_session').select(['status']).where('account_id', '=', accountId).where('session_id', '=', 'es_old_dup_cancel').executeTakeFirst();
    expect(cancelled?.status).toBe('cancelled');
    await expect(getDb().insertInto('shadow_enrollment_request').values({
      account_id: accountId, session_id: 'es_old_dup_conflict', controller_device_id: 'ctrl-old-dup', controller_signing_key_id: 'sign_x', controller_agreement_key_id: 'agree_x',
      signing_public_key: base64urlEncode(backend.randomBytes(32)), agreement_public_key: base64urlEncode(backend.randomBytes(32)), nonce: 'nonce_x', requested_at_ms: 3,
      transcript_hash: base64urlEncode(backend.randomBytes(32)), signature: base64urlEncode(backend.randomBytes(64)), status: 'pending', requested_capabilities: JSON.stringify(['account.read']), created_at: new Date(), updated_at: new Date(),
    }).execute()).rejects.toMatchObject({ code: '23505' });
  });

  it('0009 replaces global grant uniqueness with active-only uniqueness and preserves revoked history', async () => {
    await resetTo0008Db();
    const accountId = 'acct-0009-reenroll-upgrade';
    const host = await makeRegisteredHost(accountId, 'host-0009-reenroll-upgrade');
    const first = await fullEnroll(accountId, host, 'ctrl-0009-reenroll-upgrade', 'es_0009_first');
    const rev = await signDeviceRevocation(backend, host, {
      family: 'device-revocation',
      v: 1,
      fence: first.fence,
      controllerDeviceId: first.controller.deviceId,
      revokedAt: Date.now(),
      keyRotationId: 'kr_0009_first',
    });
    await revokeEnrolledController({
      accountId,
      hostDeviceId: host.deviceId,
      scopeId: first.fence.scopeId,
      controllerDeviceId: first.controller.deviceId,
      revocation: rev,
      effectiveSeq: 1,
      nowMs: Date.now(),
    });

    const next = await buildPendingRequest(accountId, host, first.controller.deviceId, 'es_0009_second');
    await submitEnrollmentRequest({ accountId, sessionId: 'es_0009_second', request: next.request, presentedSecret: next.presentedSecret, idempotencyKey: `idem_${next.request.nonce}`, nowMs: next.now });
    const approval = await hostApproveEnrollment(backend, {
      host,
      fence: first.fence,
      controllerDeviceId: next.controller.deviceId,
      controllerAgreementPublicKey: base64urlDecode(next.request.agreementPublicKey),
      transcriptHash: base64urlDecode(next.request.transcriptHash),
      sessionId: 'es_0009_second',
      nowMs: next.now,
      ttlMs: 120_000,
    });

    await expect(approveEnrollment({
      accountId,
      hostDeviceId: host.deviceId,
      sessionId: 'es_0009_second',
      grant: approval.grant,
      keyMaterial: approval.keyMaterial,
      nowMs: next.now,
    })).rejects.toMatchObject({ statusCode: 409, message: 'controller already enrolled' });
    await denyEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: 'es_0009_second' });

    await m0009.up(getDb());
    await m0009.up(getDb());
    const retry = await buildPendingRequest(accountId, host, first.controller.deviceId, 'es_0009_retry');
    await submitEnrollmentRequest({ accountId, sessionId: 'es_0009_retry', request: retry.request, presentedSecret: retry.presentedSecret, idempotencyKey: `idem_${retry.request.nonce}`, nowMs: retry.now });
    await expect(approvePendingWithFence(accountId, host, retry, first.fence)).resolves.toMatchObject({ status: 'active', controllerDeviceId: first.controller.deviceId });

    const rows = await getDb().selectFrom('shadow_enrollment_grant')
      .select(['grant_id', 'status'])
      .where('account_id', '=', accountId)
      .where('scope_id', '=', first.fence.scopeId)
      .where('controller_device_id', '=', first.controller.deviceId)
      .orderBy('created_at')
      .execute();
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'revoked']);
    expect(rows).toHaveLength(2);
    await expectCanonicalGrantIndex();
    await expect(getDb().insertInto('shadow_enrollment_grant').values({
      account_id: accountId,
      grant_id: 'grant_0009_active_conflict',
      scope_id: first.fence.scopeId,
      session_id: 'es_0009_manual_conflict',
      controller_device_id: first.controller.deviceId,
      host_device_id: host.deviceId,
      epoch: first.fence.epoch,
      lease_id: first.fence.leaseId,
      key_id: 'key_0009_manual_conflict',
      expires_at_ms: Date.now() + 120_000,
      signed_at_ms: Date.now(),
      grant_signature: base64urlEncode(backend.randomBytes(64)),
      wrap_nonce: base64urlEncode(backend.randomBytes(24)),
      wrapped_scope_key: base64urlEncode(backend.randomBytes(48)),
      transcript_hash: base64urlEncode(backend.randomBytes(32)),
      status: 'active',
      key_rotation_id: null,
      revoked_at_ms: null,
      approved_capabilities: JSON.stringify(['account.read']),
      created_at: new Date(),
      updated_at: new Date(),
    }).execute()).rejects.toMatchObject({ code: '23505', constraint: 'shadow_enrollment_grant_controller_idx' });
  });

  it('0009 fails closed on impossible duplicate active grants without mutating state or schema', async () => {
    await resetTo0008Db();
    const accountId = 'acct-0009-duplicate-active';
    const host = await makeRegisteredHost(accountId, 'host-0009-duplicate-active');
    const first = await fullEnroll(accountId, host, 'ctrl-0009-duplicate-active', 'es_0009_duplicate_active_first');

    await sql`DROP INDEX shadow_enrollment_grant_controller_idx`.execute(getDb());
    await sql`
      INSERT INTO shadow_enrollment_grant (
        account_id, grant_id, scope_id, session_id, controller_device_id, host_device_id,
        epoch, lease_id, key_id, expires_at_ms, signed_at_ms, grant_signature, wrap_nonce,
        wrapped_scope_key, transcript_hash, status, key_rotation_id, revoked_at_ms,
        approved_capabilities, created_at, updated_at
      )
      SELECT
        account_id, 'grant_0009_duplicate_active_second', scope_id, 'es_0009_duplicate_active_second',
        controller_device_id, host_device_id, epoch, lease_id, 'key_0009_duplicate_active_second',
        expires_at_ms, signed_at_ms + 1, grant_signature, wrap_nonce, wrapped_scope_key,
        transcript_hash, 'active', key_rotation_id, revoked_at_ms, approved_capabilities,
        created_at + interval '1 millisecond', updated_at
      FROM shadow_enrollment_grant
      WHERE account_id = ${accountId}
        AND scope_id = ${first.fence.scopeId}
        AND controller_device_id = ${first.controller.deviceId}
        AND status = 'active'
    `.execute(getDb());

    const beforeRows = await sql`
      SELECT row_to_json(g)::text AS row_json
      FROM (
        SELECT *
        FROM shadow_enrollment_grant
        WHERE account_id = ${accountId}
        ORDER BY grant_id
      ) g
    `.execute(getDb());
    const beforeIndexes = await sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'shadow_enrollment_grant'
      ORDER BY indexname
    `.execute(getDb());

    await expect(m0009.up(getDb())).rejects.toThrow('migration 0009 blocked: duplicate active shadow enrollment grants');

    const afterRows = await sql`
      SELECT row_to_json(g)::text AS row_json
      FROM (
        SELECT *
        FROM shadow_enrollment_grant
        WHERE account_id = ${accountId}
        ORDER BY grant_id
      ) g
    `.execute(getDb());
    const afterIndexes = await sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'shadow_enrollment_grant'
      ORDER BY indexname
    `.execute(getDb());
    expect(afterRows.rows).toEqual(beforeRows.rows);
    expect(afterIndexes.rows).toEqual(beforeIndexes.rows);
    await expect(sql`select 1 from pg_indexes where indexname = 'shadow_enrollment_active_grant_controller_idx'`.execute(getDb())).resolves.toMatchObject({ rows: [] });

    await getDb().updateTable('shadow_enrollment_grant')
      .set({ status: 'revoked', revoked_at_ms: Date.now(), updated_at: new Date() })
      .where('account_id', '=', accountId)
      .where('grant_id', '=', 'grant_0009_duplicate_active_second')
      .execute();

    await expect(m0009.up(getDb())).resolves.toBeUndefined();
    await expectCanonicalGrantIndex();
    await m0009.up(getDb());
    await expectCanonicalGrantIndex();
  });

  it('full startup normalizes the production transitional grant index before rerunning 0003', async () => {
    await resetTo0008Db();
    const accountId = 'acct-0009-transitional-restart';
    const host = await makeRegisteredHost(accountId, 'host-0009-transitional-restart');
    const first = await fullEnroll(accountId, host, 'ctrl-0009-transitional-restart', 'es_0009_transitional_first');

    await m0009.up(getDb());
    const rev = await signDeviceRevocation(backend, host, {
      family: 'device-revocation',
      v: 1,
      fence: first.fence,
      controllerDeviceId: first.controller.deviceId,
      revokedAt: Date.now(),
      keyRotationId: 'kr_0009_transitional_first',
    });
    await revokeEnrolledController({
      accountId,
      hostDeviceId: host.deviceId,
      scopeId: first.fence.scopeId,
      controllerDeviceId: first.controller.deviceId,
      revocation: rev,
      effectiveSeq: 9,
      nowMs: Date.now(),
    });
    const retry = await buildPendingRequest(accountId, host, first.controller.deviceId, 'es_0009_transitional_retry');
    await submitEnrollmentRequest({ accountId, sessionId: retry.session.sessionId, request: retry.request, presentedSecret: retry.presentedSecret, idempotencyKey: `idem_${retry.request.nonce}`, nowMs: retry.now });
    await approvePendingWithFence(accountId, host, retry, first.fence);

    await sql`ALTER INDEX shadow_enrollment_grant_controller_idx RENAME TO shadow_enrollment_active_grant_controller_idx`.execute(getDb());
    const beforeRows = await grantRowsJson(accountId);
    const beforeRevocations = await sql`
      SELECT row_to_json(r)::text AS row_json
      FROM (
        SELECT *
        FROM shadow_revocation_record
        WHERE account_id = ${accountId}
        ORDER BY key_rotation_id
      ) r
    `.execute(getDb());

    await expect(runMigrations()).resolves.toBeUndefined();
    await expectCanonicalGrantIndex();
    await expect(runMigrations()).resolves.toBeUndefined();
    await expect(runMigrations()).resolves.toBeUndefined();
    await expectCanonicalGrantIndex();
    expect(await grantRowsJson(accountId)).toEqual(beforeRows);
    await expect(sql`
      SELECT row_to_json(r)::text AS row_json
      FROM (
        SELECT *
        FROM shadow_revocation_record
        WHERE account_id = ${accountId}
        ORDER BY key_rotation_id
      ) r
    `.execute(getDb())).resolves.toEqual(beforeRevocations);
  });

  it('full startup fails closed on mismatched transitional grant index definitions without row mutation', async () => {
    await resetTo0008Db();
    const accountId = 'acct-0009-transitional-mismatch';
    const host = await makeRegisteredHost(accountId, 'host-0009-transitional-mismatch');
    await fullEnroll(accountId, host, 'ctrl-0009-transitional-mismatch', 'es_0009_transitional_mismatch');
    await sql`DROP INDEX shadow_enrollment_grant_controller_idx`.execute(getDb());
    await sql`
      CREATE UNIQUE INDEX shadow_enrollment_active_grant_controller_idx
      ON shadow_enrollment_grant (account_id, scope_id, controller_device_id)
      WHERE status = 'revoked'
    `.execute(getDb());
    const beforeRows = await grantRowsJson(accountId);
    const beforeIndexes = await grantIndexDefinitions();

    await expect(runMigrations()).rejects.toThrow('migration compatibility blocked: unexpected transitional shadow enrollment grant index definition');

    expect(await grantRowsJson(accountId)).toEqual(beforeRows);
    expect(await grantIndexDefinitions()).toEqual(beforeIndexes);
  });

  it('0009 fails closed on mismatched historical grant index definitions without row mutation', async () => {
    await resetTo0008Db();
    const accountId = 'acct-0009-historical-mismatch';
    const host = await makeRegisteredHost(accountId, 'host-0009-historical-mismatch');
    await fullEnroll(accountId, host, 'ctrl-0009-historical-mismatch', 'es_0009_historical_mismatch');
    await sql`DROP INDEX shadow_enrollment_grant_controller_idx`.execute(getDb());
    await sql`
      CREATE UNIQUE INDEX shadow_enrollment_grant_controller_idx
      ON shadow_enrollment_grant (account_id, controller_device_id, scope_id)
      WHERE status = 'active'
    `.execute(getDb());
    const beforeRows = await grantRowsJson(accountId);
    const beforeIndexes = await grantIndexDefinitions();

    await expect(m0009.up(getDb())).rejects.toThrow('migration 0009 blocked: unexpected shadow_enrollment_grant_controller_idx definition');

    expect(await grantRowsJson(accountId)).toEqual(beforeRows);
    expect(await grantIndexDefinitions()).toEqual(beforeIndexes);
  });

  it('approves re-enrollment after revoke while keeping old grant history and transactional key reactivation', async () => {
    const accountId = 'acct-revoked-reapprove';
    const host = await makeRegisteredHost(accountId, 'host-revoked-reapprove');
    const first = await fullEnroll(accountId, host, 'ctrl-revoked-reapprove', 'es_reapprove_first');
    const rev = await signDeviceRevocation(backend, host, {
      family: 'device-revocation',
      v: 1,
      fence: first.fence,
      controllerDeviceId: first.controller.deviceId,
      revokedAt: Date.now(),
      keyRotationId: 'kr_reapprove_first',
    });
    await revokeEnrolledController({
      accountId,
      hostDeviceId: host.deviceId,
      scopeId: first.fence.scopeId,
      controllerDeviceId: first.controller.deviceId,
      revocation: rev,
      effectiveSeq: 40,
      nowMs: Date.now(),
    });

    const fresh = await buildPendingRequest(accountId, host, first.controller.deviceId, 'es_reapprove_second');
    await submitEnrollmentRequest({ accountId, sessionId: 'es_reapprove_second', request: fresh.request, presentedSecret: fresh.presentedSecret, idempotencyKey: `idem_${fresh.request.nonce}`, nowMs: fresh.now });
    await expect(approvePendingWithFence(accountId, host, fresh, first.fence)).resolves.toMatchObject({ status: 'active', controllerDeviceId: first.controller.deviceId });

    const grants = await getDb().selectFrom('shadow_enrollment_grant').select(['grant_id', 'status', 'key_rotation_id'])
      .where('account_id', '=', accountId)
      .where('scope_id', '=', first.fence.scopeId)
      .where('controller_device_id', '=', first.controller.deviceId)
      .orderBy('created_at')
      .execute();
    expect(grants).toHaveLength(2);
    expect(grants.filter((g) => g.status === 'active')).toHaveLength(1);
    expect(grants.filter((g) => g.status === 'revoked')).toHaveLength(1);
    expect(grants.find((g) => g.status === 'revoked')?.key_rotation_id).toBe('kr_reapprove_first');
    const keys = await getDb().selectFrom('shadow_registered_key').select(['key_id', 'status'])
      .where('account_id', '=', accountId)
      .where('device_id', '=', first.controller.deviceId)
      .orderBy('key_id')
      .execute();
    expect(keys.filter((k) => k.status === 'active').map((k) => k.key_id).sort()).toEqual([fresh.controller.agreementKeyId, fresh.controller.signingKeyId].sort());
    expect(keys.filter((k) => k.status === 'revoked').map((k) => k.key_id).sort()).toEqual([first.controller.agreementKeyId, first.controller.signingKeyId].sort());
    const revoked = await getDb().selectFrom('shadow_revoked_controller').selectAll()
      .where('account_id', '=', accountId)
      .where('scope_id', '=', first.fence.scopeId)
      .where('controller_device_id', '=', first.controller.deviceId)
      .executeTakeFirst();
    expect(revoked).toBeUndefined();
  });

  it('allows exactly one concurrent re-enrollment approval for the same revoked controller', async () => {
    const accountId = 'acct-reapprove-concurrent';
    const host = await makeRegisteredHost(accountId, 'host-reapprove-concurrent');
    const first = await fullEnroll(accountId, host, 'ctrl-reapprove-concurrent', 'es_reapprove_concurrent_first');
    const rev = await signDeviceRevocation(backend, host, {
      family: 'device-revocation',
      v: 1,
      fence: first.fence,
      controllerDeviceId: first.controller.deviceId,
      revokedAt: Date.now(),
      keyRotationId: 'kr_reapprove_concurrent',
    });
    await revokeEnrolledController({
      accountId,
      hostDeviceId: host.deviceId,
      scopeId: first.fence.scopeId,
      controllerDeviceId: first.controller.deviceId,
      revocation: rev,
      effectiveSeq: 41,
      nowMs: Date.now(),
    });

    const b = await buildPendingRequest(accountId, host, first.controller.deviceId, 'es_reapprove_concurrent_final_b');
    await submitEnrollmentRequest({ accountId, sessionId: 'es_reapprove_concurrent_final_b', request: b.request, presentedSecret: b.presentedSecret, idempotencyKey: `idem_${b.request.nonce}`, nowMs: b.now });
    const settled = await Promise.allSettled([
      approvePendingWithFence(accountId, host, b, first.fence),
      approvePendingWithFence(accountId, host, b, first.fence),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode === 409)).toHaveLength(1);
    const grants = await getDb().selectFrom('shadow_enrollment_grant').select(['status'])
      .where('account_id', '=', accountId)
      .where('scope_id', '=', first.fence.scopeId)
      .where('controller_device_id', '=', first.controller.deviceId)
      .execute();
    expect(grants.filter((g) => g.status === 'active')).toHaveLength(1);
  });

  // ── Review finding 1 (expired consumed-session approval) — recreated probe ──
  it('reviewer: rejects host approval after the consumed session has expired', async () => {
    const accountId = 'acct-review-expired-approval';
    const host = await makeRegisteredHost(accountId, 'host-review-expired-approval');
    const now = Date.now();
    const sessionId = 'es_review_expired_approval';
    const secret = backend.randomBytes(32);
    const salt = backend.randomBytes(16);
    const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
    const session = await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 1, nowMs: now });
    const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
    const controller = await generateShadowIdentity(backend, 'ctrl-review-expired-approval');
    const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });
    await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: base64urlEncode(presentedSecret), nowMs: now });
    const lease = await acquireShadowLease({ accountId, hostDeviceId: host.deviceId, scopeId: `account:${accountId}`, requestedLeaseId: 'lease_review_expired_approval', ttlMs: 120_000 });
    const approval = await hostApproveEnrollment(backend, { host, fence: lease.fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash: base64urlDecode(request.transcriptHash), sessionId, nowMs: session.expiresAt + 1, ttlMs: 120_000 });
    // Consumed just before expiry, approved at expiresAt+1 → rejected, no grant.
    await expect(approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs: session.expiresAt + 1 })).rejects.toMatchObject({ statusCode: 403 });
    const grant = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).executeTakeFirst();
    expect(grant).toBeUndefined();
    const sess = await getDb().selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
    expect(sess?.status).toBe('consumed'); // not 'approved'
  });

  it('approval accepts at expiresAt-1, rejects at exact expiresAt and expiresAt+1 (boundary)', async () => {
    const accountId = 'acct-approve-boundary';
    const host = await makeRegisteredHost(accountId, 'host-approve-boundary');
    // Single fresh session + lease; probe the exact expiry boundary.
    const now = Date.now();
    const sid = 'es_boundary_exact';
    const secret = backend.randomBytes(32); const salt = backend.randomBytes(16);
    const v = await computeEnrollmentVerifier(backend, { sessionId: sid, accountId, secret, salt });
    const session = await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId: sid, hostSigningKeyId: host.signingKeyId, secretSalt: v.salt, secretVerifier: v.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 5, nowMs: now });
    const bootstrap = bootstrapFor(host, accountId, sid, secret, session.expiresAt);
    const controller = await generateShadowIdentity(backend, 'ctrl-approve-exact');
    const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });
    await submitEnrollmentRequest({ accountId, sessionId: sid, request, presentedSecret: base64urlEncode(presentedSecret), nowMs: now });
    const lease = await acquireShadowLease({ accountId, hostDeviceId: host.deviceId, scopeId: `account:${accountId}`, requestedLeaseId: 'lease_boundary_exact', ttlMs: 120_000 });
    const approval = await hostApproveEnrollment(backend, { host, fence: lease.fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash: base64urlDecode(request.transcriptHash), sessionId: sid, nowMs: now, ttlMs: 120_000 });
    await expect(approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: sid, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs: session.expiresAt })).rejects.toMatchObject({ statusCode: 403 });
    // +1 also rejected; still no grant, session stays consumed.
    await expect(approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: sid, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs: session.expiresAt + 1 })).rejects.toMatchObject({ statusCode: 403 });
    // expiresAt-1 accepted for this same session.
    const okApproval = await hostApproveEnrollment(backend, { host, fence: lease.fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash: base64urlDecode(request.transcriptHash), sessionId: sid, nowMs: session.expiresAt - 1, ttlMs: 120_000 });
    const ok = await approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: sid, grant: okApproval.grant, keyMaterial: okApproval.keyMaterial, nowMs: session.expiresAt - 1 });
    expect(ok.status).toBe('active');
  });

  // ── Review finding 2 (conflicting revocation overwrite) — recreated probe ──
  it('reviewer: rejects conflicting signed revocation replay instead of overwriting the record', async () => {
    const accountId = 'acct-review-conflicting-revoke';
    const host = await makeRegisteredHost(accountId, 'host-review-conflicting-revoke');
    const r = await fullEnroll(accountId, host, 'ctrl-review-conflicting-revoke', 'es_review_conflicting_revoke');
    const first = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence: r.fence, controllerDeviceId: r.controller.deviceId, revokedAt: Date.now(), keyRotationId: 'kr_review_first' });
    await expect(revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: first, effectiveSeq: 1, nowMs: Date.now() })).resolves.toMatchObject({ alreadyRevoked: false, keyRotationId: 'kr_review_first' });
    const conflicting = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence: r.fence, controllerDeviceId: r.controller.deviceId, revokedAt: Date.now() + 1, keyRotationId: 'kr_review_conflict' });
    await expect(revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: conflicting, effectiveSeq: 2, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 409 });
    const stored = await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('scope_id', '=', r.fence.scopeId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    expect(stored?.key_rotation_id).toBe('kr_review_first');
    expect(stored?.effective_seq).toBe(1);
  });

  it('revocation: exact replay idempotent; each differing field rejected 409 with original row byte-identical + no collateral mutation', async () => {
    const accountId = 'acct-revoke-fields';
    const host = await makeRegisteredHost(accountId, 'host-revoke-fields');
    const r = await fullEnroll(accountId, host, 'ctrl-revoke-fields', 'es_revoke_fields');
    const revokedAt = 1_800_000_000_000;
    const base = { family: 'device-revocation' as const, v: 1 as const, fence: r.fence, controllerDeviceId: r.controller.deviceId, revokedAt, keyRotationId: 'kr_base' };
    const signed = await signDeviceRevocation(backend, host, base);
    const call = (over: Partial<{ revocation: typeof signed; effectiveSeq: number }>) => revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: over.revocation ?? signed, effectiveSeq: over.effectiveSeq ?? 7, nowMs: Date.now() });
    // First revoke.
    await expect(call({})).resolves.toMatchObject({ alreadyRevoked: false });
    const original = await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    // Snapshot collateral state that a rejected conflict must NOT mutate.
    const gridBefore = JSON.stringify(await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).execute());
    // Exact replay → idempotent, no mutation.
    await expect(call({})).resolves.toMatchObject({ alreadyRevoked: true });
    // Differing effectiveSeq → 409 (signature identical but payload differs).
    await expect(call({ effectiveSeq: 8 })).rejects.toMatchObject({ statusCode: 409 });
    // Differing keyRotationId + signature (re-signed) → 409.
    const otherKr = await signDeviceRevocation(backend, host, { ...base, keyRotationId: 'kr_other' });
    await expect(call({ revocation: otherKr })).rejects.toMatchObject({ statusCode: 409 });
    // Differing revokedAt (re-signed) → 409.
    const otherTime = await signDeviceRevocation(backend, host, { ...base, revokedAt: revokedAt + 1 });
    await expect(call({ revocation: otherTime })).rejects.toMatchObject({ statusCode: 409 });
    // Original row byte-identical + no collateral mutation after all rejected conflicts.
    const after = await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    expect(after).toEqual(original);
    expect(JSON.stringify(await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).execute())).toBe(gridBefore);
  });

  it('consumes a session exactly once under concurrent requests', async () => {
    const accountId = 'acct-race';
    const host = await makeRegisteredHost(accountId, 'host-race');
    const now = Date.now();
    const sessionId = 'es_race';
    const secret = backend.randomBytes(32);
    const salt = backend.randomBytes(16);
    const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
    const session = await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now });
    const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
    const c1 = await generateShadowIdentity(backend, 'ctrl-race-1');
    const c2 = await generateShadowIdentity(backend, 'ctrl-race-2');
    const r1 = await buildEnrollmentRequest(backend, { controller: c1, bootstrap, nowMs: now });
    const r2 = await buildEnrollmentRequest(backend, { controller: c2, bootstrap, nowMs: now });
    const results = await Promise.allSettled([
      submitEnrollmentRequest({ accountId, sessionId, request: r1.request, presentedSecret: base64urlEncode(r1.presentedSecret), nowMs: now }),
      submitEnrollmentRequest({ accountId, sessionId, request: r2.request, presentedSecret: base64urlEncode(r2.presentedSecret), nowMs: now }),
    ]);
    const ok = results.filter((x) => x.status === 'fulfilled');
    const failed = results.filter((x) => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
  });

  it('rejects wrong-account, wrong-secret, tampered-transcript, and expired requests', async () => {
    const accountId = 'acct-neg';
    const host = await makeRegisteredHost(accountId, 'host-neg');
    const now = Date.now();
    const sessionId = 'es_neg';
    const secret = backend.randomBytes(32);
    const salt = backend.randomBytes(16);
    const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
    const session = await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now });
    const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
    const controller = await generateShadowIdentity(backend, 'ctrl-neg');
    const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });

    // Wrong secret.
    await expect(submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: base64urlEncode(backend.randomBytes(32)), nowMs: now })).rejects.toMatchObject({ statusCode: 403 });
    // Tampered transcript.
    await expect(submitEnrollmentRequest({ accountId, sessionId, request: { ...request, transcriptHash: base64urlEncode(backend.randomBytes(32)) }, presentedSecret: base64urlEncode(presentedSecret), nowMs: now })).rejects.toMatchObject({ statusCode: 403 });
    // Expired session.
    await expect(submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: base64urlEncode(presentedSecret), nowMs: session.expiresAt + 1 })).rejects.toMatchObject({ statusCode: 403 });
    // Wrong account.
    await expect(submitEnrollmentRequest({ accountId: 'acct-other', sessionId, request, presentedSecret: base64urlEncode(presentedSecret), nowMs: now })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('denies and cancels sessions and blocks approval afterwards', async () => {
    const accountId = 'acct-dc';
    const host = await makeRegisteredHost(accountId, 'host-dc');
    // Deny.
    const now = Date.now();
    const sid = 'es_deny';
    const secret = backend.randomBytes(32); const salt = backend.randomBytes(16);
    const v = await computeEnrollmentVerifier(backend, { sessionId: sid, accountId, secret, salt });
    await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId: sid, hostSigningKeyId: host.signingKeyId, secretSalt: v.salt, secretVerifier: v.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now });
    const denied = await denyEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: sid });
    expect(denied.status).toBe('denied');
    // Cancel a different session.
    const sid2 = 'es_cancel';
    const v2 = await computeEnrollmentVerifier(backend, { sessionId: sid2, accountId, secret, salt });
    await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId: sid2, hostSigningKeyId: host.signingKeyId, secretSalt: v2.salt, secretVerifier: v2.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now });
    const cancelled = await cancelEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: sid2 });
    expect(cancelled.status).toBe('cancelled');
  });

  it('never persists the plaintext one-time secret, private key, or scope key', async () => {
    const accountId = 'acct-scan';
    const host = await makeRegisteredHost(accountId, 'host-scan');
    const r = await fullEnroll(accountId, host, 'ctrl-scan');
    const secretSentinel = base64urlEncode(host.keys.signing.privateKey); // private key material
    const scopeSentinel = base64urlEncode(r.hostScopeKey);
    // Dump every enrollment table and assert none contain private/scope material.
    for (const t of ['shadow_enrollment_session', 'shadow_enrollment_request', 'shadow_enrollment_grant', 'shadow_registered_key', 'shadow_host_identity']) {
      const rows = await getDb().selectFrom(t as never).selectAll().execute();
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(secretSentinel);
      expect(dump).not.toContain(scopeSentinel);
      expect(dump).not.toContain(base64urlEncode(host.keys.agreement.privateKey));
      expect(dump).not.toContain(base64urlEncode(r.controller.keys.signing.privateKey));
    }
  });

  it('lists only same-account eligible Macs and marks expired leases offline', async () => {
    const now = Date.now();
    const hostA = await makeRegisteredHost('acct-list-a', 'host-list-a');
    await makeRegisteredHost('acct-list-b', 'host-list-b');
    await acquireShadowLease({ accountId: 'acct-list-a', hostDeviceId: hostA.deviceId, scopeId: 'account:acct-list-a', requestedLeaseId: 'lease_list_a', ttlMs: 120_000 });
    const macs = await listAccountEnrollmentMacs({ accountId: 'acct-list-a', nowMs: now });
    expect(macs.map((m) => m.hostDeviceId)).toContain('host-list-a');
    expect(macs.map((m) => m.hostDeviceId)).not.toContain('host-list-b');
    expect(macs.find((m) => m.hostDeviceId === 'host-list-a')?.online).toBe(true);
    await getDb().updateTable('shadow_lease').set({ expires_at: new Date(now - 1) }).where('account_id', '=', 'acct-list-a').where('scope_id', '=', 'account:acct-list-a').execute();
    const expired = await listAccountEnrollmentMacs({ accountId: 'acct-list-a', nowMs: now });
    expect(expired.find((m) => m.hostDeviceId === 'host-list-a')?.online).toBe(false);
  });

  it('account challenge creates a pending request without auto-authorizing control and coalesces duplicate submit', async () => {
    const accountId = 'acct-account-flow';
    const host = await makeRegisteredHost(accountId, 'host-account-flow');
    await acquireShadowLease({ accountId, hostDeviceId: host.deviceId, scopeId: `account:${accountId}`, requestedLeaseId: 'lease_account_flow', ttlMs: 120_000 });
    const controller = await generateShadowIdentity(backend, 'ctrl-account-flow');
    const requestedCapabilities = ['account.read', 'session.message'] as const;
    const challenge = await createAccountEnrollmentChallenge({
      accountId, hostDeviceId: host.deviceId, controllerDeviceId: controller.deviceId, requestedCapabilities,
      relayOrigin: RELAY_ORIGIN, nowMs: Date.now(), ttlMs: 120_000,
    });
    const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap: challenge.bootstrap, nowMs: Date.now(), requestedCapabilities });
    const first = await submitEnrollmentRequest({ accountId, sessionId: challenge.bootstrap.sessionId, request, presentedSecret: base64urlEncode(presentedSecret), idempotencyKey: request.nonce, nowMs: Date.now() });
    const second = await submitEnrollmentRequest({ accountId, sessionId: challenge.bootstrap.sessionId, request, presentedSecret: base64urlEncode(presentedSecret), idempotencyKey: request.nonce, nowMs: Date.now() });
    expect(first.status).toBe('pending');
    expect(second.coalesced).toBe(true);
    expect(await listEnrolledControllers({ accountId })).toEqual([]);
  });

  it('account challenge accepts a safe idempotency key derived from a base64url nonce outside id grammar', async () => {
    const accountId = 'acct-account-nonce-edge';
    const host = await makeRegisteredHost(accountId, 'host-account-nonce-edge');
    await acquireShadowLease({ accountId, hostDeviceId: host.deviceId, scopeId: `account:${accountId}`, requestedLeaseId: 'lease_account_nonce_edge', ttlMs: 120_000 });
    const controller = await generateShadowIdentity(backend, 'ctrl-account-nonce-edge');
    const challenge = await createAccountEnrollmentChallenge({
      accountId, hostDeviceId: host.deviceId, controllerDeviceId: controller.deviceId, requestedCapabilities: ['account.read'],
      relayOrigin: RELAY_ORIGIN, nowMs: Date.now(), ttlMs: 120_000,
    });
    const { request, presentedSecret } = await buildEnrollmentRequest(backend, {
      controller,
      bootstrap: challenge.bootstrap,
      nowMs: Date.now(),
      nonce: new Uint8Array(16).fill(255),
      requestedCapabilities: ['account.read'],
    });
    expect(request.nonce.startsWith('_')).toBe(true);
    const first = await submitEnrollmentRequest({ accountId, sessionId: challenge.bootstrap.sessionId, request, presentedSecret: base64urlEncode(presentedSecret), idempotencyKey: `idem_${request.nonce}`, nowMs: Date.now() });
    const second = await submitEnrollmentRequest({ accountId, sessionId: challenge.bootstrap.sessionId, request, presentedSecret: base64urlEncode(presentedSecret), idempotencyKey: `idem_${request.nonce}`, nowMs: Date.now() });
    expect(first.status).toBe('pending');
    expect(second.coalesced).toBe(true);
  });

  it('physical fallback: stale persisted controller identity rejects before persistence, fresh repaired identity persists pending', async () => {
    const accountId = 'acct-physical-stale-identity';
    const host = await makeRegisteredHost(accountId, 'host-physical-stale-identity');
    const controllerDeviceId = '979459b5-controller';
    const now = Date.now();

    const staleSessionId = 'es_physical_stale_identity';
    const staleSecret = backend.randomBytes(32);
    const staleSalt = backend.randomBytes(16);
    const staleVerifier = await computeEnrollmentVerifier(backend, { sessionId: staleSessionId, accountId, secret: staleSecret, salt: staleSalt });
    const staleSession = await createEnrollmentSession({
      accountId, hostDeviceId: host.deviceId, sessionId: staleSessionId, hostSigningKeyId: host.signingKeyId,
      secretSalt: staleVerifier.salt, secretVerifier: staleVerifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now,
    });
    const staleBootstrap = bootstrapFor(host, accountId, staleSessionId, staleSecret, staleSession.expiresAt);
    const signing = await backend.generateSigningKeyPair();
    const otherSigning = await backend.generateSigningKeyPair();
    const agreement = await backend.generateAgreementKeyPair();
    const staleIdentity = await materializeIdentity(backend, controllerDeviceId, { signing: { privateKey: signing.privateKey, publicKey: otherSigning.publicKey }, agreement });
    const staleBuilt = await buildEnrollmentRequest(backend, {
      controller: staleIdentity,
      bootstrap: staleBootstrap,
      nowMs: now,
      requestedCapabilities: ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set', 'screen.view'],
    });
    await expect(submitEnrollmentRequest({
      accountId, sessionId: staleSessionId, request: staleBuilt.request,
      presentedSecret: base64urlEncode(staleBuilt.presentedSecret), idempotencyKey: `idem_${staleBuilt.request.nonce}`, nowMs: now,
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(await getDb().selectFrom('shadow_enrollment_request').selectAll().where('account_id', '=', accountId).where('session_id', '=', staleSessionId).execute()).toEqual([]);

    const repairedSessionId = 'es_physical_repaired_identity';
    const repairedSecret = backend.randomBytes(32);
    const repairedSalt = backend.randomBytes(16);
    const repairedVerifier = await computeEnrollmentVerifier(backend, { sessionId: repairedSessionId, accountId, secret: repairedSecret, salt: repairedSalt });
    const repairedSession = await createEnrollmentSession({
      accountId, hostDeviceId: host.deviceId, sessionId: repairedSessionId, hostSigningKeyId: host.signingKeyId,
      secretSalt: repairedVerifier.salt, secretVerifier: repairedVerifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000, nowMs: now,
    });
    const repairedBootstrap = bootstrapFor(host, accountId, repairedSessionId, repairedSecret, repairedSession.expiresAt);
    const repairedController = await generateShadowIdentity(backend, controllerDeviceId);
    const repairedBuilt = await buildEnrollmentRequest(backend, {
      controller: repairedController,
      bootstrap: repairedBootstrap,
      nowMs: now,
      requestedCapabilities: ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set', 'screen.view'],
    });
    const repaired = await submitEnrollmentRequest({
      accountId, sessionId: repairedSessionId, request: repairedBuilt.request,
      presentedSecret: base64urlEncode(repairedBuilt.presentedSecret), idempotencyKey: `idem_${repairedBuilt.request.nonce}`, nowMs: now,
    });
    expect(repaired.status).toBe('pending');
    const pending = await getDb().selectFrom('shadow_enrollment_request').selectAll().where('account_id', '=', accountId).where('session_id', '=', repairedSessionId).executeTakeFirst();
    expect(pending?.controller_device_id).toBe(controllerDeviceId);
  });

  it('account challenge rejects cross-account and offline hosts without creating a request', async () => {
    const hostA = await makeRegisteredHost('acct-chal-a', 'host-chal-a');
    await makeRegisteredHost('acct-chal-b', 'host-chal-b');
    await expect(createAccountEnrollmentChallenge({ accountId: 'acct-chal-a', hostDeviceId: 'host-chal-b', controllerDeviceId: 'ctrl-chal-a', requestedCapabilities: ['account.read'], relayOrigin: RELAY_ORIGIN, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(createAccountEnrollmentChallenge({ accountId: 'acct-chal-a', hostDeviceId: hostA.deviceId, controllerDeviceId: 'ctrl-chal-a', requestedCapabilities: ['account.read'], relayOrigin: RELAY_ORIGIN, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 409 });
    const sessions = await listEnrollmentSessions({ accountId: 'acct-chal-a', hostDeviceId: hostA.deviceId });
    expect(sessions).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)('shadow enrollment — poll privacy + revocation', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns the grant only to the exact controller (signature-gated) and stores only ciphertext', async () => {
    const accountId = 'acct-poll';
    const host = await makeRegisteredHost(accountId, 'host-poll');
    const r = await fullEnroll(accountId, host, 'ctrl-poll');
    const ts = Date.now();
    const nonce = 'poll1';
    const sig = await signControllerPoll(backend, r.controller.keys.signing.privateKey, accountId, r.sessionId, r.controller.deviceId, nonce, ts);
    const poll = await pollEnrollment({ accountId, sessionId: r.sessionId, controllerDeviceId: r.controller.deviceId, nonce, timestampMs: ts, signature: sig, nowMs: ts });
    expect(poll.status).toBe('approved');
    expect(poll.grant).toBeTruthy();
    // The relay-stored grant carries only ciphertext; the DB cannot decrypt it.
    const grantRow = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).executeTakeFirst();
    const scopeSentinel = base64urlEncode(r.hostScopeKey);
    expect(JSON.stringify(grantRow)).not.toContain(scopeSentinel);

    // A different (attacker) key cannot poll the grant.
    const attacker = await generateShadowIdentity(backend, r.controller.deviceId);
    const badSig = await signControllerPoll(backend, attacker.keys.signing.privateKey, accountId, r.sessionId, r.controller.deviceId, 'poll2', ts);
    await expect(pollEnrollment({ accountId, sessionId: r.sessionId, controllerDeviceId: r.controller.deviceId, nonce: 'poll2', timestampMs: ts, signature: badSig, nowMs: ts })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('atomically revokes a controller, is idempotent, and rejects stale/forged/wrong-account revokes', async () => {
    const accountId = 'acct-rev';
    const host = await makeRegisteredHost(accountId, 'host-rev');
    const r = await fullEnroll(accountId, host, 'ctrl-rev');
    const revMsg = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence: r.fence, controllerDeviceId: r.controller.deviceId, revokedAt: Date.now(), keyRotationId: 'kr_1' });

    // Forged (signed by a different key) → 401.
    const forge = await generateShadowIdentity(backend, host.deviceId);
    const forged = await signDeviceRevocation(backend, forge, { family: 'device-revocation', v: 1, fence: r.fence, controllerDeviceId: r.controller.deviceId, revokedAt: Date.now(), keyRotationId: 'kr_x' });
    await expect(revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: forged, effectiveSeq: 1, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 401 });

    // Wrong account.
    await expect(revokeEnrolledController({ accountId: 'acct-wrong', hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: revMsg, effectiveSeq: 1, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 403 });

    // Real revoke.
    const rev = await revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: revMsg, effectiveSeq: 1, nowMs: Date.now() });
    expect(rev.alreadyRevoked).toBe(false);
    // Idempotent replay.
    const rev2 = await revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: revMsg, effectiveSeq: 1, nowMs: Date.now() });
    expect(rev2.alreadyRevoked).toBe(true);

    // The controller's registered key + grant + enforcement are all revoked.
    const key = await getDb().selectFrom('shadow_registered_key').selectAll().where('account_id', '=', accountId).where('device_id', '=', r.controller.deviceId).where('purpose', '=', 'sign').executeTakeFirst();
    expect(key?.status).toBe('revoked');
    const grant = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    expect(grant?.status).toBe('revoked');
    const enforce = await getDb().selectFrom('shadow_revoked_controller').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    expect(enforce).toBeTruthy();
  });

  // ── Pre-review hardening: legacy null-digest fails closed ──────────────────
  it('fails closed (409) on a legacy null-digest revocation row and never mutates/backfills it', async () => {
    const accountId = 'acct-null-digest';
    const host = await makeRegisteredHost(accountId, 'host-null-digest');
    const r = await fullEnroll(accountId, host, 'ctrl-null-digest');
    const revokedAt = 1_800_000_000_000;
    const signed = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence: r.fence, controllerDeviceId: r.controller.deviceId, revokedAt, keyRotationId: 'kr_legacy' });
    // Reproduce the exact shape produced by the additive `ADD COLUMN IF NOT EXISTS
    // request_digest text` on a table created by an earlier variant: the column is
    // NULLABLE and a pre-existing row carries a NULL digest.
    await sql`alter table shadow_revocation_record alter column request_digest drop not null`.execute(getDb());
    await getDb().insertInto('shadow_revocation_record').values({ account_id: accountId, scope_id: r.fence.scopeId, controller_device_id: r.controller.deviceId, key_rotation_id: 'kr_legacy', revoked_at_ms: revokedAt, effective_seq: 3, revocation_signature: signed.signature, host_device_id: host.deviceId, request_digest: null, created_at: new Date() }).execute();
    const before = await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    const gridBefore = JSON.stringify(await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).execute());
    // A core-matching replay (same signature/keyRotationId/revokedAt/effectiveSeq, no rotations)
    // must FAIL CLOSED with 409 — the null digest cannot prove identical rotations.
    await expect(revokeEnrolledController({ accountId, hostDeviceId: host.deviceId, scopeId: r.fence.scopeId, controllerDeviceId: r.controller.deviceId, revocation: signed, effectiveSeq: 3, nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 409 });
    const after = await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', r.controller.deviceId).executeTakeFirst();
    expect(after).toEqual(before); // byte-identical, digest still null (no backfill)
    expect(after?.request_digest).toBeNull();
    expect(JSON.stringify(await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).execute())).toBe(gridBefore);
  });

  // ── Pre-review hardening: canonical rotations (grantId bind, dup, reorder) ──
  it('binds rotation grantId, rejects wrong grantId + duplicate targets, and treats reordered unique rotations as an exact replay', async () => {
    const accountId = 'acct-rot';
    const host = await makeRegisteredHost(accountId, 'host-rot');
    const a = await fullEnroll(accountId, host, 'ctrl-rot-a', 'es_rot_a'); // revoke target
    const b = await enrollAnother(accountId, host, 'ctrl-rot-b', a.fence, 'es_rot_b');
    const c = await enrollAnother(accountId, host, 'ctrl-rot-c', a.fence, 'es_rot_c');
    const revokedAt = 1_800_000_100_000;
    const signed = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence: a.fence, controllerDeviceId: a.controller.deviceId, revokedAt, keyRotationId: 'kr_rot' });
    const rotB = { controllerDeviceId: 'ctrl-rot-b', grantId: b.grantId, keyId: 'wk_new', wrapNonce: base64urlEncode(backend.randomBytes(12)), wrappedScopeKey: base64urlEncode(backend.randomBytes(48)) };
    const rotC = { controllerDeviceId: 'ctrl-rot-c', grantId: c.grantId, keyId: 'wk_new', wrapNonce: base64urlEncode(backend.randomBytes(12)), wrappedScopeKey: base64urlEncode(backend.randomBytes(48)) };
    const base = { accountId, hostDeviceId: host.deviceId, scopeId: a.fence.scopeId, controllerDeviceId: a.controller.deviceId, revocation: signed, effectiveSeq: 1 };

    // Wrong grantId on a rotation → 409, nothing revoked (controller A still active).
    await expect(revokeEnrolledController({ ...base, remainingRotations: [{ ...rotB, grantId: 'grant_wrong' }], nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 409 });
    expect((await getDb().selectFrom('shadow_registered_key').selectAll().where('account_id', '=', accountId).where('device_id', '=', 'ctrl-rot-a').where('purpose', '=', 'sign').executeTakeFirst())?.status).toBe('active');
    expect(await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', 'ctrl-rot-a').executeTakeFirst()).toBeUndefined();

    // Duplicate rotation target → 400 before mutation.
    await expect(revokeEnrolledController({ ...base, remainingRotations: [rotB, { ...rotB }], nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 400 });
    expect((await getDb().selectFrom('shadow_registered_key').selectAll().where('account_id', '=', accountId).where('device_id', '=', 'ctrl-rot-a').where('purpose', '=', 'sign').executeTakeFirst())?.status).toBe('active');

    // Real revoke with rotations [B, C].
    const rev = await revokeEnrolledController({ ...base, remainingRotations: [rotB, rotC], nowMs: Date.now() });
    expect(rev.alreadyRevoked).toBe(false);
    const digestAfterFirst = (await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', 'ctrl-rot-a').executeTakeFirst())?.request_digest;
    // Remaining grants were rewrapped.
    expect((await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('grant_id', '=', b.grantId).executeTakeFirst())?.key_id).toBe('wk_new');

    // Replay with rotations REORDERED [C, B] → same canonical digest → idempotent.
    const replay = await revokeEnrolledController({ ...base, remainingRotations: [rotC, rotB], nowMs: Date.now() });
    expect(replay.alreadyRevoked).toBe(true);
    expect((await getDb().selectFrom('shadow_revocation_record').selectAll().where('account_id', '=', accountId).where('controller_device_id', '=', 'ctrl-rot-a').executeTakeFirst())?.request_digest).toBe(digestAfterFirst);

    // A DIFFERENT rotation ciphertext for B → different digest → 409 conflict.
    await expect(revokeEnrolledController({ ...base, remainingRotations: [{ ...rotB, wrappedScopeKey: base64urlEncode(backend.randomBytes(48)) }, rotC], nowMs: Date.now() })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe.skipIf(!HAS_DB)('shadow signed-request auth + HTTP enrollment', () => {
  beforeEach(async () => { await resetDb(); await migrateAuth(); });
  afterAll(async () => { await closeDb(); });

  it('enforces a signed proof on enrolled data routes and rejects tamper + replay', async () => {
    const app = buildAccountServer();
    await app.ready();
    try {
      const signed = await auth.api.signUpEmail({ body: { email: `enroll${Date.now()}@x.dev`, password: 'pw-12345678', name: 'E' } });
      const token = signed.token as string;
      const accountId = signed.user.id as string;
      const host = await makeRegisteredHost(accountId, 'http-host') as IdentityWithAccount;
      host.__accountId = accountId;

      // No proof → 401.
      const noProof = await app.inject({ method: 'POST', url: '/api/shadow/lease', headers: { authorization: `Bearer ${token}`, 'x-maestro-device-id': 'http-host', 'content-type': 'application/json' }, payload: JSON.stringify({ scopeId: `account:${accountId}`, leaseId: 'l1', ttlMs: 60_000 }) });
      expect(noProof.statusCode).toBe(401);

      // Valid signed proof → 200.
      const body = JSON.stringify({ scopeId: `account:${accountId}`, leaseId: 'l1', ttlMs: 60_000 });
      const url = '/api/shadow/lease';
      const okHeaders = await signHeaders(host, 'POST', url, body);
      const good = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, ...okHeaders }, payload: body });
      expect(good.statusCode).toBe(200);

      // Tampered body (same proof) → 401.
      const tamperBody = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, ...(await signHeaders(host, 'POST', url, body)) }, payload: JSON.stringify({ scopeId: `account:${accountId}`, leaseId: 'l1', ttlMs: 999 }) });
      expect(tamperBody.statusCode).toBe(401);

      // Replay the exact same signed headers twice → the proof is accepted once
      // (reaches the handler, not a 401) and the replay is rejected (nonce burned).
      const hdrs = await signHeaders(host, 'POST', url, body);
      const first = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, ...hdrs }, payload: body });
      const replay = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, ...hdrs }, payload: body });
      expect(first.statusCode).not.toBe(401);
      expect(replay.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('runs the full enrollment flow over HTTP and denies the controller after revocation', async () => {
    const app = buildAccountServer();
    await app.ready();
    try {
      const signed = await auth.api.signUpEmail({ body: { email: `flow${Date.now()}@x.dev`, password: 'pw-12345678', name: 'F' } });
      const token = signed.token as string;
      const accountId = signed.user.id as string;
      const authz = { authorization: `Bearer ${token}` };

      // Host registers identity (bootstrap-host).
      await upsertDevice({ id: 'flow-host', userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
      const host = await generateShadowIdentity(backend, 'flow-host') as IdentityWithAccount;
      host.__accountId = accountId;
      const regSig = await signHostRegistration(backend, host.keys.signing.privateKey, accountId, host.deviceId, host.signingPublicKey, host.agreementPublicKey);
      const regRes = await app.inject({ method: 'POST', url: '/api/shadow/enroll/host-identity', headers: { ...authz, 'x-maestro-device-id': 'flow-host', 'content-type': 'application/json' }, payload: JSON.stringify({ signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: regSig }) });
      expect(regRes.statusCode).toBe(200);

      // Host creates the session (enrolled-host signed request).
      const now = Date.now();
      const sessionId = 'es_http';
      const secret = backend.randomBytes(32); const salt = backend.randomBytes(16);
      const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
      const sBody = JSON.stringify({ sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY_ORIGIN, ttlMs: 120_000 });
      const sRes = await app.inject({ method: 'POST', url: '/api/shadow/enroll/session', headers: { ...authz, ...(await signHeaders(host, 'POST', '/api/shadow/enroll/session', sBody)) }, payload: sBody });
      expect(sRes.statusCode).toBe(200);
      const expiresAt = (sRes.json() as { expiresAt: number }).expiresAt;

      // Controller submits its request (bootstrap-controller: body IS the proof).
      const bootstrap = bootstrapFor(host, accountId, sessionId, secret, expiresAt);
      const controller = await generateShadowIdentity(backend, 'flow-ctrl') as IdentityWithAccount;
      controller.__accountId = accountId;
      const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now });
      const reqRes = await app.inject({ method: 'POST', url: '/api/shadow/enroll/request', headers: { ...authz, 'content-type': 'application/json' }, payload: JSON.stringify({ sessionId, request, presentedSecret: base64urlEncode(presentedSecret) }) });
      expect(reqRes.statusCode).toBe(200);

      // Host acquires lease + approves (signed request).
      const lBody = JSON.stringify({ scopeId: `account:${accountId}`, leaseId: 'lease_http', ttlMs: 120_000 });
      const lRes = await app.inject({ method: 'POST', url: '/api/shadow/lease', headers: { ...authz, ...(await signHeaders(host, 'POST', '/api/shadow/lease', lBody)) }, payload: lBody });
      expect(lRes.statusCode).toBe(200);
      const fence = (lRes.json() as { fence: { accountId: string; scopeId: string; hostDeviceId: string; epoch: number; leaseId: string } }).fence;
      const approval = await hostApproveEnrollment(backend, { host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash: base64urlDecode(request.transcriptHash), sessionId, nowMs: now, ttlMs: 120_000 });
      const aBody = JSON.stringify({ sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial });
      const aRes = await app.inject({ method: 'POST', url: '/api/shadow/enroll/approve', headers: { ...authz, ...(await signHeaders(host, 'POST', '/api/shadow/enroll/approve', aBody)) }, payload: aBody });
      expect(aRes.statusCode).toBe(200);

      // Controller polls + unwraps.
      const ts = Date.now();
      const pollSig = await signControllerPoll(backend, controller.keys.signing.privateKey, accountId, sessionId, controller.deviceId, 'pn1', ts);
      const pRes = await app.inject({ method: 'POST', url: '/api/shadow/enroll/poll', headers: { ...authz, 'content-type': 'application/json' }, payload: JSON.stringify({ sessionId, controllerDeviceId: controller.deviceId, nonce: 'pn1', timestampMs: ts, signature: pollSig }) });
      expect(pRes.statusCode).toBe(200);
      expect((pRes.json() as { status: string }).status).toBe('approved');

      // Enrolled controller can now sign a data request (cursor) → 200/expected.
      const cBody = JSON.stringify({ fence, lastSeq: 0 });
      const cRes = await app.inject({ method: 'POST', url: '/api/shadow/cursor', headers: { ...authz, ...(await signHeaders(controller, 'POST', '/api/shadow/cursor', cBody)) }, payload: cBody });
      expect(cRes.statusCode).toBe(200);

      // Host revokes the controller.
      const revMsg = await signDeviceRevocation(backend, host, { family: 'device-revocation', v: 1, fence, controllerDeviceId: controller.deviceId, revokedAt: Date.now(), keyRotationId: 'kr_http' });
      const rBody = JSON.stringify({ scopeId: `account:${accountId}`, controllerDeviceId: controller.deviceId, revocation: revMsg, effectiveSeq: 1 });
      const rRes = await app.inject({ method: 'POST', url: '/api/shadow/enroll/revoke', headers: { ...authz, ...(await signHeaders(host, 'POST', '/api/shadow/enroll/revoke', rBody)) }, payload: rBody });
      expect(rRes.statusCode).toBe(200);

      // Revoked controller can no longer sign a data request → 401 (key revoked).
      const cBody2 = JSON.stringify({ fence, lastSeq: 0 });
      const cRes2 = await app.inject({ method: 'POST', url: '/api/shadow/cursor', headers: { ...authz, ...(await signHeaders(controller, 'POST', '/api/shadow/cursor', cBody2)) }, payload: cBody2 });
      expect(cRes2.statusCode).toBe(401);

      // The host (unaffected) still works.
      const eventsBody = JSON.stringify({ events: [] });
      const eRes = await app.inject({ method: 'POST', url: '/api/shadow/events', headers: { ...authz, ...(await signHeaders(host, 'POST', '/api/shadow/events', eventsBody)) }, payload: eventsBody });
      expect(eRes.statusCode).toBe(400); // empty batch rejected by the relay AFTER auth passes
    } finally {
      await app.close();
    }
  });
});
