import { describe, expect, it } from 'vitest';
import {
  SHADOW_PROTOCOL_VERSION,
  advanceCommandLifecycle,
  decodeShadowMessage,
  hostCommandAckSemanticallyEqual,
  type CommandLifecycleState,
  type HostCommandAck,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const decodeShadowMessageAtNow = (value: unknown) => decodeShadowMessage(value, { nowMs: now });
const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };

const baseAck = (overrides: Partial<HostCommandAck> = {}): HostCommandAck => ({
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

const sentState = (ack?: HostCommandAck): CommandLifecycleState => ({
  status: ack ? 'accepted' : 'sent',
  commandId: 'cmd_1',
  fence,
  createdAt: now,
  expiresAt: now + 60_000,
  ack,
  resultSeq: ack?.resultSeq,
});

const decodeAck = (value: Record<string, unknown>): HostCommandAck => {
  const decoded = decodeShadowMessageAtNow(value);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value as HostCommandAck;
};

const ackWire = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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

const preview = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  family: 'preview-session',
  v: SHADOW_PROTOCOL_VERSION,
  visualSessionId: 'vis_1',
  fence,
  controllerDeviceId: 'ctrl_phone_1',
  source: 'browser',
  mode: 'web-tunnel',
  inputMode: 'view-only',
  transport: 'encrypted-relay',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  expiresAt: now + 10_000,
  signature: 'sig_preview',
  ...overrides,
});

const ws = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  family: 'web-tunnel-ws',
  v: SHADOW_PROTOCOL_VERSION,
  tunnelId: 'tun_1',
  streamId: 'stream_1',
  frameSeq: 1,
  kind: 'open',
  path: '/ws',
  headers: { accept: '*/*' },
  createdAt: now,
  signature: 'sig_ws',
  ...overrides,
});

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete copy[key];
  return copy;
};

const omitUndefined = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

describe('fourth correction exact signed ACK repeat semantics', () => {
  it.each([
    ['family', { family: undefined }],
    ['v', { v: 2 }],
    ['commandId', { commandId: 'cmd_2' }],
    ['status', { status: 'duplicate', duplicateOf: 'cmd_0' }],
    ['fence.accountId', { fence: { ...fence, accountId: 'acct_other' } }],
    ['fence.scopeId', { fence: { ...fence, scopeId: 'scope_other' } }],
    ['fence.hostDeviceId', { fence: { ...fence, hostDeviceId: 'host_other' } }],
    ['fence.epoch', { fence: { ...fence, epoch: 8 } }],
    ['fence.leaseId', { fence: { ...fence, leaseId: 'lease_other' } }],
    ['acceptedSeq', { acceptedSeq: 3 }],
    ['resultSeq', { resultSeq: 6 }],
    ['signedAt', { signedAt: now + 1 }],
    ['signature', { signature: 'sig_other' }],
  ])('detects accepted ACK semantic mismatch in %s', (_field, mutation) => {
    const original = baseAck();
    const mutated = baseAck(mutation as Partial<HostCommandAck>);
    expect(hostCommandAckSemanticallyEqual(original, original)).toBe(true);
    expect(hostCommandAckSemanticallyEqual(original, mutated)).toBe(false);

    const repeated = advanceCommandLifecycle(sentState(original), { type: 'host-ack', ack: mutated, now });
    expect(repeated.outcome).toBe(_field === 'fence.accountId' || _field === 'fence.scopeId' || _field === 'fence.hostDeviceId' || _field === 'fence.epoch' || _field === 'fence.leaseId' ? 'fenced' : _field === 'commandId' ? 'invalid' : 'advanced');
    if (repeated.outcome === 'advanced') expect(repeated.state.status).toBe('conflict');
  });

  it.each([
    ['duplicateOf', { duplicateOf: 'cmd_other' }],
    ['resultSeq', { resultSeq: 6 }],
    ['signedAt', { signedAt: now + 1 }],
    ['signature', { signature: 'sig_other' }],
  ])('detects duplicate ACK semantic mismatch in %s', (_field, mutation) => {
    const original = baseAck({ status: 'duplicate', acceptedSeq: undefined, duplicateOf: 'cmd_0' });
    const mutated = baseAck({ status: 'duplicate', acceptedSeq: undefined, duplicateOf: 'cmd_0', ...mutation });
    expect(hostCommandAckSemanticallyEqual(original, mutated)).toBe(false);
    const repeated = advanceCommandLifecycle(sentState(original), { type: 'host-ack', ack: mutated, now });
    expect(repeated.outcome).toBe('advanced');
    expect(repeated.state.status).toBe('conflict');
  });

  it.each([
    ['error.code', { error: { code: 'OTHER', message: 'no' } }],
    ['error.message', { error: { code: 'REJECTED', message: 'different' } }],
    ['signedAt', { signedAt: now + 1 }],
    ['signature', { signature: 'sig_other' }],
  ])('detects terminal ACK semantic mismatch in %s', (_field, mutation) => {
    const original = baseAck({ status: 'rejected', acceptedSeq: undefined, resultSeq: undefined, error: { code: 'REJECTED', message: 'no' } });
    const mutated = baseAck({ status: 'rejected', acceptedSeq: undefined, resultSeq: undefined, error: { code: 'REJECTED', message: 'no' }, ...mutation });
    expect(hostCommandAckSemanticallyEqual(original, mutated)).toBe(false);
  });

  it('normalizes decoded terminal ACK error equality by exact semantic fields', () => {
    const first = decodeAck(ackWire({ status: 'rejected', acceptedSeq: undefined, resultSeq: undefined, error: { code: 'REJECTED', message: 'no' } }));
    const repeat = decodeAck(ackWire({ status: 'rejected', acceptedSeq: undefined, resultSeq: undefined, error: { code: 'REJECTED', message: 'no' } }));
    expect(hostCommandAckSemanticallyEqual(first, repeat)).toBe(true);
  });
});

