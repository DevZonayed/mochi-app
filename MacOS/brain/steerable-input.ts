/**
 * A single-consumer async input channel for the Claude Agent SDK's STREAMING-INPUT
 * mode. Passing `query({ prompt: channel.stream })` (an AsyncIterable, not a string)
 * keeps the SDK session OPEN: the agent processes `first` as its initial user turn,
 * then the channel can `push()` more user messages mid-session — a STEER — which the
 * SDK delivers at the next turn boundary WITHOUT aborting the CLI subprocess or
 * resuming the conversation from disk (the old cancel-then-reseed path). `close()`
 * ends the input so the SDK finalises and the output stream completes.
 *
 * Why a hand-rolled channel instead of an inline `async function*`: the generator is
 * the SDK's INPUT side, but the decisions that drive it live on the OUTPUT side (the
 * for-await loop reading the SDK's message stream) — WHEN to feed a steer, and WHEN
 * to end the turn (settled, nothing pending). This object bridges the two with a
 * push/close API the loop calls, and is unit-tested in isolation from the real SDK.
 *
 * Single consumer only: `stream` is iterated by exactly one for-await loop.
 */
export interface SteerableInput<T> {
  /** The AsyncGenerator handed to `query({ prompt })`. Yields `first`, then each
      pushed message in order, then completes once `close()` is called and the queue
      is drained. */
  readonly stream: AsyncGenerator<T, void, unknown>;
  /** Queue another user message (a steer). Returns false if the channel is already
      closed (the turn finished first → the caller should fall back to a normal send). */
  push(msg: T): boolean;
  /** Signal end-of-input. Idempotent. A consumer blocked awaiting input unblocks and
      the generator completes once any already-queued messages are drained. */
  close(): void;
  /** Count of pushed-but-not-yet-yielded messages. The output loop reads this on a
      turn boundary to decide if it's final (0 → close) or a steer is mid-flight (>0). */
  pending(): number;
  /** True once `close()` has been called. */
  readonly closed: boolean;
}

export function createSteerableInput<T>(first: T): SteerableInput<T> {
  const queue: T[] = [];
  let closed = false;
  // The single waiter parked in the generator's `await` while the queue is empty.
  // Resolved by push()/close(); cleared on resolve so it's armed at most once.
  let wake: (() => void) | null = null;
  const signal = () => { const w = wake; wake = null; w?.(); };

  async function* gen(): AsyncGenerator<T, void, unknown> {
    yield first;
    while (true) {
      // Check the queue at the loop top BEFORE parking, so a push that lands while
      // we're between iterations is never lost (no missed-wakeup race).
      if (queue.length) { yield queue.shift()!; continue; }
      if (closed) return;
      await new Promise<void>(res => { wake = res; });
    }
  }

  return {
    stream: gen(),
    push(msg: T): boolean {
      if (closed) return false;
      queue.push(msg);
      signal();
      return true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      signal();
    },
    pending: () => queue.length,
    get closed() { return closed; },
  };
}
