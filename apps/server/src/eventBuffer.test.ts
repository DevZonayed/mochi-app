/* EventBuffer — ring buffer with monotonic seq + bounded memory + buffer-
   overflow signaling. Verifies the contract the server's replay code depends
   on: ordering, overflow detection, wraparound correctness, and reset. */

import { describe, it, expect } from 'vitest';
import { EventBuffer } from './eventBuffer.js';

describe('EventBuffer', () => {
  it('starts empty with latestSeq=0 and oldestSeq=0', () => {
    const b = new EventBuffer(10);
    expect(b.latestSeq).toBe(0);
    expect(b.oldestSeq).toBe(0);
    expect(b.size).toBe(0);
  });

  it('push() returns a monotonically increasing seq starting at 1', () => {
    const b = new EventBuffer(10);
    expect(b.push('job', { id: 'a' })).toBe(1);
    expect(b.push('session', { id: 'b' })).toBe(2);
    expect(b.push('job', { id: 'c' })).toBe(3);
    expect(b.latestSeq).toBe(3);
    expect(b.size).toBe(3);
  });

  it('since(0) replays everything in original order', () => {
    const b = new EventBuffer(10);
    b.push('job', { i: 1 }); b.push('job', { i: 2 }); b.push('job', { i: 3 });
    const r = b.since(0);
    expect(r.bufferOverflow).toBe(false);
    expect(r.events.map((e) => (e.data as { i: number }).i)).toEqual([1, 2, 3]);
    expect(r.latestSeq).toBe(3);
  });

  it('since(N) only returns events with seq > N', () => {
    const b = new EventBuffer(10);
    b.push('job', { i: 1 }); b.push('job', { i: 2 }); b.push('job', { i: 3 });
    const r = b.since(1);
    expect(r.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('since(latestSeq) returns empty events but reports latestSeq', () => {
    const b = new EventBuffer(10);
    b.push('job', null); b.push('session', null);
    const r = b.since(2);
    expect(r.events).toEqual([]);
    expect(r.latestSeq).toBe(2);
    expect(r.bufferOverflow).toBe(false);
  });

  it('since() on an empty buffer is a no-op (no overflow)', () => {
    const b = new EventBuffer(10);
    const r = b.since(0);
    expect(r.events).toEqual([]);
    expect(r.latestSeq).toBe(0);
    expect(r.bufferOverflow).toBe(false);
  });

  describe('ring buffer wraparound', () => {
    it('keeps only the last `capacity` events when overflowing', () => {
      const b = new EventBuffer(3);
      b.push('job', { i: 1 });
      b.push('job', { i: 2 });
      b.push('job', { i: 3 });
      b.push('job', { i: 4 }); // evicts seq=1
      b.push('job', { i: 5 }); // evicts seq=2
      expect(b.size).toBe(3);
      expect(b.latestSeq).toBe(5);
      expect(b.oldestSeq).toBe(3);
    });

    it('since() on a wrapped buffer returns events in the correct order', () => {
      const b = new EventBuffer(3);
      for (let i = 1; i <= 5; i++) b.push('job', { i });
      // Buffer now holds seq=3,4,5. since(2) should return [3,4,5].
      const r = b.since(2);
      expect(r.events.map((e) => e.seq)).toEqual([3, 4, 5]);
      expect(r.events.map((e) => (e.data as { i: number }).i)).toEqual([3, 4, 5]);
    });

    it('since() signals bufferOverflow when the client missed too much', () => {
      const b = new EventBuffer(3);
      for (let i = 1; i <= 5; i++) b.push('job', { i });
      // Client last saw seq=1, but oldest we still have is seq=3.
      // Anything < oldestSeq - 1 (= 2) means the gap [2, oldestSeq-1] is lost,
      // so we MUST signal overflow — sending a partial replay would leave the
      // client with a hole it doesn't know about.
      const r = b.since(1);
      expect(r.bufferOverflow).toBe(true);
      expect(r.events).toEqual([]);
      expect(r.latestSeq).toBe(5);
    });

    it('since(oldestSeq - 1) is at the EDGE — no overflow, full replay', () => {
      // The boundary: client last saw the event just before the buffer's
      // oldest — they get the entire current buffer with no gap.
      const b = new EventBuffer(3);
      for (let i = 1; i <= 5; i++) b.push('job', { i });
      // oldestSeq = 3, so since(2) should hand back [3,4,5] without overflow.
      const r = b.since(2);
      expect(r.bufferOverflow).toBe(false);
      expect(r.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    });
  });

  it('reset() drops everything (new pairing epoch — old seqs are meaningless)', () => {
    const b = new EventBuffer(10);
    b.push('job', null); b.push('session', null); b.push('job', null);
    b.reset();
    expect(b.latestSeq).toBe(0);
    expect(b.size).toBe(0);
    // New events restart from seq=1.
    expect(b.push('job', null)).toBe(1);
  });

  it('refuses a non-positive capacity (catches a config typo early)', () => {
    expect(() => new EventBuffer(0)).toThrow();
    expect(() => new EventBuffer(-1)).toThrow();
  });

  it('store timestamps on events (for future TTL or telemetry)', () => {
    const b = new EventBuffer(3);
    const before = Date.now();
    b.push('job', null);
    const after = Date.now();
    const r = b.since(0);
    expect(r.events[0].ts).toBeGreaterThanOrEqual(before);
    expect(r.events[0].ts).toBeLessThanOrEqual(after);
  });
});