describe('fourth correction preview-session mode schemas', () => {
  it.each([
    ['artifact', omitUndefined(preview({ mode: 'artifact', source: 'file-preview', transport: 'encrypted-relay', projectId: 'proj_1', sessionId: 'sess_1', surfaceId: undefined }))],
    ['web-tunnel', omitUndefined(preview({ mode: 'web-tunnel', source: 'browser', transport: 'encrypted-relay', projectId: 'proj_1', sessionId: 'sess_1', surfaceId: undefined }))],
    ['pixel-stream', omitUndefined(preview({ mode: 'pixel-stream', source: 'native-window', transport: 'webrtc-direct', projectId: undefined, sessionId: undefined, surfaceId: 'surface_1' }))],
  ])('accepts valid %s preview schema', (_mode, message) => {
    expect(decodeShadowMessageAtNow(message).ok).toBe(true);
  });

  it.each([
    ['artifact missing projectId', without(omitUndefined(preview({ mode: 'artifact', source: 'file-preview', transport: 'encrypted-relay', surfaceId: undefined })), 'projectId')],
    ['artifact forbids surfaceId', preview({ mode: 'artifact', source: 'file-preview', transport: 'encrypted-relay', surfaceId: 'surface_1' })],
    ['artifact rejects browser source', preview({ mode: 'artifact', source: 'browser', transport: 'encrypted-relay', surfaceId: undefined })],
    ['web missing projectId', without(omitUndefined(preview({ mode: 'web-tunnel', source: 'browser', transport: 'encrypted-relay', sessionId: 'sess_1', surfaceId: undefined })), 'projectId')],
    ['web missing sessionId', without(omitUndefined(preview({ mode: 'web-tunnel', source: 'browser', transport: 'encrypted-relay', surfaceId: undefined })), 'sessionId')],
    ['web forbids surfaceId', preview({ mode: 'web-tunnel', source: 'browser', transport: 'encrypted-relay', surfaceId: 'surface_1' })],
    ['web rejects native source', preview({ mode: 'web-tunnel', source: 'native-window', transport: 'encrypted-relay', surfaceId: undefined })],
    ['pixel missing surfaceId', without(omitUndefined(preview({ mode: 'pixel-stream', source: 'native-window', transport: 'webrtc-direct', projectId: undefined, sessionId: undefined, surfaceId: 'surface_1' })), 'surfaceId')],
    ['pixel forbids projectId', preview({ mode: 'pixel-stream', source: 'native-window', transport: 'webrtc-direct', projectId: 'proj_1', sessionId: undefined, surfaceId: 'surface_1' })],
    ['pixel forbids sessionId', preview({ mode: 'pixel-stream', source: 'native-window', transport: 'webrtc-direct', projectId: undefined, sessionId: 'sess_1', surfaceId: 'surface_1' })],
    ['pixel rejects file source', preview({ mode: 'pixel-stream', source: 'file-preview', transport: 'webrtc-direct', projectId: undefined, sessionId: undefined, surfaceId: 'surface_1' })],
    ['pixel rejects relay-frame transport', preview({ mode: 'pixel-stream', source: 'native-window', transport: 'relay-frame', projectId: undefined, sessionId: undefined, surfaceId: 'surface_1' })],
    ['unknown key', { ...preview(), route: '/unexpected' }],
    ['unsupported version', preview({ v: 2 })],
    ['missing signature', without(preview(), 'signature')],
    ['expired time shape', preview({ expiresAt: -1 })],
  ])('rejects malformed preview-session %s', (_name, message) => {
    expect(decodeShadowMessageAtNow(message).ok).toBe(false);
  });
});

