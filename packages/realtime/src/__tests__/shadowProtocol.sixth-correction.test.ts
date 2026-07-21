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

const duplicateAck = (): HostCommandAck => ack({
  status: 'duplicate',
  acceptedSeq: undefined,
  duplicateOf: 'cmd_original',
});

const terminalAck = (status: Extract<HostCommandAck['status'], 'rejected' | 'expired' | 'stale-epoch' | 'unauthorized'>): HostCommandAck => ack({
  status,
  acceptedSeq: undefined,
  resultSeq: undefined,
  error: { code: status.toUpperCase(), message: `${status} from host` },
});

const stateWithAck = (status: CommandLifecycleStatus, storedAck: HostCommandAck): CommandLifecycleState => ({
  status,
  commandId: 'cmd_1',
  fence,
  createdAt: now,
  expiresAt: now + 60_000,
  ack: storedAck,
  resultSeq: storedAck.resultSeq,
  rejectReason: storedAck.error?.message,
});

const withoutFamily = (storedAck: HostCommandAck): HostCommandAck => {
  const { family: _family, ...rest } = storedAck;
  return rest as HostCommandAck;
};

const withoutVersion = (storedAck: HostCommandAck): HostCommandAck => {
  const { v: _v, ...rest } = storedAck;
  return rest as HostCommandAck;
};

const ackIdentityMutations: Array<[string, (storedAck: HostCommandAck) => HostCommandAck]> = [
  ['changed family', (storedAck) => ({ ...storedAck, family: 'state-event' } as unknown as HostCommandAck)],
  ['missing family', withoutFamily],
  ['changed version', (storedAck) => ({ ...storedAck, v: SHADOW_PROTOCOL_VERSION + 1 } as unknown as HostCommandAck)],
  ['missing version', withoutVersion],
];

const terminalStates: Array<[CommandLifecycleStatus, HostCommandAck]> = [
  ['applied', ack()],
  ['rejected', terminalAck('rejected')],
  ['expired', terminalAck('expired')],
  ['stale-epoch', terminalAck('stale-epoch')],
  ['unauthorized', terminalAck('unauthorized')],
  ['revoked', ack({ status: 'rejected', acceptedSeq: undefined, resultSeq: undefined, error: { code: 'REVOKED', message: 'controller revoked' } })],
  ['conflict', ack()],
];

const activeStates: Array<[CommandLifecycleStatus, HostCommandAck]> = [
  ['accepted', ack()],
  ['executing', ack()],
  ['awaiting-state-event', ack()],
  ['awaiting-state-event', duplicateAck()],
];

describe('sixth correction direct lifecycle ACK family/version mutation coverage', () => {
  it.each(terminalStates)('keeps exact ACK repeat for terminal %s idempotent as the control path', (status, storedAck) => {
    const state = stateWithAck(status, storedAck);
    const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: storedAck, now });

    expect(repeated.outcome).toBe('idempotent');
    expect(repeated.state).toBe(state);
  });

  it.each(terminalStates.flatMap(([status, storedAck]) => ackIdentityMutations.map(([field, mutate]) => [status, storedAck, field, mutate] as const)))(
    'does not treat terminal %s ACK with %s as idempotent',
    (status, storedAck, _field, mutate) => {
      const state = stateWithAck(status, storedAck);
      const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: mutate(storedAck), now });

      expect(repeated.outcome).toBe('advanced');
      expect(repeated.state.status).toBe('conflict');
      expect(repeated.state.ack).toBe(storedAck);
      expect(repeated.state.rejectReason).toBe('conflicting-terminal-ack');
    },
  );

  it.each(activeStates.flatMap(([status, storedAck]) => ackIdentityMutations.map(([field, mutate]) => [status, storedAck, field, mutate] as const)))(
    'does not treat active %s ACK with %s as idempotent',
    (status, storedAck, _field, mutate) => {
      const state = stateWithAck(status, storedAck);
      const repeated = advanceCommandLifecycle(state, { type: 'host-ack', ack: mutate(storedAck), now });

      expect(repeated.outcome).toBe('advanced');
      expect(repeated.state.status).toBe('conflict');
      expect(repeated.state.ack).toBe(storedAck);
      expect(repeated.state.rejectReason).toBe('conflicting-ack');
    },
  );
});
