/* WebRTC support: session-authed TURN/STUN credentials and account-scoped
   signaling. Signaling is just a device-targeted routed message — a remote can
   only ever negotiate a peer with a device in its OWN account (else 404), so P2P
   inherits the same isolation as everything else. Falls back to the relay path
   in the clients when P2P can't connect. */
import { createHmac } from 'node:crypto';
import { assertDeviceInAccount } from './accountDevices.js';
import { publishSignal } from './routing.js';

export interface TurnCreds { host: string | null; username: string | null; credential: string | null; ttl: number; }

/** Time-limited TURN credentials (HMAC over TURN_SECRET, the coturn REST contract).
    All-null when TURN isn't configured → clients use public STUN. */
export function turnCredentials(now: number = Date.now()): TurnCreds {
  const host = process.env.TURN_HOST || null;
  const secret = process.env.TURN_SECRET || null;
  if (!host || !secret) return { host: null, username: null, credential: null, ttl: 0 };
  const ttl = 3600;
  const username = String(Math.floor(now / 1000) + ttl);
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { host, username, credential, ttl };
}

/** Route a WebRTC signal (offer/answer/ICE) to a device in the SAME account.
    Throws {statusCode:404} if the target isn't in the caller's account. */
export async function routeSignal(
  userId: string,
  fromDeviceId: string,
  toDeviceId: string,
  signal: unknown,
): Promise<void> {
  await assertDeviceInAccount(userId, toDeviceId);
  publishSignal(toDeviceId, fromDeviceId, signal);
}
