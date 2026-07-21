import { describe, expect, it } from 'vitest';
import {
  ScreenRelayHub,
  SCREEN_RELAY_HIGH_WATER_BYTES,
  SCREEN_RELAY_IDLE_MS,
  SCREEN_RELAY_MAX_SESSION_MS,
  SCREEN_RELAY_MAX_CONTROL_BYTES,
  type RelaySocket,
} from './screenRelay.js';

class FakeSocket implements RelaySocket {
  frames: Uint8Array[] = [];
  controls: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private buffered = 0;
  setBuffered(n: number) { this.buffered = n; }
  send(data: string | Uint8Array, binary: boolean): void {
    if (binary) this.frames.push(data as Uint8Array); else this.controls.push(data as string);
  }
  bufferedAmount(): number { return this.buffered; }
  close(code: number, reason: string): void { this.closed = { code, reason }; }
}

const KEY = 'acc_1:host_1';
function frame(n: number, size = 1024): Uint8Array { const b = new Uint8Array(size); b[0] = n & 0xff; return b; }

describe('ScreenRelayHub — routing', () => {
  it('routes host→controller frames to the sole viewer', () => {
    const hub = new ScreenRelayHub();
    const host = new FakeSocket(); const ctrl = new FakeSocket();
    hub.attachHost(KEY, 'host_1', host, 0);
    expect(hub.attachController(KEY, 'ctrl_1', ctrl, 0)).toEqual({ ok: true });
    expect(hub.routeFrame(KEY, frame(1), 1)).toBe('sent');
    expect(hub.routeFrame(KEY, frame(2), 2)).toBe('sent');
    expect(ctrl.frames).toHaveLength(2);
    expect(ctrl.frames[0]![0]).toBe(1);
    expect(hub.metrics().framesRouted).toBe(2);
  });

  it('rejects a frame with no controller attached (and never buffers durably)', () => {
    const hub = new ScreenRelayHub();
    hub.attachHost(KEY, 'host_1', new FakeSocket(), 0);
    expect(hub.routeFrame(KEY, frame(1), 1)).toBe('rejected');
  });

  it('rejects oversize / empty frames', () => {
    const hub = new ScreenRelayHub();
    hub.attachHost(KEY, 'host_1', new FakeSocket(), 0);
    hub.attachController(KEY, 'ctrl_1', new FakeSocket(), 0);
    expect(hub.routeFrame(KEY, new Uint8Array(0), 1)).toBe('rejected');
    expect(hub.routeFrame(KEY, new Uint8Array(2_000_000), 1)).toBe('rejected');
  });
});

describe('ScreenRelayHub — latest-frame backpressure (queue <= 1)', () => {
  it('drops stale frames while backpressured, keeping only the latest, then flushes it', () => {
    const hub = new ScreenRelayHub();
    const host = new FakeSocket(); const ctrl = new FakeSocket();
    hub.attachHost(KEY, 'host_1', host, 0);
    hub.attachController(KEY, 'ctrl_1', ctrl, 0);
    // saturate the socket
    ctrl.setBuffered(SCREEN_RELAY_HIGH_WATER_BYTES + 1);
    expect(hub.routeFrame(KEY, frame(1), 1)).toBe('dropped'); // held in slot
    expect(hub.routeFrame(KEY, frame(2), 2)).toBe('dropped'); // replaces slot, older dropped
    expect(hub.routeFrame(KEY, frame(3), 3)).toBe('dropped'); // replaces slot again
    expect(ctrl.frames).toHaveLength(0);
    expect(hub.metrics().framesDropped).toBe(2); // frames 1 and 2 dropped; 3 held
    // socket drains → next frame flushes the pending latest (3) then sends the new one
    ctrl.setBuffered(0);
    expect(hub.routeFrame(KEY, frame(4), 4)).toBe('sent');
    // pending (3) flushed first, then 4 sent
    expect(ctrl.frames.map((f) => f[0])).toEqual([3, 4]);
    // the queue never grew beyond a single slot
    const stats = hub.controllerStats(KEY)!;
    expect(stats.dropped).toBe(2);
  });
});

