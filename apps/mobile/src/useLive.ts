/* Real-time host events for the UI. One shared SSE stream (api.openLiveStream) is
   opened while any screen is subscribed and closed when the last one leaves.
   Components call useLive(['job','session'], cb) to react instantly to Mac events. */

import { useEffect, useRef } from 'react';
import { openLiveStream, type LiveEventName } from './api';

type Listener = (name: LiveEventName, data: unknown) => void;

const listeners = new Set<Listener>();
let dispose: (() => void) | null = null;
let refs = 0;

function ensureOpen(): void {
  if (dispose) return;
  dispose = openLiveStream((name, data) => {
    for (const l of [...listeners]) l(name, data);
  });
}

/** Subscribe to live events whose name is in `names`. `cb` may change each render
    (kept in a ref) without tearing down the subscription. */
export function useLive(names: LiveEventName[], cb: Listener): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const key = names.join(',');
  useEffect(() => {
    refs += 1;
    ensureOpen();
    const wanted = new Set(names);
    const l: Listener = (n, d) => { if (wanted.has(n)) cbRef.current(n, d); };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      refs -= 1;
      if (refs <= 0 && dispose) { dispose(); dispose = null; refs = 0; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
