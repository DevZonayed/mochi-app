import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice, listDevicesForUser, assertHostInAccount } from './accountDevices.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!HAS_DB)('account device registry isolation', () => {
  beforeAll(async () => {
    await runMigrations();
    await getDb().deleteFrom('device').execute();
  });
  afterAll(async () => { await closeDb(); });

  it("lists only the owner's devices and blocks cross-account host access", async () => {
    await upsertDevice({ id: 'A-host', userId: 'userA', role: 'host', name: 'A Mac', platform: 'macos', deckId: 'dA' });
    await upsertDevice({ id: 'B-host', userId: 'userB', role: 'host', name: 'B Mac', platform: 'macos', deckId: 'dB' });

    const a = await listDevicesForUser('userA');
    expect(a.map((d) => d.id)).toEqual(['A-host']);

    await expect(assertHostInAccount('userA', 'B-host')).rejects.toMatchObject({ statusCode: 404 });
    expect((await assertHostInAccount('userA', 'A-host')).id).toBe('A-host');
  });

  it('upsert updates in place (no duplicate row)', async () => {
    await upsertDevice({ id: 'A-host', userId: 'userA', role: 'host', name: 'Renamed Mac', platform: 'macos', deckId: 'dA' });
    const a = await listDevicesForUser('userA');
    expect(a.filter((d) => d.id === 'A-host')).toHaveLength(1);
    expect(a.find((d) => d.id === 'A-host')?.name).toBe('Renamed Mac');
  });
});
