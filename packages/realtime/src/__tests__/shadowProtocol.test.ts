import { describe, expect, it } from 'vitest';
import {
  SHADOW_PROTOCOL_VERSION,
  SHADOW_ASSET_CAPABILITY_MAX_TTL_MS,
  SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS,
  SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS,
  SHADOW_MAX_FUTURE_CLOCK_SKEW_MS,
  SHADOW_PREVIEW_SESSION_MAX_TTL_MS,
  SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS,
  advanceCommandLifecycle,
  decideReconnect,
  decodeBlobCapability,
  decodeShadowConnectHello,
  decodeShadowMessage,
  decodeVisualInputEvent,
  decodeWebTunnelSession,
  planCacheResume,
  planCursorTransaction,
  planRetention,
  sequenceShadowEvent,
  validateAuthorityFence,
  type AuthorityContext,
  type CommandLifecycleState,
  type ShadowCursor,
  type ShadowStateEvent,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = {
  accountId: 'acct_main',
  scopeId: 'scope_main',
  hostDeviceId: 'host_mac_1',
  epoch: 7,
  leaseId: 'lease_active',
} as const;

const authority: AuthorityContext = {
  fence,
  leaseExpiresAt: now + 60_000,
  revokedControllerDeviceIds: new Set(['ctrl_revoked']),
};

const ttlSamples = {
  'preview-session': {
    maxTtl: SHADOW_PREVIEW_SESSION_MAX_TTL_MS,
    make: (expiresAt: number, sourceAt = now) => ({
      family: 'preview-session' as const,
      v: SHADOW_PROTOCOL_VERSION,
      visualSessionId: 'vis_ttl',
      fence,
      controllerDeviceId: 'ctrl_phone_1',
      source: 'browser',
      mode: 'web-tunnel',
      inputMode: 'view-only',
      transport: 'encrypted-relay',
      projectId: 'proj_1',
      sessionId: 'sess_1',
      expiresAt,
      signature: 'sig_preview',
    }),
  },
  'visual-control-grant': {
    maxTtl: SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS,
    make: (expiresAt: number, sourceAt = now) => ({
      family: 'visual-control-grant' as const,
      v: SHADOW_PROTOCOL_VERSION,
      grantId: 'vgrant_ttl',
      visualSessionId: 'vis_ttl',
      fence,
      controllerDeviceId: 'ctrl_phone_1',
      mode: 'control',
      expiresAt,
      signedAt: sourceAt,
      signature: 'sig_control',
    }),
  },
  'enrollment-grant': {
    maxTtl: SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS,
    make: (expiresAt: number, sourceAt = now) => ({
      family: 'enrollment-grant' as const,
      v: SHADOW_PROTOCOL_VERSION,
      fence,
      controllerDeviceId: 'ctrl_phone_1',
      grantId: 'enroll_ttl',
      expiresAt,
      keyId: 'key_scope_1',
      signedAt: sourceAt,
      signature: 'sig_enroll',
    }),
  },
  'asset-capability': {
    maxTtl: SHADOW_ASSET_CAPABILITY_MAX_TTL_MS,
    make: (expiresAt: number, sourceAt = now) => ({
      family: 'asset-capability' as const,
      v: SHADOW_PROTOCOL_VERSION,
      capabilityId: 'cap_ttl',
      fence,
      controllerDeviceId: 'ctrl_phone_1',
      contentId: 'cid_asset_ttl',
      variant: 'screen',
      permissions: ['read'],
      expiresAt,
      signature: 'sig_cap',
    }),
  },
  'command-envelope': {
    maxTtl: SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS,
    make: (expiresAt: number, sourceAt = now) => ({
      family: 'command-envelope' as const,
      v: SHADOW_PROTOCOL_VERSION,
      commandId: 'cmd_ttl',
      idempotencyKey: 'idem_ttl',
      controllerDeviceId: 'ctrl_phone_1',
      fence,
      method: 'sendChat',
      paramsCiphertext: 'cipher_params',
      grantScopes: ['chat'],
      createdAt: sourceAt,
      expiresAt,
      signature: 'sig_cmd',
    }),
  },
} as const;

function event(seq: number, prevSeq = seq - 1, extra: Partial<ShadowStateEvent> = {}): ShadowStateEvent {
  return {
    v: SHADOW_PROTOCOL_VERSION,
    eventId: `event_${seq}`,
    seq,
    prevSeq,
    fence,
    collection: 'job',
    op: 'upsert',
    entityId: 'job_1',
    revision: seq,
    commandId: 'cmd_1',
    durable: true,
    payloadCiphertext: `cipher_${seq}`,
    payloadDigest: `sha256:${String(seq).padStart(64, '0')}`,
    keyId: 'key_scope_1',
    createdAt: now + seq,
    signature: `sig_${seq}`,
    ...extra,
  };
}

describe('shadow protocol decoders', () => {
  it('accepts the exact reconnect hello contract and rejects unknown versions, bad seq, and unsafe ids', () => {
    const hello = {
      protocolVersion: 1,
      accountId: 'acct_main',
      scopeId: 'scope_main',
      controllerDeviceId: 'ctrl_phone_1',
      hostDeviceId: 'host_mac_1',
      epoch: 7,
      lastSeq: 42,
      snapshotId: 'snap_42',
      collectionDigests: { job: 'sha256:a'.padEnd(71, 'a') },
      supportedTransports: ['relay', 'lan'],
    };
    expect(decodeShadowConnectHello(hello).ok).toBe(true);
    expect(decodeShadowConnectHello({ ...hello, protocolVersion: 2 }).ok).toBe(false);
    expect(decodeShadowConnectHello({ ...hello, lastSeq: -1 }).ok).toBe(false);
    expect(decodeShadowConnectHello({ ...hello, hostDeviceId: '../host' }).ok).toBe(false);
  });

  it('fails closed for every message family on unknown discriminants and plaintext/path-bearing payloads', () => {
    expect(decodeShadowMessage({ family: 'state-event', ...event(1) }).ok).toBe(true);
    expect(decodeShadowMessage({ family: 'state-event', ...event(1), payload: { secret: 'plain' } }).ok).toBe(false);
    expect(decodeShadowMessage({ family: 'state-event', ...event(1), localPath: '/Users/me/file' }).ok).toBe(false);
    expect(decodeShadowMessage({ family: 'wat', v: 1 }).ok).toBe(false);
    expect(decodeShadowMessage({ family: 'command-ack', v: 1, commandId: 'cmd_1', status: 'accepted', fence, acceptedSeq: 1, resultSeq: 1, signedAt: now, signature: 'sig' }).ok).toBe(true);
    expect(decodeShadowMessage({ family: 'command-ack', v: 1, commandId: 'cmd_1', status: 'maybe', fence, signedAt: now, signature: 'sig' }).ok).toBe(false);
  });

  it.each(Object.entries(ttlSamples))('enforces TTL bounds for %s decoder messages', (_family, sample) => {
    const hasSourceTime = _family === 'visual-control-grant' || _family === 'enrollment-grant' || _family === 'command-envelope';
    const boundary = now + sample.maxTtl + (hasSourceTime ? 0 : SHADOW_MAX_FUTURE_CLOCK_SKEW_MS);
    expect(decodeShadowMessage(sample.make(boundary), { nowMs: now }).ok).toBe(true);
    expect(decodeShadowMessage(sample.make(boundary + 1), { nowMs: now }).ok).toBe(false);
    expect(decodeShadowMessage(sample.make(Number.MAX_SAFE_INTEGER), { nowMs: now }).ok).toBe(false);
    expect(decodeShadowMessage(sample.make(now), { nowMs: now }).ok).toBe(false);
    expect(decodeShadowMessage(sample.make(Number.NaN), { nowMs: now }).ok).toBe(false);
    expect(decodeShadowMessage(sample.make(Number.POSITIVE_INFINITY), { nowMs: now }).ok).toBe(false);
  });

  it.each([
    ['visual-control-grant', ttlSamples['visual-control-grant']],
    ['enrollment-grant', ttlSamples['enrollment-grant']],
    ['command-envelope', ttlSamples['command-envelope']],
  ] as const)('enforces intrinsic source-time bounds for %s', (_family, sample) => {
    const sourceAt = now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS;
    expect(decodeShadowMessage(sample.make(sourceAt + sample.maxTtl, sourceAt), { nowMs: now }).ok).toBe(true);
    expect(decodeShadowMessage(sample.make(sourceAt + sample.maxTtl + 1, sourceAt), { nowMs: now }).ok).toBe(false);
    expect(decodeShadowMessage(sample.make(sourceAt + sample.maxTtl, sourceAt + 1), { nowMs: now }).ok).toBe(false);
    expect(decodeShadowMessage(sample.make(sourceAt - 1, sourceAt), { nowMs: now }).ok).toBe(false);
  });

  it('keeps old v1 visual control grants without grantId compatible at a valid TTL', () => {
    const grant = ttlSamples['visual-control-grant'].make(now + 60_000, now);
    const { grantId: _grantId, ...legacyGrant } = grant;
    expect(decodeShadowMessage(legacyGrant, { nowMs: now }).ok).toBe(true);
  });

  it('validates snapshot manifests/chunks and rejects invalid ranges or plaintext bytes', () => {
    const manifest = {
      family: 'snapshot-manifest',
      v: 1,
      snapshotId: 'snap_100',
      fence,
      baseSeq: 100,
      schemaVersion: 1,
      createdAt: now,
      collectionDigests: { job: 'sha256:a'.padEnd(71, 'a') },
      chunks: [{
        contentId: 'cid_job_1',
        collection: 'job',
        pageKey: 'job/page/0001',
        entityCount: 2,
        compressedBytes: 100,
        encryptedBytes: 128,
        plaintextDigest: 'sha256:b'.padEnd(71, 'b'),
        ciphertextDigest: 'sha256:c'.padEnd(71, 'c'),
        encryptionKeyId: 'key_scope_1',
        nonce: 'nonce_1',
        compression: 'zstd',
        encryption: 'aes-256-gcm',
      }],
      manifestDigest: 'sha256:d'.padEnd(71, 'd'),
      signature: 'sig',
    };
    expect(decodeShadowMessage(manifest).ok).toBe(true);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...manifest.chunks[0], encryptedBytes: 0 }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, bytes: 'base64-asset-bytes' }).ok).toBe(false);
  });
});

