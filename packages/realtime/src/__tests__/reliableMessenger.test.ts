import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReliableMessenger } from '../reliableMessenger';
import { makeEnvelope } from '../envelope';
import type { Envelope } from '../envelope';
import type { ConnState } from '../transport';

class FakeConn {
  sent: Envelope[] = [];
  private msgCb: (e: Envelope) => void = () => {};
  private stateCb: (s: ConnState) => void = () => {};
  send(e: Envelope) {
    this.sent.push(e);
  }
  onMessage(cb: (e: Envelope) => void) {
    this.msgCb = cb;
  }
  onStateChange(cb: (s: ConnState) => void) {
    this.stateCb = cb;
  }
  // test helpers
  recv(e: Envelope) {
    this.msgCb(e);
  }
  state(s: ConnState) {
    this.stateCb(s);
  }
}

describe('ReliableMessenger', () => {
  let conn: FakeConn;
  beforeEach(() => {
    conn = new FakeConn();
  });

  it('queues a reliable message and sends it when connected', () => {
    const m = new ReliableMessenger(conn, { heartbeatMs: 0 });
    conn.state('connected');
    m.send(makeEnvelope('cmd', { method: 'x' }));
    expect(conn.sent.filter((e) => e.kind === 'cmd')).toHaveLength(1);
    m.dispose();
  });

  it('flushes the outbox on reconnect until acked', () => {
    const m = new ReliableMessenger(conn, { heartbeatMs: 0 });
    const env = makeEnvelope('cmd', { method: 'x' });
    m.send(env); // not connected yet
    conn.state('connected');
    conn.sent.length = 0;
    conn.state('disconnected');
    conn.state('connected');
    expect(conn.sent.some((e) => e.id === env.id)).toBe(true); // resent
    conn.recv(makeEnvelope('ack', undefined, env.id)); // ack clears it
    conn.sent.length = 0;
    conn.state('connected');
    expect(conn.sent.some((e) => e.id === env.id)).toBe(false); // no longer queued
    m.dispose();
  });

  it('acks + delivers an inbound message once, dedupes a repeat', () => {
    const delivered: Envelope[] = [];
    const m = new ReliableMessenger(conn, { heartbeatMs: 0, onDeliver: (e) => delivered.push(e) });
    conn.state('connected');
    const inbound = makeEnvelope('event', { name: 'job' });
    conn.recv(inbound);
    conn.recv(inbound); // duplicate
    expect(delivered).toHaveLength(1);
    expect(conn.sent.filter((e) => e.kind === 'ack' && e.id === inbound.id)).toHaveLength(2);
    m.dispose();
  });

  it('replies to ping with pong', () => {
    const m = new ReliableMessenger(conn, { heartbeatMs: 0 });
    conn.state('connected');
    conn.recv(makeEnvelope('ping', undefined, 'p1'));
    expect(conn.sent.find((e) => e.kind === 'pong')?.id).toBe('p1');
    m.dispose();
  });

  it('emits heartbeat pings while connected', () => {
    vi.useFakeTimers();
    const m = new ReliableMessenger(conn, { heartbeatMs: 1000 });
    conn.state('connected');
    vi.advanceTimersByTime(2500);
    expect(conn.sent.filter((e) => e.kind === 'ping').length).toBeGreaterThanOrEqual(2);
    m.dispose();
    vi.useRealTimers();
  });
});
