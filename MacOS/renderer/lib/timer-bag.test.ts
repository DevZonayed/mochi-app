import { describe, it, expect, vi } from 'vitest';
import { createTimerBag, type TimerScheduler } from './timer-bag';

/** A deterministic scheduler: timers only fire when we explicitly `fire(id)`. */
function fakeScheduler() {
  const tasks = new Map<number, () => void>();
  let seq = 0;
  const scheduler: TimerScheduler = {
    setTimeout: (fn: () => void) => { const id = ++seq; tasks.set(id, fn); return id; },
    clearTimeout: (id: number) => { tasks.delete(id); },
  };
  return {
    scheduler,
    fire: (id: number) => { const t = tasks.get(id); if (t) { tasks.delete(id); t(); } },
    pending: () => tasks.size,
  };
}

describe('createTimerBag — unmount-safe timers', () => {
  it('runs a scheduled callback when fired before dispose, then drops it', () => {
    const { scheduler, fire } = fakeScheduler();
    const bag = createTimerBag(scheduler);
    const cb = vi.fn();
    const id = bag.set(cb, 100);
    expect(bag.active).toBe(1);
    fire(id);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(bag.active).toBe(0);
  });

  it('dispose() clears every pending timer and none of them ever fire', () => {
    const { scheduler, fire, pending } = fakeScheduler();
    const bag = createTimerBag(scheduler);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const id1 = bag.set(cb1, 100);
    const id2 = bag.set(cb2, 200);
    expect(bag.active).toBe(2);

    bag.dispose();
    expect(bag.disposed).toBe(true);
    expect(pending()).toBe(0);   // underlying scheduler was told to clear them

    fire(id1); fire(id2);        // no-ops — already cleared
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('after dispose, set() is a no-op that never schedules or runs (setState-after-unmount guard)', () => {
    const { scheduler, fire, pending } = fakeScheduler();
    const bag = createTimerBag(scheduler);
    bag.dispose();
    const cb = vi.fn();
    const id = bag.set(cb, 10);
    expect(pending()).toBe(0);   // nothing was scheduled
    fire(id);
    expect(cb).not.toHaveBeenCalled();
    expect(bag.active).toBe(0);
  });

  it('a fired callback does not run if the bag was disposed after scheduling', () => {
    const { scheduler, fire } = fakeScheduler();
    const bag = createTimerBag(scheduler);
    const cb = vi.fn();
    const id = bag.set(cb, 10);
    bag.dispose();
    fire(id); // even if a stray fire slips through, the disposed guard blocks the callback
    expect(cb).not.toHaveBeenCalled();
  });

  it('clear() removes a specific timer without disposing the bag', () => {
    const { scheduler, fire } = fakeScheduler();
    const bag = createTimerBag(scheduler);
    const cb = vi.fn();
    const id = bag.set(cb, 10);
    bag.clear(id);
    expect(bag.active).toBe(0);
    expect(bag.disposed).toBe(false);
    fire(id);
    expect(cb).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent', () => {
    const { scheduler } = fakeScheduler();
    const bag = createTimerBag(scheduler);
    bag.set(vi.fn(), 10);
    bag.dispose();
    expect(() => bag.dispose()).not.toThrow();
    expect(bag.disposed).toBe(true);
  });
});