describe('authority and event sequencing', () => {
  it('validates host authority and fences lower/wrong/expired/revoked authority', () => {
    const expectAuthorityReason = (result: ReturnType<typeof validateAuthorityFence>, reason: string): void => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    };
    expect(validateAuthorityFence(authority, { fence, controllerDeviceId: 'ctrl_ok', now }).ok).toBe(true);
    expectAuthorityReason(validateAuthorityFence(authority, { fence: { ...fence, epoch: 6 }, controllerDeviceId: 'ctrl_ok', now }), 'stale-epoch');
    expectAuthorityReason(validateAuthorityFence(authority, { fence: { ...fence, hostDeviceId: 'host_other' }, controllerDeviceId: 'ctrl_ok', now }), 'wrong-host');
    expectAuthorityReason(validateAuthorityFence(authority, { fence, controllerDeviceId: 'ctrl_ok', now: now + 90_000 }), 'expired');
    expectAuthorityReason(validateAuthorityFence(authority, { fence, controllerDeviceId: 'ctrl_revoked', now }), 'revoked');
  });

  it('accepts only next events, detects gaps, idempotently ignores exact duplicates, and never partially advances on conflict', () => {
    let cursor: ShadowCursor = { fence, lastSeq: 0, lastEventId: null, lastDigest: null };
    const first = sequenceShadowEvent(cursor, event(1));
    expect(first.outcome).toBe('accepted');
    cursor = first.cursor;
    expect(cursor.lastSeq).toBe(1);

    expect(sequenceShadowEvent(cursor, event(1)).outcome).toBe('duplicate');
    expect(sequenceShadowEvent(cursor, event(3, 2)).outcome).toBe('gap');
    expect(sequenceShadowEvent(cursor, event(2, 0)).outcome).toBe('gap');
    expect(sequenceShadowEvent(cursor, event(1, 0, { payloadDigest: 'sha256:x'.padEnd(71, 'x') })).outcome).toBe('conflict');
    expect(sequenceShadowEvent(cursor, event(2, 1, { fence: { ...fence, epoch: 8 } })).outcome).toBe('fenced');
    expect(cursor.lastSeq).toBe(1);
  });

  it('plans an atomic cursor transaction with inbox delete after apply and advance', () => {
    const plan = planCursorTransaction({ controllerDeviceId: 'ctrl_phone_1', cursor: { fence, lastSeq: 4, lastEventId: null, lastDigest: null }, event: event(5, 4), inboxId: 'inbox_5' });
    expect(plan.outcome).toBe('apply-and-advance');
    expect(plan.steps).toEqual(['persist-inbox', 'decrypt-validate', 'apply-entity', 'advance-cursor', 'delete-inbox']);
    expect(plan.nextCursor.lastSeq).toBe(5);
  });
});

