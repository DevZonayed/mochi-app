import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import { DeviceRegistry, LEGACY_DEVICE_ID } from './devices.js';

/** A fake SSE response — we only rely on object identity + `.end()`. */
function fakeRes(): ServerResponse & { ended: boolean } {
  return { ended: false, end() { (this as { ended: boolean }).ended = true; } } as unknown as ServerResponse & { ended: boolean };
}

/** Controllable clock. */
function clock(start = 1000) {
  const c = { t: start };
  return { now: () => c.t, advance: (ms: number) => { c.t += ms; } };
}

describe('DeviceRegistry', () => {
  it('touch() creates a device that lists as not-live with its name + lastSeen', () => {
    const ck = clock();
    const r = new DeviceRegistry({ now: ck.now });
    r.touch('dev-a', 'Chrome · macOS');
    const list = r.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'dev-a', name: 'Chrome · macOS', live: false, lastSeen: 1000 });
  });

  it('addStream() makes a device live; removeStream() drops live but keeps the device', () => {
    const ck = clock();
    const r = new DeviceRegistry({ now: ck.now });
    const res = fakeRes();
    r.addStream('dev-a', 'iPhone', res);
    expect(r.list()[0]).toMatchObject({ id: 'dev-a', name: 'iPhone', live: true });
    expect(r.streamCount).toBe(1);
    r.removeStream('dev-a', res);
    expect(r.list()[0]).toMatchObject({ id: 'dev-a', live: false });
    expect(r.streamCount).toBe(0);
  });

  it('tracks two distinct devices independently', () => {
    const r = new DeviceRegistry();
    r.touch('a', 'A');
    r.touch('b', 'B');
    expect(r.list().map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('kick() returns the open streams, revokes the id, and removes the device', () => {
    const r = new DeviceRegistry();
    const s1 = fakeRes();
    const s2 = fakeRes();
    r.addStream('victim', 'Phone', s1);
    r.addStream('victim', 'Phone', s2);
    r.touch('bystander', 'Other');

    const closed = r.kick('victim');
    expect(closed).toHaveLength(2);
    expect(closed).toContain(s1);
    expect(closed).toContain(s2);
    // Caller ends them:
    closed.forEach((s) => s.end());
    expect((s1 as unknown as { ended: boolean }).ended).toBe(true);

    expect(r.isRevoked('victim')).toBe(true);
    expect(r.list().map((d) => d.id)).toEqual(['bystander']); // bystander untouched
  });

  it('a revoked device cannot re-register via touch() or addStream()', () => {
    const r = new DeviceRegistry();
    r.touch('gone', 'Phone');
    r.kick('gone');
    r.touch('gone', 'Phone'); // ignored
    r.addStream('gone', 'Phone', fakeRes()); // ignored
    expect(r.list()).toHaveLength(0);
    expect(r.isRevoked('gone')).toBe(true);
  });

  it('re-pairing with a FRESH id works after the old id was kicked', () => {
    const r = new DeviceRegistry();
    r.touch('old-id', 'Phone');
    r.kick('old-id');
    expect(r.isRevoked('old-id')).toBe(true);
    // Client mints a new id on re-pair:
    r.touch('new-id', 'Phone');
    expect(r.isRevoked('new-id')).toBe(false);
    expect(r.list().map((d) => d.id)).toEqual(['new-id']);
  });

  it('reset() clears devices and revocations (new pairing epoch)', () => {
    const r = new DeviceRegistry();
    r.touch('a', 'A');
    r.kick('a');
    r.touch('b', 'B');
    r.reset();
    expect(r.list()).toHaveLength(0);
    expect(r.isRevoked('a')).toBe(false);
  });

  it('prune (via list) drops a stale streamless device but keeps a live or recent one', () => {
    const ck = clock();
    const r = new DeviceRegistry({ ttlMs: 1000, now: ck.now });
    r.touch('stale', 'A');
    r.addStream('live', 'B', fakeRes());
    ck.advance(2000); // both now "old"
    r.touch('recent', 'C'); // refreshed at the new time
    const ids = r.list().map((d) => d.id).sort();
    expect(ids).toEqual(['live', 'recent']); // 'stale' pruned; 'live' kept (open stream); 'recent' kept (fresh)
  });

  it('lists most-recently-seen first', () => {
    const ck = clock();
    const r = new DeviceRegistry({ now: ck.now });
    r.touch('first', 'A');
    ck.advance(10);
    r.touch('second', 'B');
    expect(r.list().map((d) => d.id)).toEqual(['second', 'first']);
  });

  it('buckets missing/empty ids under the legacy id', () => {
    const r = new DeviceRegistry();
    r.touch(null, 'Old web');
    r.touch('', 'Also old');
    const list = r.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(LEGACY_DEVICE_ID);
  });

  it('touch updates name only when a new name is provided', () => {
    const r = new DeviceRegistry();
    r.touch('a', 'Original');
    r.touch('a'); // no name
    expect(r.list()[0].name).toBe('Original');
    r.touch('a', 'Renamed');
    expect(r.list()[0].name).toBe('Renamed');
  });
});
