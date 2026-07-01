/* Claude usage-limit reset parsing.

   When a claude.ai subscription run hits its usage cap (the 5-hour or weekly
   limit), the Agent SDK reports it two ways and we want the reset time from
   either: a structured `rate_limit_event` (status 'rejected', a `resetsAt`
   timestamp), or — for the plain CLI path — a thrown error whose message is the
   classic "Claude AI usage limit reached|<unix-seconds>". These pure helpers
   extract a normalized millisecond reset time from both, so the engine can
   schedule a hands-free "continue" for when the limit lifts. Kept dependency-free
   so they're trivially unit-testable without the SDK or Electron. */

/** Shape of the SDK's `rate_limit_info` we care about (a subset of SDKRateLimitInfo). */
export interface RateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected' | string;
  resetsAt?: number;
  overageResetsAt?: number;
  rateLimitType?: string;
  isUsingOverage?: boolean;
}

/** Anything below this is plainly seconds, not milliseconds (≈ Sep 2001 in ms). */
const MS_THRESHOLD = 1e12;

/** Normalize a reset value that may be in seconds OR milliseconds to ms. */
export function normalizeResetMs(v: number | undefined | null): number | undefined {
  if (v == null || !Number.isFinite(v) || v <= 0) return undefined;
  return v < MS_THRESHOLD ? Math.round(v * 1000) : Math.round(v);
}

/** True only when the limit is actually exhausted (request rejected), not a warning. */
export function isRejected(info: RateLimitInfo | undefined | null): boolean {
  return !!info && info.status === 'rejected';
}

/** The reset time (ms) from a rejected rate-limit event, preferring the overage
    window when the run is already spending overage. Undefined if not rejected. */
export function resetFromRateLimitInfo(info: RateLimitInfo | undefined | null): number | undefined {
  if (!isRejected(info)) return undefined;
  const raw = (info!.isUsingOverage ? info!.overageResetsAt : undefined) ?? info!.resetsAt ?? info!.overageResetsAt;
  return normalizeResetMs(raw);
}

/** Matches the explicit Claude usage-limit phrasing (NOT transient overload/429,
    which should keep retrying). Anchored to the subscription-cap wording. */
const USAGE_LIMIT_RE = /usage limit reached|claude ai usage limit|reached your usage limit|weekly limit reached|5-?hour limit reached/i;

export function isUsageLimitMessage(msg: string): boolean {
  return USAGE_LIMIT_RE.test(msg);
}

/** Parse a reset time (ms) out of a usage-limit error message. Handles the classic
    "…usage limit reached|<unix-seconds>" form and a bare trailing unix timestamp,
    plus an ISO-8601 "resets at <date>" form. Undefined if none is present. */
export function parseUsageLimitReset(msg: string): number | undefined {
  // "Claude AI usage limit reached|1708934400" — pipe-delimited unix seconds (or ms).
  const pipe = /\|\s*(\d{10,13})\b/.exec(msg);
  if (pipe) return normalizeResetMs(Number(pipe[1]));
  // "resets at 2026-06-17T18:30:00Z" / "resets 2026-06-17 18:30".
  const iso = /resets?(?:\s+at)?\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:]+(?:Z|[+-][0-9:]+)?)/i.exec(msg);
  if (iso) { const t = Date.parse(iso[1]); if (!Number.isNaN(t)) return t; }
  // A lone unix timestamp anywhere (last resort).
  const bare = /\b(1[6-9]\d{8}|20\d{8}|1[6-9]\d{11}|20\d{11})\b/.exec(msg);
  if (bare) return normalizeResetMs(Number(bare[1]));
  return undefined;
}
