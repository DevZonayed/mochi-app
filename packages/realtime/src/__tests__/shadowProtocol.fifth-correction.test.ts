import { describe, expect, it } from 'vitest';
import {
  SHADOW_PROTOCOL_VERSION,
  advanceCommandLifecycle,
  type CommandLifecycleState,
  type CommandLifecycleStatus,
  type HostCommandAck,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };

const baseState = (status: CommandLifecycleStatus, ack?: HostCommandAck): CommandLifecycleState => ({
  status,
  commandId: 'cmd_1',
  fence,
  createdAt: now,
  expiresAt: now + 60_000,
  ack,
  resultSeq: ack?.resultSeq,
  rejectReason: ack?.error?.message,
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

const terminalAck = (status: Extract<HostCommandAck['status'], 'rejected' | 'expired' | 'stale-epoch' | 'unauthorized'>): HostCommandAck => ack({
  status,
  acceptedSeq: undefined,
  resultSeq: undefined,
  error: { code: status.toUpperCase(), message: `${status} from host` },
});

const duplicateAck = (): HostCommandAck => ack({
  status: 'duplicate',
  acceptedSeq: undefined,
  duplicateOf: 'cmd_original',
});

const hostBusyAck = (): HostCommandAck => ack({
  status: 'host-busy',
  acceptedSeq: undefined,
  resultSeq: undefined,
});

const ackDerivedTerminalStates: Array<[CommandLifecycleStatus, HostCommandAck]> = [
  ['applied', ack()],
  ['rejected', terminalAck('rejected')],
  ['expired', terminalAck('expired')],
  ['stale-epoch', terminalAck('stale-epoch')],
  ['unauthorized', terminalAck('unauthorized')],
  ['revoked', ack({ status: 'rejected', acceptedSeq: undefined, resultSeq: undefined, error: { code: 'REVOKED', message: 'controller revoked' } })],
  ['conflict', ack()],
];

describe('fifth correction terminal ACK lifecycle security checks', () => {
  it.each(ackDerivedTerminalStates)('treats exact ACK repeat for terminal %s as idempotent', (status, storedAck) => {
    const state = baseState(status, storedAck);
    const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: storedAck, now });
    expect(repeated.outcome).toBe('idempotent');
    expect(repeated.state).toBe(state);
  });

  it.each([
    ['signature', (stored: HostCommandAck): HostCommandAck => ({ ...stored, signature: `${stored.signature}_other` })],
    ['signedAt', (stored: HostCommandAck): HostCommandAck => ({ ...stored, signedAt: stored.signedAt + 1 })],
    ['status', (stored: HostCommandAck): HostCommandAck => ({ ...stored, status: 'host-busy', acceptedSeq: undefined, resultSeq: undefined, duplicateOf: undefined, error: undefined })],
    ['acceptedSeq', (stored: HostCommandAck): HostCommandAck => ({ ...stored, acceptedSeq: (stored.acceptedSeq ?? 2) + 1 })],
    ['resultSeq', (stored: HostCommandAck): HostCommandAck => ({ ...stored, resultSeq: (stored.resultSeq ?? 5) + 1 })],
    ['duplicateOf', (): HostCommandAck => ({ ...duplicateAck(), duplicateOf: 'cmd_other' })],
    ['error.code', (): HostCommandAck => ({ ...terminalAck('rejected'), error: { code: 'OTHER', message: 'rejected from host' } })],
    ['error.message', (): HostCommandAck => ({ ...terminalAck('rejected'), error: { code: 'REJECTED', message: 'different' } })],
  ])('turns terminal ACK semantic mutation in %s into conflict, not idempotent', (_field, mutate) => {
    const stored = _field === 'duplicateOf' ? duplicateAck() : _field.startsWith('error.') ? terminalAck('rejected') : ack();
    const state = baseState(_field === 'duplicateOf' || _field.startsWith('error.') ? 'rejected' : 'applied', stored);
    const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: mutate(stored), now });
    expect(repeated.outcome).toBe('advanced');
    expect(repeated.state.status).toBe('conflict');
    expect(repeated.state.ack).toBe(stored);
    expect(repeated.state.rejectReason).toBe('conflicting-terminal-ack');
  });

  it('checks wrong fence before terminal idempotency and leaves state unchanged', () => {
    const state = baseState('rejected', terminalAck('rejected'));
    const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: { ...terminalAck('rejected'), fence: { ...fence, epoch: 8 } }, now });
    expect(repeated.outcome).toBe('fenced');
    expect(repeated.state).toBe(state);
  });

  it('checks wrong command before terminal idempotency and leaves state unchanged', () => {
    const state = baseState('rejected', terminalAck('rejected'));
    const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: { ...terminalAck('rejected'), commandId: 'cmd_other' }, now });
    expect(repeated.outcome).toBe('invalid');
    expect(repeated.state).toBe(state);
  });

  it.each([
    ['cancelled', baseState('cancelled')],
    ['locally expired', baseState('expired')],
  ])('does not treat terminal %s without ACK as an idempotent host repeat', (_name, state) => {
    const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: ack(), now });
    expect(repeated.outcome).toBe('invalid');
    expect(repeated.state).toBe(state);
  });

  it('keeps non-ACK inputs to terminal states terminal-safe idempotent', () => {
    const state = baseState('rejected', terminalAck('rejected'));
    expect(advanceCommandLifecycle(state, { type: 'execute', now }).outcome).toBe('idempotent');
    expect(advanceCommandLifecycle(state, { type: 'state-event', event: {
      v: SHADOW_PROTOCOL_VERSION,
      eventId: 'event_1',
      seq: 5,
      prevSeq: 4,
      fence,
      collection: 'job',
      op: 'upsert',
      entityId: 'job_1',
      revision: 1,
      commandId: 'cmd_1',
      durable: true,
      payloadCiphertext: 'ciphertext',
      payloadDigest: 'sha256:abcdef1234567890',
      keyId: 'key_1',
      createdAt: now,
      signature: 'sig_event',
    }, now }).outcome).toBe('idempotent');
  });

  it('preserves active accepted and duplicate ACK repeat behavior', () => {
    const acceptedState = baseState('accepted', ack());
    expect(advanceCommandLifecycle(acceptedState, { type: 'host-ack', ack: ack(), now }).outcome).toBe('idempotent');
    expect(advanceCommandLifecycle(acceptedState, { type: 'host-ack', ack: ack({ signature: 'sig_other' }), now }).state.status).toBe('conflict');

    const duplicateState = baseState('awaiting-state-event', duplicateAck());
    expect(advanceCommandLifecycle(duplicateState, { type: 'host-ack', ack: duplicateAck(), now }).outcome).toBe('idempotent');
    expect(advanceCommandLifecycle(duplicateState, { type: 'host-ack', ack: { ...duplicateAck(), duplicateOf: 'cmd_other' }, now }).state.status).toBe('conflict');
  });

  it('keeps late host-busy ACK invalid after local terminal state without stored evidence', () => {
    const repeated = advanceCommandLifecycle(baseState('cancelled'), { type: 'host-ack', ack: hostBusyAck(), now });
    expect(repeated.outcome).toBe('invalid');
    expect(repeated.state.status).toBe('cancelled');
  });
});
