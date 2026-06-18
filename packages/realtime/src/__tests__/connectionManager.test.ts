import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '../connectionManager';
import { makeEnvelope } from '../envelope';
import type { Transport, ConnState } from '../transport';
import type { Envelope } from '../envelope';

class FakeTransport implements Transport {
  ready = false;
  closed = false;
  sent: Envelope[] = [];
  private msgCb: (e: Envelope) => void = () => {};
  private stateCb: (s: ConnState) => void = () => {};
  send(e: Envelope) {
    this.sent.push(e);
  }
  isReady() {
    return this.ready;
  }
  onMessage(cb: (e: Envelope) => void) {
    this.msgCb = cb;
  }
  onStateChange(cb: (s: ConnState) => void) {
    this.stateCb = cb;
  }
  close() {
    this.closed = true;
  }
  // test helpers
  emit(e: Envelope) {
    this.msgCb(e);
  }
  setState(s: ConnState) {
    this.ready = s === 'connected';
    this.stateCb(s);
  }
}

describe('ConnectionManager', () => {
  it('adopts P2P when it connects before the timeout', async () => {
    const p2p = new FakeTransport();
    const relay = new FakeTransport();
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => relay, p2pTimeoutMs: 8000 });
    const p = m.connect();
    p2p.setState('connected');
    expect(await p).toBe('p2p');
    expect(m.kind).toBe('p2p');
    expect(relay.closed).toBe(false);
  });

  it('falls back to relay when P2P never connects', async () => {
    vi.useFakeTimers();
    const p2p = new FakeTransport();
    const relay = new FakeTransport();
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => relay, p2pTimeoutMs: 8000 });
    const p = m.connect();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await p).toBe('relay');
    expect(p2p.closed).toBe(true);
    expect(m.kind).toBe('relay');
    vi.useRealTimers();
  });

  it('adopts P2P immediately if already ready', async () => {
    const p2p = new FakeTransport();
    p2p.ready = true;
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => new FakeTransport() });
    expect(await m.connect()).toBe('p2p');
  });

  it('routes send() to and forwards messages from the active transport', async () => {
    const p2p = new FakeTransport();
    const got: Envelope[] = [];
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => new FakeTransport() });
    m.onMessage((e) => got.push(e));
    const p = m.connect();
    p2p.setState('connected');
    await p;
    m.send(makeEnvelope('cmd', { method: 'x' }));
    expect(p2p.sent).toHaveLength(1);
    p2p.emit(makeEnvelope('event', { name: 'job' }));
    expect(got).toHaveLength(1);
  });
});
