import { describe, expect, it } from 'vitest';
import { SHADOW_PROTOCOL_VERSION, decodeShadowMessage, type ShadowWireMessage } from '../shadowProtocol';

type ShadowFamily = NonNullable<ShadowWireMessage['family']>;
type MutableMessage = Record<string, unknown> & { family: ShadowFamily; v?: number; protocolVersion?: number };

const now = 1_700_000_000_000;
const decodeShadowMessageAtNow = (value: unknown) => decodeShadowMessage(value, { nowMs: now });
const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };
const newFence = { ...fence, hostDeviceId: 'host_mac_2', epoch: 8, leaseId: 'lease_new' };
const digest = (ch: string): string => `sha256:${ch.repeat(64)}`;
const range = { start: 0, endExclusive: 64 };
const variants = {
  placeholder: { contentId: 'cid_placeholder', variant: 'placeholder', bytes: 100, sha256: digest('a'), mime: 'image/jpeg', availableOffline: true },
  small: { contentId: 'cid_small', variant: 'small', bytes: 1000, sha256: digest('b'), mime: 'image/jpeg', availableOffline: true },
  medium: { contentId: 'cid_medium', variant: 'medium', bytes: 10_000, sha256: digest('c'), mime: 'image/jpeg', availableOffline: false },
  screen: { contentId: 'cid_screen', variant: 'screen', bytes: 20_000, sha256: digest('d'), mime: 'image/jpeg', availableOffline: false },
  original: { contentId: 'cid_original', variant: 'original', bytes: 50_000, sha256: digest('e'), mime: 'image/png', availableOffline: false },
} as const;

