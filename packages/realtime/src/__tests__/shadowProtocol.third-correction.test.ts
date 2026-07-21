import { describe, expect, it } from 'vitest';
import {
  SHADOW_PROTOCOL_VERSION,
  advanceCommandLifecycle,
  decodeShadowMessage,
  type CommandLifecycleState,
  type CommandLifecycleStatus,
  type HostCommandAck,
  type ShadowStateEvent,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };
const digest = (ch: string): string => `sha256:${ch.repeat(64)}`;

const baseState = (status: CommandLifecycleStatus = 'pending-local'): CommandLifecycleState => ({
  status,
  commandId: 'cmd_1',
  fence,
  createdAt: now,
  expiresAt: now + 60_000,
});

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

const event = (seq: number, overrides: Partial<ShadowStateEvent> = {}): ShadowStateEvent => ({
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
  ...overrides,
});

describe('third correction command ACK ordering', () => {
  it.each([
    ['pending-local', 'invalid', 'pending-local'],
    ['sent', 'advanced', 'accepted'],
    ['accepted', 'idempotent', 'accepted'],
    ['executing', 'idempotent', 'executing'],
    ['awaiting-state-event', 'idempotent', 'awaiting-state-event'],
    ['applied', 'idempotent', 'applied'],
    ['rejected', 'idempotent', 'rejected'],
    ['expired', 'idempotent', 'expired'],
    ['cancelled', 'idempotent', 'cancelled'],
    ['stale-epoch', 'idempotent', 'stale-epoch'],
    ['unauthorized', 'idempotent', 'unauthorized'],
    ['conflict', 'idempotent', 'conflict'],
    ['revoked', 'idempotent', 'revoked'],
  ] satisfies Array<[CommandLifecycleStatus, ReturnType<typeof advanceCommandLifecycle>['outcome'], CommandLifecycleStatus]>)(
    'handles accepted ACK in %s without ACK-before-sent skip',
    (status, outcome, nextStatus) => {
      const state = status === 'sent'
        ? baseState('sent')
        : { ...baseState(status), ack: status === 'pending-local' ? undefined : ack(), resultSeq: status === 'pending-local' ? undefined : 5 };
      const advanced = advanceCommandLifecycle(state, { type: 'host-ack', ack: ack(), now });
      expect(advanced.outcome).toBe(outcome);
      expect(advanced.state.status).toBe(nextStatus);
    },
  );

  it('terminates conflicting duplicate ACKs in already-ACKed active states', () => {
    const accepted = { ...baseState('accepted'), ack: ack(), resultSeq: 5 };
    expect(advanceCommandLifecycle(accepted, { type: 'host-ack', ack: ack({ resultSeq: 6 }), now }).state.status).toBe('conflict');
  });
});

describe('third correction result sequence boundaries', () => {
  it('requires exact event seq when ACK supplies resultSeq', () => {
    const awaiting = { ...baseState('awaiting-state-event'), ack: ack(), resultSeq: 5 };
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(4), now }).outcome).toBe('invalid');
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(5), now }).state.status).toBe('applied');
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(6), now }).outcome).toBe('invalid');
  });

  it('allows accepted ACK without resultSeq and binds the first matching post-boundary event', () => {
    const decoded = decodeShadowMessage({
      family: 'command-ack',
      v: SHADOW_PROTOCOL_VERSION,
      commandId: 'cmd_1',
      status: 'accepted',
      fence,
      acceptedSeq: 5,
      signedAt: now,
      signature: 'sig_ack',
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    let state = advanceCommandLifecycle(baseState('sent'), { type: 'host-ack', ack: decoded.value as HostCommandAck, now }).state;
    state = advanceCommandLifecycle(advanceCommandLifecycle(state, { type: 'execute', now }).state, { type: 'await-state-event', now }).state;
    expect(advanceCommandLifecycle(state, { type: 'state-event', event: event(4), now }).outcome).toBe('invalid');
    const applied = advanceCommandLifecycle(state, { type: 'state-event', event: event(5), now });
    expect(applied.state.status).toBe('applied');
    const conflict = advanceCommandLifecycle({ ...state, pendingEvent: { eventId: 'event_5', seq: 5, commandId: 'cmd_1' } }, { type: 'state-event', event: event(6), now });
    expect(conflict.state.status).toBe('conflict');
  });

  it('rejects wrong command or wrong fence before applying', () => {
    const awaiting = { ...baseState('awaiting-state-event'), ack: ack(), resultSeq: 5 };
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(5, { commandId: 'cmd_other' }), now }).outcome).toBe('invalid');
    expect(advanceCommandLifecycle(awaiting, { type: 'state-event', event: event(5, { fence: { ...fence, epoch: 8 } }), now }).outcome).toBe('fenced');
  });
});

describe('third correction command ACK decoder semantics', () => {
  it.each([
    ['accepted missing acceptedSeq', { status: 'accepted', resultSeq: 5 }, false],
    ['accepted result before accepted boundary', { status: 'accepted', acceptedSeq: 5, resultSeq: 4 }, false],
    ['accepted without result', { status: 'accepted', acceptedSeq: 5 }, true],
    ['duplicate with authoritative result', { status: 'duplicate', duplicateOf: 'cmd_0', resultSeq: 5 }, true],
    ['duplicate missing duplicateOf', { status: 'duplicate', resultSeq: 5 }, false],
    ['duplicate with error', { status: 'duplicate', duplicateOf: 'cmd_0', resultSeq: 5, error: { code: 'DUP', message: 'duplicate' } }, false],
    ['rejected with signed error', { status: 'rejected', error: { code: 'REJECTED', message: 'no' } }, true],
    ['rejected with acceptedSeq', { status: 'rejected', acceptedSeq: 5, error: { code: 'REJECTED', message: 'no' } }, false],
    ['host-busy no result', { status: 'host-busy' }, true],
    ['host-busy with result', { status: 'host-busy', resultSeq: 5 }, false],
  ])('validates %s', (_name, partial, expected) => {
    expect(decodeShadowMessage({
      family: 'command-ack',
      v: SHADOW_PROTOCOL_VERSION,
      commandId: 'cmd_1',
      fence,
      signedAt: now,
      signature: 'sig_ack',
      ...partial,
    }).ok).toBe(expected);
  });
});
