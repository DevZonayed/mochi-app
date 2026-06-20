/* SyncWorker — pushes the Mac's chat + project-memory deltas to the relay
   mirror so a phone can read yesterday's chats and the current STATE.md while
   the Mac is asleep.

   Design constraints:
   - The Mac is still the source of truth (Mac-as-the-brain principle). The
     mirror is push-only from here; we never read it back to make decisions.
   - Fire-and-forget. Callers should NOT await pushes — they hand the worker
     a delta and continue. The worker queues, retries with exponential
     backoff, and drops the delta if the relay is down for too long (the next
     in-flight delta supersedes anyway since records are upserts keyed by id).
   - No new deps: built on `fetch` + `setTimeout`. Tested by injecting a fake
     fetch.
   - Disabled when no accessToken / no httpBase is configured (e.g., the user
     hasn't paired yet) — the queue grows but never tries to send. Once a
     token shows up the next call flushes everything still in the queue.

   The desktop wiring in main.ts feeds this worker from the existing chat-write
   and STATE.md-write paths; the queue smooths bursts so a chat that ships 30
   tokens per second doesn't spam the relay. */

export interface SyncChat {
  id: string;
  projectId?: string | null;
  title?: string;
  archived?: boolean;
  updatedAt?: number;
}

export interface SyncMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface SyncMemory {
  projectId: string;
  kind: 'state' | 'checkpoint';
  content: string;
  tags?: string[];
  commitSha?: string | null;
  /** Optional explicit id — defaults to {accountId}:{projectId}:state or
      {accountId}:{projectId}:{commitSha} server-side. */
  id?: string;
}

export interface SyncWorkerOptions {
  /** Relay base URL (https://api.nexalance.cloud — NOT the wss host). */
  httpBase: () => string;
  /** Current pairing access token. Read fresh on every push so a rotation
      doesn't break the worker. Return empty when offline / unpaired. */
  accessToken: () => string;
  /** Override for tests. Real code uses globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** First retry delay (ms). Doubles up to maxRetryMs. */
  baseRetryMs?: number;
  maxRetryMs?: number;
  /** How long the worker waits idle before flushing a batch of messages. */
  batchDelayMs?: number;
  /** Drop messages older than this many ms in the queue (won't matter much
      since the mirror is upsert-by-id, but keeps memory bounded). */
  maxQueueMs?: number;
  /** Logger hook so the desktop can fold this into its existing logging. */
  log?: (msg: string, ...extras: unknown[]) => void;
}

interface PendingMessages {
  chatId: string;
  messages: SyncMessage[];
}

/** Worker for pushing Mac deltas to the relay mirror. Instantiate once in
    main.ts; call the syncX methods from the relevant write paths. */
export class SyncWorker {
  private readonly fetchImpl: typeof fetch;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly batchDelayMs: number;
  private readonly maxQueueMs: number;
  private readonly log: (msg: string, ...extras: unknown[]) => void;

  // Per-resource queues. We keep them separate so a failing chat upsert
  // doesn't block message inserts, and so we can batch messages per chat.
  private chatQueue: SyncChat[] = [];
  private messageQueue: Map<string, SyncMessage[]> = new Map();
  private memoryQueue: SyncMemory[] = [];

  // De-dupe: don't enqueue the same chat upsert twice in flight — just
  // overwrite. Same for memories (state is single-row per project).
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;
  private stopped = false;

  constructor(private readonly opts: SyncWorkerOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.baseRetryMs = opts.baseRetryMs ?? 1000;
    this.maxRetryMs = opts.maxRetryMs ?? 30_000;
    this.batchDelayMs = opts.batchDelayMs ?? 250;
    this.maxQueueMs = opts.maxQueueMs ?? 60 * 60 * 1000;
    this.log = opts.log ?? (() => { /* silent */ });
    this.retryMs = this.baseRetryMs;
  }

  /** Stop accepting new work and cancel timers. Call on app quit. */
  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** Enqueue a chat upsert. Overwrites any previously queued upsert for
      the same chat (the latest snapshot is all that matters). */
  syncChat(chat: SyncChat): void {
    if (this.stopped) return;
    const existing = this.chatQueue.findIndex((c) => c.id === chat.id);
    if (existing >= 0) this.chatQueue[existing] = { ...this.chatQueue[existing], ...chat };
    else this.chatQueue.push(chat);
    this.scheduleFlush();
  }

