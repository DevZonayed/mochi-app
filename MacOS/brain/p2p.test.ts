import { describe, it, expect } from 'vitest';
import { DesktopP2PHost } from './p2p.js';
import type { ToRendererMsg } from './p2p.js';
import { makeEnvelope } from '@maestro/realtime';

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeHost() {
  const toRenderer: ToRendererMsg[] = [];
  const relayed: { did: string; signal: unknown }[] = [];
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  let cmdImpl: (m: string, p: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true });
  const host = new DesktopP2PHost({
    heartbeatMs: 0, // no lingering interval in tests
    toRenderer: (m) => toRenderer.push(m),
    signalViaRelay: (did, signal) => relayed.push({ did, signal }),
    handleCommand: (method, params) => {
      commands.push({ method, params });
      return cmdImpl(method, params);
    },
  });
  return { host, toRenderer, relayed, commands, setCmd: (f: typeof cmdImpl) => { cmdImpl = f; } };
}

const msgOut = (msgs: ToRendererMsg[], kind: string) =>
  msgs.filter((m): m is Extract<ToRendererMsg, { kind: 'msg-out' }> => m.kind === 'msg-out' && m.env.kind === kind);

describe('DesktopP2PHost', () => {
  it('ignores signaling while disabled', () => {
    const h = makeHost();
    h.host.onSignal('dev-a', { kind: 'offer' });
    expect(h.toRenderer).toHaveLength(0);
  });

  it('forwards inbound signaling to the renderer when enabled', () => {
    const h = makeHost();
    h.host.setEnabled(true);
    h.host.onSignal('dev-a', { kind: 'offer', sdp: 's' });
    expect(h.toRenderer).toContainEqual({ kind: 'signal-in', did: 'dev-a', signal: { kind: 'offer', sdp: 's' } });
  });

  it('relays the renderer peer outbound signaling', () => {
    const h = makeHost();
    h.host.setEnabled(true);
    h.host.onSignal('dev-a', { kind: 'offer' });
    h.host.fromRendererSignal('dev-a', { kind: 'answer', sdp: 'x' });
    expect(h.relayed).toContainEqual({ did: 'dev-a', signal: { kind: 'answer', sdp: 'x' } });
  });

  it('runs an inbound command and returns an ok result envelope', async () => {
    const h = makeHost();
    h.host.setEnabled(true);
    h.setCmd(async (m) => ({ echoed: m }));
    h.host.onSignal('dev-a', { kind: 'offer' });
    h.host.fromRendererState('dev-a', 'connected');
    h.host.fromRendererMessage('dev-a', makeEnvelope('cmd', { reqId: 'r1', method: 'sendChat', params: { text: 'hi' } }));
    await tick();
    expect(h.commands).toContainEqual({ method: 'sendChat', params: { text: 'hi' } });
    const result = msgOut(h.toRenderer, 'result')[0];
    expect(result.did).toBe('dev-a');
    expect(result.env.payload).toMatchObject({ reqId: 'r1', ok: true, result: { echoed: 'sendChat' } });
  });

  it('returns an error result when the command throws (status preserved)', async () => {
    const h = makeHost();
    h.host.setEnabled(true);
    h.setCmd(async () => {
      throw Object.assign(new Error('not available remotely'), { statusCode: 403 });
    });
    h.host.onSignal('dev-a', { kind: 'offer' });
    h.host.fromRendererState('dev-a', 'connected');
    h.host.fromRendererMessage('dev-a', makeEnvelope('cmd', { reqId: 'r2', method: 'getPairing' }));
    await tick();
    const result = msgOut(h.toRenderer, 'result')[0];
    expect(result.env.payload).toMatchObject({ reqId: 'r2', ok: false, error: 'not available remotely', statusCode: 403 });
  });

  it('broadcasts events only to peers whose channel is open', () => {
    const h = makeHost();
    h.host.setEnabled(true);
    h.host.onSignal('dev-a', { kind: 'offer' });
    h.host.onSignal('dev-b', { kind: 'offer' });
    h.host.fromRendererState('dev-b', 'connected'); // only b is ready
    h.toRenderer.length = 0;
    h.host.broadcastEvent('job', { id: 'j1' });
    const events = msgOut(h.toRenderer, 'event');
    expect(events).toHaveLength(1);
    expect(events[0].did).toBe('dev-b');
    expect(events[0].env.payload).toEqual({ name: 'job', data: { id: 'j1' } });
  });

  it('disabling tears down peers and stops broadcasting', () => {
    const h = makeHost();
    h.host.setEnabled(true);
    h.host.onSignal('dev-a', { kind: 'offer' });
    h.host.fromRendererState('dev-a', 'connected');
    h.toRenderer.length = 0;
    h.host.setEnabled(false);
    expect(h.toRenderer).toContainEqual({ kind: 'close', did: 'dev-a' });
    h.toRenderer.length = 0;
    h.host.broadcastEvent('job', {});
    expect(h.toRenderer).toHaveLength(0);
  });
});
