import { describe, expect, it } from 'vitest';
import {
  SHADOW_PROTOCOL_VERSION,
  decodeShadowMessage,
  parseAccountId,
  parseCommandId,
  parseContentId,
  validateEnrollmentGrant,
  validateHandoffTransition,
  validateRevocation,
  isFenceValidAfterHandoff,
  type ShadowWireMessage,
  type HandoffState,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const decodeShadowMessageAtNow = (value: unknown) => decodeShadowMessage(value, { nowMs: now });
const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };
const newFence = { ...fence, hostDeviceId: 'host_mac_2', epoch: 8, leaseId: 'lease_new' };
const digest = (ch: string) => `sha256:${ch.repeat(64)}`;
const variants = {
  placeholder: { contentId: 'cid_placeholder', variant: 'placeholder', bytes: 100, sha256: digest('a'), mime: 'image/jpeg', availableOffline: true },
  small: { contentId: 'cid_small', variant: 'small', bytes: 1000, sha256: digest('b'), mime: 'image/jpeg', availableOffline: true },
  medium: { contentId: 'cid_medium', variant: 'medium', bytes: 10_000, sha256: digest('c'), mime: 'image/jpeg', availableOffline: false },
  screen: { contentId: 'cid_screen', variant: 'screen', bytes: 20_000, sha256: digest('d'), mime: 'image/jpeg', availableOffline: false },
  original: { contentId: 'cid_original', variant: 'original', bytes: 50_000, sha256: digest('e'), mime: 'image/png', availableOffline: false },
} as const;

