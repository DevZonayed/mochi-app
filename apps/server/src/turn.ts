/* Time-limited TURN credentials (coturn `use-auth-secret` / `lt-cred-mech`).

   The static secret lives ONLY on the relay (env `TURN_STATIC_SECRET`); clients
   fetch a short-lived username/credential pair from GET /api/turn-credentials.
   When the secret isn't configured the endpoint reports no TURN, and clients
   fall back to public STUN — which is exactly the Option-A default. */

import { createHmac } from 'node:crypto';

export interface TurnConfig {
  /** coturn host (e.g. `turn.example.com`), or null when TURN isn't configured. */
  host: string | null;
  username: string | null;
  credential: string | null;
  /** Seconds the credential stays valid; 0 when unconfigured. */
  ttl: number;
}

/** coturn HMAC cred: username = expiry-unixtime, credential = base64(HMAC-SHA1(secret, username)). */
export function makeTurnCredential(
  secret: string,
  host: string,
  ttlSeconds = 3600,
  nowMs: number = Date.now(),
): TurnConfig {
  const username = `${Math.floor(nowMs / 1000) + ttlSeconds}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { host, username, credential, ttl: ttlSeconds };
}

/** Client-facing TURN config from env; unconfigured → all-null (STUN-only). */
export function turnConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): TurnConfig {
  const secret = env.TURN_STATIC_SECRET;
  const host = env.TURN_HOST;
  if (!secret || !host) return { host: null, username: null, credential: null, ttl: 0 };
  const ttl = Number(env.TURN_TTL_SECONDS) || 3600;
  return makeTurnCredential(secret, host, ttl, nowMs);
}
