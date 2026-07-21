/**
 * Phase 3A2a re-review finding 2 — enrolled-controller lease reconciliation route
 * `getScopeAuthority` (real PostgreSQL). Proves: an enrolled controller reads the
 * server-authoritative fence + lease expiry; a REVOKED controller is denied (403)
 * with no mutation; a host role cannot use the controller route; renewal is
 * reflected (later expiry) with the SAME fence (epoch/leaseId unchanged).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice } from './accountDevices.js';
import { acquireShadowLease, getScopeAuthority, revokeShadowController } from './shadowRelay.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

async function reset(): Promise<void> {
  for (const t of ['shadow_command', 'shadow_revoked_controller', 'shadow_lease'] as const) {
    await getDb().schema.dropTable(t).ifExists().execute();
  }
  await runMigrations();
  for (const t of ['shadow_command', 'shadow_revoked_controller', 'shadow_lease'] as const) {
    await getDb().deleteFrom(t).execute();
  }
  await getDb().deleteFrom('device').execute();
  await upsertDevice({ id: 'host-a', userId: 'acct-a', role: 'host', name: 'Mac A', platform: 'macos' });
  await upsertDevice({ id: 'ctrl-a', userId: 'acct-a', role: 'remote', name: 'Phone A', platform: 'ios' });
}

describe.skipIf(!HAS_DB)('shadow authority reconciliation route (finding 2)', () => {
  beforeEach(reset);
  afterAll(async () => { await closeDb(); });

  it('returns the server-authoritative fence + lease expiry for an enrolled controller', async () => {
    const { fence, expiresAt } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const authority = await getScopeAuthority({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', scopeId: 'account:acct-a' });
    expect(authority.fence).toEqual(fence);
    expect(authority.expiresAt).toBe(expiresAt);
  });

  it('reflects a same-fence renewal as a later expiry (epoch/leaseId unchanged)', async () => {
    const first = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 1_000 });
    const before = await getScopeAuthority({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', scopeId: 'account:acct-a' });
    const renewed = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', currentFence: first.fence, requestedLeaseId: first.fence.leaseId, ttlMs: 60_000 });
    const after = await getScopeAuthority({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', scopeId: 'account:acct-a' });
    expect(after.fence.epoch).toBe(before.fence.epoch);
    expect(after.fence.leaseId).toBe(before.fence.leaseId);
    expect(after.expiresAt).toBe(renewed.expiresAt);
    expect(after.expiresAt).toBeGreaterThanOrEqual(before.expiresAt);
  });

  it('denies a revoked controller (403) and mutates nothing', async () => {
    await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await revokeShadowController({ accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', keyRotationEffectiveSeq: 3 });
    await expect(getScopeAuthority({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', scopeId: 'account:acct-a' })).rejects.toMatchObject({ statusCode: 403 });
    // Lease is untouched.
    const lease = await getDb().selectFrom('shadow_lease').selectAll().where('account_id', '=', 'acct-a').executeTakeFirst();
    expect(lease?.lease_id).toBe('lease_a');
  });

  it('rejects the host device using the controller route (403)', async () => {
    await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await expect(getScopeAuthority({ accountId: 'acct-a', controllerDeviceId: 'host-a', scopeId: 'account:acct-a' })).rejects.toMatchObject({ statusCode: 403 });
  });
});