const baseMessages: ShadowWireMessage[] = [
  { family: 'connect-hello', protocolVersion: 1, accountId: 'acct_main', scopeId: 'scope_main', controllerDeviceId: 'ctrl_phone_1', hostDeviceId: 'host_mac_1', epoch: 7, lastSeq: 3, snapshotId: 'snap_1', collectionDigests: { job: digest('f') }, supportedTransports: ['relay', 'lan'] },
  { family: 'connect-decision', v: 1, decision: 'delta', fromSeq: 4, toSeq: 5, signedAt: now, signature: 'sig_decision' },
  { family: 'state-event', v: 1, eventId: 'event_1', seq: 1, prevSeq: 0, fence, collection: 'job', op: 'upsert', entityId: 'job_1', revision: 1, durable: true, payloadCiphertext: 'cipher_event', payloadDigest: digest('1'), keyId: 'key_1', createdAt: now, signature: 'sig_event' },
  { family: 'event-ack', v: 1, eventId: 'event_1', controllerDeviceId: 'ctrl_phone_1', fence, lastSeq: 1, ackedAt: now, signature: 'sig_event_ack' },
  { family: 'cursor-ack', v: 1, controllerDeviceId: 'ctrl_phone_1', fence, lastSeq: 1, snapshotId: 'snap_1', collectionDigests: { job: digest('2') }, ackedAt: now, signature: 'sig_cursor' },
  { family: 'gap-repair-request', v: 1, controllerDeviceId: 'ctrl_phone_1', fence, fromSeq: 2, toSeq: 4, reason: 'gap', requestedAt: now, signature: 'sig_gap_req' },
  { family: 'gap-repair-response', v: 1, fence, fromSeq: 2, toSeq: 4, eventIds: ['event_2', 'event_3', 'event_4'], snapshotId: 'snap_1', createdAt: now, signature: 'sig_gap_res' },
  { family: 'command-envelope', v: 1, commandId: 'cmd_1', idempotencyKey: 'idem_1', controllerDeviceId: 'ctrl_phone_1', fence, method: 'sendChat', paramsCiphertext: 'cipher_params', grantScopes: ['chat'], createdAt: now, expiresAt: now + 10_000, signature: 'sig_cmd' },
  { family: 'command-ack', v: 1, commandId: 'cmd_1', status: 'accepted', fence, acceptedSeq: 1, resultSeq: 2, signedAt: now, signature: 'sig_ack' },
  { family: 'command-state', v: 1, commandId: 'cmd_1', fence, state: 'accepted', durable: true, seq: 2, createdAt: now, signature: 'sig_cmd_state' },
  { family: 'snapshot-manifest', v: 1, snapshotId: 'snap_1', fence, baseSeq: 3, schemaVersion: 1, createdAt: now, collectionDigests: { job: digest('3') }, chunks: [{ contentId: 'cid_chunk_1', collection: 'job', pageKey: 'job-page-1', entityCount: 1, compressedBytes: 100, encryptedBytes: 128, plaintextDigest: digest('4'), ciphertextDigest: digest('5'), encryptionKeyId: 'key_1', nonce: 'nonce_1', compression: 'zstd', encryption: 'aes-256-gcm' }], manifestDigest: digest('6'), signature: 'sig_manifest' },
  { family: 'snapshot-chunk-request', v: 1, snapshotId: 'snap_1', contentId: 'cid_chunk_1', range: { start: 0, endExclusive: 64 }, requestedAt: now, signature: 'sig_chunk_req' },
  { family: 'snapshot-chunk-response', v: 1, snapshotId: 'snap_1', contentId: 'cid_chunk_1', range: { start: 0, endExclusive: 64 }, ciphertextDigest: digest('7'), encryptedBytes: 64, keyId: 'key_1', createdAt: now, signature: 'sig_chunk_res' },
  { family: 'asset-manifest', v: 1, assetId: 'asset_1', revisionId: 'rev_1', fence, variants, createdAt: now, signature: 'sig_asset_manifest' },
  { family: 'asset-capability', v: 1, capabilityId: 'cap_1', fence, controllerDeviceId: 'ctrl_phone_1', assetId: 'asset_1', contentId: 'cid_screen', variant: 'screen', permissions: ['read', 'range-read'], expiresAt: now + 10_000, signature: 'sig_cap' },
  { family: 'asset-range-request', v: 1, capabilityId: 'cap_1', contentId: 'cid_screen', variant: 'screen', range: { start: 0, endExclusive: 1024 }, requestedAt: now, signature: 'sig_asset_req' },
  { family: 'asset-range-response', v: 1, capabilityId: 'cap_1', contentId: 'cid_screen', variant: 'screen', range: { start: 0, endExclusive: 1024 }, ciphertextDigest: digest('8'), encryptedBytes: 1024, createdAt: now, signature: 'sig_asset_res' },
  { family: 'preview-session', v: 1, visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_phone_1', source: 'browser', mode: 'web-tunnel', inputMode: 'view-only', transport: 'encrypted-relay', projectId: 'proj_1', sessionId: 'sess_1', expiresAt: now + 10_000, signature: 'sig_preview' },
  { family: 'web-tunnel-http-request', v: 1, tunnelId: 'tun_1', requestId: 'req_1', method: 'GET', path: '/preview/index.html', headers: { accept: 'text/html' }, createdAt: now, signature: 'sig_req' },
  { family: 'web-tunnel-http-response', v: 1, tunnelId: 'tun_1', requestId: 'req_1', status: 200, headers: { 'content-type': 'text/html' }, bodyContentId: 'cid_body', etag: 'abc', createdAt: now, signature: 'sig_res' },
  { family: 'web-tunnel-ws', v: 1, tunnelId: 'tun_1', streamId: 'stream_1', frameSeq: 1, kind: 'open', path: '/ws', headers: { accept: '*/*' }, createdAt: now, signature: 'sig_ws' },
  { family: 'visual-frame', v: 1, visualSessionId: 'vis_1', frameSeq: 1, hostStateSeq: 3, projectRevision: 'rev_1', contentId: 'cid_frame', timestamp: now, codec: 'h264', keyframe: true, signature: 'sig_frame' },
  { family: 'visual-control-grant', v: 1, grantId: 'vgrant_1', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_phone_1', mode: 'control', expiresAt: now + 10_000, signedAt: now, signature: 'sig_control' },
  { family: 'visual-input', v: 1, visualSessionId: 'vis_1', fence, inputSeq: 1, frameSeqSeen: 1, kind: 'tap', viewport: { width: 390, height: 844, scale: 3 }, payloadCiphertext: 'cipher_input', createdAt: now, signature: 'sig_input' },
  { family: 'enrollment-request', v: 1, accountId: 'acct_main', controllerDeviceId: 'ctrl_phone_1', devicePublicKeyId: 'key_device_1', requestedAt: now, signature: 'sig_enroll_req' },
  { family: 'enrollment-grant', v: 1, fence, controllerDeviceId: 'ctrl_phone_1', grantId: 'grant_1', expiresAt: now + 10_000, keyId: 'key_scope_1', signedAt: now, signature: 'sig_enroll_grant' },
  { family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_phone_1', revokedAt: now, keyRotationId: 'rotation_1', signature: 'sig_revoke' },
  { family: 'key-rotation', v: 1, fence, keyId: 'key_2', previousKeyId: 'key_1', effectiveSeq: 10, createdAt: now, signature: 'sig_rotation' },
  { family: 'handoff-prepare', v: 1, scopeId: 'scope_main', fromHostDeviceId: 'host_mac_1', toHostDeviceId: 'host_mac_2', currentEpoch: 7, reason: 'operator-request', requestedAt: now, signature: 'sig_hp' },
  { family: 'handoff-quiesced', v: 1, oldFence: fence, finalSnapshotId: 'snap_final', finalBaseSeq: 10, quiescedAt: now, signature: 'sig_hq' },
  { family: 'handoff-grant', v: 1, oldFence: fence, newFence, finalSnapshotId: 'snap_final', finalBaseSeq: 10, oldHostFenceExpiresAt: now + 1_000, secretReauthRequired: true, serverSignature: 'sig_hg' },
  { family: 'handoff-commit', v: 1, oldFence: fence, newFence, committedAt: now, signature: 'sig_hc' },
  { family: 'handoff-abort', v: 1, oldFence: fence, reason: 'operator-cancelled', abortedAt: now, signature: 'sig_ha' },
  { family: 'handoff-fenced', v: 1, oldFence: fence, newEpoch: 8, fencedAt: now, signature: 'sig_hf' },
];

describe('complete V2 wire message families', () => {
  it.each(baseMessages.map((message) => [message.family, message]))('accepts and round-trips %s', (_family, message) => {
    const decoded = decodeShadowMessageAtNow(JSON.parse(JSON.stringify(message)));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.family).toBe(message.family);
  });

  it('rejects unknown versions, families, keys, and deep forbidden metadata-only fields', () => {
    expect(decodeShadowMessageAtNow({ ...baseMessages[2], v: 2 }).ok).toBe(false);
    expect(decodeShadowMessageAtNow({ family: 'unknown', v: 1 }).ok).toBe(false);
    expect(decodeShadowMessageAtNow({ ...baseMessages[8], extra: true }).ok).toBe(false);
    expect(decodeShadowMessageAtNow({ ...baseMessages[13], variants: { ...variants, screen: { ...variants.screen, nested: { secret: 'plain' } } } }).ok).toBe(false);
    expect(decodeShadowMessageAtNow({ ...baseMessages[18], path: 'http://169.254.169.254/latest' }).ok).toBe(false);
  });

  it('validates public ID/content parsers at runtime', () => {
    expect(parseAccountId('acct_main').ok).toBe(true);
    expect(parseCommandId('../cmd').ok).toBe(false);
    expect(parseContentId('/tmp/file').ok).toBe(false);
  });
});

describe('enrollment revocation and handoff validators', () => {
  it('keeps protocol v1 compatible with visual control grants emitted before grantId extension', () => {
    const oldHostGrant = {
      family: 'visual-control-grant',
      v: SHADOW_PROTOCOL_VERSION,
      visualSessionId: 'vis_legacy_1',
      fence,
      controllerDeviceId: 'ctrl_phone_1',
      mode: 'control',
      expiresAt: now + 10_000,
      signedAt: now,
      signature: 'sig_control_legacy',
    };
    const bytes = JSON.stringify(oldHostGrant);
    const decoded = decodeShadowMessageAtNow(JSON.parse(bytes));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject(oldHostGrant);
    expect('grantId' in decoded.value).toBe(false);
  });

  it('rejects expired or revoked grants and validates revocation key rotation', () => {
    const grant = { controllerDeviceId: 'ctrl_phone_1', grantId: 'grant_1', fence, expiresAt: now + 1000 };
    expect(validateEnrollmentGrant({ grant, controllerDeviceId: 'ctrl_phone_1', now }).ok).toBe(true);
    expect(validateEnrollmentGrant({ grant, controllerDeviceId: 'ctrl_phone_1', now: now + 2000 }).ok).toBe(false);
    expect(validateEnrollmentGrant({ grant, controllerDeviceId: 'ctrl_phone_1', now, revokedDeviceIds: new Set(['ctrl_phone_1']) }).ok).toBe(false);
    expect(validateRevocation({ grant, revokedAt: now, keyRotationEffectiveSeq: 11, currentSeq: 10 }).ok).toBe(true);
    expect(validateRevocation({ grant, revokedAt: now, keyRotationEffectiveSeq: 9, currentSeq: 10 }).ok).toBe(false);
  });

  it('requires quiescence, final snapshot, higher epoch, and fences old epoch after commit', () => {
    let state: HandoffState = { oldFence: fence, phase: 'idle' };
    expect(validateHandoffTransition(state, { type: 'prepare', toHostDeviceId: 'host_mac_2', requestedByShadowOnly: true }).ok).toBe(false);
    const prepared = validateHandoffTransition(state, { type: 'prepare', toHostDeviceId: 'host_mac_2' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    state = prepared.state;
    expect(validateHandoffTransition(state, { type: 'grant', newFence, finalSnapshotId: 'snap_final', finalBaseSeq: 10 }).ok).toBe(false);
    const quiesced = validateHandoffTransition(state, { type: 'quiesce', finalSnapshotId: 'snap_final', finalBaseSeq: 10 });
    expect(quiesced.ok).toBe(true);
    if (!quiesced.ok) return;
    const granted = validateHandoffTransition(quiesced.state, { type: 'grant', newFence, finalSnapshotId: 'snap_final', finalBaseSeq: 10 });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    const committed = validateHandoffTransition(granted.state, { type: 'commit', newFence });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(isFenceValidAfterHandoff({ fence, handoff: committed.state })).toBe(false);
    expect(isFenceValidAfterHandoff({ fence: newFence, handoff: committed.state })).toBe(true);
  });
});
