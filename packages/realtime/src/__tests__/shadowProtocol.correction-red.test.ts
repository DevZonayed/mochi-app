import { describe, expect, it } from 'vitest';
import {
  decodeShadowMessage,
  advanceCommandLifecycle,
  SHADOW_PROTOCOL_VERSION,
  type CommandLifecycleState,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = {
  accountId: 'acct_main',
  scopeId: 'scope_main',
  hostDeviceId: 'host_mac_1',
  epoch: 7,
  leaseId: 'lease_active',
};

describe('shadow protocol correction red coverage', () => {
  it('decodes required non-state wire families with retained family discriminants', () => {
    const decoded = decodeShadowMessage({
      family: 'event-ack',
      v: SHADOW_PROTOCOL_VERSION,
      eventId: 'event_1',
      controllerDeviceId: 'ctrl_phone_1',
      fence,
      lastSeq: 1,
      ackedAt: now,
      signature: 'sig_event_ack',
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.family).toBe('event-ack');
  });

  it('requires signed command ACKs and does not skip accepted/executing', () => {
    expect(decodeShadowMessage({
      family: 'command-ack',
      v: SHADOW_PROTOCOL_VERSION,
      commandId: 'cmd_1',
      status: 'accepted',
      fence,
      signedAt: now,
    }).ok).toBe(false);

    let state: CommandLifecycleState = {
      status: 'pending-local',
      commandId: 'cmd_1',
      fence,
      createdAt: now,
      expiresAt: now + 60_000,
    };
    state = advanceCommandLifecycle(state, { type: 'sent', now }).state;
    state = advanceCommandLifecycle(state, {
      type: 'host-ack',
      now,
      ack: {
        v: SHADOW_PROTOCOL_VERSION,
        commandId: 'cmd_1',
        status: 'accepted',
        fence,
        acceptedSeq: 2,
        resultSeq: 4,
        signedAt: now,
        signature: 'sig_ack',
      },
    }).state;
    expect(state.status).toBe('accepted');
    state = advanceCommandLifecycle(state, { type: 'execute', now }).state;
    expect(state.status).toBe('executing');
    state = advanceCommandLifecycle(state, { type: 'await-state-event', now }).state;
    expect(state.status).toBe('awaiting-state-event');
  });
});