const validSamples = {
  'connect-hello': { family: 'connect-hello', protocolVersion: 1, accountId: 'acct_main', scopeId: 'scope_main', controllerDeviceId: 'ctrl_phone_1', hostDeviceId: 'host_mac_1', epoch: 7, lastSeq: 3, snapshotId: 'snap_1', collectionDigests: { job: digest('f') }, supportedTransports: ['relay', 'lan'] },
  'connect-decision': { family: 'connect-decision', v: 1, decision: 'delta', fromSeq: 4, toSeq: 5, signedAt: now, signature: 'sig_decision' },
  'state-event': { family: 'state-event', v: 1, eventId: 'event_1', seq: 1, prevSeq: 0, fence, collection: 'job', op: 'upsert', entityId: 'job_1', revision: 1, durable: true, payloadCiphertext: 'cipher_event', payloadDigest: digest('1'), keyId: 'key_1', createdAt: now, signature: 'sig_event' },
  'event-ack': { family: 'event-ack', v: 1, eventId: 'event_1', controllerDeviceId: 'ctrl_phone_1', fence, lastSeq: 1, ackedAt: now, signature: 'sig_event_ack' },
  'cursor-ack': { family: 'cursor-ack', v: 1, controllerDeviceId: 'ctrl_phone_1', fence, lastSeq: 1, snapshotId: 'snap_1', collectionDigests: { job: digest('2') }, ackedAt: now, signature: 'sig_cursor' },
  'gap-repair-request': { family: 'gap-repair-request', v: 1, controllerDeviceId: 'ctrl_phone_1', fence, fromSeq: 2, toSeq: 4, reason: 'gap', requestedAt: now, signature: 'sig_gap_req' },
  'gap-repair-response': { family: 'gap-repair-response', v: 1, fence, fromSeq: 2, toSeq: 4, eventIds: ['event_2', 'event_3'], snapshotId: 'snap_1', createdAt: now, signature: 'sig_gap_res' },
  'command-envelope': { family: 'command-envelope', v: 1, commandId: 'cmd_1', idempotencyKey: 'idem_1', controllerDeviceId: 'ctrl_phone_1', fence, method: 'sendChat', paramsCiphertext: 'cipher_params', grantScopes: ['chat'], createdAt: now, expiresAt: now + 10_000, signature: 'sig_cmd' },
  'command-ack': { family: 'command-ack', v: 1, commandId: 'cmd_1', status: 'accepted', fence, acceptedSeq: 1, resultSeq: 2, signedAt: now, signature: 'sig_ack' },
  'command-state': { family: 'command-state', v: 1, commandId: 'cmd_1', fence, state: 'accepted', durable: true, seq: 2, createdAt: now, signature: 'sig_cmd_state' },
  'snapshot-manifest': { family: 'snapshot-manifest', v: 1, snapshotId: 'snap_1', fence, baseSeq: 3, schemaVersion: 1, createdAt: now, collectionDigests: { job: digest('3') }, chunks: [{ contentId: 'cid_chunk_1', collection: 'job', pageKey: 'job-page-1', entityCount: 1, compressedBytes: 100, encryptedBytes: 128, plaintextDigest: digest('4'), ciphertextDigest: digest('5'), encryptionKeyId: 'key_1', nonce: 'nonce_1', compression: 'zstd', encryption: 'aes-256-gcm' }], manifestDigest: digest('6'), signature: 'sig_manifest' },
  'snapshot-chunk-request': { family: 'snapshot-chunk-request', v: 1, snapshotId: 'snap_1', contentId: 'cid_chunk_1', range, requestedAt: now, signature: 'sig_chunk_req' },
  'snapshot-chunk-response': { family: 'snapshot-chunk-response', v: 1, snapshotId: 'snap_1', contentId: 'cid_chunk_1', range, ciphertextDigest: digest('7'), encryptedBytes: 64, keyId: 'key_1', createdAt: now, signature: 'sig_chunk_res' },
  'asset-manifest': { family: 'asset-manifest', v: 1, assetId: 'asset_1', revisionId: 'rev_1', fence, variants, createdAt: now, signature: 'sig_asset_manifest' },
  'asset-capability': { family: 'asset-capability', v: 1, capabilityId: 'cap_1', fence, controllerDeviceId: 'ctrl_phone_1', assetId: 'asset_1', contentId: 'cid_screen', variant: 'screen', permissions: ['read', 'range-read'], expiresAt: now + 10_000, signature: 'sig_cap' },
  'asset-range-request': { family: 'asset-range-request', v: 1, capabilityId: 'cap_1', contentId: 'cid_screen', variant: 'screen', range, requestedAt: now, signature: 'sig_asset_req' },
  'asset-range-response': { family: 'asset-range-response', v: 1, capabilityId: 'cap_1', contentId: 'cid_screen', variant: 'screen', range, ciphertextDigest: digest('8'), encryptedBytes: 64, createdAt: now, signature: 'sig_asset_res' },
  'preview-session': { family: 'preview-session', v: 1, visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_phone_1', source: 'browser', mode: 'web-tunnel', inputMode: 'view-only', transport: 'encrypted-relay', projectId: 'proj_1', sessionId: 'sess_1', expiresAt: now + 10_000, signature: 'sig_preview' },
  'web-tunnel-http-request': { family: 'web-tunnel-http-request', v: 1, tunnelId: 'tun_1', requestId: 'req_1', method: 'GET', path: '/preview/index.html', headers: { accept: 'text/html' }, createdAt: now, signature: 'sig_req' },
  'web-tunnel-http-response': { family: 'web-tunnel-http-response', v: 1, tunnelId: 'tun_1', requestId: 'req_1', status: 200, headers: { 'content-type': 'text/html' }, bodyContentId: 'cid_body', createdAt: now, signature: 'sig_res' },
  'web-tunnel-ws': { family: 'web-tunnel-ws', v: 1, tunnelId: 'tun_1', streamId: 'stream_1', frameSeq: 1, kind: 'open', path: '/ws', headers: { accept: '*/*' }, createdAt: now, signature: 'sig_ws' },
  'visual-frame': { family: 'visual-frame', v: 1, visualSessionId: 'vis_1', frameSeq: 1, hostStateSeq: 3, projectRevision: 'rev_1', contentId: 'cid_frame', timestamp: now, codec: 'h264', keyframe: true, signature: 'sig_frame' },
  'visual-control-grant': { family: 'visual-control-grant', v: 1, grantId: 'vgrant_1', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_phone_1', mode: 'control', expiresAt: now + 10_000, signedAt: now, signature: 'sig_control' },
  'visual-input': { family: 'visual-input', v: 1, visualSessionId: 'vis_1', fence, inputSeq: 1, frameSeqSeen: 1, kind: 'tap', viewport: { width: 390, height: 844, scale: 3 }, payloadCiphertext: 'cipher_input', createdAt: now, signature: 'sig_input' },
  'enrollment-request': { family: 'enrollment-request', v: 1, accountId: 'acct_main', controllerDeviceId: 'ctrl_phone_1', devicePublicKeyId: 'key_device_1', requestedAt: now, signature: 'sig_enroll_req' },
  'enrollment-grant': { family: 'enrollment-grant', v: 1, fence, controllerDeviceId: 'ctrl_phone_1', grantId: 'grant_1', expiresAt: now + 10_000, keyId: 'key_scope_1', signedAt: now, signature: 'sig_enroll_grant' },
  'device-revocation': { family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_phone_1', revokedAt: now, keyRotationId: 'rotation_1', signature: 'sig_revoke' },
  'key-rotation': { family: 'key-rotation', v: 1, fence, keyId: 'key_2', previousKeyId: 'key_1', effectiveSeq: 10, createdAt: now, signature: 'sig_rotation' },
  'handoff-prepare': { family: 'handoff-prepare', v: 1, scopeId: 'scope_main', fromHostDeviceId: 'host_mac_1', toHostDeviceId: 'host_mac_2', currentEpoch: 7, reason: 'operator-request', requestedAt: now, signature: 'sig_hp' },
  'handoff-quiesced': { family: 'handoff-quiesced', v: 1, oldFence: fence, finalSnapshotId: 'snap_final', finalBaseSeq: 10, quiescedAt: now, signature: 'sig_hq' },
  'handoff-grant': { family: 'handoff-grant', v: 1, oldFence: fence, newFence, finalSnapshotId: 'snap_final', finalBaseSeq: 10, oldHostFenceExpiresAt: now + 1_000, secretReauthRequired: true, serverSignature: 'sig_hg' },
  'handoff-commit': { family: 'handoff-commit', v: 1, oldFence: fence, newFence, committedAt: now, signature: 'sig_hc' },
  'handoff-abort': { family: 'handoff-abort', v: 1, oldFence: fence, reason: 'operator-cancelled', abortedAt: now, signature: 'sig_ha' },
  'handoff-fenced': { family: 'handoff-fenced', v: 1, oldFence: fence, newEpoch: 8, fencedAt: now, signature: 'sig_hf' },
} satisfies Record<ShadowFamily, MutableMessage>;

type MissingFamilySample = Exclude<ShadowFamily, keyof typeof validSamples>;
const exhaustiveFamilySamples: Record<MissingFamilySample, never> = {};
void exhaustiveFamilySamples;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const without = (message: MutableMessage, key: string): MutableMessage => {
  const copy = clone(message);
  delete copy[key];
  return copy;
};
const omitUndefined = (message: MutableMessage): MutableMessage => Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined)) as MutableMessage;

const requiredKeyByFamily = {
  'connect-hello': 'hostDeviceId',
  'connect-decision': 'decision',
  'state-event': 'eventId',
  'event-ack': 'eventId',
  'cursor-ack': 'controllerDeviceId',
  'gap-repair-request': 'fromSeq',
  'gap-repair-response': 'eventIds',
  'command-envelope': 'idempotencyKey',
  'command-ack': 'status',
  'command-state': 'state',
  'snapshot-manifest': 'chunks',
  'snapshot-chunk-request': 'snapshotId',
  'snapshot-chunk-response': 'ciphertextDigest',
  'asset-manifest': 'variants',
  'asset-capability': 'permissions',
  'asset-range-request': 'capabilityId',
  'asset-range-response': 'ciphertextDigest',
  'preview-session': 'visualSessionId',
  'web-tunnel-http-request': 'path',
  'web-tunnel-http-response': 'status',
  'web-tunnel-ws': 'streamId',
  'visual-frame': 'frameSeq',
  'visual-control-grant': 'visualSessionId',
  'visual-input': 'inputSeq',
  'enrollment-request': 'devicePublicKeyId',
  'enrollment-grant': 'grantId',
  'device-revocation': 'keyRotationId',
  'key-rotation': 'previousKeyId',
  'handoff-prepare': 'toHostDeviceId',
  'handoff-quiesced': 'finalSnapshotId',
  'handoff-grant': 'newFence',
  'handoff-commit': 'newFence',
  'handoff-abort': 'reason',
  'handoff-fenced': 'newEpoch',
} satisfies Record<ShadowFamily, string>;

const coverageManifest = {
  connectDecision: ['delta', 'manifest-repair', 'fenced:wrong-host', 'fenced:stale-epoch', 'fenced:future-epoch', 'incompatible'],
  commandAckStatus: ['accepted', 'duplicate', 'rejected', 'stale-epoch', 'unauthorized', 'expired', 'host-busy'],
  commandState: ['sent', 'accepted', 'executing', 'awaiting-state-event', 'applied', 'rejected', 'expired', 'cancelled', 'stale-epoch', 'unauthorized', 'conflict', 'revoked'],
  previewMode: ['artifact', 'web-tunnel', 'pixel-stream'],
  wsKind: ['open', 'frame', 'close'],
  assetVariant: ['placeholder', 'small', 'medium', 'screen', 'original'],
  chunkRange: ['snapshot-chunk-request', 'snapshot-chunk-response', 'asset-range-request', 'asset-range-response'],
  visualControl: ['view-only', 'control'],
  gapRepair: ['gap', 'digest-mismatch', 'missing-snapshot', 'response'],
  security: ['enrollment-request', 'enrollment-grant', 'device-revocation', 'key-rotation'],
  handoff: ['prepare', 'quiesced', 'grant', 'commit', 'abort', 'fenced'],
} as const;

const invalidVariantSamples: Array<[string, MutableMessage]> = [
  ['connect-decision delta missing fromSeq', { family: 'connect-decision', v: 1, decision: 'delta', toSeq: 5, signedAt: now, signature: 'sig_decision' }],
  ['connect-decision manifest repair bad snapshot', { family: 'connect-decision', v: 1, decision: 'manifest-repair', snapshotId: '../snap', replayFromSeq: 4, signedAt: now, signature: 'sig_decision' }],
  ['connect-decision fenced bad reason', { family: 'connect-decision', v: 1, decision: 'fenced', reason: 'old-host', signedAt: now, signature: 'sig_decision' }],
  ['connect-decision incompatible empty versions', { family: 'connect-decision', v: 1, decision: 'incompatible', supportedProtocolVersions: [], signedAt: now, signature: 'sig_decision' }],
  ['command-ack accepted missing acceptedSeq', { ...clone(validSamples['command-ack']), acceptedSeq: undefined }],
  ['command-ack duplicate missing duplicateOf', { ...clone(validSamples['command-ack']), status: 'duplicate', acceptedSeq: undefined, duplicateOf: undefined }],
  ['command-ack terminal result forbidden', { ...clone(validSamples['command-ack']), status: 'rejected', acceptedSeq: undefined, resultSeq: 2, error: { code: 'REJECTED', message: 'no' } }],
  ['command-ack host busy result forbidden', { ...clone(validSamples['command-ack']), status: 'host-busy', acceptedSeq: undefined, resultSeq: 2 }],
  ['command-state accepted non-durable', { ...clone(validSamples['command-state']), state: 'accepted', durable: false }],
  ['preview artifact forbids surfaceId', { ...clone(validSamples['preview-session']), mode: 'artifact', source: 'file-preview', surfaceId: 'surf_1' }],
  ['preview web missing sessionId', without(clone(validSamples['preview-session']), 'sessionId')],
  ['preview pixel forbids projectId', { ...clone(validSamples['preview-session']), mode: 'pixel-stream', source: 'native-window', transport: 'webrtc-direct', surfaceId: 'surf_1' }],
  ['ws open forbids data', { ...clone(validSamples['web-tunnel-ws']), dataContentId: 'cid_frame' }],
  ['ws frame missing data', omitUndefined({ ...clone(validSamples['web-tunnel-ws']), kind: 'frame', path: undefined, headers: undefined })],
  ['ws close missing code', omitUndefined({ ...clone(validSamples['web-tunnel-ws']), kind: 'close', path: undefined, headers: undefined })],
  ['asset variant missing original', { ...clone(validSamples['asset-manifest']), variants: { ...variants, original: undefined } }],
  ['snapshot response missing key', without(clone(validSamples['snapshot-chunk-response']), 'keyId')],
  ['asset range response bad variant', { ...clone(validSamples['asset-range-response']), variant: 'thumbnail' }],
    ['visual-control bad mode', { ...clone(validSamples['visual-control-grant']), mode: 'write' }],
    ['visual-control bad grantId', { ...clone(validSamples['visual-control-grant']), grantId: 'bad/id' }],
  ['gap repair bad reason', { ...clone(validSamples['gap-repair-request']), reason: 'old' }],
  ['enrollment request bad key', { ...clone(validSamples['enrollment-request']), devicePublicKeyId: '../key' }],
  ['revocation missing rotation', without(clone(validSamples['device-revocation']), 'keyRotationId')],
  ['key rotation bad seq', { ...clone(validSamples['key-rotation']), effectiveSeq: -1 }],
  ['handoff prepare same host', { ...clone(validSamples['handoff-prepare']), toHostDeviceId: 'host_mac_1' }],
  ['handoff grant stale new epoch', { ...clone(validSamples['handoff-grant']), newFence: fence }],
  ['handoff abort missing reason', without(clone(validSamples['handoff-abort']), 'reason')],
];

describe('third correction exhaustive family samples', () => {
  it.each(Object.entries(validSamples).map(([family, message]) => [family, message]))('decodes valid %s and round-trips discriminants', (family, message) => {
    const decoded = decodeShadowMessageAtNow(clone(message));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.family).toBe(family);
      expect(JSON.parse(JSON.stringify(decoded.value)).family).toBe(family);
    }
  });

  it.each(Object.entries(validSamples).map(([family, message]) => [family, message]))('rejects generic mutations for %s', (_family, message) => {
    const unsupported = clone(message);
    if ('protocolVersion' in unsupported) unsupported.protocolVersion = SHADOW_PROTOCOL_VERSION + 1;
    else unsupported.v = SHADOW_PROTOCOL_VERSION + 1;
    expect(decodeShadowMessageAtNow(unsupported).ok).toBe(false);
    expect(decodeShadowMessageAtNow({ ...clone(message), unknown: true }).ok).toBe(false);
    if ('signature' in message) expect(decodeShadowMessageAtNow(without(message, 'signature')).ok).toBe(false);
    const timeKey = ['signedAt', 'createdAt', 'ackedAt', 'requestedAt', 'revokedAt', 'quiescedAt', 'committedAt', 'abortedAt', 'fencedAt'].find((key) => key in message);
    if (timeKey !== undefined) expect(decodeShadowMessageAtNow(without(message, timeKey)).ok).toBe(false);
  });

  it.each(Object.entries(requiredKeyByFamily).map(([family, key]) => [family, validSamples[family as ShadowFamily], key]))('rejects deletion of required semantic key %s from %s', (_family, message, key) => {
    expect(decodeShadowMessageAtNow(without(message, key)).ok).toBe(false);
  });

  it.each(invalidVariantSamples)('rejects malformed variant sample: %s', (_name, message) => {
    expect(decodeShadowMessageAtNow(omitUndefined(message)).ok).toBe(false);
  });

  it('maps every named variant category to positive and negative matrix coverage', () => {
    expect(coverageManifest.connectDecision).toHaveLength(6);
    expect(coverageManifest.commandAckStatus).toHaveLength(7);
    expect(coverageManifest.commandState).toHaveLength(12);
    expect(coverageManifest.previewMode).toEqual(['artifact', 'web-tunnel', 'pixel-stream']);
    expect(coverageManifest.wsKind).toEqual(['open', 'frame', 'close']);
    expect(coverageManifest.assetVariant).toEqual(['placeholder', 'small', 'medium', 'screen', 'original']);
    expect(invalidVariantSamples.map(([name]) => name).join('\n')).toContain('preview pixel');
    expect(invalidVariantSamples.map(([name]) => name).join('\n')).toContain('ws frame');
    expect(invalidVariantSamples.map(([name]) => name).join('\n')).toContain('handoff grant');
  });

  it('rejects deep forbidden payload inserted into legitimate metadata fields', () => {
    expect(decodeShadowMessageAtNow({ ...clone(validSamples['asset-manifest']), variants: { ...variants, screen: { ...variants.screen, secret: 'plain' } } }).ok).toBe(false);
    const manifest = clone(validSamples['snapshot-manifest']);
    (manifest as Record<string, unknown>).chunks = [{ ...((manifest as Record<string, unknown>).chunks as Record<string, unknown>[])[0], plaintext: 'raw' }];
    expect(decodeShadowMessageAtNow(manifest).ok).toBe(false);
  });
});