describe('fourth correction web-tunnel-ws kind schemas', () => {
  it.each([
    ['open', ws({ kind: 'open', path: '/ws', headers: { accept: '*/*' } })],
    ['frame', omitUndefined(ws({ kind: 'frame', path: undefined, headers: undefined, dataContentId: 'cid_frame_1' }))],
    ['close', omitUndefined(ws({ kind: 'close', path: undefined, headers: undefined, code: 1000, reason: 'done' }))],
  ])('accepts valid %s WS message', (_kind, message) => {
    expect(decodeShadowMessageAtNow(message).ok).toBe(true);
  });

  it.each([
    ['open missing path', without(ws({ kind: 'open', headers: { accept: '*/*' } }), 'path')],
    ['open missing headers', without(ws({ kind: 'open', path: '/ws' }), 'headers')],
    ['open forbids data', ws({ kind: 'open', dataContentId: 'cid_frame_1' })],
    ['open forbids close code', ws({ kind: 'open', code: 1000 })],
    ['open bad path', ws({ kind: 'open', path: 'http://127.0.0.1:3000/ws' })],
    ['open bad header', ws({ kind: 'open', headers: { host: 'localhost' } })],
    ['frame missing data', omitUndefined(ws({ kind: 'frame', path: undefined, headers: undefined }))],
    ['frame forbids path', omitUndefined(ws({ kind: 'frame', dataContentId: 'cid_frame_1', path: '/ws', headers: undefined }))],
    ['frame forbids headers', omitUndefined(ws({ kind: 'frame', dataContentId: 'cid_frame_1', path: undefined, headers: { accept: '*/*' } }))],
    ['frame forbids close code', omitUndefined(ws({ kind: 'frame', dataContentId: 'cid_frame_1', path: undefined, headers: undefined, code: 1000 }))],
    ['frame bad content', omitUndefined(ws({ kind: 'frame', dataContentId: '../secret', path: undefined, headers: undefined }))],
    ['close missing code', omitUndefined(ws({ kind: 'close', path: undefined, headers: undefined }))],
    ['close forbids path', omitUndefined(ws({ kind: 'close', path: '/ws', headers: undefined, code: 1000 }))],
    ['close forbids headers', omitUndefined(ws({ kind: 'close', path: undefined, headers: { accept: '*/*' }, code: 1000 }))],
    ['close forbids data', omitUndefined(ws({ kind: 'close', path: undefined, headers: undefined, dataContentId: 'cid_frame_1', code: 1000 }))],
    ['close bad code', omitUndefined(ws({ kind: 'close', path: undefined, headers: undefined, code: 999 }))],
    ['close bad reason', omitUndefined(ws({ kind: 'close', path: undefined, headers: undefined, code: 1000, reason: 'x'.repeat(124) }))],
    ['unknown key', { ...ws(), status: 101 }],
    ['unsupported version', ws({ v: 2 })],
    ['missing signature', without(ws(), 'signature')],
    ['missing timestamp', without(ws(), 'createdAt')],
  ])('rejects malformed web-tunnel-ws %s', (_name, message) => {
    expect(decodeShadowMessageAtNow(message).ok).toBe(false);
  });
});
