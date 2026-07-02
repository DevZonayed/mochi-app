/* BrowserWatcher behavior tests.

   Strategy: use a synchronous test scheduler (drive ticks by hand instead of
   real time) + stub the bridge.request return value per-tick + stub dispatch
   to capture the chat-post call. The Store is the production module pointed
   at a temp dir (cron.recurrence.test.ts pattern). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-bwatch-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { BrowserWatcher, type BrowserBridgeForWatch, type WatchDispatch } from './browser-watch.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A controllable scheduler — `flush()` runs the tick callback once. The watcher
    treats this as its master loop (no setInterval, no real time). */
function makeScheduler() {
  let cb: (() => void) | null = null;
  return {
    schedule: (fn: () => void) => { cb = fn; return { cancel: () => { cb = null; } }; },
    flush: () => cb?.(),
  };
}

/** Per-test bridge stub. `connected` toggles the no-browser branch; `replies`
    is a queue the next `request()` call shifts and returns. Plain throws are
    also supported via `replies.push(new Error('bad'))`. */
function makeBridge() {
  const calls: { type: string; params: Record<string, unknown> }[] = [];
  const replies: unknown[] = [];
  let connected = true;
  const bridge: BrowserBridgeForWatch = {
    hasActiveBrowser: () => connected,
    request: async (type, params) => {
      calls.push({ type, params });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      // Default: pretend the eval returned false. Tests usually push a reply.
      return next ?? { ok: true, value: false };
    },
  };
  return { bridge, calls, replies, setConnected: (b: boolean) => { connected = b; } };
}

/** Dispatch stub that captures sendChat / cancelJob calls. */
function makeDispatch() {
  const calls: { method: string; params: any }[] = [];
  let nextJobId = 1;
  const dispatch: WatchDispatch = async (method, params) => {
    calls.push({ method, params });
    if (method === 'sendChat') return { session: { id: params.sessionId ?? 'sess' }, job: { id: `job-${nextJobId++}` } };
    return {};
  };
  return { dispatch, calls };
}

/** Build a session + project so the watcher can post into a real chat row. */
function bootstrap(store: Store): { projectId: string; sessionId: string } {
  const p = store.createProject({ name: 'P' });
  // The Store doesn't expose createSession in the same way for tests, but the
  // watcher only needs the IDs to exist on the watch row — listJobs(projectId, sessionId)
  // returns [] when there's no session and that's the "no running job" path.
  return { projectId: p.id, sessionId: 's-test' };
}

let store: Store;
beforeEach(() => {
  rmSync(hoisted.dir, { recursive: true, force: true });
  store = new Store();
});
afterEach(() => {
  try { rmSync(hoisted.dir, { recursive: true, force: true }); } catch { /* */ }
});

describe('BrowserWatcher.create', () => {
  it('clamps interval below the floor and rejects an empty condition', () => {
    const { projectId, sessionId } = bootstrap(store);
    const { bridge } = makeBridge();
    const { dispatch } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });

    expect(() => w.create({ projectId, sessionId, title: 't', condition: '' as string })).toThrow(/condition/i);
    expect(() => w.create({ projectId, sessionId, title: 't', condition: 'true' as string, intervalMs: 0 })).not.toThrow();
    const row = store.listBrowserWatches({ activeOnly: true })[0];
    expect(row.intervalMs).toBeGreaterThanOrEqual(500); // floor
  });

  it('clamps maxDurationMs to >= 2× intervalMs AND <= 24h', () => {
    const { projectId, sessionId } = bootstrap(store);
    const w = new BrowserWatcher({ store, bridge: null, dispatch: async () => ({}), scheduler: makeScheduler() });
    // Way too long → capped at 24h.
    const big = w.create({ projectId, sessionId, title: 't', condition: 'true', intervalMs: 1000, maxDurationMs: 999 * 24 * 60 * 60_000 });
    expect(big.expiresAt - big.createdAt).toBeLessThanOrEqual(24 * 60 * 60_000 + 1000);
    // Way too short → bumped to 2× interval.
    const tiny = w.create({ projectId, sessionId, title: 't', condition: 'true', intervalMs: 1000, maxDurationMs: 10 });
    expect(tiny.expiresAt - tiny.createdAt).toBeGreaterThanOrEqual(2_000);
  });
});

