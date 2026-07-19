/* useMountedTimerBag — a StrictMode-safe mount guard + timer bag.

   React 18 StrictMode (dev) intentionally runs a mount effect as
   setup -> cleanup -> setup. A naive `useEffect(() => () => { mounted=false;
   bag.dispose(); })` therefore fires its cleanup once on the LIVE component and
   never undoes it: `mounted` stays false and the single `useRef` timer bag stays
   permanently disposed, so every delayed UI update (copy toast, check flash,
   menu auto-close) silently dies in dev.

   This hook re-arms on every (re)mount: the setup body sets `mounted = true` and
   recreates the bag if it was disposed by a prior cleanup. On a REAL unmount the
   final cleanup leaves `mounted = false` and the bag disposed, so no callback
   ever runs setState on a dead component. The scheduler is injectable so the
   lifecycle is testable with a deterministic fake. */

import * as React from 'react';
import { createTimerBag, type TimerBag, type TimerScheduler } from './timer-bag';

const browserScheduler: TimerScheduler = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export interface MountedTimerBag {
  /** True only while the component is mounted (StrictMode-safe). */
  mounted: React.MutableRefObject<boolean>;
  /** The live, re-armed timer bag. Always call through this accessor. */
  bag: () => TimerBag;
}

export function useMountedTimerBag(scheduler: TimerScheduler = browserScheduler): MountedTimerBag {
  const mounted = React.useRef(true);
  const bagRef = React.useRef<TimerBag | null>(null);
  if (bagRef.current === null) bagRef.current = createTimerBag(scheduler);

  React.useEffect(() => {
    mounted.current = true;
    // Re-arm if a prior (StrictMode) cleanup disposed the bag.
    if (bagRef.current === null || bagRef.current.disposed) {
      bagRef.current = createTimerBag(scheduler);
    }
    return () => {
      mounted.current = false;
      bagRef.current?.dispose();
    };
    // `scheduler` is a stable module const (or a stable test double); this runs
    // once per real mount and once more per StrictMode remount, which is exactly
    // the lifecycle we re-arm against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { mounted, bag: () => bagRef.current as TimerBag };
}
