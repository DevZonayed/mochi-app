/* Event replay buffer.
 *
 * Why this exists: the relay used to be transient — SSE/WS clients only saw
 * events that arrived AFTER they connected. So a phone that went offline for
 * 30 seconds (network blink, app backgrounded, screen lock) returned to a
 * stale UI and had no way to know which events it missed.
 *
 * This module sits in front of the broadcast layer:
 *   1. Every event from the desktop gets a monotonically-increasing `seq`.
 *   2. The buffer keeps the last N events (a ring buffer, bounded by the
 *      `capacity` constructor arg) so memory is fixed-size regardless of
 *      uptime.
 *   3. A reconnecting client sends `?since=<lastSeq>`; we replay events with
 *      `seq > since` then transition to live. The client's local UI is
 *      back in sync without a full refetch.
 *   4. If `since < buffer.min` (client was offline longer than the window),
 *      we signal `bufferOverflow` so the client triggers a full snapshot
 *      refetch instead of getting an incomplete delta.
 *
 * Bounded by design: this is a transient cache, NOT durability. We never
 * persist to disk — a relay restart loses the buffer and every client is
 * treated as fresh-connect. That's fine because the Mac re-pushes its full
 * snapshot on every host reconnect anyway. */

export interface BufferedEvent {
  seq: number;
  ts: number; // unix ms when the server received it
  name: string;
  data: unknown;
}

export interface ReplayResult {
  /** True iff the requested `since` is older than the oldest event we still
   *  hold — the client missed too much and should fully refetch instead of
   *  trusting the (incomplete) replay. */
  bufferOverflow: boolean;
  /** Events with `seq > since`, in original order (oldest first). */
  events: BufferedEvent[];
  /** The current latest seq — clients can stamp this even if `events` is
   *  empty so the next reconnect starts from here. */
  latestSeq: number;
}

export class EventBuffer {
  /** Ring buffer of events. `head` is the index of the OLDEST entry; once
   *  the buffer fills, push overwrites head and rotates it forward. */
  private buf: BufferedEvent[];
  private head = 0;
  private filled = false;
  private seq = 0;

  constructor(private readonly capacity = 2000) {
    if (capacity < 1) throw new Error('EventBuffer capacity must be >= 1');
    this.buf = new Array<BufferedEvent>(capacity);
  }

  /** Append an event. Returns the assigned seq. Mutating-only writers: a
   *  single ws message handler in server.ts is the sole call site. */
  push(name: string, data: unknown, now: number = Date.now()): number {
    this.seq += 1;
    const ev: BufferedEvent = { seq: this.seq, ts: now, name, data };
    if (!this.filled) {
      this.buf[this.seq - 1] = ev;
      if (this.seq >= this.capacity) this.filled = true;
    } else {
      this.buf[this.head] = ev;
      this.head = (this.head + 1) % this.capacity;
    }
    return this.seq;
  }

  /** The seq of the latest pushed event (0 if none). */
  get latestSeq(): number { return this.seq; }

  /** The seq of the OLDEST retained event (0 if buffer is empty). */
  get oldestSeq(): number {
    if (this.seq === 0) return 0;
    if (!this.filled) return 1;
    // Filled: head points at the slot we're about to overwrite, which is
    // also the oldest. seq=this.seq − (capacity − 1).
    return this.seq - this.capacity + 1;
  }

  /** Size (entries currently held). */
  get size(): number {
    return this.filled ? this.capacity : this.seq;
  }

  /** Replay events with seq > `since`. If `since < oldestSeq`, return
   *  bufferOverflow=true and an EMPTY events array — the caller must
   *  trigger a full snapshot refetch rather than show partial data. */
  since(since: number): ReplayResult {
    if (this.seq === 0) {
      return { bufferOverflow: false, events: [], latestSeq: 0 };
    }
    if (since >= this.seq) {
      // Already up to date — no replay needed.
      return { bufferOverflow: false, events: [], latestSeq: this.seq };
    }
    if (since < this.oldestSeq - 1) {
      // The client missed events that already rolled off.
      return { bufferOverflow: true, events: [], latestSeq: this.seq };
    }
    // Walk forward from oldest, emitting only what's > since.
    const out: BufferedEvent[] = [];
    if (!this.filled) {
      // Linear layout: indexes 0..seq-1 hold seq=1..seq in order.
      for (let i = 0; i < this.seq; i++) {
        const ev = this.buf[i];
        if (ev && ev.seq > since) out.push(ev);
      }
    } else {
      // Circular layout — start at head, wrap.
      for (let i = 0; i < this.capacity; i++) {
        const ev = this.buf[(this.head + i) % this.capacity];
        if (ev && ev.seq > since) out.push(ev);
      }
    }
    return { bufferOverflow: false, events: out, latestSeq: this.seq };
  }

  /** Drop everything — used by tests and on host re-pairing (the deck epoch
   *  changes, so old seqs are meaningless). */
  reset(): void {
    this.buf = new Array<BufferedEvent>(this.capacity);
    this.head = 0;
    this.filled = false;
    this.seq = 0;
  }
}
