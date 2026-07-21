import { describe, expect, it } from 'vitest';
import {
  SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES,
  SHADOW_PROTOCOL_VERSION,
  advanceCommandLifecycle,
  decodeShadowMessage,
  decodeVisualInputEvent,
  type CommandLifecycleInput,
  type CommandLifecycleState,
  type HostCommandAck,
  type ShadowStateEvent,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = {
  accountId: 'acct_main',
  scopeId: 'scope_main',
  hostDeviceId: 'host_mac_1',
  epoch: 7,
  leaseId: 'lease_active',
};
const digest = (ch: string): string => `sha256:${ch.repeat(64)}`;

const visualInput = {
  family: 'visual-input',
  v: SHADOW_PROTOCOL_VERSION,
  visualSessionId: 'vis_1',
  fence,
  inputSeq: 1,
  frameSeqSeen: 1,
  kind: 'tap',
  viewport: { width: 390, height: 844, scale: 3 },
  payloadCiphertext: 'cipher_input',
  createdAt: now,
  signature: 'sig_visual_input',
} as const;

const chunk = {
  contentId: 'cid_job_1',
  collection: 'job',
  pageKey: 'job-page-1',
  entityCount: 2,
  compressedBytes: 100,
  encryptedBytes: 128,
  plaintextDigest: digest('a'),
  ciphertextDigest: digest('b'),
  encryptionKeyId: 'key_scope_1',
  nonce: 'nonce_1',
  compression: 'zstd',
  encryption: 'aes-256-gcm',
} as const;

const manifest = {
  family: 'snapshot-manifest',
  v: SHADOW_PROTOCOL_VERSION,
  snapshotId: 'snap_1',
  fence,
  baseSeq: 10,
  schemaVersion: 1,
  createdAt: now,
  collectionDigests: { job: digest('c') },
  chunks: [chunk],
  manifestDigest: digest('d'),
  signature: 'sig_manifest',
} as const;

function event(seq: number, extra: Partial<ShadowStateEvent> = {}): ShadowStateEvent {
  return {
    v: SHADOW_PROTOCOL_VERSION,
    eventId: `event_${seq}`,
    seq,
    prevSeq: seq - 1,
    fence,
    collection: 'job',
    op: 'upsert',
    entityId: 'job_1',
    revision: seq,
    commandId: 'cmd_1',
    durable: true,
    payloadCiphertext: 'cipher_event',
    payloadDigest: digest('e'),
    keyId: 'key_scope_1',
    createdAt: now,
    signature: 'sig_event',
    ...extra,
  };
}

const ack = (overrides: Partial<HostCommandAck> = {}): HostCommandAck => ({
  family: 'command-ack',
  v: SHADOW_PROTOCOL_VERSION,
  commandId: 'cmd_1',
  status: 'accepted',
  fence,
  acceptedSeq: 2,
  resultSeq: 5,
  signedAt: now,
  signature: 'sig_ack',
  ...overrides,
});

const initialState = (): CommandLifecycleState => ({
  status: 'pending-local',
  commandId: 'cmd_1',
  fence,
  createdAt: now,
  expiresAt: now + 60_000,
});

describe('second correction strict visual input decoder', () => {
  it('rejects unknown keys, missing fence, malformed viewport, bad payload, and bad signature at wire decode', () => {
    expect(decodeShadowMessage(visualInput).ok).toBe(true);
    expect(decodeShadowMessage({ ...visualInput, extra: true }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, fence: undefined }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, inputSeq: 0 }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, frameSeqSeen: -1 }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, kind: 'paste' }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, viewport: { width: 390, height: 844, scale: 3, raw: true } }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, viewport: { width: Number.POSITIVE_INFINITY, height: 844, scale: 3 } }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, payloadCiphertext: '' }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, createdAt: Number.NaN }).ok).toBe(false);
    expect(decodeShadowMessage({ ...visualInput, signature: '' }).ok).toBe(false);
  });

  it('uses the same static decoder before dynamic session authorization checks', () => {
    const { family: _family, ...missingFamily } = visualInput;
    const { v: _v, ...missingVersion } = visualInput;
    expect(decodeVisualInputEvent(missingFamily, {
      visualSessionId: 'vis_1',
      mode: 'control',
      lastInputSeq: 0,
      minFrameSeq: 0,
      now,
      maxAgeMs: 5_000,
    }).ok).toBe(false);
    expect(decodeVisualInputEvent(missingVersion, {
      visualSessionId: 'vis_1',
      mode: 'control',
      lastInputSeq: 0,
      minFrameSeq: 0,
      now,
      maxAgeMs: 5_000,
    }).ok).toBe(false);
    expect(decodeVisualInputEvent({ ...visualInput, family: 'visual-frame' }, {
      visualSessionId: 'vis_1',
      mode: 'control',
      lastInputSeq: 0,
      minFrameSeq: 0,
      now,
      maxAgeMs: 5_000,
    }).ok).toBe(false);
    expect(decodeVisualInputEvent({ ...visualInput, v: 2 }, {
      visualSessionId: 'vis_1',
      mode: 'control',
      lastInputSeq: 0,
      minFrameSeq: 0,
      now,
      maxAgeMs: 5_000,
    }).ok).toBe(false);
    expect(decodeVisualInputEvent({ ...visualInput, viewport: { width: 390, height: 844, scale: 3, raw: true } }, {
      visualSessionId: 'vis_1',
      mode: 'control',
      lastInputSeq: 0,
      minFrameSeq: 0,
      now,
      maxAgeMs: 5_000,
    }).ok).toBe(false);
  });
});

