/* Redis coordination layer: presence (TTL), host snapshot mirror, and pub/sub
   fan-out so the server runs as N stateless instances. Under tests (or when
   REDIS_URL is unset) it uses ioredis-mock — a devDependency loaded lazily so it
   never ships to production. */
import { Redis } from 'ioredis';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function makeClient(): Redis {
  if (process.env.NODE_ENV === 'test' || !process.env.REDIS_URL) {
    const RedisMock = require('ioredis-mock') as new () => Redis;
    return new RedisMock();
  }
  const client = new Redis(process.env.REDIS_URL as string, {
    // Keep retrying forever with a bounded backoff instead of giving up.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  // CRITICAL: ioredis emits an 'error' event on every connection blip (idle close,
  // network hiccup, reconnect). Without a listener Node treats it as an uncaught
  // exception and CRASHES the process — which crash-looped the whole relay and hung
  // every new /ws/remote/screen upgrade. Swallow (log) errors here; ioredis reconnects
  // on its own via retryStrategy above.
  client.on('error', (err: Error) => {
    try { console.error('[redis] connection error (recovering):', err?.message ?? err); } catch { /* */ }
  });
  return client;
}

const main: Redis = makeClient();
export const pub: Redis = makeClient();

export const markOnline = (deviceId: string, ttlSec = 30): Promise<unknown> =>
  main.set(`presence:device:${deviceId}`, '1', 'EX', ttlSec);
export const markOffline = (deviceId: string): Promise<unknown> => main.del(`presence:device:${deviceId}`);
export const isOnline = async (deviceId: string): Promise<boolean> =>
  (await main.exists(`presence:device:${deviceId}`)) === 1;

export const setSnapshot = (hostId: string, snap: unknown): Promise<unknown> =>
  main.set(`snapshot:host:${hostId}`, JSON.stringify(snap), 'EX', 120);
export const getSnapshot = async (hostId: string): Promise<unknown> => {
  const v = await main.get(`snapshot:host:${hostId}`);
  return v ? JSON.parse(v) : null;
};

/* ── Set primitives (used by push token store) ────────────────────────── */
export const sAdd = (key: string, member: string): Promise<number> => main.sadd(key, member);
export const sRem = (key: string, member: string): Promise<number> => main.srem(key, member);
export const sMembers = (key: string): Promise<string[]> => main.smembers(key);
export const sCard = (key: string): Promise<number> => main.scard(key);

/** Set a key ONLY if it doesn't exist (atomic cross-instance dedupe). Returns
    true on first-write, false when the key was already present. */
export async function setNxEx(key: string, value: string, ttlSec: number): Promise<boolean> {
  const r = await main.set(key, value, 'EX', ttlSec, 'NX');
  return r === 'OK';
}

export const publish = (channel: string, msg: unknown): Promise<number> =>
  pub.publish(channel, JSON.stringify(msg));

/** Subscribe to a channel; returns an unsubscribe disposer. Each subscription
    owns its own connection (ioredis can't mix subscribe with normal commands). */
export function subscribe(channel: string, cb: (msg: unknown) => void): () => void {
  const c = makeClient();
  void c.subscribe(channel);
  const handler = (chan: string, raw: string): void => {
    if (chan !== channel) return;
    try { cb(JSON.parse(raw)); } catch { /* non-JSON */ }
  };
  c.on('message', handler);
  return () => {
    c.removeListener('message', handler);
    void c.unsubscribe(channel);
    void c.quit();
  };
}
