/* Pure parsing of Claude usage-limit reset times from both the structured SDK
   rate-limit event and the classic CLI error message. */
import { describe, it, expect } from 'vitest';
import { normalizeResetMs, isRejected, resetFromRateLimitInfo, isUsageLimitMessage, parseUsageLimitReset } from './limit-reset.js';

describe('normalizeResetMs', () => {
  it('passes through millisecond timestamps', () => {
    const ms = 1_900_000_000_000; // well past the seconds/ms threshold
    expect(normalizeResetMs(ms)).toBe(ms);
  });
  it('promotes second timestamps to milliseconds', () => {
    expect(normalizeResetMs(1_700_000_000)).toBe(1_700_000_000_000);
  });
  it('rejects junk', () => {
    expect(normalizeResetMs(undefined)).toBeUndefined();
    expect(normalizeResetMs(0)).toBeUndefined();
    expect(normalizeResetMs(-5)).toBeUndefined();
    expect(normalizeResetMs(Number.NaN)).toBeUndefined();
  });
});

describe('rate-limit info', () => {
  it('only flags a rejected status', () => {
    expect(isRejected({ status: 'rejected' })).toBe(true);
    expect(isRejected({ status: 'allowed_warning' })).toBe(false);
    expect(isRejected({ status: 'allowed' })).toBe(false);
    expect(isRejected(undefined)).toBe(false);
  });
  it('extracts the reset time only when rejected', () => {
    expect(resetFromRateLimitInfo({ status: 'rejected', resetsAt: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(resetFromRateLimitInfo({ status: 'allowed_warning', resetsAt: 1_700_000_000 })).toBeUndefined();
  });
  it('prefers the overage window when spending overage', () => {
    const info = { status: 'rejected' as const, resetsAt: 1_700_000_000, overageResetsAt: 1_700_003_600, isUsingOverage: true };
    expect(resetFromRateLimitInfo(info)).toBe(1_700_003_600_000);
  });
  it('falls back to resetsAt when not on overage', () => {
    const info = { status: 'rejected' as const, resetsAt: 1_700_000_000, overageResetsAt: 1_700_003_600, isUsingOverage: false };
    expect(resetFromRateLimitInfo(info)).toBe(1_700_000_000_000);
  });
});

describe('usage-limit message detection', () => {
  it('matches the explicit subscription-cap wording', () => {
    expect(isUsageLimitMessage('Claude AI usage limit reached|1708934400')).toBe(true);
    expect(isUsageLimitMessage('You have reached your usage limit')).toBe(true);
    expect(isUsageLimitMessage('weekly limit reached, try later')).toBe(true);
  });
  it('does NOT match transient overload (those should retry)', () => {
    expect(isUsageLimitMessage('Overloaded')).toBe(false);
    expect(isUsageLimitMessage('429 too many requests')).toBe(false);
    expect(isUsageLimitMessage('process exited with code 1')).toBe(false);
  });
});

describe('parseUsageLimitReset', () => {
  it('parses the pipe-delimited unix-seconds CLI form', () => {
    expect(parseUsageLimitReset('Claude AI usage limit reached|1708934400')).toBe(1_708_934_400_000);
  });
  it('parses a pipe-delimited millisecond form', () => {
    expect(parseUsageLimitReset('limit reached|1708934400000')).toBe(1_708_934_400_000);
  });
  it('parses an ISO "resets at" form', () => {
    expect(parseUsageLimitReset('usage limit reached; resets at 2026-06-17T18:30:00Z')).toBe(Date.parse('2026-06-17T18:30:00Z'));
  });
  it('returns undefined when no time is present', () => {
    expect(parseUsageLimitReset('usage limit reached, please try again later')).toBeUndefined();
  });
});
