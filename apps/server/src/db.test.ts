import { describe, it, expect, afterAll } from 'vitest';
import { getDb, runMigrations, closeDb } from './db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!HAS_DB)('db', () => {
  afterAll(async () => { await closeDb(); });

  it('runs migrations and the device table exists', async () => {
    await runMigrations();
    const rows = await getDb().selectFrom('device').selectAll().execute();
    expect(Array.isArray(rows)).toBe(true);
  });
});
