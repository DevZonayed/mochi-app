import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice } from './accountDevices.js';
import { subscribe } from './redis.js';
import { routeSignal, turnCredentials } from './webrtc.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!HAS_DB)('webrtc signaling (account-scoped)', () => {
  beforeAll(async () => {
    await runMigrations();
    await getDb().deleteFrom('device').execute();
    await upsertDevice({ id: 'acct1-host', userId: 'acct1', role: 'host', name: 'Mac', platform: 'macos', deckId: 'd' });
    await upsertDevice({ id: 'acct1-phone', userId: 'acct1', role: 'remote', name: 'iPhone', platform: 'ios' });
    await upsertDevice({ id: 'acct2-host', userId: 'acct2', role: 'host', name: 'OtherMac', platform: 'macos', deckId: 'd2' });
  });
  afterAll(async () => { await closeDb(); });

  it('routes a signal to a host in the same account', async () => {
    const got = new Promise<{ fromDeviceId: string; signal: unknown }>((resolve) => {
      const unsub = subscribe('signal:device:acct1-host', (m) => { unsub(); resolve(m as never); });
    });
    await routeSignal('acct1', 'acct1-phone', 'acct1-host', { type: 'offer', sdp: 'x' });
    const msg = await got;
    expect(msg.fromDeviceId).toBe('acct1-phone');
    expect(msg.signal).toEqual({ type: 'offer', sdp: 'x' });
  });

  it("rejects signaling another account's device (404)", async () => {
    await expect(routeSignal('acct1', 'acct1-phone', 'acct2-host', { type: 'offer' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('turn credentials', () => {
  it('returns nulls when TURN is unconfigured', () => {
    delete process.env.TURN_HOST; delete process.env.TURN_SECRET; delete process.env.TURN_STATIC_SECRET;
    expect(turnCredentials()).toEqual({ host: null, username: null, credential: null, ttl: 0 });
  });
  it('returns time-limited creds when configured', () => {
    process.env.TURN_HOST = 'turn:turn.example.com:3478';
    process.env.TURN_SECRET = 's3cr3t';
    const c = turnCredentials(1_000_000_000_000);
    expect(c.host).toBe('turn:turn.example.com:3478');
    expect(c.username).toBe(String(1_000_000_000 + 3600));
    expect(c.credential).toBeTruthy();
    delete process.env.TURN_HOST; delete process.env.TURN_SECRET;
  });
});