describe('second correction exact snapshot chunk shape', () => {
  it('rejects unknown top-level and nested chunk keys, duplicate pages/content ids, bad digests, sizes, and algorithms', () => {
    expect(decodeShadowMessage(manifest).ok).toBe(true);
    expect(decodeShadowMessage({ ...manifest, metadata: {} }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, extra: true }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, plaintext: 'secret' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, encryptedBytes: 0 }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, contentId: '../cid' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, ciphertextDigest: 'md5:bad' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, compression: 'brotli' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [{ ...chunk, encryption: 'none' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [chunk, { ...chunk, contentId: 'cid_job_2' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, chunks: [chunk, { ...chunk, pageKey: 'job-page-2' }] }).ok).toBe(false);
    expect(decodeShadowMessage({ ...manifest, collectionDigests: { job: digest('c'), madeUp: digest('f') } }).ok).toBe(false);
  });

  it('bounds encrypted payload and snapshot ciphertext sizes at shared cap', () => {
    const cappedCiphertext = 'x'.repeat(SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES);
    const tooLargeCiphertext = `${cappedCiphertext}x`;
    expect(decodeShadowMessage({ family: 'state-event', ...event(1, { payloadCiphertext: cappedCiphertext }) }).ok).toBe(true);
    expect(decodeShadowMessage({ family: 'state-event', ...event(1, { payloadCiphertext: tooLargeCiphertext }) }).ok).toBe(false);

    const cappedChunk = { ...chunk, encryptedBytes: SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES };
    const oversizedChunk = { ...chunk, encryptedBytes: SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES + 1 };
    expect(decodeShadowMessage({ ...manifest, chunks: [cappedChunk] }).ok).toBe(true);
    expect(decodeShadowMessage({ ...manifest, chunks: [oversizedChunk] }).ok).toBe(false);

    const response = {
      family: 'snapshot-chunk-response',
      v: SHADOW_PROTOCOL_VERSION,
      snapshotId: 'snap_1',
      contentId: 'cid_job_1',
      range: { start: 0, endExclusive: 10 },
      ciphertextDigest: digest('b'),
      encryptedBytes: SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES,
      keyId: 'key_scope_1',
      createdAt: now,
      signature: 'sig_response',
    };
    expect(decodeShadowMessage(response).ok).toBe(true);
    expect(decodeShadowMessage({ ...response, encryptedBytes: SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES + 1 }).ok).toBe(false);
  });
});

describe('second correction mandatory command lifecycle graph', () => {
  it('allows only adjacent visible command transitions before a state event can apply', () => {
    let state = initialState();
    state = advanceCommandLifecycle(state, { type: 'sent', now }).state;
    state = advanceCommandLifecycle(state, { type: 'host-ack', ack: ack(), now }).state;
    expect(state.status).toBe('accepted');
    expect(advanceCommandLifecycle(state, { type: 'await-state-event', now }).outcome).toBe('invalid');
    expect(advanceCommandLifecycle(state, { type: 'state-event', event: event(5), now }).state.status).toBe('accepted');
    state = advanceCommandLifecycle(state, { type: 'execute', now }).state;
    expect(state.status).toBe('executing');
    expect(advanceCommandLifecycle(state, { type: 'state-event', event: event(5), now }).state.status).toBe('executing');
    state = advanceCommandLifecycle(state, { type: 'await-state-event', now }).state;
    expect(state.status).toBe('awaiting-state-event');
    state = advanceCommandLifecycle(state, { type: 'state-event', event: event(5), now }).state;
    expect(state.status).toBe('applied');
  });

  it('handles duplicates, event-before-ack, wrong command/fence, resultSeq bounds, and terminal ACK statuses', () => {
    const sent = advanceCommandLifecycle(initialState(), { type: 'sent', now }).state;
    const eventBeforeAck = advanceCommandLifecycle(sent, { type: 'state-event', event: event(5), now });
    expect(eventBeforeAck.state.status).toBe('sent');
    expect(eventBeforeAck.state.pendingEvent?.eventId).toBe('event_5');
    const accepted = advanceCommandLifecycle(eventBeforeAck.state, { type: 'host-ack', ack: ack(), now }).state;
    expect(accepted.status).toBe('accepted');
    const executing = advanceCommandLifecycle(accepted, { type: 'execute', now }).state;
    const awaiting = advanceCommandLifecycle(executing, { type: 'await-state-event', now }).state;
    expect(awaiting.status).toBe('awaiting-state-event');
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(4), now }).outcome).toBe('invalid');
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(5, { commandId: 'cmd_other' }), now }).outcome).toBe('invalid');
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(5, { fence: { ...fence, epoch: 8 } }), now }).outcome).toBe('fenced');
    expect(advanceCommandLifecycle(awaiting, { type: 'host-ack', ack: ack(), now }).outcome).toBe('idempotent');
    expect(advanceCommandLifecycle(awaiting, { type: 'host-ack', ack: ack({ resultSeq: 6 }), now }).state.status).toBe('conflict');

    const terminalStatuses: Array<HostCommandAck['status']> = ['rejected', 'stale-epoch', 'unauthorized', 'expired', 'host-busy'];
    for (const status of terminalStatuses) {
      const terminal = advanceCommandLifecycle(sent, { type: 'host-ack', ack: ack({
        status,
        resultSeq: undefined,
        acceptedSeq: undefined,
        error: status === 'host-busy' ? undefined : { code: status, message: status },
      }), now });
      expect(['rejected', 'stale-epoch', 'unauthorized', 'expired']).toContain(terminal.state.status);
    }
  });

  it.each([
    ['pending-local execute', initialState(), { type: 'execute', now }],
    ['pending-local await', initialState(), { type: 'await-state-event', now }],
    ['accepted await', advanceCommandLifecycle(advanceCommandLifecycle(initialState(), { type: 'sent', now }).state, { type: 'host-ack', ack: ack(), now }).state, { type: 'await-state-event', now }],
  ] satisfies Array<[string, CommandLifecycleState, CommandLifecycleInput]>)('rejects forbidden skip %s', (_name, state, input) => {
    expect(advanceCommandLifecycle(state, input).outcome).toBe('invalid');
  });
});
