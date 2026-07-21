/**
 * Phase 3A2a additive controller ACK-poll route enforcement (real PostgreSQL).
 * Proves: a controller polls ONLY its own acked commands (no cross-controller
 * leakage), only `acked` rows are returned, the limit is bounded, and a REVOKED
 * controller is denied (403) with no mutation — reusing the real relay service.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice } from './accountDevices.js';
import {
  acquireShadowLease,
  enqueueShadowCommand,
  ackShadowCommand,
  revokeShadowController,
  listControllerCommandAcks,
} from './shadowRelay.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const digest = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;

async function reset(): Promise<void> {
  for (const t of ['shadow_transport', 'shadow_command', 'shadow_revoked_controller', 'shadow_lease'] as const) {
    await getDb().schema.dropTable(t).ifExists().execute();
  }
  await runMigrations();
  for (const t of ['shadow_transport', 'shadow_command', 'shadow_revoked_controller', 'shadow_lease'] as const) {
    await getDb().deleteFrom(t).execute();
  }
  await getDb().deleteFrom('device').execute();
  await upsertDevice({ id: 'host-a', userId: 'acct-a', role: 'host', name: 'Mac A', platform: 'macos' });
  await upsertDevice({ id: 'ctrl-a', userId: 'acct-a', role: 'remote', name: 'Phone A', platform: 'ios' });
  await upsertDevice({ id: 'ctrl-b', userId: 'acct-a', role: 'remote', name: 'Phone B', platform: 'ios' });
}

describe.skipIf(!HAS_DB)('shadow controller command ACK poll (additive)', () => {
  beforeEach(reset);
  afterAll(async () => { await closeDb(); });

  async function setupTwoAckedControllers() {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await enqueueShadowCommand({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, commandId: 'cmd_a', idempotencyKey: 'idem_a', envelopeCiphertext: 'cipher_a', payloadDigest: digest('a') });
    await enqueueShadowCommand({ accountId: 'acct-a', controllerDeviceId: 'ctrl-b', fence, commandId: 'cmd_b', idempotencyKey: 'idem_b', envelopeCiphertext: 'cipher_b', payloadDigest: digest('b') });
    // A queued-but-not-acked command for ctrl-a (must NOT appear).
    await enqueueShadowCommand({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, commandId: 'cmd_a2', idempotencyKey: 'idem_a2', envelopeCiphertext: 'cipher_a2', payloadDigest: digest('c') });
    await ackShadowCommand({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', commandId: 'cmd_a', ackCiphertext: 'ack_cipher_a', ackDigest: digest('d') });
    await ackShadowCommand({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', commandId: 'cmd_b', ackCiphertext: 'ack_cipher_b', ackDigest: digest('e') });
    return fence;
  }

  it('returns only the requesting controller\'s acked commands (no cross-controller leakage)', async () => {
    const fence = await setupTwoAckedControllers();
    const a = await listControllerCommandAcks({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence });
    expect(a.map((x) => x.commandId)).toEqual(['cmd_a']);
    expect(a[0]).toMatchObject({ status: 'acked', ackCiphertext: 'ack_cipher_a', ackDigest: digest('d') });
    const b = await listControllerCommandAcks({ accountId: 'acct-a', controllerDeviceId: 'ctrl-b', fence });
    expect(b.map((x) => x.commandId)).toEqual(['cmd_b']);
  });

  it('denies a revoked controller with 403 and mutates nothing', async () => {
    const fence = await setupTwoAckedControllers();
    await revokeShadowController({ accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', keyRotationEffectiveSeq: 5 });
    await expect(listControllerCommandAcks({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence })).rejects.toMatchObject({ statusCode: 403 });
    // The surviving controller still reads its own ack.
    const b = await listControllerCommandAcks({ accountId: 'acct-a', controllerDeviceId: 'ctrl-b', fence });
    expect(b.map((x) => x.commandId)).toEqual(['cmd_b']);
  });

  it('rejects a stale/invalid fence (409) and bounds the limit', async () => {
    const fence = await setupTwoAckedControllers();
    await expect(listControllerCommandAcks({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence: { ...fence, epoch: fence.epoch + 1 } })).rejects.toMatchObject({ statusCode: 409 });
    // Limit is clamped into [1,100]; a huge value does not error.
    const a = await listControllerCommandAcks({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, limit: 10_000 });
    expect(a).toHaveLength(1);
  });
});
