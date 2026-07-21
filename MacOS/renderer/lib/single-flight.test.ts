import { describe, it, expect, vi } from 'vitest';
import { createSingleFlight } from './single-flight';

/** A promise whose settlement we control, so concurrency is deterministic. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createSingleFlight — coalesces concurrent identical work', () => {
  it('shares ONE in-flight promise for the same key; every caller gets it and settles', async () => {
    const sf = createSingleFlight<string>();
    const gate = deferred<void>();
    const fn = vi.fn(async () => { await gate.promise; return 'RESULT'; });

    const a = sf.run('s1::concise', fn);
    const b = sf.run('s1::concise', fn);

    expect(fn).toHaveBeenCalledTimes(1); // second caller reused the in-flight promise
    expect(a).toBe(b);                   // literally the same promise object

    gate.resolve();
    expect(await a).toBe('RESULT');
    expect(await b).toBe('RESULT');      // both callers settle from the single run
  });

  it('runs distinct keys (session/mode) independently and concurrently', async () => {
    const sf = createSingleFlight<string>();
    const g1 = deferred<void>();
    const g2 = deferred<void>();
    const fn = vi.fn(async (which: string) => { await (which === 'a' ? g1 : g2).promise; return which; });

    const a = sf.run('s1::concise', () => fn('a'));
    const b = sf.run('s1::full', () => fn('b'));

    expect(fn).toHaveBeenCalledTimes(2); // different keys => both run
    expect(a).not.toBe(b);
    g1.resolve(); g2.resolve();
    expect(await a).toBe('a');
    expect(await b).toBe('b');
  });

  it('clears the slot after settle so a later identical call re-runs', async () => {
    const sf = createSingleFlight<number>();
    let n = 0;
    const run = () => sf.run('k', async () => ++n);
    expect(await run()).toBe(1);
    expect(await run()).toBe(2); // fresh run, not the cached first result
    expect(sf.size).toBe(0);
  });

  it('clears the slot even when the shared work REJECTS, and propagates to all callers', async () => {
    const sf = createSingleFlight<string>();
    const gate = deferred<void>();
    const fn = vi.fn(async () => { await gate.promise; throw new Error('boom'); });

    const a = sf.run('k', fn);
    const b = sf.run('k', fn);
    expect(a).toBe(b);

    gate.resolve();
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(sf.size).toBe(0);

    // slot cleared => a subsequent call re-invokes rather than replaying the rejection
    const c = sf.run('k', async () => 'recovered');
    expect(await c).toBe('recovered');
  });

  it('invokes fn EAGERLY once so a same-tick duplicate coalesces onto it', async () => {
    const sf = createSingleFlight<string>();
    const fn = vi.fn(async () => 'x');
    const p = sf.run('k', fn);
    expect(fn).toHaveBeenCalledTimes(1); // started synchronously, in-flight now
    const dup = sf.run('k', fn);         // same tick, same key
    expect(dup).toBe(p);
    expect(fn).toHaveBeenCalledTimes(1); // duplicate did NOT re-invoke
    await p;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('turns a SYNCHRONOUS throw inside fn into a rejection and clears the slot', async () => {
    const sf = createSingleFlight<string>();
    const p = sf.run('k', () => { throw new Error('sync-throw'); });
    await expect(p).rejects.toThrow('sync-throw');
    expect(sf.size).toBe(0);
  });
});
