/* Pure exponential retry-backoff: delay math, retry-worthy failure classifier,
   key derivation. Wiring is engine/store-level and tested via the store tests. */
import { describe, it, expect } from 'vitest';
import {
  RETRY_MAX_ATTEMPTS, retryDelayMs, retryDelayLabel,
  isRetryWorthy, retryKeyFor, retryScheduleTitle, retryNote, retryGiveUpNote,
} from './retry-backoff.js';

describe('retryDelayMs', () => {
  it('is linear: 1 min, 2 min, 3 min, … 10 min', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(180_000);
    expect(retryDelayMs(10)).toBe(600_000);
  });
  it('clamps to [1, MAX]', () => {
    expect(retryDelayMs(0)).toBe(60_000);   // attempt 0 → treated as attempt 1
    expect(retryDelayMs(-5)).toBe(60_000);
    expect(retryDelayMs(11)).toBe(600_000); // past cap → cap delay
    expect(retryDelayMs(100)).toBe(600_000);
  });
  it('handles junk input safely', () => {
    expect(retryDelayMs(Number.NaN)).toBe(60_000);
    expect(retryDelayMs(Number.POSITIVE_INFINITY)).toBe(60_000);
  });
});

describe('retryDelayLabel', () => {
  it('reads as "N min"', () => {
    expect(retryDelayLabel(1)).toBe('1 min');
    expect(retryDelayLabel(10)).toBe('10 min');
  });
});

describe('isRetryWorthy', () => {
  it('catches the boot-sweep marker (image_ni4jn.png)', () => {
    expect(isRetryWorthy('Interrupted — Maestro was restarted while this job was running.')).toBe(true);
  });
  it('catches transient network / process / overload errors', () => {
    expect(isRetryWorthy('claude exited with code 1')).toBe(true);
    expect(isRetryWorthy('ECONNRESET reading from anthropic')).toBe(true);
    expect(isRetryWorthy('fetch failed: ETIMEDOUT')).toBe(true);
    expect(isRetryWorthy('overloaded_error: 529 from upstream')).toBe(true);
    expect(isRetryWorthy('rate-limited: 429 too many requests')).toBe(true);
    expect(isRetryWorthy('502 bad gateway')).toBe(true);
    expect(isRetryWorthy('503 service unavailable')).toBe(true);
    expect(isRetryWorthy('504 gateway timeout')).toBe(true);
  });
  it('catches the engine\'s own "kept hitting a transient error" summary', () => {
    expect(isRetryWorthy('The engine kept hitting a transient error and stopped after 2 retries — usually a brief network or service blip. Tap Retry.\n\nclaude exited with code 1')).toBe(true);
  });
  it('does NOT retry deterministic / auth / quota errors', () => {
    expect(isRetryWorthy('Not signed in — `claude login` first.')).toBe(false);
    expect(isRetryWorthy('Invalid API key')).toBe(false);
    expect(isRetryWorthy('401 unauthorized')).toBe(false);
    expect(isRetryWorthy('403 forbidden')).toBe(false);
    expect(isRetryWorthy('Insufficient credits')).toBe(false);
    expect(isRetryWorthy('Payment method required')).toBe(false);
    expect(isRetryWorthy('Engine missing — download it first (Settings → Engines).')).toBe(false);
  });
  it('does NOT retry the Claude subscription cap (auto-continue handles it)', () => {
    expect(isRetryWorthy('Claude AI usage limit reached|1708934400')).toBe(false);
    expect(isRetryWorthy('weekly limit reached, please try later')).toBe(false);
    expect(isRetryWorthy('5-hour limit reached for the day')).toBe(false);
  });
  it('does NOT retry empty / unknown errors', () => {
    expect(isRetryWorthy(undefined)).toBe(false);
    expect(isRetryWorthy(null)).toBe(false);
    expect(isRetryWorthy('')).toBe(false);
    expect(isRetryWorthy('user cancelled')).toBe(false);
  });
});

describe('retryKeyFor', () => {
  it('uses session: prefix for chat turns', () => {
    expect(retryKeyFor({ sessionId: 'sess-1', jobId: 'job-A' })).toBe('session:sess-1');
  });
  it('uses job: prefix for one-off jobs', () => {
    expect(retryKeyFor({ jobId: 'job-A' })).toBe('job:job-A');
    expect(retryKeyFor({ sessionId: null, jobId: 'job-A' })).toBe('job:job-A');
  });
});

describe('schedule title + notes', () => {
  it('title shows N/10', () => {
    expect(retryScheduleTitle(3)).toBe('Auto-retry (3/10) in 3 min');
    expect(retryScheduleTitle(1)).toBe('Auto-retry (1/10) in 1 min');
  });
  it('clamps title', () => {
    expect(retryScheduleTitle(0)).toBe('Auto-retry (1/10) in 1 min');
    expect(retryScheduleTitle(99)).toBe('Auto-retry (10/10) in 10 min');
  });
  it('retryNote uses the schedule fire time + attempt', () => {
    const note = retryNote(2, Date.now() + 120_000);
    expect(note).toMatch(/Auto-retry 2\/10/);
    expect(note).toMatch(/~2 min/);
  });
  it('give-up note flags exhaustion', () => {
    expect(retryGiveUpNote()).toMatch(/Auto-retry exhausted \(10 attempts\)/);
  });
});

describe('constants', () => {
  it('MAX is 10 (matches the request)', () => {
    expect(RETRY_MAX_ATTEMPTS).toBe(10);
  });
});
