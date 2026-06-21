/* Async retry backoff for failed runs.

   The scenario this guards (image_ni4jn.png): a job ended "Run failed —
   Interrupted — Maestro was restarted while this job was running" (the boot
   sweep marks orphaned runs failed; the operator has to tap Retry). The same
   shape covers a Claude/Codex network blip past the engine's INLINE retry
   budget (TRANSIENT_FAIL_RE in engine.ts), an OpenAI/Anthropic overload, a
   429, or a transient 5xx — none of which warrant burying the chat.

   Strategy: when a job fails with a retry-worthy error, queue a one-shot
   schedule that fires a fresh attempt after a linearly-growing delay
   (1 min → 2 min → 3 min … capped at RETRY_MAX_ATTEMPTS). On success, the
   counter for that session/job resets so a SINGLE later failure starts again
   from 1 minute — no carry-over.

   Pure module so the math + classifier are trivially unit-testable. Wiring
   (counter persistence, schedule creation, cron dispatch) lives in store.ts +
   cron.ts + engine.ts. */

/** Maximum attempts (matches the user's request — 10 escalating retries,
    then surface the failure for human attention). */
export const RETRY_MAX_ATTEMPTS = 10;

/** Delay before the Nth attempt (1-indexed). Linear: 1m, 2m, 3m, … 10m.
    Past RETRY_MAX_ATTEMPTS the caller should NOT schedule a retry — surface
    the failure instead. Inputs are clamped to keep the math safe. */
export function retryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt)) return 60_000;
  const n = Math.min(Math.max(1, Math.floor(attempt)), RETRY_MAX_ATTEMPTS);
  return n * 60_000;
}

/** Human-readable label for the schedule title / chat note. */
export function retryDelayLabel(attempt: number): string {
  const min = Math.round(retryDelayMs(attempt) / 60_000);
  return `${min} min`;
}

/* ── Failure classification ──────────────────────────────────────────── */

/** Deterministic problems that re-trying won't fix — auth, missing CLI,
    invalid key, 401/403, quota/payment, and the hard subscription-cap (which
    is handled by the separate at-reset auto-continue path, not this one). */
const NEVER_RETRY_RE = /not\s+signed\s+in|cli\s+not\s+found|not\s+found\s+on\s+this\s+Mac|invalid\s+api\s+key|unauthorized|forbidden|\b40[13]\b|insufficient|payment\s+(required|method)|claude\s+ai\s+usage\s+limit|weekly\s+limit\s+reached|5-?hour\s+limit\s+reached|quota\s+exceeded|engine\s+missing/i;

/** Failures whose root cause is transient + retrying-is-cheap: process
    crashes, network blips, the boot-sweep "Interrupted — Maestro was
    restarted" marker, provider overload, 429, 5xx. Aligned with engine.ts
    TRANSIENT_FAIL_RE but broader (it also catches our own boot-sweep + the
    engine's "kept hitting a transient error" summary, since both surface as
    a failed job the operator would otherwise have to retry by hand). */
const RETRY_WORTHY_RE = /Interrupted\s+—\s+Maestro\s+was\s+restarted|exited\s+with\s+code|exited\s+unexpectedly|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket\s+hang\s+up|fetch\s+failed|network\s+error|premature\s+close|stream\s+(?:closed|ended|error)|overloaded|rate.?limit|too\s+many\s+requests|\b429\b|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+timeout|temporarily|kept\s+hitting\s+a\s+transient\s+error|process\s+died|connection\s+reset|read\s+ECONNRESET|write\s+EPIPE/i;

/** Is this error worth a scheduled retry? Deterministic problems return
    false; transient/restart/overload errors return true. Empty/unknown
    errors return false (we never auto-retry a cancellation or a "no error"). */
export function isRetryWorthy(error: string | undefined | null): boolean {
  if (!error) return false;
  const s = String(error);
  if (NEVER_RETRY_RE.test(s)) return false;
  return RETRY_WORTHY_RE.test(s);
}

/** Convenience: pick the retry key for a job. Per-session when it's a chat
    turn (so a row of consecutive failed turns count as one streak), else
    per-job (so a one-off failure isn't muddled with chat retries). */
export function retryKeyFor(opts: { sessionId?: string | null; jobId: string }): string {
  return opts.sessionId ? `session:${opts.sessionId}` : `job:${opts.jobId}`;
}

/** Build the title for the auto-retry schedule, e.g. "Auto-retry (3/10) in 3 min". */
export function retryScheduleTitle(attempt: number): string {
  const n = Math.min(Math.max(1, Math.floor(attempt)), RETRY_MAX_ATTEMPTS);
  return `Auto-retry (${n}/${RETRY_MAX_ATTEMPTS}) in ${retryDelayLabel(n)}`;
}

/** The note we surface in the chat / job error so the operator can tell the
    failure is being auto-recovered rather than dead. */
export function retryNote(attempt: number, fireAt: number): string {
  const when = new Date(fireAt).toLocaleTimeString();
  return `↻ Auto-retry ${attempt}/${RETRY_MAX_ATTEMPTS} scheduled for ${when} (~${retryDelayLabel(attempt)}). Cancel it any time from the scheduled-messages strip.`;
}

/** Note when the cap is hit — operator action required. */
export function retryGiveUpNote(): string {
  return `✕ Auto-retry exhausted (${RETRY_MAX_ATTEMPTS} attempts). The failure looks persistent — tap Retry or check engine status.`;
}
