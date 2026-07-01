/* Per-session composer-queue hold decision (pure).
 *
 * The chat composer lets the user type ahead while a turn is running: those
 * messages go into a per-session queue (persisted to localStorage) and drain
 * ONE AT A TIME when the session becomes idle. Two states must additionally
 * HOLD the queue instead of draining it:
 *
 *  1. A turn is live (streaming) — the normal "wait for the turn to finish" case.
 *  2. The session is blocked on Claude's usage cap. When a run hits the cap it
 *     finalizes as `status:'done'` but carries `pausedReason:'limit'` +
 *     `pausedUntil = reset`, and an `auto-continue` schedule is armed for the
 *     reset. If the queue drained here, EVERY typed-ahead message would fire at
 *     once as a burst of doomed runs (each instantly re-hitting the cap) — the
 *     reported bug. So we hold until a fresh turn supersedes the limited one
 *     (the auto-continue firing, or an explicit interrupt/send-now), then drain
 *     sequentially once the cap has actually lifted.
 *
 * The hold persists a grace window past the countdown so the renderer's 1 s tick
 * can't briefly release it and race the cron auto-continue (which ticks every
 * 30 s and can fire slightly late). The grace also guarantees the hold releases
 * eventually if the auto-continue was cancelled, so the queue never deadlocks.
 *
 * Kept dependency-free so the decision is trivially unit-testable without React.
 */

export type PausedReason = 'wakeup' | 'limit' | null | undefined;

export interface TurnLike {
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | string;
  pausedUntil?: number | null;
  pausedReason?: PausedReason;
}

export interface HoldInput {
  /** The last turn in the session, or null if there are none yet. */
  lastTurn: TurnLike | null;
  /** Is there a pending (enabled, future) auto-continue schedule for this session? */
  hasPendingAutoContinue: boolean;
  /** `Date.now()` — injected so tests are deterministic. */
  now: number;
  /** How long past the paused countdown to keep holding. Defaults to 3 min. */
  graceMs?: number;
}

export interface HoldState {
  /** A turn is actively streaming (live, not parked on a wakeup countdown). */
  streaming: boolean;
  /** The last turn was blocked by the usage cap and is still within the hold window. */
  limitPaused: boolean;
  /** Don't send/drain into this session right now: queue new messages, hold the drain. */
  held: boolean;
}

/** Default grace window: comfortably larger than the cron tick (30 s) plus the
    reset buffer (60 s), so a legitimate auto-continue always lands inside it. */
export const DEFAULT_LIMIT_HOLD_GRACE_MS = 3 * 60_000;

export function computeHoldState(input: HoldInput): HoldState {
  const { lastTurn, hasPendingAutoContinue, now } = input;
  const graceMs = input.graceMs ?? DEFAULT_LIMIT_HOLD_GRACE_MS;

  const pausedUntil = lastTurn?.pausedUntil ?? null;
  // A turn parked on a future countdown (wakeup OR limit) is not "streaming".
  const lastTurnPaused = pausedUntil != null && pausedUntil > now;
  const live = !!lastTurn && (lastTurn.status === 'running' || lastTurn.status === 'pending');
  const streaming = live && !lastTurnPaused;

  // Limit hold: sticky while the last turn ended on the cap, within the grace
  // window past the countdown. A missing `pausedUntil` (cap hit with no reported
  // reset) holds indefinitely — safer than bursting doomed runs; the user can
  // still force a send via ⌘↩ / a queue-row "send now".
  const limitPaused = lastTurn?.pausedReason === 'limit'
    && (pausedUntil == null || pausedUntil > now - graceMs);

  const held = streaming || limitPaused || hasPendingAutoContinue;
  return { streaming, limitPaused, held };
}
