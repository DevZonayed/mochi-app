import type { JobStatus } from './api';

/** State of the last chat turn + the composer queue, as the drainer sees it. */
export interface DrainState {
  /** The last turn is actively streaming (running/pending, not parked). */
  streaming: boolean;
  /** How many messages are waiting in the composer queue. */
  queueLength: number;
  /** A drain is already in flight (guards against double-fire). */
  draining: boolean;
  /** The last turn ended blocked by a Claude usage/rate limit — a hands-free
      auto-continue will resume THIS turn when the limit resets. */
  awaitingLimitReset: boolean;
  /** The last turn is paused/parked (e.g. a ScheduleWakeup) and will resume on
      its own. */
  lastTurnPaused: boolean;
  /** Terminal status of the last turn, or null when there is no prior turn. */
  lastStatus: JobStatus | null;
}

/**
 * The single source of truth for "may we fire the next queued message NOW?".
 *
 * Queued chat messages must drain ONE AT A TIME, and only when the agent reaches a
 * genuinely CLEAN idle. The bug this guards against: when a turn stops streaming
 * for a NON-clean reason — blocked by a usage limit, failed (incl. auto-retry
 * backoff windows), cancelled, or paused — the old drainer treated "not streaming"
 * as "ready" and burned every queued message back-to-back against the same wall
 * ("all queued messages sent at once").
 *
 * Rules (HOLD unless every check passes):
 *   1. not already streaming, queue non-empty, not mid-drain;
 *   2. not awaiting a usage-limit reset (the auto-continue resumes this turn first —
 *      after it lands on 'done' the queue resumes, one message per turn; a drained
 *      message that re-hits the limit simply re-arms the hold — self-healing);
 *   3. not paused/parked (wait for the turn to wake, don't queue behind a dormant
 *      iterator);
 *   4. the last turn finished cleanly (status 'done'). 'failed'/'cancelled' HOLD so
 *      the queue is never dumped into a broken or stopped turn; a successful retry
 *      lands on 'done' and draining resumes.
 *
 * The queue is never discarded when held — it's persisted and simply waits, and the
 * user can always Send-now / edit / remove an item explicitly.
 */
export function canDrainQueue(s: DrainState): boolean {
  if (s.streaming || s.queueLength === 0 || s.draining) return false;
  if (s.awaitingLimitReset || s.lastTurnPaused) return false;
  if (s.lastStatus != null && s.lastStatus !== 'done') return false;
  return true;
}
