/**
 * Phase 3A2a re-review HIGH — atomic `renewLeaseWithTransitions` (real PostgreSQL).
 * Proves the ONE-transaction renew-and-store: happy path, idempotent replay,
 * mismatched-replay 409, successor/stale fence 409, strict-increase / bounds, and
 * grant-set integrity (missing / extra / duplicate / cross-controller / bad-signature)
 * — every rejection rolls back atomically (lease expiry unchanged, zero transition rows).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice } from './accountDevices.js';
import { acquireShadowLease, renewLeaseWithTransitions, revokeShadowController } from './shadowRelay.js';
import { registerHostIdentity, signHostRegistration } from './shadowEnrollmentService.js';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode } from '@maestro/realtime/shadowCrypto';
import { generateShadowIdentity, type ShadowIdentity } from '@maestro/realtime/shadowEnrollment';
import { signAuthorityTransition, type AuthorityTransitionGrantFields } from '@maestro/realtime/shadowAuthorityTransition';
import type { Fence } from '@maestro/realtime/shadowProtocol';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const ACC = 'acct-r';
const HOST = 'host-r';
const SCOPE = `account:${ACC}`;

let host: ShadowIdentity;
let seq = 0;

async function reset(): Promise<void> {
  for (const t of ['shadow_lease_renewal_receipt', 'shadow_authority_transition', 'shadow_enrollment_grant', 'shadow_revoked_controller', 'shadow_host_identity', 'shadow_registered_key', 'shadow_lease'] as const) {
    await getDb().schema.dropTable(t).ifExists().execute();
  }
  await runMigrations();
  await getDb().deleteFrom('device').execute();
  await upsertDevice({ id: HOST, userId: ACC, role: 'host', name: 'Mac', platform: 'macos' });
  host = await generateShadowIdentity(node, HOST);
  const regSig = await signHostRegistration(node, host.keys.signing.privateKey, ACC, HOST, host.signingPublicKey, host.agreementPublicKey);
  await registerHostIdentity({ accountId: ACC, hostDeviceId: HOST, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: regSig, nowMs: Date.now() });
}

async function enrollActiveController(controllerDeviceId: string, fence: Fence): Promise<void> {
  await upsertDevice({ id: controllerDeviceId, userId: ACC, role: 'remote', name: 'Phone', platform: 'ios' });
  await getDb().insertInto('shadow_enrollment_grant').values({
    account_id: ACC, grant_id: `g_${controllerDeviceId}`, scope_id: SCOPE, session_id: `s_${controllerDeviceId}`,
    controller_device_id: controllerDeviceId, host_device_id: HOST, epoch: fence.epoch, lease_id: fence.leaseId,
    key_id: 'wk', expires_at_ms: Date.now() + 3_600_000, signed_at_ms: Date.now(), grant_signature: 'sig', wrap_nonce: 'wn',
    wrapped_scope_key: 'wsk', transcript_hash: 'th', status: 'active', key_rotation_id: null, revoked_at_ms: null,
    created_at: new Date(), updated_at: new Date(),
  }).execute();
}

async function mint(fence: Fence, controllerDeviceId: string, expiresAt: number, over: Partial<AuthorityTransitionGrantFields> & { signKey?: Uint8Array } = {}): Promise<AuthorityTransitionGrantFields> {
  const now = Date.now();
  const { signKey, ...g } = over;
  return signAuthorityTransition(node, signKey ?? host.keys.signing.privateKey, {
    family: 'authority-transition-grant', v: 1,
    transitionId: g.transitionId ?? `tr_${now}_${seq++}`, kind: 'lease-renewal',
    controllerDeviceId, previousFence: g.previousFence ?? fence, nextFence: g.nextFence ?? fence,
    issuedAt: g.issuedAt ?? now - 1_000, expiresAt, nonce: g.nonce ?? `n_${now}_${seq++}`,
    keyId: g.keyId ?? host.signingKeyId,
  });
}

async function leaseRow() {
  return getDb().selectFrom('shadow_lease').selectAll().where('account_id', '=', ACC).where('scope_id', '=', SCOPE).executeTakeFirst();
}
async function transitionCount(): Promise<number> {
  const r = await getDb().selectFrom('shadow_authority_transition').select((eb) => eb.fn.countAll<string>().as('c')).where('account_id', '=', ACC).executeTakeFirst();
  return Number(r?.c ?? 0);
}

describe.skipIf(!HAS_DB)('atomic lease renewal + transitions (finding HIGH-1)', () => {
  beforeEach(reset);
  afterAll(async () => { await closeDb(); });

  async function setup(ttlMs = 30_000): Promise<{ fence: Fence; expiresAt: number }> {
    const lease = await acquireShadowLease({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, requestedLeaseId: `lease_${HOST}`, ttlMs });
    await enrollActiveController('ctrl-1', lease.fence);
    return lease;
  }

  it('atomically extends the lease AND stores one transition per active controller, idempotently', async () => {
    const { fence, expiresAt } = await setup();
    await enrollActiveController('ctrl-2', fence);
    const req = Date.now() + 120_000;
    const grants = [await mint(fence, 'ctrl-1', req), await mint(fence, 'ctrl-2', req)];
    const r1 = await renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: 'rn_1', currentFence: fence, expectedCurrentExpiresAt: expiresAt, requestedExpiresAt: req, grants });
    expect(r1.replayed).toBe(false);
    expect(r1.expiresAt).toBe(req);
    expect((await leaseRow())!.expires_at.getTime()).toBe(req);
    expect(await transitionCount()).toBe(2);
    // Idempotent replay of the identical body → committed receipt, no new rows.
    const r2 = await renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: 'rn_1', currentFence: fence, expectedCurrentExpiresAt: expiresAt, requestedExpiresAt: req, grants });
    expect(r2.replayed).toBe(true);
    expect(r2.expiresAt).toBe(req);
    expect(await transitionCount()).toBe(2);
  });

  it('rejects a mismatched replay body under the same renewalId (409)', async () => {
    const { fence, expiresAt } = await setup();
    const req = Date.now() + 120_000;
    await renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: 'rn_x', currentFence: fence, expectedCurrentExpiresAt: expiresAt, requestedExpiresAt: req, grants: [await mint(fence, 'ctrl-1', req)] });
    await expect(renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: 'rn_x', currentFence: fence, requestedExpiresAt: req + 5_000, grants: [await mint(fence, 'ctrl-1', req + 5_000)] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a successor / stale fence (409) with zero mutation', async () => {
    const { fence } = await setup();
    const req = Date.now() + 120_000;
    const before = (await leaseRow())!.expires_at.getTime();
    await expect(renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: 'rn_s', currentFence: { ...fence, epoch: fence.epoch + 3 }, requestedExpiresAt: req, grants: [await mint({ ...fence, epoch: fence.epoch + 3 }, 'ctrl-1', req)] })).rejects.toMatchObject({ statusCode: 409 });
    expect((await leaseRow())!.expires_at.getTime()).toBe(before);
    expect(await transitionCount()).toBe(0);
  });

  it('rejects grant-set integrity violations atomically (missing / extra / duplicate / cross-controller / bad-sig / bounds)', async () => {
    const { fence, expiresAt } = await setup();
    await enrollActiveController('ctrl-2', fence);
    const req = Date.now() + 120_000;
    const before = (await leaseRow())!.expires_at.getTime();
    const call = (grants: unknown[], requestedExpiresAt = req, rid = `rn_${seq++}`) =>
      renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: rid, currentFence: fence, expectedCurrentExpiresAt: expiresAt, requestedExpiresAt, grants });
    // Missing ctrl-2.
    await expect(call([await mint(fence, 'ctrl-1', req)])).rejects.toMatchObject({ statusCode: 400 });
    // Extra (non-active) controller.
    await expect(call([await mint(fence, 'ctrl-1', req), await mint(fence, 'ctrl-2', req), await mint(fence, 'ctrl-nope', req)])).rejects.toMatchObject({ statusCode: 400 });
    // Duplicate controller grant.
    await expect(call([await mint(fence, 'ctrl-1', req), await mint(fence, 'ctrl-1', req)])).rejects.toMatchObject({ statusCode: 400 });
    // Grant expiry != requested.
    await expect(call([await mint(fence, 'ctrl-1', req + 1), await mint(fence, 'ctrl-2', req)])).rejects.toMatchObject({ statusCode: 400 });
    // Rollback / equal expiry.
    await expect(call([await mint(fence, 'ctrl-1', before), await mint(fence, 'ctrl-2', before)], before)).rejects.toMatchObject({ statusCode: 400 });
    // Bad signature (foreign key).
    const foreign = await node.generateSigningKeyPair();
    await expect(call([await mint(fence, 'ctrl-1', req, { signKey: foreign.privateKey }), await mint(fence, 'ctrl-2', req)])).rejects.toMatchObject({ statusCode: 403 });
    // Every rejection left the lease + transitions untouched.
    expect((await leaseRow())!.expires_at.getTime()).toBe(before);
    expect(await transitionCount()).toBe(0);
  });

  it('excludes a revoked controller from the required active set', async () => {
    const { fence, expiresAt } = await setup();
    await enrollActiveController('ctrl-2', fence);
    await revokeShadowController({ accountId: ACC, scopeId: SCOPE, controllerDeviceId: 'ctrl-2', keyRotationEffectiveSeq: 1 });
    const req = Date.now() + 120_000;
    // Only ctrl-1 is active now → a grant for just ctrl-1 succeeds; including ctrl-2 is an extra.
    const ok = await renewLeaseWithTransitions({ accountId: ACC, hostDeviceId: HOST, scopeId: SCOPE, renewalId: 'rn_rv', currentFence: fence, expectedCurrentExpiresAt: expiresAt, requestedExpiresAt: req, grants: [await mint(fence, 'ctrl-1', req)] });
    expect(ok.expiresAt).toBe(req);
    expect(await transitionCount()).toBe(1);
  });
});