describe('command lifecycle and reconnect decisions', () => {
  it('requires host ack plus matching authoritative event before applied', () => {
    let state: CommandLifecycleState = { status: 'pending-local', commandId: 'cmd_1', fence, createdAt: now, expiresAt: now + 60_000 };
    state = advanceCommandLifecycle(state, { type: 'sent', now }).state;
    state = advanceCommandLifecycle(state, { type: 'host-ack', ack: { v: 1, commandId: 'cmd_1', status: 'accepted', fence, acceptedSeq: 4, resultSeq: 5, signedAt: now, signature: 'sig' }, now }).state;
    expect(state.status).toBe('accepted');
    state = advanceCommandLifecycle(state, { type: 'execute', now }).state;
    expect(state.status).toBe('executing');
    state = advanceCommandLifecycle(state, { type: 'await-state-event', now }).state;
    expect(state.status).toBe('awaiting-state-event');
    expect(advanceCommandLifecycle(state, { type: 'state-event', event: event(5, 4, { commandId: 'cmd_other' }), now }).state.status).toBe('awaiting-state-event');
    state = advanceCommandLifecycle(state, { type: 'state-event', event: event(5, 4, { commandId: 'cmd_1' }), now }).state;
    expect(state.status).toBe('applied');
    expect(advanceCommandLifecycle(state, { type: 'state-event', event: event(5, 4, { commandId: 'cmd_1' }), now }).outcome).toBe('idempotent');
  });

  it('does not complete with ack alone or event alone and fences wrong epoch', () => {
    const pending: CommandLifecycleState = { status: 'pending-local', commandId: 'cmd_1', fence, createdAt: now, expiresAt: now + 60_000 };
    expect(advanceCommandLifecycle(pending, { type: 'state-event', event: event(1), now }).state.status).toBe('pending-local');
    expect(advanceCommandLifecycle(pending, { type: 'host-ack', ack: { v: 1, commandId: 'cmd_1', status: 'accepted', fence: { ...fence, epoch: 8 }, acceptedSeq: 1, resultSeq: 1, signedAt: now, signature: 'sig' }, now }).outcome).toBe('fenced');
    expect(advanceCommandLifecycle(pending, { type: 'expire', now: now + 90_000 }).state.status).toBe('expired');
  });

  it('chooses retained delta, manifest repair, fenced, or incompatible without full-sync fallback', () => {
    expect(decideReconnect({ hello: { hostDeviceId: 'host_mac_1', epoch: 7, lastSeq: 50, snapshotId: 'snap_40', protocolVersion: 1, collectionDigests: {} }, retainedMinSeq: 40, headSeq: 55, latestSnapshotId: 'snap_40', hostDeviceId: 'host_mac_1', epoch: 7, supportedProtocolVersions: [1] }).decision).toBe('delta');
    expect(decideReconnect({ hello: { hostDeviceId: 'host_mac_1', epoch: 7, lastSeq: 10, protocolVersion: 1, collectionDigests: {} }, retainedMinSeq: 40, headSeq: 55, latestSnapshotId: 'snap_40', hostDeviceId: 'host_mac_1', epoch: 7, supportedProtocolVersions: [1] }).decision).toBe('manifest-repair');
    expect(decideReconnect({ hello: { hostDeviceId: 'host_mac_1', epoch: 6, lastSeq: 50, protocolVersion: 1, collectionDigests: {} }, retainedMinSeq: 40, headSeq: 55, latestSnapshotId: 'snap_40', hostDeviceId: 'host_mac_1', epoch: 7, supportedProtocolVersions: [1] }).decision).toBe('fenced');
    expect(decideReconnect({ hello: { hostDeviceId: 'host_mac_1', epoch: 7, lastSeq: 50, protocolVersion: 2, collectionDigests: {} }, retainedMinSeq: 40, headSeq: 55, latestSnapshotId: 'snap_40', hostDeviceId: 'host_mac_1', epoch: 7, supportedProtocolVersions: [1] }).decision).toBe('incompatible');
  });
});

