/* Browser watcher — the agent places a "watch" on the active Chrome tab
   (a JS condition expression); the desktop polls it on the agent's behalf,
   and when the condition becomes true posts a NEW message into the
   originating chat (starting a fresh agent turn with the full session
   context). The agent's current turn doesn't have to stay alive — the
   watcher is desktop-owned, persists across turns AND desktop restarts.

   Architecture rationale:
   - Polling lives on the DESKTOP, not in the extension. The extension can be
     evicted to standby when another Chrome profile takes over; the desktop
     always knows which profile is active and routes via ExtensionBridge.
   - We REUSE the existing bridge.request('evaluate', …) wire — no new
     extension command needed.
   - We REUSE `dispatch('sendChat', …)` — same path extension-bridge.deliver()
     uses to post a chat message. The fire becomes a real chat turn with all
     the usual plumbing (sessions, agent run, transcript).

   Lifecycle of one watch:
       create() ──tick→ eval ──true?──→ deliver() → mark fired
                          │                              │
                       too late                       repeat? ──no→ cancel()
                          │                              │
                       cancel() ←─── now > expiresAt    yes → keep going
                                                        (edge-detect false→true)

   Hard guards:
   - intervalMs is clamped to [MIN_INTERVAL_MS, MAX_INTERVAL_MS]
   - expiresAt is clamped to <= now + MAX_DURATION_MS
   - per-eval timeout via bridge.request's own timeoutMs
   - on bridge disconnect: we don't expire, we don't tick, we just wait. The
     `lastResult: 'no-browser'` shows the operator (and the agent) why nothing
     is happening.
   - on evaluator error (bad JS, page closed mid-eval): we DON'T cancel the
     watch (transient page errors are common during navigation) UNLESS we see
     the same error N consecutive times — then we cancel as 'invalid-condition'. */

import type { Store, BrowserWatch } from './store.js';

/** Minimum interval. Anything below would saturate the bridge for marginal
    benefit — most UIs settle in 250–500ms after the relevant DOM mutation. */
const MIN_INTERVAL_MS = 500;
/** Maximum interval (5 min). Past this you're not really watching, you're
    just letting the watch sit. The agent should usually pick 1–10s. */
const MAX_INTERVAL_MS = 5 * 60_000;
/** Hard cap on how long ANY watch can run: 24 hours. Forces the agent to
    re-arm anything longer, which is the right contract — a 7-day watch that
    silently expired would be worse than a re-arm prompt. */
const MAX_DURATION_MS = 24 * 60 * 60_000;
/** How often the scheduler decides whether ANY watch is due. Independent of
    each watch's intervalMs — the master tick is just a cheap sweeper. */
const SCHEDULER_TICK_MS = 250;
/** Per-eval timeout for the JS condition. The agent's condition should be
    near-instant (a DOM query, a property read); anything slower is a smell. */
const EVAL_TIMEOUT_MS = 4_000;
/** Wrap the agent's bridge.request with a slightly higher overall timeout so
    the network/IPC overhead doesn't immediately throw on an expensive eval. */
const BRIDGE_TIMEOUT_MS = 8_000;
/** Tolerance: an exact-interval-due check would race with the tick granularity
    and randomly skip a slot. Treat "within this tolerance of due" as due. */
const DUE_TOLERANCE_MS = 200;
/** If the JS condition throws the SAME error this many ticks in a row, we
    auto-cancel the watch as invalid-condition. Two transient hits (page nav,
    same-origin redirect mid-eval) shouldn't kill a watch — but a syntax error
    or a permanently-missing global should. */
const INVALID_CONDITION_STREAK = 5;

/** Bridge surface the watcher needs. Matches the BrowserCtx in engine.ts but
    typed more strictly (and includes a status getter for connection-aware ticks). */