describe('ScreenRelayHub — single viewer + control', () => {
  it('a second controller gets busy and never steals the pair', () => {
    const hub = new ScreenRelayHub();
    hub.attachHost(KEY, 'host_1', new FakeSocket(), 0);
    const first = new FakeSocket();
    expect(hub.attachController(KEY, 'ctrl_1', first, 0)).toEqual({ ok: true });
    const second = new FakeSocket();
    expect(hub.attachController(KEY, 'ctrl_2', second, 0)).toEqual({ ok: false, reason: 'busy' });
    expect(hub.activeControllerDeviceId(KEY)).toBe('ctrl_1');
    // first viewer still receives frames
    expect(hub.routeFrame(KEY, frame(1), 1)).toBe('sent');
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(0);
  });

  it('same-device reconnect replaces its own slot (closes the old socket)', () => {
    const hub = new ScreenRelayHub();
    hub.attachHost(KEY, 'host_1', new FakeSocket(), 0);
    const s1 = new FakeSocket(); const s2 = new FakeSocket();
    hub.attachController(KEY, 'ctrl_1', s1, 0);
    expect(hub.attachController(KEY, 'ctrl_1', s2, 1)).toEqual({ ok: true });
    expect(s1.closed).toMatchObject({ code: 1000 });
    hub.routeFrame(KEY, frame(1), 2);
    expect(s2.frames).toHaveLength(1);
  });

  it('forwards control both directions, rejects oversize control', () => {
    const hub = new ScreenRelayHub();
    const host = new FakeSocket(); const ctrl = new FakeSocket();
    hub.attachHost(KEY, 'host_1', host, 0);
    hub.attachController(KEY, 'ctrl_1', ctrl, 0);
    expect(hub.routeControl(KEY, 'host', '{"kind":"screen-status"}', 1)).toBe(true);
    expect(ctrl.controls).toHaveLength(1);
    expect(hub.routeControl(KEY, 'controller', '{"kind":"screen-start"}', 2)).toBe(true);
    expect(host.controls).toHaveLength(1);
    expect(hub.routeControl(KEY, 'host', 'x'.repeat(SCREEN_RELAY_MAX_CONTROL_BYTES + 1), 3)).toBe(false);
  });
});

describe('ScreenRelayHub — teardown + expiry', () => {
  it('detaching the host zeroes any held frame and gcs when both gone', () => {
    const hub = new ScreenRelayHub();
    const host = new FakeSocket(); const ctrl = new FakeSocket();
    hub.attachHost(KEY, 'host_1', host, 0);
    hub.attachController(KEY, 'ctrl_1', ctrl, 0);
    ctrl.setBuffered(SCREEN_RELAY_HIGH_WATER_BYTES + 1);
    hub.routeFrame(KEY, frame(1), 1); // held
    hub.detachHost(KEY, host);
    expect(hub.hasHost(KEY)).toBe(false);
    hub.detachController(KEY, 'ctrl_1');
    expect(hub.metrics().pairs).toBe(0);
  });

  it('sweep tears down idle and over-age pairs', () => {
    const hub = new ScreenRelayHub();
    const host = new FakeSocket(); const ctrl = new FakeSocket();
    hub.attachHost(KEY, 'host_1', host, 0);
    hub.attachController(KEY, 'ctrl_1', ctrl, 0);
    hub.routeFrame(KEY, frame(1), 100);
    const dead = hub.sweep(100 + SCREEN_RELAY_IDLE_MS + 1);
    expect(dead).toEqual([KEY]);
    expect(host.closed).toMatchObject({ code: 1000, reason: 'expired' });
    expect(ctrl.closed).toMatchObject({ code: 1000, reason: 'expired' });
    expect(hub.metrics().pairs).toBe(0);
  });

  it('sweep tears down a pair that exceeds the absolute session cap', () => {
    const hub = new ScreenRelayHub();
    const host = new FakeSocket(); const ctrl = new FakeSocket();
    hub.attachHost(KEY, 'host_1', host, 0);
    hub.attachController(KEY, 'ctrl_1', ctrl, 0);
    hub.routeFrame(KEY, frame(1), SCREEN_RELAY_MAX_SESSION_MS); // keep active so idle doesn't trip first
    const dead = hub.sweep(SCREEN_RELAY_MAX_SESSION_MS + 1);
    expect(dead).toEqual([KEY]);
  });
});