describe('BrowserWatcher.tick — eval + edge-detect', () => {
  it('skips the eval when no browser is connected (and records lastResult=no-browser)', async () => {
    const { projectId, sessionId } = bootstrap(store);
    const { bridge, setConnected } = makeBridge();
    setConnected(false);
    const { dispatch, calls: dispatchCalls } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });
    w.start();

    const rec = w.create({ projectId, sessionId, title: 't', condition: 'true', intervalMs: 500 });
    // Force "due" by backdating lastEvalAt (no evaluation happened yet, so the
    // anchor is createdAt; bumping it past intervalMs makes the next flush eval).
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush();
    await new Promise(r => setTimeout(r, 5));

    const after = store.listBrowserWatches({ activeOnly: true })[0];
    expect(after.lastResult).toBe('no-browser');
    expect(dispatchCalls).toHaveLength(0); // nothing posted
  });

  it('false stays inactive; first true posts to chat and one-shot cancels the watch', async () => {
    const { projectId, sessionId } = bootstrap(store);
    const { bridge, replies } = makeBridge();
    const { dispatch, calls: dispatchCalls } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });
    w.start();

    const rec = w.create({ projectId, sessionId, title: 'wait', condition: 'true', intervalMs: 500 });

    // Tick 1: condition false → no fire. (tab_url is NOT called because fire() doesn't run.)
    replies.push({ ok: true, value: false });
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush();
    await new Promise(r => setTimeout(r, 5));
    expect(dispatchCalls.filter(c => c.method === 'sendChat')).toHaveLength(0);

    // Tick 2: condition true → fire + one-shot cancel.
    replies.push({ ok: true, value: true });               // evaluate -> true
    replies.push({ url: 'https://example.com/q' });        // tab_url for the fire message
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush();
    await new Promise(r => setTimeout(r, 5));

    const posted = dispatchCalls.filter(c => c.method === 'sendChat');
    expect(posted).toHaveLength(1);
    expect(posted[0].params.projectId).toBe(projectId);
    expect(posted[0].params.sessionId).toBe(sessionId);
    expect(posted[0].params.text).toContain('Browser watch fired');
    expect(posted[0].params.text).toContain('"wait"');
    expect(posted[0].params.text).toContain('https://example.com/q');

    const after = store.listBrowserWatches()[0];
    expect(after.active).toBe(false);
    expect(after.cancelReason).toBe('fired-once');
    expect(after.fireCount).toBe(1);
    expect(after.lastJobId).toMatch(/^job-/);
  });

  it('repeat:true fires on every false→true transition, NOT on consecutive trues', async () => {
    const { projectId, sessionId } = bootstrap(store);
    const { bridge, replies } = makeBridge();
    const { dispatch, calls: dispatchCalls } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });
    w.start();

    const rec = w.create({ projectId, sessionId, title: 'repeat', condition: 'x', intervalMs: 500, repeat: true });

    // false → true (fire 1)
    replies.push({ ok: true, value: true });
    replies.push({ url: 'http://x' });
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush(); await new Promise(r => setTimeout(r, 5));
    // still-true (NO fire — edge detection)
    replies.push({ ok: true, value: true });
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush(); await new Promise(r => setTimeout(r, 5));
    // true → false (no fire)
    replies.push({ ok: true, value: false });
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush(); await new Promise(r => setTimeout(r, 5));
    // false → true again (fire 2)
    replies.push({ ok: true, value: true });
    replies.push({ url: 'http://x' });
    store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
    sched.flush(); await new Promise(r => setTimeout(r, 5));

    const sendCalls = dispatchCalls.filter(c => c.method === 'sendChat');
    expect(sendCalls).toHaveLength(2);
    const after = store.listBrowserWatches()[0];
    expect(after.active).toBe(true);            // repeat:true keeps it alive
    expect(after.fireCount).toBe(2);
  });
});

describe('BrowserWatcher.tick — expiry + error streak', () => {
  it('auto-cancels (reason=expired) once now > expiresAt', async () => {
    const { projectId, sessionId } = bootstrap(store);
    const { bridge } = makeBridge();
    const { dispatch } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });
    w.start();

    const rec = w.create({ projectId, sessionId, title: 't', condition: 'true', intervalMs: 1000, maxDurationMs: 2_000 });
    // Force expired by backdating expiresAt to the past.
    (store.listBrowserWatches({ activeOnly: true })[0] as any).expiresAt = Date.now() - 1;
    sched.flush(); await new Promise(r => setTimeout(r, 5));

    const after = store.listBrowserWatches().find(x => x.id === rec.id)!;
    expect(after.active).toBe(false);
    expect(after.cancelReason).toBe('expired');
  });

  it('auto-cancels after 5 consecutive identical errors AND posts a notice to the chat', async () => {
    const { projectId, sessionId } = bootstrap(store);
    const { bridge, replies } = makeBridge();
    const { dispatch, calls: dispatchCalls } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });
    w.start();

    const rec = w.create({ projectId, sessionId, title: 'bad', condition: 'throw "boom"', intervalMs: 500 });

    // Same error 5 times.
    for (let i = 0; i < 5; i++) {
      replies.push({ ok: false, error: 'boom' });
      store.updateBrowserWatch(rec.id, { lastEvalAt: Date.now() - 10_000 });
      sched.flush(); await new Promise(r => setTimeout(r, 5));
    }

    const after = store.listBrowserWatches().find(x => x.id === rec.id)!;
    expect(after.active).toBe(false);
    expect(after.cancelReason).toBe('invalid-condition');
    expect(after.lastError).toBe('boom');
    // The notice message hits the chat.
    const notice = dispatchCalls.find(c => c.method === 'sendChat' && /cancelled/.test(c.params.text));
    expect(notice).toBeTruthy();
    expect(notice!.params.text).toContain('error 5×');
  });
});

describe('BrowserWatcher.list + cancel', () => {
  it('list() and cancel() respect session boundaries via the store', () => {
    const { projectId } = bootstrap(store);
    const { bridge } = makeBridge();
    const { dispatch } = makeDispatch();
    const sched = makeScheduler();
    const w = new BrowserWatcher({ store, bridge, dispatch, scheduler: sched });

    const a = w.create({ projectId, sessionId: 'sess-A', title: 'a', condition: 'true' });
    const b = w.create({ projectId, sessionId: 'sess-B', title: 'b', condition: 'true' });
    expect(w.list({ sessionId: 'sess-A' }).map(x => x.id)).toEqual([a.id]);
    expect(w.list({ sessionId: 'sess-B' }).map(x => x.id)).toEqual([b.id]);

    const c = w.cancel(a.id)!;
    expect(c.active).toBe(false);
    expect(c.cancelReason).toBe('manual');
    expect(w.cancel('does-not-exist')).toBeNull();
  });
});