  /** Enqueue messages for a chat. Multiple calls for the same chat coalesce
      into one POST. */
  syncMessages(chatId: string, messages: SyncMessage[]): void {
    if (this.stopped || !messages.length) return;
    const existing = this.messageQueue.get(chatId) ?? [];
    // De-dupe on message id — later content wins (a re-stream of a token-
    // streamed assistant message should overwrite the partial one).
    const byId = new Map<string, SyncMessage>();
    for (const m of existing) byId.set(m.id, m);
    for (const m of messages) byId.set(m.id, { ...m, chatId });
    this.messageQueue.set(chatId, [...byId.values()]);
    this.scheduleFlush();
  }

  /** Enqueue a project-memory upsert. */
  syncMemory(mem: SyncMemory): void {
    if (this.stopped) return;
    // State is single-row per project — last write wins, so drop earlier
    // state queue entries for the same project+kind.
    const key = (m: SyncMemory) => `${m.projectId}:${m.kind}:${m.id ?? m.commitSha ?? 'state'}`;
    this.memoryQueue = this.memoryQueue.filter((m) => key(m) !== key(mem));
    this.memoryQueue.push(mem);
    this.scheduleFlush();
  }

  /** Drain everything queued NOW, returning a promise that resolves after the
      attempt (whether it succeeded or not). Tests use this; production code
      relies on scheduleFlush. */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const base = this.opts.httpBase();
    const token = this.opts.accessToken();
    if (!base || !token) {
      this.log('[sync] skipping flush: no base/token');
      return;
    }

    // Snapshot + clear queues so callers can keep enqueueing while we POST.
    const chats = this.chatQueue;
    const messages = this.messageQueue;
    const memories = this.memoryQueue;
    this.chatQueue = [];
    this.messageQueue = new Map();
    this.memoryQueue = [];

    let anyFailure = false;
    for (const chat of chats) {
      if (!await this.post(base, token, '/api/mirror/chat', chat)) { this.chatQueue.push(chat); anyFailure = true; }
    }
    for (const [chatId, msgs] of messages) {
      if (!await this.post(base, token, `/api/mirror/chats/${encodeURIComponent(chatId)}/messages`, { messages: msgs })) {
        this.messageQueue.set(chatId, [...(this.messageQueue.get(chatId) ?? []), ...msgs]);
        anyFailure = true;
      }
    }
    for (const mem of memories) {
      if (!await this.post(base, token, '/api/mirror/memory', mem)) { this.memoryQueue.push(mem); anyFailure = true; }
    }

    if (anyFailure) {
      // Bounded exponential backoff. The queue itself caps at maxQueueMs of
      // entries (see scheduleFlush), so a sustained outage doesn't grow
      // memory unboundedly.
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
      this.scheduleFlush(this.retryMs);
    } else {
      this.retryMs = this.baseRetryMs;
    }
  }

  /** Internal — wait `batchDelayMs` before flushing so a burst of edits
      coalesces into a single POST. */
  private scheduleFlush(after: number = this.batchDelayMs): void {
    if (this.stopped) return;
    if (this.flushTimer) return; // already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, after);
  }

  /** Returns true on 2xx, false on retryable failure. 4xx is a permanent
      drop (bad request — replaying won't help) and counts as "succeeded"
      so we don't loop forever. */
  private async post(base: string, token: string, path: string, body: unknown): Promise<boolean> {
    try {
      const res = await this.fetchImpl(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) {
        this.log(`[sync] dropping ${path}: ${res.status}`);
        return true; // permanent — don't retry
      }
      this.log(`[sync] retry ${path}: ${res.status}`);
      return false;
    } catch (e) {
      this.log(`[sync] retry ${path}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** Diagnostics. Used by tests + a future Settings → "Mirror sync" panel
      that shows whether the worker is up to date. */
  pendingCounts(): { chats: number; messageBatches: number; memories: number } {
    let messages = 0;
    for (const v of this.messageQueue.values()) messages += v.length;
    return {
      chats: this.chatQueue.length,
      messageBatches: messages,
      memories: this.memoryQueue.length,
    };
  }
}