describe('third correction explicit discriminant variant matrices', () => {
  it.each([
    ['delta', { decision: 'delta', fromSeq: 4, toSeq: 5 }],
    ['manifest-repair', { decision: 'manifest-repair', snapshotId: 'snap_1', baseSeqHint: 3, replayFromSeq: 4 }],
    ['fenced wrong-host', { decision: 'fenced', reason: 'wrong-host' }],
    ['fenced stale-epoch', { decision: 'fenced', reason: 'stale-epoch' }],
    ['fenced future-epoch', { decision: 'fenced', reason: 'future-epoch' }],
    ['incompatible', { decision: 'incompatible', supportedProtocolVersions: [1] }],
  ])('connect-decision %s', (_name, partial) => {
    expect(decodeShadowMessageAtNow({ family: 'connect-decision', v: 1, signedAt: now, signature: 'sig_decision', ...partial }).ok).toBe(true);
  });

  it.each([
    ['missing delta field', { decision: 'delta', toSeq: 5 }],
    ['forbidden unknown field', { decision: 'delta', fromSeq: 4, toSeq: 5, snapshotId: 'snap_wrong' }],
    ['bad fenced reason', { decision: 'fenced', reason: 'old-host' }],
  ])('rejects malformed connect-decision %s', (_name, partial) => {
    expect(decodeShadowMessageAtNow({ family: 'connect-decision', v: 1, signedAt: now, signature: 'sig_decision', ...partial }).ok).toBe(false);
  });

  it.each([
    ['accepted with resultSeq', { status: 'accepted', acceptedSeq: 1, resultSeq: 2 }],
    ['accepted without resultSeq', { status: 'accepted', acceptedSeq: 1 }],
    ['duplicate', { status: 'duplicate', duplicateOf: 'cmd_original', resultSeq: 2 }],
    ['rejected', { status: 'rejected', error: { code: 'REJECTED', message: 'rejected' } }],
    ['stale-epoch', { status: 'stale-epoch', error: { code: 'STALE', message: 'stale' } }],
    ['unauthorized', { status: 'unauthorized', error: { code: 'UNAUTH', message: 'unauthorized' } }],
    ['expired', { status: 'expired', error: { code: 'EXPIRED', message: 'expired' } }],
    ['host-busy', { status: 'host-busy' }],
  ])('command-ack %s', (_name, partial) => {
    expect(decodeShadowMessageAtNow({ family: 'command-ack', v: 1, commandId: 'cmd_1', fence, signedAt: now, signature: 'sig_ack', ...partial }).ok).toBe(true);
  });

  it.each([
    ['accepted missing acceptedSeq', { status: 'accepted', resultSeq: 2 }],
    ['duplicate with error', { status: 'duplicate', duplicateOf: 'cmd_original', resultSeq: 2, error: { code: 'DUP', message: 'dup' } }],
    ['rejected with resultSeq', { status: 'rejected', resultSeq: 2, error: { code: 'REJ', message: 'rej' } }],
    ['host-busy resultSeq', { status: 'host-busy', resultSeq: 2 }],
  ])('rejects malformed command-ack %s', (_name, partial) => {
    expect(decodeShadowMessageAtNow({ family: 'command-ack', v: 1, commandId: 'cmd_1', fence, signedAt: now, signature: 'sig_ack', ...partial }).ok).toBe(false);
  });

  it.each([
    ['sent', false], ['accepted', true], ['executing', false], ['awaiting-state-event', true],
    ['applied', true], ['rejected', true], ['expired', true], ['cancelled', true],
    ['stale-epoch', true], ['unauthorized', true], ['conflict', true], ['revoked', true],
  ])('command-state %s', (state, durable) => {
    expect(decodeShadowMessageAtNow({ family: 'command-state', v: 1, commandId: 'cmd_1', fence, state, durable, seq: 2, createdAt: now, signature: 'sig_state' }).ok).toBe(true);
    expect(decodeShadowMessageAtNow({ family: 'command-state', v: 1, commandId: 'cmd_1', fence, state, durable: !durable, seq: 2, createdAt: now, signature: 'sig_state' }).ok).toBe(false);
  });

  it.each([
    ['artifact', { mode: 'artifact', source: 'file-preview', transport: 'encrypted-relay', projectId: 'proj_1' }],
    ['web-tunnel', { mode: 'web-tunnel', source: 'browser', transport: 'encrypted-relay', projectId: 'proj_1', sessionId: 'sess_1' }],
    ['pixel-stream', { mode: 'pixel-stream', source: 'native-window', transport: 'webrtc-direct', surfaceId: 'surf_1' }],
  ])('preview-session %s', (_name, partial) => {
    expect(decodeShadowMessageAtNow(omitUndefined({ ...clone(validSamples['preview-session']), projectId: undefined, sessionId: undefined, surfaceId: undefined, ...partial })).ok).toBe(true);
  });

  it.each([
    ['open', { kind: 'open', path: '/ws', headers: { accept: '*/*' } }],
    ['frame', { kind: 'frame', dataContentId: 'cid_ws_frame' }],
    ['close', { kind: 'close', code: 1000 }],
  ])('web-tunnel-ws %s', (_name, partial) => {
    expect(decodeShadowMessageAtNow({ family: 'web-tunnel-ws', v: 1, tunnelId: 'tun_1', streamId: 'stream_1', frameSeq: 1, createdAt: now, signature: 'sig_ws', ...partial }).ok).toBe(true);
  });

  it.each(['placeholder', 'small', 'medium', 'screen', 'original'] as const)('asset-manifest has %s variant', (variant) => {
    const decoded = decodeShadowMessageAtNow(validSamples['asset-manifest']);
    expect(decoded.ok).toBe(true);
    expect((validSamples['asset-manifest'].variants as typeof variants)[variant].variant).toBe(variant);
  });

  it.each([
    ['missing variant', { ...variants, original: undefined }],
    ['mismatched variant', { ...variants, screen: { ...variants.screen, variant: 'small' } }],
    ['unknown variant key', { ...variants, thumbnail: variants.small }],
  ])('rejects malformed asset variants %s', (_name, mutatedVariants) => {
    expect(decodeShadowMessageAtNow({ ...clone(validSamples['asset-manifest']), variants: mutatedVariants }).ok).toBe(false);
  });

  it.each([
    ['snapshot request', validSamples['snapshot-chunk-request']],
    ['snapshot response', validSamples['snapshot-chunk-response']],
    ['asset request', validSamples['asset-range-request']],
    ['asset response', validSamples['asset-range-response']],
  ])('range/chunk transfer %s', (_name, message) => {
    expect(decodeShadowMessageAtNow(message).ok).toBe(true);
    expect(decodeShadowMessageAtNow({ ...clone(message), range: { start: 64, endExclusive: 0 } }).ok).toBe(false);
  });

  it.each([
    ['visual-control view-only', { ...clone(validSamples['visual-control-grant']), mode: 'view-only' }],
    ['visual-control control', { ...clone(validSamples['visual-control-grant']), mode: 'control' }],
    ['gap request digest-mismatch', { ...clone(validSamples['gap-repair-request']), reason: 'digest-mismatch' }],
    ['gap request missing-snapshot', { ...clone(validSamples['gap-repair-request']), reason: 'missing-snapshot' }],
    ['gap response with snapshot', validSamples['gap-repair-response']],
    ['connect hello relay continuity', validSamples['connect-hello']],
    ['enrollment request', validSamples['enrollment-request']],
    ['enrollment grant', validSamples['enrollment-grant']],
    ['device revocation', validSamples['device-revocation']],
    ['key rotation', validSamples['key-rotation']],
    ['handoff prepare', validSamples['handoff-prepare']],
    ['handoff quiesced', validSamples['handoff-quiesced']],
    ['handoff grant', validSamples['handoff-grant']],
    ['handoff commit', validSamples['handoff-commit']],
    ['handoff abort', validSamples['handoff-abort']],
    ['handoff fenced', validSamples['handoff-fenced']],
  ])('control/repair/security/handoff variant %s', (_name, message) => {
    expect(decodeShadowMessageAtNow(message).ok).toBe(true);
  });
});
