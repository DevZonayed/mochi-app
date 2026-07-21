import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { render } from '@testing-library/react';
import { useMountedTimerBag, type MountedTimerBag } from './useMountedTimerBag';
import type { TimerScheduler } from './timer-bag';

/** Deterministic scheduler so we assert on scheduling without real timers. */
function fakeScheduler(): TimerScheduler & { pending: () => number } {
  const tasks = new Map<number, () => void>();
  let seq = 0;
  return {
    setTimeout: (fn: () => void) => { const id = ++seq; tasks.set(id, fn); return id; },
    clearTimeout: (id: number) => { tasks.delete(id); },
    pending: () => tasks.size,
  };
}

function Probe({ scheduler, sink }: { scheduler: TimerScheduler; sink: (v: MountedTimerBag) => void }) {
  const v = useMountedTimerBag(scheduler);
  sink(v);
  return null;
}

describe('useMountedTimerBag — StrictMode-safe mount lifecycle', () => {
  it('stays mounted with a LIVE bag after the StrictMode setup->cleanup->setup cycle', () => {
    const scheduler = fakeScheduler();
    let latest: MountedTimerBag | null = null;
    render(
      <React.StrictMode>
        <Probe scheduler={scheduler} sink={(v) => { latest = v; }} />
      </React.StrictMode>,
    );
    expect(latest).not.toBeNull();
    // The dev StrictMode cleanup must NOT leave the live component flagged unmounted...
    expect(latest!.mounted.current).toBe(true);
    // ...nor the bag permanently disposed.
    expect(latest!.bag().disposed).toBe(false);
    // And scheduling actually works post-mount (regression: returned -1 when disposed).
    const cb = vi.fn();
    const id = latest!.bag().set(cb, 100);
    expect(id).not.toBe(-1);
    expect(scheduler.pending()).toBe(1);
  });

  it('marks unmounted and disposes the live bag on a REAL unmount', () => {
    const scheduler = fakeScheduler();
    let latest: MountedTimerBag | null = null;
    const { unmount } = render(
      <React.StrictMode>
        <Probe scheduler={scheduler} sink={(v) => { latest = v; }} />
      </React.StrictMode>,
    );
    const liveBag = latest!.bag();
    expect(liveBag.disposed).toBe(false);
    liveBag.set(vi.fn(), 100);
    expect(scheduler.pending()).toBe(1);

    unmount();

    expect(latest!.mounted.current).toBe(false);
    expect(liveBag.disposed).toBe(true);
    expect(scheduler.pending()).toBe(0); // pending timer cleared on unmount
  });
});
