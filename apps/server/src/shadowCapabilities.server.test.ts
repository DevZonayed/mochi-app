/**
 * Phase 3A2b1 §1-B — server persistence of controller-signed REQUESTED + host-APPROVED
 * capabilities on real PostgreSQL. Real crypto; gated on TEST_DATABASE_URL.
 */
process.env.SHADOW_RELAY_ORIGINS = 'https://relay.test';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'kysely';
import { runMigrations, getDb, closeDb } from './db.js';
import * as m0001 from './migrations/0001_devices.js';
import * as m0002 from './migrations/0002_shadow_relay.js';
import * as m0003 from './migrations/0003_shadow_enrollment.js';
import * as m0004 from './migrations/0004_shadow_transition.js';
import * as m0005 from './migrations/0005_shadow_lease_renewal_receipt.js';
import * as m0006 from './migrations/0006_shadow_capabilities.js';
import { upsertDevice } from './accountDevices.js';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode, base64urlDecode } from '@maestro/realtime/shadowCrypto';
import {
  generateShadowIdentity, buildEnrollmentRequest, approveEnrollment as hostApprove,
  type ShadowIdentity, type EnrollmentBootstrap, SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
} from '@maestro/realtime/shadowEnrollment';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import {
  registerHostIdentity, createEnrollmentSession, submitEnrollmentRequest, approveEnrollment,
  signHostRegistration, computeEnrollmentVerifier, listPendingEnrollmentRequests, listEnrolledControllers,
} from './shadowEnrollmentService.js';
import { acquireShadowLease } from './shadowRelay.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const RELAY = 'https://relay.test';
const TABLES = [
  'shadow_revocation_record', 'shadow_request_nonce', 'shadow_enrollment_grant', 'shadow_enrollment_request',
  'shadow_enrollment_session', 'shadow_registered_key', 'shadow_host_identity',
  'shadow_transport', 'shadow_command', 'shadow_blob_capability', 'shadow_blob', 'shadow_chunk',
  'shadow_snapshot', 'shadow_cursor', 'shadow_event', 'shadow_revoked_controller', 'shadow_lease',
] as const;

async function resetDb(): Promise<void> {
  for (const t of TABLES) await getDb().schema.dropTable(t).ifExists().execute();
  await runMigrations();
  for (const t of TABLES) await getDb().deleteFrom(t as never).execute();
  await getDb().deleteFrom('device').execute();
}
async function resetToOld0006Db(): Promise<void> {
  for (const t of TABLES) await getDb().schema.dropTable(t).ifExists().execute();
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006]) await m.up(getDb());
  for (const t of TABLES) await getDb().deleteFrom(t as never).execute();
  await getDb().deleteFrom('device').execute();
}
async function capabilityConstraintDefs(): Promise<Record<string, string>> {
  const rows = await sql<{ conname: string; def: string }>`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname IN ('shadow_req_caps_shape', 'shadow_grant_caps_shape')
    ORDER BY conname
  `.execute(getDb());
  return Object.fromEntries(rows.rows.map((row) => [row.conname, row.def]));
}
async function makeHost(accountId: string, hostDeviceId: string): Promise<ShadowIdentity> {
  await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
  const host = await generateShadowIdentity(backend, hostDeviceId);
  const sig = await signHostRegistration(backend, host.keys.signing.privateKey, accountId, hostDeviceId, host.signingPublicKey, host.agreementPublicKey);
  await registerHostIdentity({ accountId, hostDeviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: sig, nowMs: Date.now() });
  return host;
}
function bootstrapFor(host: ShadowIdentity, accountId: string, sessionId: string, secret: Uint8Array, expiresAt: number): EnrollmentBootstrap {
  return { scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION, sessionId, accountId, hostDeviceId: host.deviceId, hostSigningKeyId: host.signingKeyId, hostSigningPublicKey: base64urlEncode(host.signingPublicKey), hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey), relayOrigin: RELAY, secret: base64urlEncode(secret), expiresAt };
}

/** Submit a request carrying `requested`; return the built request + host approval material. */
async function submitWith(accountId: string, host: ShadowIdentity, controllerDeviceId: string, sessionId: string, requested?: ShadowCapability[], mutate?: (r: Record<string, unknown>) => void) {
  const now = Date.now();
  const secret = backend.randomBytes(32); const salt = backend.randomBytes(16);
  const verifier = await computeEnrollmentVerifier(backend, { sessionId, accountId, secret, salt });
  const session = await createEnrollmentSession({ accountId, hostDeviceId: host.deviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: RELAY, ttlMs: 120_000, nowMs: now });
  const bootstrap = bootstrapFor(host, accountId, sessionId, secret, session.expiresAt);
  const controller = await generateShadowIdentity(backend, controllerDeviceId);
  const { request, presentedSecret } = await buildEnrollmentRequest(backend, { controller, bootstrap, nowMs: now, requestedCapabilities: requested });
  const wire = { ...request } as Record<string, unknown>;
  if (mutate) mutate(wire);
  return { controller, request: wire, presentedSecret, bootstrap, sessionId, now };
}
async function approveWith(accountId: string, host: ShadowIdentity, controllerDeviceId: string, ctx: { request: Record<string, unknown>; sessionId: string; now: number }, capabilities?: ShadowCapability[]) {
  const lease = await acquireShadowLease({ accountId, hostDeviceId: host.deviceId, scopeId: `account:${accountId}`, requestedLeaseId: `lease_${ctx.sessionId}`, ttlMs: 120_000 });
  const transcriptHash = base64urlDecode(ctx.request.transcriptHash as string);
  const approval = await hostApprove(backend, { host, fence: lease.fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(ctx.request.agreementPublicKey as string), transcriptHash, sessionId: ctx.sessionId, nowMs: ctx.now, ttlMs: 120_000, capabilities });
  return approveEnrollment({ accountId, hostDeviceId: host.deviceId, sessionId: ctx.sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs: ctx.now });
}

