/* Pure helper for ScheduleWakeup pause tracking.
 *
 * The Claude Agent SDK holds the `query()` async iterator OPEN across a
 * `ScheduleWakeup` (verified in the wild: a job sat 11 h on status:'running'
 * with the transcript ending in a successful ScheduleWakeup + final text and
 * no result message — i.e. `runClaude`'s for-await loop never exited, so the
 * caller's status:'done' transition was never reached). Without intervention
 * the UI says "Responding…" through the entire dormant gap.
 *
 * This helper turns the raw SDK message stream into discrete `paused` /
 * `resumed` events for the renderer:
 *
 *   1. tool_use { name: 'ScheduleWakeup', id, input.delaySeconds } → remember
 *      the (clamped) delay against the tool id.
 *   2. tool_result { tool_use_id, is_error } that matches a remembered id:
 *      success → emit `paused` with pausedUntil = now + delay*1000.
 *      error   → discard the pending entry; no pause.
 *   3. Any subsequent assistant content (the wakeup fired and the model is
 *      speaking again) → emit `resumed`.
 *   4. Terminal cleanup (runClaude returning or throwing) → emit `resumed`
 *      if still paused, so a stale countdown never accompanies done / failed /
 *      cancelled.
 *
 * The SDK clamps the model's requested delay to [60, 3600] s; we mirror the
 * clamp so the UI's countdown doesn't overshoot when the model asks for >1 h
 * (the real wakeup would fire much earlier and the countdown would jump).
 *
 * Idempotent paused/resumed emission: back-to-back wakeups in one turn fire
 * `paused` once (the second is a no-op until the first is resumed); a resumed
 * call with no active pause is a no-op. Callers can invoke `resume()` freely
 * in finally-style cleanup without double-emitting.
 */

export const MIN_WAKEUP_SECONDS = 60;
export const MAX_WAKEUP_SECONDS = 3600;

/** Extract a clamped, validated `delaySeconds` from a ScheduleWakeup tool_use
    input. Returns null when the input is missing / malformed / non-positive
    (the wakeup will be silently ignored — no pause is recorded, the iterator
    behaviour is unchanged). */
export function parseWakeupDelay(input: unknown): number | null {
  const raw = (input as { delaySeconds?: unknown } | null | undefined)?.delaySeconds;
  const n = typeof raw === 'number' && isFinite(raw) ? raw : Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  return Math.min(MAX_WAKEUP_SECONDS, Math.max(MIN_WAKEUP_SECONDS, Math.floor(n)));
}

export type PauseEvent =
  | { kind: 'paused'; until: number; reason: 'wakeup' }
  | { kind: 'resumed' };

/** Pure stateful tracker for the wakeup-pause lifecycle. Driven by callbacks
    from the engine's stream loop; emits `paused` / `resumed` exactly when the
    state transitions (idempotent), so a caller can wire it straight to the
    RunHooks onPaused/onResumed without their own debounce. The clock is
    injected so tests are deterministic. */
export class WakeupPauseTracker {
  private readonly now: () => number;
  private readonly pending = new Map<string, number>(); // toolUseId → clamped seconds
  private paused = false;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Note a ScheduleWakeup tool_use so its tool_result can be matched. Non-
      ScheduleWakeup tools and tools with malformed input are silently ignored. */
  onToolUse(id: string | undefined, name: string | undefined, input: unknown): void {
    if (!id || name !== 'ScheduleWakeup') return;
    const seconds = parseWakeupDelay(input);
    if (seconds == null) return;
    this.pending.set(id, seconds);
  }

  /** Match a tool_result against pending wakeups. Returns a `paused` event the
      first time a SUCCESSFUL ScheduleWakeup result lands (subsequent wakeups
      while already paused are no-ops until a resume happens). An is_error
      result for a pending wakeup just discards it — no pause. Returns null
      for any other tool_result. */
  onToolResult(toolUseId: string | undefined, isError: boolean): PauseEvent | null {
    if (!toolUseId) return null;
    const seconds = this.pending.get(toolUseId);
    if (seconds == null) return null;
    this.pending.delete(toolUseId);
    if (isError) return null; // SDK didn't arm the wakeup; nothing to pause for
    if (this.paused) return null; // already paused — second wakeup just slides under it
    this.paused = true;
    return { kind: 'paused', until: this.now() + seconds * 1000, reason: 'wakeup' };
  }

  /** Call when the next assistant message arrives with real content. If we
      were dormant the wakeup just fired — emit `resumed`. Otherwise a no-op. */
  onAssistantContent(): PauseEvent | null {
    if (!this.paused) return null;
    this.paused = false;
    return { kind: 'resumed' };
  }

  /** Terminal cleanup — runClaude returning / throwing / aborting. Emits
      `resumed` if still paused so a stale countdown can't accompany a
      done/failed/cancelled status. Idempotent. */
  reset(): PauseEvent | null {
    this.pending.clear();
    if (!this.paused) return null;
    this.paused = false;
    return { kind: 'resumed' };
  }

  /** Diagnostic — true while a pause is being held. */
  get isPaused(): boolean { return this.paused; }
}