describe('retention, assets, web tunnel, and visual input', () => {
  it('compacts only verified covered closed segments and ignores permanently stale controllers safely', () => {
    const plan = planRetention({
      now,
      snapshot: { snapshotId: 'snap_80', baseSeq: 80, verified: true, publishedAt: now - 90_000 },
      segments: [
        { segmentId: 'seg_1', firstSeq: 1, lastSeq: 40, closed: true, verified: true },
        { segmentId: 'seg_2', firstSeq: 41, lastSeq: 80, closed: true, verified: true },
        { segmentId: 'seg_3', firstSeq: 81, lastSeq: 100, closed: false, verified: true },
      ],
      controllers: [
        { controllerDeviceId: 'ctrl_fresh', lastSeq: 76, lastSeenAt: now - 1_000 },
        { controllerDeviceId: 'ctrl_stale', lastSeq: 10, lastSeenAt: now - 10_000_000, permanentlyInactive: true },
      ],
      staleAfterMs: 300_000,
      safetyTailEvents: 10,
      snapshotSafetyMs: 60_000,
    });
    expect(plan.deleteSegmentIds).toEqual(['seg_1']);
    expect(plan.keepReasons.get('seg_2')).toContain('active-controller-cursor');
    expect(plan.keepReasons.get('seg_3')).toContain('open-segment');
  });

  it('rejects path-like asset capabilities and wrong controller/host/epoch/content/variant/expiry', () => {
    const cap = { v: 1, capabilityId: 'cap_1', fence, controllerDeviceId: 'ctrl_phone_1', assetId: 'asset_1', contentId: 'cid_1', variant: 'screen', permissions: ['read'], expiresAt: now + 10_000, signature: 'sig' };
    expect(decodeBlobCapability(cap, { controllerDeviceId: 'ctrl_phone_1', fence, contentId: 'cid_1', variant: 'screen', now }).ok).toBe(true);
    expect(decodeBlobCapability({ ...cap, contentId: '/tmp/file' }, { controllerDeviceId: 'ctrl_phone_1', fence, contentId: '/tmp/file', variant: 'screen', now }).ok).toBe(false);
    expect(decodeBlobCapability(cap, { controllerDeviceId: 'ctrl_other', fence, contentId: 'cid_1', variant: 'screen', now }).ok).toBe(false);
    expect(decodeBlobCapability(cap, { controllerDeviceId: 'ctrl_phone_1', fence, contentId: 'cid_1', variant: 'original', now }).ok).toBe(false);
    expect(decodeBlobCapability(cap, { controllerDeviceId: 'ctrl_phone_1', fence, contentId: 'cid_1', variant: 'screen', now: now + 20_000 }).ok).toBe(false);
  });

  it('confines web tunnels to approved loopback origin/port/path and rejects proxy semantics', () => {
    const session = { v: 1, tunnelId: 'tun_1', fence, projectId: 'proj_1', controllerDeviceId: 'ctrl_phone_1', allowedLoopbackPort: 5173, allowedOrigin: 'http://127.0.0.1:5173', route: '/preview', expiresAt: now + 60_000 };
    expect(decodeWebTunnelSession(session, now).ok).toBe(true);
    expect(decodeWebTunnelSession({ ...session, allowedOrigin: 'http://192.168.0.1:5173' }, now).ok).toBe(false);
    expect(decodeWebTunnelSession({ ...session, allowedLoopbackPort: 22 }, now).ok).toBe(false);
    expect(decodeWebTunnelSession({ ...session, route: '/../etc/passwd' }, now).ok).toBe(false);
    expect(decodeWebTunnelSession({ ...session, route: 'tcp://127.0.0.1:5173' }, now).ok).toBe(false);
  });

  it('rejects replay/out-of-order/expired/wrong-session visual input and permits view-only descriptors without input', () => {
    const input = { family: 'visual-input', v: SHADOW_PROTOCOL_VERSION, visualSessionId: 'vis_1', fence, inputSeq: 2, frameSeqSeen: 7, kind: 'tap', viewport: { width: 390, height: 844, scale: 3 }, payloadCiphertext: 'cipher_input', createdAt: now, signature: 'sig' };
    expect(decodeVisualInputEvent(input, { visualSessionId: 'vis_1', mode: 'control', lastInputSeq: 1, minFrameSeq: 5, now, maxAgeMs: 5_000 }).ok).toBe(true);
    expect(decodeVisualInputEvent(input, { visualSessionId: 'vis_1', mode: 'view-only', lastInputSeq: 1, minFrameSeq: 5, now, maxAgeMs: 5_000 }).ok).toBe(false);
    expect(decodeVisualInputEvent({ ...input, inputSeq: 1 }, { visualSessionId: 'vis_1', mode: 'control', lastInputSeq: 1, minFrameSeq: 5, now, maxAgeMs: 5_000 }).ok).toBe(false);
    expect(decodeVisualInputEvent(input, { visualSessionId: 'vis_other', mode: 'control', lastInputSeq: 1, minFrameSeq: 5, now, maxAgeMs: 5_000 }).ok).toBe(false);
    expect(decodeVisualInputEvent(input, { visualSessionId: 'vis_1', mode: 'control', lastInputSeq: 1, minFrameSeq: 5, now: now + 9_000, maxAgeMs: 5_000 }).ok).toBe(false);
  });

  it('plans deterministic cache resume and JSON wire payloads stay metadata-only', () => {
    const plan = planCacheResume({ contentId: 'cid_1', totalBytes: 1000, verifiedRanges: [{ start: 0, endExclusive: 100 }, { start: 200, endExclusive: 400 }], requestedRange: { start: 0, endExclusive: 500 } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.missingRanges).toEqual([{ start: 100, endExclusive: 200 }, { start: 400, endExclusive: 500 }]);
    const serialized = JSON.stringify(event(1));
    expect(JSON.parse(serialized)).toEqual(event(1));
    expect(serialized.length).toBeLessThan(2_000);
    expect(serialized).not.toMatch(/base64|assetBytes|\/Users\/|file:\/\//);
  });
});
