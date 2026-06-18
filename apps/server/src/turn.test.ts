import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeTurnCredential, turnConfigFromEnv } from './turn.js';

describe('turn credentials', () => {
  it('makeTurnCredential builds an expiry username + HMAC-SHA1 credential', () => {
    const now = 1_700_000_000_000; // fixed ms
    const cfg = makeTurnCredential('s3cret', 'turn.example.com', 3600, now);
    expect(cfg.host).toBe('turn.example.com');
    expect(cfg.username).toBe(`${Math.floor(now / 1000) + 3600}`);
    const expected = createHmac('sha1', 's3cret').update(cfg.username as string).digest('base64');
    expect(cfg.credential).toBe(expected);
    expect(cfg.ttl).toBe(3600);
  });

  it('turnConfigFromEnv returns STUN-only (nulls) when unconfigured', () => {
    expect(turnConfigFromEnv({})).toEqual({ host: null, username: null, credential: null, ttl: 0 });
  });

  it('turnConfigFromEnv mints creds when secret + host present', () => {
    const now = 1_700_000_000_000;
    const cfg = turnConfigFromEnv(
      { TURN_STATIC_SECRET: 's', TURN_HOST: 'turn.example.com', TURN_TTL_SECONDS: '60' },
      now,
    );
    expect(cfg.host).toBe('turn.example.com');
    expect(cfg.ttl).toBe(60);
    expect(cfg.username).toBe(`${Math.floor(now / 1000) + 60}`);
    expect(cfg.credential).toBeTruthy();
  });
});