export interface BrowserBridgeForWatch {
  /** Is the active profile currently connected + ready to receive RPCs? */
  hasActiveBrowser(): boolean;
  /** Run a CDP-backed RPC against the active profile. */
  request(type: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** Dispatch surface for posting the fire message into the originating chat
    (the same `sendChat` extension-bridge.deliver() uses). Matches localApi.ts. */
export type WatchDispatch = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Emit a UI event to the renderer (Settings → browser watches list). */
export type WatchEmit = (name: 'browser-watch', payload: { id: string; reason: 'tick' | 'fired' | 'cancelled' | 'created' }) => void;

export interface BrowserWatcherOpts {
  store: Store;
  bridge: BrowserBridgeForWatch | null;
  dispatch: WatchDispatch;
  emit?: WatchEmit;
  /** Override for tests so we don't burn real timers. Defaults to setInterval. */
  scheduler?: { schedule: (cb: () => void, ms: number) => { unref?: () => void; cancel: () => void } };
}

/** Per-watch streak counter (in-memory, not persisted — error streaks reset
    across desktop restarts which is the right default: a transient error from
    yesterday shouldn't kill a fresh restart). */
interface WatchStreak { lastError: string; count: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
export class BrowserWatcher {
  private store: Store;
  private bridge: BrowserBridgeForWatch | null;
  private dispatch: WatchDispatch;
  private emit: WatchEmit;
  private timer: { cancel: () => void } | null = null;
  private streaks = new Map<string, WatchStreak>();
  /** In-flight evals — guards against a slow page causing concurrent ticks
      against the same watch (would burn bridge IPCs + double-fire). */
  private inflight = new Set<string>();

  constructor(opts: BrowserWatcherOpts) {
    this.store = opts.store;
    this.bridge = opts.bridge;
    this.dispatch = opts.dispatch;
    this.emit = opts.emit ?? (() => { /* no UI in headless tests */ });
    if (opts.scheduler) this._customScheduler = opts.scheduler;
  }
  private _customScheduler?: BrowserWatcherOpts['scheduler'];

  /** Start the master tick loop. Idempotent — calling twice is a no-op so the
      app's restart flows (re-init after sign-out, etc.) stay safe. */
  start(): void {
    if (this.timer) return;
    if (this._customScheduler) {
      this.timer = this._customScheduler.schedule(() => this.tick(), SCHEDULER_TICK_MS);
    } else {
      const t = setInterval(() => this.tick(), SCHEDULER_TICK_MS);
      // Unref so the master interval doesn't pin Electron's main process open
      // during shutdown. The before-quit hook clears it for orderly shutdown.
      if (typeof (t as any).unref === 'function') (t as any).unref();
      this.timer = { cancel: () => clearInterval(t) };
    }
  }

  stop(): void {
    if (this.timer) { this.timer.cancel(); this.timer = null; }
    this.inflight.clear();
    this.streaks.clear();
  }

  /** Create a watch. Validates + clamps inputs, persists, fires a UI event. */
  create(input: {
    projectId: string; sessionId: string; title: string;
    condition: string; message?: string;
    intervalMs?: number; maxDurationMs?: number; repeat?: boolean;
  }): BrowserWatch {
    if (!input.projectId) throw new Error('browser_watch: projectId required');
    if (!input.sessionId) throw new Error('browser_watch: sessionId required');
    if (typeof input.condition !== 'string' || !input.condition.trim()) {
      throw new Error('browser_watch: condition (JS expression) required');
    }
    const intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Number(input.intervalMs) || 5_000));
    const maxDurationMs = Math.max(intervalMs * 2, Math.min(MAX_DURATION_MS, Number(input.maxDurationMs) || 30 * 60_000));
    const rec = this.store.createBrowserWatch({
      projectId: input.projectId,
      sessionId: input.sessionId,
      title: input.title || 'Browser watch',
      condition: input.condition,
      message: input.message,
      intervalMs,
      expiresAt: Date.now() + maxDurationMs,
      repeat: !!input.repeat,
    });
    try { this.emit('browser-watch', { id: rec.id, reason: 'created' }); } catch { /* no UI */ }
    return rec;
  }

  /** Cancel a watch (operator from Settings OR agent via browser_watch_cancel).
      Returns the updated row, or null when no such watch. */
  cancel(watchId: string): BrowserWatch | null {
    const r = this.store.cancelBrowserWatch(watchId, 'manual');
    if (r) { try { this.emit('browser-watch', { id: r.id, reason: 'cancelled' }); } catch { /* */ } }
    return r;
  }

  /** Snapshot for UI / agent — same filters as store.listBrowserWatches. */
  list(opts?: { activeOnly?: boolean; sessionId?: string; projectId?: string }): BrowserWatch[] {
    return this.store.listBrowserWatches(opts);
  }

  /** Master tick. Cheap when there's nothing active. */
  private tick(): void {
    const watches = this.store.listBrowserWatches({ activeOnly: true });
    if (watches.length === 0) return;
    const now = Date.now();
    for (const w of watches) {
      // 1) Expired? auto-cancel; emit so the UI updates without a poll.
      if (w.expiresAt <= now) {
        this.store.cancelBrowserWatch(w.id, 'expired');
        this.inflight.delete(w.id); this.streaks.delete(w.id);
        try { this.emit('browser-watch', { id: w.id, reason: 'cancelled' }); } catch { /* */ }
        continue;
      }
      // 2) Skip if a prior eval is still in flight (slow page / disconnected mid-eval).
      if (this.inflight.has(w.id)) continue;
      // 3) Skip if not yet due (anchored to lastEvalAt, falling back to createdAt).
      const lastEval = w.lastEvalAt ?? w.createdAt;
      if (now - lastEval + DUE_TOLERANCE_MS < w.intervalMs) continue;
      // 4) Bridge unavailable? Record the state but DO NOT expire. The watch
      // will pick back up the moment a profile reconnects.
      if (!this.bridge?.hasActiveBrowser()) {
        this.store.updateBrowserWatch(w.id, { lastEvalAt: now, lastResult: 'no-browser' });
        continue;
      }
      // 5) Fire-and-forget the eval; the response handler updates state.
      this.inflight.add(w.id);
      void this.evalOnce(w).finally(() => this.inflight.delete(w.id));
    }
  }

  /** Run the condition once, update state, fire if it transitioned to true. */
  private async evalOnce(w: BrowserWatch): Promise<void> {
    const now = Date.now();
    // Wrap the agent's expression so a bare expression OR a Promise both work.
    // Coerce to boolean so a watch with a truthy non-boolean (e.g. a DOM element)
    // doesn't get serialized as the whole element — that would blow the IPC payload.
    const wrapped = `(async () => { try { return !!(await (async () => (${w.condition}))()); } catch (e) { throw e; } })()`;
    let result: 'true' | 'false' | 'error' = 'false';
    let lastError: string | undefined;
    try {
      const r = await this.bridge!.request('evaluate', {
        expression: wrapped,
        awaitPromise: true,
        returnByValue: true,
        timeoutMs: EVAL_TIMEOUT_MS,
      }, BRIDGE_TIMEOUT_MS) as { ok?: boolean; value?: unknown; error?: string };
      if (r?.ok === false) { result = 'error'; lastError = r.error || 'evaluate failed'; }
      else result = r?.value === true ? 'true' : 'false';
    } catch (e) {
      result = 'error';
      lastError = e instanceof Error ? e.message : String(e);
    }

    // Error-streak detection: cancel after N consecutive identical errors.
    if (result === 'error') {
      const k = this.streaks.get(w.id);
      const sig = lastError ?? '(unknown)';
      if (k && k.lastError === sig) {
        k.count += 1;
        if (k.count >= INVALID_CONDITION_STREAK) {
          this.store.updateBrowserWatch(w.id, { lastEvalAt: now, lastResult: 'error', lastError });
          this.store.cancelBrowserWatch(w.id, 'invalid-condition');
          this.streaks.delete(w.id);
          try { this.emit('browser-watch', { id: w.id, reason: 'cancelled' }); } catch { /* */ }
          // Best-effort: tell the chat that the watch self-cancelled, so the
          // agent doesn't keep referring to it as live.
          void this.notifyCancellation(w, `error ${INVALID_CONDITION_STREAK}× in a row: ${sig}`);
          return;
        }
      } else {
        this.streaks.set(w.id, { lastError: sig, count: 1 });
      }
      this.store.updateBrowserWatch(w.id, { lastEvalAt: now, lastResult: 'error', lastError });
      try { this.emit('browser-watch', { id: w.id, reason: 'tick' }); } catch { /* */ }
      return;
    }
    // Reset the streak on a non-error tick.
    if (this.streaks.has(w.id)) this.streaks.delete(w.id);

    const wasTrue = !!w.lastWasTrue;
    const isTrue = result === 'true';

    // Edge-detect: only fire on false→true (or first-tick→true). Repeated true
    // ticks while the condition stays true don't spam the chat.
    if (isTrue && !wasTrue) {
      const fired = await this.fire(w).catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (fired?.ok) {
        const newCount = (w.fireCount ?? 0) + 1;
        this.store.updateBrowserWatch(w.id, {
          lastEvalAt: now, lastResult: 'true', lastWasTrue: true,
          fireCount: newCount, lastFiredAt: now, lastJobId: fired.jobId,
        });
        if (!w.repeat) {
          this.store.cancelBrowserWatch(w.id, 'fired-once');
          try { this.emit('browser-watch', { id: w.id, reason: 'cancelled' }); } catch { /* */ }
        } else {
          try { this.emit('browser-watch', { id: w.id, reason: 'fired' }); } catch { /* */ }
        }
      } else {
        // Couldn't post (no project? session deleted?). Record + keep going —
        // a transient sendChat failure shouldn't kill the watch outright.
        this.store.updateBrowserWatch(w.id, {
          lastEvalAt: now, lastResult: 'true', lastWasTrue: true,
          lastError: `fire failed: ${fired?.error ?? 'unknown'}`,
        });
        try { this.emit('browser-watch', { id: w.id, reason: 'tick' }); } catch { /* */ }
      }
      return;
    }

    // Plain tick — either still-false, or still-true (no edge).
    this.store.updateBrowserWatch(w.id, {
      lastEvalAt: now, lastResult: result, lastWasTrue: isTrue,
    });
    try { this.emit('browser-watch', { id: w.id, reason: 'tick' }); } catch { /* */ }
  }

  /** Post a NEW chat turn into the originating session with a description of
      what fired. Returns the jobId so it can be linked from the watch row. */
  private async fire(w: BrowserWatch): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
    // Steal the bridge's URL helper if we can — adds tab context to the fire
    // message so the agent knows WHICH page the watch was on.
    let url = '';
    try {
      const t = await this.bridge!.request('tab_url', {}, 3000) as { url?: string };
      if (t?.url) url = t.url;
    } catch { /* the tab may have closed; the fire message still goes through */ }
    const body = [
      `🔔 **Browser watch fired** — "${w.title}"`,
      w.message ? w.message : null,
      `Condition: \`${truncate(w.condition, 280)}\``,
      url ? `Tab: ${url}` : null,
      `Watch id: \`${w.id}\` (interval=${w.intervalMs}ms${w.repeat ? ', repeating' : ', one-shot'})`,
    ].filter(Boolean).join('\n');
    try {
      // Same path as extension-bridge.deliver(): if a job is in-flight on the
      // session, interrupt it first so the new turn picks up cleanly.
      const running = this.store.listJobs(w.projectId, w.sessionId).find(j => j.status === 'running' || j.status === 'pending');
      if (running) {
        try { await this.dispatch('cancelJob', { id: running.id }); } catch { /* already gone */ }
      }
      const r = await this.dispatch('sendChat', { projectId: w.projectId, sessionId: w.sessionId, text: body }) as { session?: { id: string }; job?: { id: string } };
      const jobId = r?.job?.id ?? '';
      if (!jobId) return { ok: false, error: 'sendChat returned no job' };
      return { ok: true, jobId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Post a one-line "your watch was cancelled because …" notice into the chat
      so the agent isn't waiting forever on a dead watch. Best-effort. */
  private async notifyCancellation(w: BrowserWatch, reason: string): Promise<void> {
    const body = `🛑 Browser watch **"${w.title}"** cancelled — ${reason}. Re-arm with browser_watch if you want to keep observing.`;
    try { await this.dispatch('sendChat', { projectId: w.projectId, sessionId: w.sessionId, text: body }); }
    catch { /* nothing useful to do */ }
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
