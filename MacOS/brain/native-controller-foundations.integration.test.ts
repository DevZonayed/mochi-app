import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowHostCore, StaticShadowKeyProvider, type ShadowAuthority } from './shadow-host.js';
import {
  createMemoryShadowStore,
  ShadowMobileClient,
  type ShadowExpectedAuthority,
} from '../../apps/mobile/src/shadowClientCore';
import {
  decodeShadowMessage,
  decideReconnect,
  validateAuthorityFence,
  validateShadowCapabilityTiming,
  type Fence,
  type HostCommandAck,
} from '@maestro/realtime';

const now = 1_800_000_000_000;
const key = Buffer.alloc(32, 7);
const fence: Fence = {
  accountId: 'acct_cross_1',
  scopeId: 'scope_cross_1',
  hostDeviceId: 'host_cross_1',
  epoch: 1,
  leaseId: 'lease_cross_1',
};
const expectedAuthority: ShadowExpectedAuthority = {
  fence,
  controllerDeviceId: 'ctrl_cross_1',
  leaseExpiresAt: now + 60_000,
};

function authority(): ShadowAuthority {
  return {
    accountId: fence.accountId,
    scopeId: fence.scopeId,
    hostDeviceId: fence.hostDeviceId,
    epoch: fence.epoch,
    leaseId: fence.leaseId,
    leaseExpiresAt: now + 60_000,
  };
}

function mobileClient(at = now): ShadowMobileClient {
  return new ShadowMobileClient({
    controllerDeviceId: 'ctrl_cross_1',
    hostDeviceId: fence.hostDeviceId,
    expectedAuthority,
    store: createMemoryShadowStore('ctrl_cross_1', fence.hostDeviceId, expectedAuthority),
    now: () => at,
    crypto: {
      decryptEvent: async (event) => ({ event, payload: { entityId: event.entityId, revision: event.revision } }),
      digest: async (bytes) => `sha256:${Array.from(bytes).join('').padEnd(64, 'a').slice(0, 64)}`,
    },
    controlMessageVerifier: {
      verifyControlMessage: async () => ({ ok: true }),
    },
  });
}

describe('native controller foundations cross-module compatibility', () => {
  it('applies a host-emitted integrated protocol event in the mobile durable core', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-shadow-cross-'));
    try {
      const host = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
      host.setAuthority(authority());
      const emitted = host.appendEvent({
        fence,
        controllerDeviceId: expectedAuthority.controllerDeviceId,
        collection: 'job',
        op: 'upsert',
        entityId: 'job_cross_1',
        revision: 1,
        commandId: 'cmd_cross_1',
        payload: { title: 'cross-module' },
        now,
      });

      expect(decodeShadowMessage(emitted, { nowMs: now }).ok).toBe(true);

      const client = mobileClient();
      await client.queueCommand({ commandId: 'cmd_cross_1', fence, createdAt: now, expiresAt: now + 60_000 });
      await client.markCommandSent('cmd_cross_1');
      await client.applyMessage({
        family: 'command-ack',
        v: 1,
        commandId: 'cmd_cross_1',
        status: 'accepted',
        fence,
        acceptedSeq: 1,
        resultSeq: 1,
        signedAt: now + 1,
        signature: 'sig_ack_cross_1',
      });
      await client.advanceCommand('cmd_cross_1', 'execute');
      await client.advanceCommand('cmd_cross_1', 'await-state-event');

      const result = await client.applyMessage(emitted);
      expect(result.status).toBe('applied');
      const state = client.read();
      expect(state.cursor?.lastSeq).toBe(1);
      expect(state.entities).toEqual([
        expect.objectContaining({ id: 'job_cross_1', collection: 'job', revision: 1, deleted: false }),
      ]);
      expect(state.commands.find((command) => command.commandId === 'cmd_cross_1')).toEqual(
        expect.objectContaining({ status: 'applied', appliedEventId: emitted.eventId }),
      );
      host.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps command ACK, reconnect, fence, and ciphertext-bound semantics shared across modules', async () => {
    const client = mobileClient();
    await client.queueCommand({ commandId: 'cmd_ack_1', fence, createdAt: now, expiresAt: now + 60_000 });
    await client.markCommandSent('cmd_ack_1');
    const ack: HostCommandAck = {
      family: 'command-ack',
      v: 1,
      commandId: 'cmd_ack_1',
      status: 'accepted',
      fence,
      acceptedSeq: 1,
      signedAt: now + 1,
      signature: 'sig_ack_1',
    };
    expect(await client.applyMessage(ack)).toEqual(expect.objectContaining({ status: 'applied' }));
    expect(client.read().commands.find((command) => command.commandId === 'cmd_ack_1')).toEqual(
      expect.objectContaining({ status: 'accepted', ack }),
    );

    expect(decideReconnect({
      hello: {
        protocolVersion: 1,
        hostDeviceId: fence.hostDeviceId,
        epoch: fence.epoch,
        lastSeq: 3,
        collectionDigests: {},
      },
      retainedMinSeq: 4,
      headSeq: 9,
      latestSnapshotId: 'snap_cross_1',
      hostDeviceId: fence.hostDeviceId,
      epoch: fence.epoch,
      supportedProtocolVersions: [1],
      latestSnapshotBaseSeq: 6,
    })).toEqual({ decision: 'manifest-repair', snapshotId: 'snap_cross_1', baseSeqHint: 6, replayFromSeq: 7 });

    expect(validateAuthorityFence(
      { fence, leaseExpiresAt: now + 60_000, revokedControllerDeviceIds: new Set(['ctrl_revoked']) },
      { fence: { ...fence, epoch: 0 }, controllerDeviceId: 'ctrl_cross_1', now },
    )).toEqual({ ok: false, reason: 'stale-epoch' });
    expect(validateAuthorityFence(
      { fence, leaseExpiresAt: now + 60_000, revokedControllerDeviceIds: new Set(['ctrl_revoked']) },
      { fence, controllerDeviceId: 'ctrl_revoked', now },
    )).toEqual({ ok: false, reason: 'revoked' });

    expect(validateShadowCapabilityTiming({
      family: 'asset-capability',
      sourceAt: now,
      expiresAt: now + 60_000,
      encryptedBytes: 1024,
      nowMs: now + 1,
    })).toEqual({ ok: true, value: true });
    expect(decodeShadowMessage({
      family: 'asset-range-response',
      v: 1,
      capabilityId: 'cap_cross_1',
      contentId: 'content_cross_1',
      variant: 'original',
      range: { start: 0, endExclusive: 1 },
      ciphertextDigest: `sha256:${'a'.repeat(64)}`,
      encryptedBytes: 256_001,
      createdAt: now,
      signature: 'sig_asset_range_response_1',
    }, { nowMs: now + 1 })).toEqual({ ok: false, reason: 'bad-response-crypto' });
  });
});
