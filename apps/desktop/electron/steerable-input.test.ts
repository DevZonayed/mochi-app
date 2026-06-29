import { describe, it, expect } from 'vitest';
import { createSteerableInput } from './steerable-input.js';

/** Iterate a generator to completion (with a safety cap so a hang fails loudly). */
async function drain<T>(gen: AsyncGenerator<T>, max = 100): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) { out.push(v); if (out.length >= max) break; }
  return out;
}

const tick = () => new Promise(r => setTimeout(r, 10));

describe('createSteerableInput', () => {
  it('yields first, then ends when closed with nothing pending', async () => {
    const ch = createSteerableInput('hello');
    ch.close();
    expect(await drain(ch.stream)).toEqual(['hello']);
  });

  it('yields first then pushed messages in order, then ends on close', async () => {
    const ch = createSteerableInput('a');
    ch.push('b');
    ch.push('c');
    ch.close();
    expect(await drain(ch.stream)).toEqual(['a', 'b', 'c']);
  });

  it('delivers a push that arrives while the consumer is blocked (the steer case)', async () => {
    const ch = createSteerableInput('first');
    const got: string[] = [];
    const consumer = (async () => {
      for await (const v of ch.stream) { got.push(v); if (v === 'steer') ch.close(); }
    })();
    // Let the consumer pull 'first' and park awaiting more input.
    await tick();
    expect(got).toEqual(['first']);
    expect(ch.push('steer')).toBe(true); // mid-turn steer
    await consumer;
    expect(got).toEqual(['first', 'steer']);
  });

  it('close() while the consumer is blocked ends the stream cleanly', async () => {
    const ch = createSteerableInput('only');
    const got: string[] = [];
    const consumer = (async () => { for await (const v of ch.stream) got.push(v); })();
    await tick();
    expect(got).toEqual(['only']);
    ch.close();
    await consumer; // must resolve, not hang
    expect(got).toEqual(['only']);
  });

  it('push after close returns false and is not yielded', async () => {
    const ch = createSteerableInput('x');
    ch.close();
    expect(ch.push('late')).toBe(false);
    expect(await drain(ch.stream)).toEqual(['x']);
  });

  it('pending() tracks queued-but-unyielded count', () => {
    const ch = createSteerableInput('x');
    expect(ch.pending()).toBe(0);
    ch.push('a');
    ch.push('b');
    expect(ch.pending()).toBe(2);
  });

  it('closed reflects close()', () => {
    const ch = createSteerableInput('x');
    expect(ch.closed).toBe(false);
    ch.close();
    expect(ch.closed).toBe(true);
  });

  it('drains queued messages before ending even if close() races a push', async () => {
    const ch = createSteerableInput('a');
    ch.push('b'); // still queued
    ch.close();   // close with 'b' pending → 'b' must still be delivered
    expect(await drain(ch.stream)).toEqual(['a', 'b']);
  });

  it('delivers several steers queued back-to-back, in order', async () => {
    const ch = createSteerableInput('m0');
    const got: string[] = [];
    const consumer = (async () => {
      for await (const v of ch.stream) { got.push(v); if (got.length === 4) ch.close(); }
    })();
    await tick();
    ch.push('m1');
    ch.push('m2');
    ch.push('m3');
    await consumer;
    expect(got).toEqual(['m0', 'm1', 'm2', 'm3']);
  });
});