describe.skipIf(!HAS_DB)('server capability persistence (§1-B, real PG)', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeDb(); });

  it('migration is idempotent (fresh + reopen) and defaults legacy rows to account.read', async () => {
    await runMigrations(); await runMigrations(); // reopen re-runs up() — must not error
    const acct = 'acct-cap-legacy'; const host = await makeHost(acct, 'host_1');
    const ctx = await submitWith(acct, host, 'ctrl_1', 'es_legacy'); // no requested field
    await submitEnrollmentRequest({ accountId: acct, sessionId: ctx.sessionId, request: ctx.request as never, presentedSecret: base64urlEncode(ctx.presentedSecret), nowMs: ctx.now });
    const row = await getDb().selectFrom('shadow_enrollment_request').select(['requested_capabilities']).where('session_id', '=', 'es_legacy').executeTakeFirst();
    expect(row!.requested_capabilities).toEqual(['account.read']);
    const pending = await listPendingEnrollmentRequests({ accountId: acct, hostDeviceId: 'host_1' });
    expect(pending[0].requestedCapabilities).toEqual(['account.read']);
  });

  it('persists the verified requested set + host-approved subset; list views expose them', async () => {
    const acct = 'acct-cap-full'; const host = await makeHost(acct, 'host_1');
    const requested: ShadowCapability[] = ['account.read', 'session.message', 'job.start'];
    const ctx = await submitWith(acct, host, 'ctrl_1', 'es_full', requested);
    await submitEnrollmentRequest({ accountId: acct, sessionId: ctx.sessionId, request: ctx.request as never, presentedSecret: base64urlEncode(ctx.presentedSecret), nowMs: ctx.now });
    const req = await getDb().selectFrom('shadow_enrollment_request').select(['requested_capabilities']).where('session_id', '=', 'es_full').executeTakeFirst();
    expect(req!.requested_capabilities).toEqual(requested);

    await approveWith(acct, host, 'ctrl_1', ctx, ['account.read', 'session.message']); // subset
    const grant = await getDb().selectFrom('shadow_enrollment_grant').select(['approved_capabilities']).where('controller_device_id', '=', 'ctrl_1').executeTakeFirst();
    expect(grant!.approved_capabilities).toEqual(['account.read', 'session.message']);
    const controllers = await listEnrolledControllers({ accountId: acct });
    expect(controllers.find((c) => c.controllerDeviceId === 'ctrl_1')!.approvedCapabilities).toEqual(['account.read', 'session.message']);
  });

  it('fresh migration accepts the exact current 8-cap physical fallback request and grant', async () => {
    const acct = 'acct-cap-fresh-8'; const host = await makeHost(acct, 'host_fresh_8');
    const requested: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set', 'screen.view'];
    const ctx = await submitWith(acct, host, 'ctrl_fresh_8', 'es_fresh_8', requested);
    await submitEnrollmentRequest({ accountId: acct, sessionId: ctx.sessionId, request: ctx.request as never, presentedSecret: base64urlEncode(ctx.presentedSecret), nowMs: ctx.now });
    await approveWith(acct, host, 'ctrl_fresh_8', ctx, requested);
    const req = await getDb().selectFrom('shadow_enrollment_request').select(['requested_capabilities']).where('session_id', '=', 'es_fresh_8').executeTakeFirst();
    const grant = await getDb().selectFrom('shadow_enrollment_grant').select(['approved_capabilities']).where('controller_device_id', '=', 'ctrl_fresh_8').executeTakeFirst();
    expect(req!.requested_capabilities).toEqual(requested);
    expect(grant!.approved_capabilities).toEqual(requested);
    expect(await capabilityConstraintDefs()).toMatchObject({
      shadow_req_caps_shape: expect.stringContaining('jsonb_array_length(requested_capabilities) >= 1'),
      shadow_grant_caps_shape: expect.stringContaining('jsonb_array_length(approved_capabilities) <= 8'),
    });
  });

  it('upgrades old 0006 capability constraints from 7 to explicit 0007 limit 8 idempotently', async () => {
    await resetToOld0006Db();
    const oldDefs = await capabilityConstraintDefs();
    expect(oldDefs.shadow_req_caps_shape).toContain('jsonb_array_length(requested_capabilities) <= 7');
    expect(oldDefs.shadow_grant_caps_shape).toContain('jsonb_array_length(approved_capabilities) <= 7');

    const acct = 'acct-cap-upgrade-8'; const host = await makeHost(acct, 'host_upgrade_8');
    const requested: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set', 'screen.view'];
    const blocked = await submitWith(acct, host, 'ctrl_upgrade_8_blocked', 'es_upgrade_8_blocked', requested);
    await expect(submitEnrollmentRequest({
      accountId: acct, sessionId: blocked.sessionId, request: blocked.request as never,
      presentedSecret: base64urlEncode(blocked.presentedSecret), nowMs: blocked.now,
    })).rejects.toThrow();
    expect(await getDb().selectFrom('shadow_enrollment_request').selectAll().where('session_id', '=', 'es_upgrade_8_blocked').execute()).toEqual([]);

    await runMigrations();
    const upgradedDefs = await capabilityConstraintDefs();
    expect(upgradedDefs.shadow_req_caps_shape).toContain('jsonb_array_length(requested_capabilities) <= 8');
    expect(upgradedDefs.shadow_grant_caps_shape).toContain('jsonb_array_length(approved_capabilities) <= 8');

    const allowed = await submitWith(acct, host, 'ctrl_upgrade_8_allowed', 'es_upgrade_8_allowed', requested);
    const pending = await submitEnrollmentRequest({
      accountId: acct, sessionId: allowed.sessionId, request: allowed.request as never,
      presentedSecret: base64urlEncode(allowed.presentedSecret), nowMs: allowed.now,
    });
    expect(pending.status).toBe('pending');
    await approveWith(acct, host, 'ctrl_upgrade_8_allowed', allowed, requested);
    const grant = await getDb().selectFrom('shadow_enrollment_grant').select(['approved_capabilities']).where('controller_device_id', '=', 'ctrl_upgrade_8_allowed').executeTakeFirst();
    expect(grant!.approved_capabilities).toEqual(requested);

    await runMigrations();
    expect(await capabilityConstraintDefs()).toEqual(upgradedDefs);
  });

  it('server REJECTS a host approval beyond the verified requested set (403)', async () => {
    const acct = 'acct-cap-elev'; const host = await makeHost(acct, 'host_1');
    const ctx = await submitWith(acct, host, 'ctrl_1', 'es_elev', ['account.read', 'session.message']);
    await submitEnrollmentRequest({ accountId: acct, sessionId: ctx.sessionId, request: ctx.request as never, presentedSecret: base64urlEncode(ctx.presentedSecret), nowMs: ctx.now });
    // Host (authenticated) approves job.cancel which was NOT requested → server rejects.
    await expect(approveWith(acct, host, 'ctrl_1', ctx, ['account.read', 'job.cancel'])).rejects.toMatchObject({ statusCode: 403 });
    // No grant was written.
    const grant = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('controller_device_id', '=', 'ctrl_1').executeTakeFirst();
    expect(grant).toBeUndefined();
  });

  it('a tampered requested-capability field fails the request proof (403), stores nothing', async () => {
    const acct = 'acct-cap-tamper'; const host = await makeHost(acct, 'host_1');
    // Sign a request for [read, message] then escalate the wire field to [read, message, cancel].
    const ctx = await submitWith(acct, host, 'ctrl_1', 'es_tamper', ['account.read', 'session.message'], (r) => { r.requestedCapabilities = ['account.read', 'session.message', 'job.cancel']; });
    await expect(submitEnrollmentRequest({ accountId: acct, sessionId: ctx.sessionId, request: ctx.request as never, presentedSecret: base64urlEncode(ctx.presentedSecret), nowMs: ctx.now })).rejects.toMatchObject({ statusCode: 403 });
    const req = await getDb().selectFrom('shadow_enrollment_request').selectAll().where('session_id', '=', 'es_tamper').executeTakeFirst();
    expect(req).toBeUndefined();
  });

  it('reopen preserves stored capability rows intact', async () => {
    const acct = 'acct-cap-reopen'; const host = await makeHost(acct, 'host_1');
    const ctx = await submitWith(acct, host, 'ctrl_1', 'es_reopen', ['account.read', 'job.start']);
    await submitEnrollmentRequest({ accountId: acct, sessionId: ctx.sessionId, request: ctx.request as never, presentedSecret: base64urlEncode(ctx.presentedSecret), nowMs: ctx.now });
    await approveWith(acct, host, 'ctrl_1', ctx, ['account.read', 'job.start']);
    await runMigrations(); // reopen (idempotent up())
    const grant = await getDb().selectFrom('shadow_enrollment_grant').select(['approved_capabilities']).where('controller_device_id', '=', 'ctrl_1').executeTakeFirst();
    expect(grant!.approved_capabilities).toEqual(['account.read', 'job.start']);
  });
});
