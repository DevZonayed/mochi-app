import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice } from './accountDevices.js';
import { markOnline, subscribe } from './redis.js';
import { forwardCommand, submitResult } from './routing.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!HAS_DB)('command routing (bounded, account-scoped)', () => {
  beforeAll(async () => {
    await runMigrations();
    await getDb().deleteFrom('device').execute();
    await upsertDevice({ id: 'host-1', userId: 'owner', role: 'host', name: 'Mac', platform: 'macos', deckId: 'd1' });
  });
  afterAll(async () => { await closeDb(); });

  it('delivers a command to the host and resolves with its reply', async () => {
    await markOnline('host-1', 30);
    // Fake host: the instance holding host-1's WS would do this.
    const unsub = subscribe('cmd:host:host-1', (raw) => {
      const m = raw as { cmdId: string; method: string };
      submitResult(m.cmdId, true, { echo: m.method });
    });
    const res = await forwardCommand('owner', 'host-1', 'ping', {}, 5000);
    expect(res).toEqual({ echo: 'ping' });
    unsub();
  });

  it('rejects a cross-account host with 404 (isolation)', async () => {
    await markOnline('host-1', 30);
    await expect(forwardCommand('intruder', 'host-1', 'ping', {}, 5000)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects 503 when the host is offline', async () => {
    await upsertDevice({ id: 'host-off', userId: 'owner', role: 'host', name: 'Off', platform: 'macos', deckId: 'd2' });
    await expect(forwardCommand('owner', 'host-off', 'ping', {}, 5000)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('rejects 504 when the host never replies (no infinite hang)', async () => {
    await markOnline('host-1', 30);
    // No subscriber answers → must time out fast (injected 150ms), not hang.
    await expect(forwardCommand('owner', 'host-1', 'ping', {}, 150)).rejects.toMatchObject({ statusCode: 504 });
  });
});
