/* Real-time host events for the UI. One shared SSE/WS stream
   (api.openLiveStream) is opened while any screen is subscribed and closed
   when the last one leaves. Components call useLive(['job','session'], cb) to
   react instantly to Mac events.

   AppState handling (the "I left the app for 2 minutes and came back to a
   stale screen" fix):
   - On `background` / `inactive` we tear the stream down on purpose. iOS
     freezes JS, dispatches no events, and the underlying socket is going to
     die in carrier NAT / app suspend anyway. Keeping it open just holds a
     dead handle and confuses reconnect logic on resume.
   - On `active` (returning to foreground) we:
       1. Reopen the stream — gives us a clean socket and a fresh `hello`
          frame with the host's current online state.
       2. Reset `hostOnline` to `null` (unknown) so a stale "Mac is asleep"
          banner doesn't flash before the new `hello` arrives.
       3. Fire a synthetic `resume` event to EVERY useLive callback,
          regardless of its `names` filter. Existing screens already pass
          their `load()` as the callback, so this is a one-shot refresh of
          every live data screen with no per-screen changes required.
   This means the user always sees fresh data within a few hundred ms of
   coming back to the app — no more "irregular, laggy, not getting every
   data" experience.
*/

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { openLiveStream, getConnPath, subscribeConnPath, setLastSeq, type LiveEventName } from './api';

type Listener = (name: LiveEventName, data: unknown) => void;

const listeners = new Set<Listener>();
let dispose: (() => void) | null = null;
let refs = 0;

/* Host-online tracking. The relay emits `host { online }` on connect/disconnect.
   We cache the latest value module-side and surface it via useHostOnline()
   so screens can fall back to the server-mirrored data (Phase 2 mirror) when
   the Mac is asleep. Starts as `null` = unknown (haven't received a host
   event yet); turns into a real boolean once the stream is open. */
let hostOnline: boolean | null = null;
const hostSubs = new Set<() => void>();
function setHostOnline(v: boolean | null): void {
  if (hostOnline === v) return;
  hostOnline = v;
  for (const cb of hostSubs) { try { cb(); } catch { /* fine */ } }
}

function ensureOpen(): void {
  if (dispose) return;
  dispose = openLiveStream((name, data) => {
    // Track host presence so useHostOnline can drive offline-fallback UI.
    if (name === 'host' && data && typeof data === 'object') {
      setHostOnline(!!(data as { online?: boolean }).online);
    } else if (name === 'hello' && data && typeof data === 'object') {
      // The `hello` greeting carries hostOnline too, for clients that
      // connect AFTER the host already came up.
      const h = data as { hostOnline?: boolean };
      if (typeof h.hostOnline === 'boolean') setHostOnline(h.hostOnline);
    } else if (name === 'buffer-overflow' && data && typeof data === 'object') {
      // The relay's replay buffer didn't have enough history to reach our
      // last seq — we were offline longer than its window. The payload
      // carries `latestSeq` (the relay's current seq), so we fast-forward
      // our cursor there. The next reconnect won't bother asking for an
      // unreachable replay, AND every subscriber gets the buffer-overflow
      // event (unfiltered by useLive) and triggers its own full refetch.
      const latest = (data as { latestSeq?: number }).latestSeq;
      if (typeof latest === 'number' && latest > 0) setLastSeq(latest);
    }
    for (const l of [...listeners]) l(name, data);
  });
}

/* ── AppState (foreground/background) ────────────────────────────────────
   Single module-level subscription — installed lazily on first useLive /
   useHostOnline mount, never torn down because the cost of leaving an
   AppState listener attached is trivial and re-attaching every re-render
   would race the actual transition. */
let appStateInit = false;
let currentAppState: AppStateStatus = AppState.currentState ?? 'unknown';
function ensureAppState(): void {
  if (appStateInit) return;
  appStateInit = true;
  AppState.addEventListener('change', (next) => {
    const prev = currentAppState;
    currentAppState = next;
    if (prev === 'active' && next !== 'active') {
      // Foreground → background: drop the (likely doomed) stream now so we
      // start fresh on resume rather than reusing a dead socket.
      if (dispose) { try { dispose(); } catch { /* fine */ } dispose = null; }
      // Clear stale host presence — it'll repopulate from the next `hello`.
      setHostOnline(null);
      return;
    }
    if (prev !== 'active' && next === 'active') {
      // Background → foreground: reopen the stream and tell every screen to
      // refresh its data. `refs > 0` means there's still a live useLive
      // subscriber; if none, ensureOpen() is a no-op and we skip the fan-out.
      if (refs > 0) {
        ensureOpen();
        // Synthetic resume frame, delivered UNFILTERED — useLive bypasses
        // the names filter for `resume` so every subscriber re-fetches.
        for (const l of [...listeners]) {
          try { l('resume' as LiveEventName, null); } catch { /* never break others */ }
        }
      }
    }
  });
}

/** Subscribe to live events whose name is in `names`. `cb` may change each render
    (kept in a ref) without tearing down the subscription.
    Special case: `resume` always fires for every subscriber regardless of `names` —
    it's how the "app came back to foreground" refresh sweeps every screen. */
export function useLive(names: LiveEventName[], cb: Listener): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const key = names.join(',');
  useEffect(() => {
    refs += 1;
    ensureOpen();
    ensureAppState();
    const wanted = new Set(names);
    const l: Listener = (n, d) => {
      // `resume` (app foreground) and `buffer-overflow` (relay's replay
      // buffer didn't reach our last seq) both mean "your data is stale —
      // refetch now." Delivered unfiltered so every subscriber acts.
      if (n === 'resume' || n === 'buffer-overflow' || wanted.has(n)) cbRef.current(n, d);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      refs -= 1;
      if (refs <= 0 && dispose) { dispose(); dispose = null; refs = 0; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** The live stream's current transport: 'p2p' (direct WebRTC) or 'relay'. Re-renders on change. */
export function useConnPath(): 'p2p' | 'relay' {
  return useSyncExternalStore(subscribeConnPath, getConnPath, getConnPath);
}

/** Whether the Mac is reachable. Drives offline-fallback UI in the screens
    that read mirrored data from the relay (Phase 2). Returns `null` until
    we've received the first `hello` or `host` event from the stream — which
    also happens after a foreground resume, so a transient `null` after
    coming back to the app means "we're checking, not necessarily offline". */
export function useHostOnline(): boolean | null {
  const [v, setV] = useState<boolean | null>(hostOnline);
  useEffect(() => {
    // If we already have a value cached module-side (the stream has been
    // open before this hook mounted), sync our local state to it once.
    if (hostOnline !== v) setV(hostOnline);
    const cb = () => setV(hostOnline);
    hostSubs.add(cb);
    // Make sure the stream is open so we actually receive host events even
    // if no other screen has subscribed to live events.
    refs += 1;
    ensureOpen();
    ensureAppState();
    return () => {
      hostSubs.delete(cb);
      refs -= 1;
      if (refs <= 0 && dispose) { dispose(); dispose = null; refs = 0; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

/* ── Test helpers ──────────────────────────────────────────────────────
   Not exported via the package boundary — vitest imports them directly. */
export const __test = {
  /** Force-trigger a foreground/background transition for tests. */
  setAppState(s: AppStateStatus): void { currentAppState = s; },
  /** Reset module state between tests (subscribers, refs, host cache). */
  reset(): void {
    listeners.clear(); hostSubs.clear();
    if (dispose) { try { dispose(); } catch { /* fine */ } dispose = null; }
    refs = 0; hostOnline = null; appStateInit = false; currentAppState = 'active';
  },
};
