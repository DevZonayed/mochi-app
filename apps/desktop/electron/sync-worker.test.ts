/* SyncWorker tests — verify the batching, de-dup, retry, and pause-when-unpaired
   semantics with an injected fake fetch. No real network. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncWorker } from './sync-worker.js';

interface Call { path: string; body: unknown }

function makeFetch(responses: number[] = [200]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const status = responses[Math.min(i, responses.length - 1)];
    i++;
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

const BASE = 'http://relay';
const TOKEN = 'tok-x';

function newWorker(fetchImpl: typeof fetch) {
  return new SyncWorker({
    httpBase: () => BASE,
    accessToken: () => TOKEN,
    fetchImpl,
    batchDelayMs: 5,   // short for tests
    baseRetryMs: 5,
    maxRetryMs: 20,
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('SyncWorker', () => {
  it('flushes a queued chat to /api/mirror/chat', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncChat({ id: 'c1', title: 'Hello' });
    await vi.advanceTimersByTimeAsync(10);
    await w.flush(); // ensure the timer-triggered flush completes
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/mirror/chat');
    expect(calls[0].body).toMatchObject({ id: 'c1', title: 'Hello' });
  });

  it('coalesces multiple syncChat calls for the same id into one POST', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncChat({ id: 'c1', title: 'V1' });
    w.syncChat({ id: 'c1', title: 'V2', archived: true });
    await w.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ id: 'c1', title: 'V2', archived: true });
  });

  it('coalesces messages per chat into one POST per chat', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncMessages('c1', [{ id: 'm1', chatId: 'c1', role: 'user',      content: 'hi'    }]);
    w.syncMessages('c1', [{ id: 'm2', chatId: 'c1', role: 'assistant', content: 'hello' }]);
    w.syncMessages('c2', [{ id: 'm3', chatId: 'c2', role: 'user',      content: 'other' }]);
    await w.flush();
    expect(calls).toHaveLength(2);
    const c1 = calls.find((c) => c.path === '/api/mirror/chats/c1/messages');
    const c2 = calls.find((c) => c.path === '/api/mirror/chats/c2/messages');
    expect(((c1?.body as { messages: { id: string }[] }).messages).map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(((c2?.body as { messages: { id: string }[] }).messages).map((m) => m.id)).toEqual(['m3']);
  });

  it('a later message with the same id overwrites the earlier one', async () => {
    // Token-stream case: an assistant message gets pushed with partial
    // content, then again with the final content. The final wins.
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncMessages('c1', [{ id: 'm1', chatId: 'c1', role: 'assistant', content: 'partial' }]);
    w.syncMessages('c1', [{ id: 'm1', chatId: 'c1', role: 'assistant', content: 'final'   }]);
    await w.flush();
    expect(calls).toHaveLength(1);
    const msgs = (calls[0].body as { messages: { id: string; content: string }[] }).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('final');
  });

  it('drops earlier state-memory pushes for the same project', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncMemory({ projectId: 'p1', kind: 'state', content: 'A' });
    w.syncMemory({ projectId: 'p1', kind: 'state', content: 'B' });
    w.syncMemory({ projectId: 'p1', kind: 'state', content: 'C' });
    await w.flush();
    // Only the latest survives.
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { content: string }).content).toBe('C');
  });

  it('keeps separate checkpoint pushes (commitSha-keyed)', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncMemory({ projectId: 'p1', kind: 'checkpoint', content: 'cp1', commitSha: 'aaa' });
    w.syncMemory({ projectId: 'p1', kind: 'checkpoint', content: 'cp2', commitSha: 'bbb' });
    await w.flush();
    expect(calls).toHaveLength(2);
  });

  it('skips flush silently when no access token is available', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = new SyncWorker({ httpBase: () => BASE, accessToken: () => '', fetchImpl, batchDelayMs: 5, baseRetryMs: 5, maxRetryMs: 20 });
    w.syncChat({ id: 'c1', title: 'Held' });
    await w.flush();
    expect(calls).toHaveLength(0);
    expect(w.pendingCounts().chats).toBe(1); // still queued for when we pair
  });

  it('treats a 4xx as a permanent drop (no retry)', async () => {
    const { fetchImpl, calls } = makeFetch([400]);
    const w = newWorker(fetchImpl);
    w.syncChat({ id: 'c1' });
    await w.flush();
    expect(calls).toHaveLength(1);
    expect(w.pendingCounts().chats).toBe(0); // dropped
  });

  it('re-enqueues on a 5xx and schedules a retry', async () => {
    const { fetchImpl, calls } = makeFetch([500, 200]);
    const w = newWorker(fetchImpl);
    w.syncChat({ id: 'c1' });
    await w.flush();
    // First attempt failed → re-queued.
    expect(calls).toHaveLength(1);
    expect(w.pendingCounts().chats).toBe(1);
    // Retry timer fires; second attempt succeeds.
    await vi.advanceTimersByTimeAsync(50);
    await w.flush();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(w.pendingCounts().chats).toBe(0);
  });

  it('stop() cancels timers and drops new work', async () => {
    const { fetchImpl, calls } = makeFetch();
    const w = newWorker(fetchImpl);
    w.syncChat({ id: 'c1' });
    w.stop();
    w.syncChat({ id: 'c2' });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);
    expect(w.pendingCounts().chats).toBe(1); // only the pre-stop one stayed
  });
});
