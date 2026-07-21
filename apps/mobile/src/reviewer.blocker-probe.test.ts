// INDEPENDENT PROBE for the claimed BLOCKER: a repair-required commit persists an
// id='current' store-load evidence row WITHOUT table/rowIdentityHash, which the
// load validator (shadowClient.ts:778) then rejects → SQLite store bricks on reload.
// Real node:sqlite, no mocks of the store logic.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Fence, ShadowStateEvent } from '@maestro/realtime';
vi.mock('expo-sqlite', () => ({}));

import { ExpoSQLiteShadowStore } from './shadowClient';
import { ShadowMobileClient, type ShadowExpectedAuthority } from './shadowClientCore';

const root: Fence = { accountId: 'acctZ', scopeId: 'scopeZ', hostDeviceId: 'hostZ', epoch: 1, leaseId: 'leaseA' };
const rootAuth: ShadowExpectedAuthority = { fence: root, controllerDeviceId: 'ctrlZ', leaseExpiresAt: 9_999 };
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const crypto = {
  decryptEvent: async (evt: ShadowStateEvent) => ({ event: evt, payload: { entityId: evt.entityId, revision: evt.revision } }),
  digest: async (bytes: Uint8Array) => `sha256:${Array.from(bytes).join('').padEnd(64, 'a').slice(0, 64)}`,
};
const evt = (seq: number, o: Partial<ShadowStateEvent> = {}): ShadowStateEvent => ({
  v: 1, eventId: `ev_${seq}`, seq, prevSeq: seq - 1, fence: root, collection: 'project', op: 'upsert',
  entityId: `p_${seq}`, revision: seq, durable: true, payloadCiphertext: `ct_${seq}`,
  payloadDigest: digest(String(seq).slice(0, 1)), keyId: 'k1', createdAt: 1_000 + seq, signature: `s_${seq}`, ...o,
});

type Raw = { exec(s: string): void; close(): void; prepare(s: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown } };
async function openReal(path: string) {
  const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync?: new (p: string) => Raw };
  if (!sqlite.DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new sqlite.DatabaseSync(path);
  const db = {
    async execAsync(s: string) { raw.exec(s); },
    async runAsync(s: string, ...p: unknown[]) { raw.prepare(s).run(...p); },
    async getAllAsync<T = Record<string, unknown>>(s: string, ...p: unknown[]) { return raw.prepare(s).all(...p) as T[]; },
    async withTransactionAsync<T>(t: () => Promise<T>) { return this.withExclusiveTransactionAsync(t); },
    async withExclusiveTransactionAsync<T>(t: () => Promise<T>): Promise<T> {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = await t(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  return { raw, db };
}

describe('BLOCKER PROBE: repair-required commit then reload on real SQLite', () => {
  it('drives the SQLite store into repair-required via a bootstrap gap, then reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blocker-'));
    try {
      const { raw, db } = await openReal(join(dir, 'b.sqlite'));
      const store = new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth);
      const c = new ShadowMobileClient({ controllerDeviceId: 'ctrlZ', hostDeviceId: 'hostZ', expectedAuthority: rootAuth, store, now: () => 2_000, crypto });
      await c.load();
      // First event with seq=2 (prevSeq=1) is a bootstrap gap → markRepair → repair-required commit.
      const r = await c.applyStateEvent(evt(2));
      expect(r.status).toBe('gap');
      expect(c.read().connection).toBe('repair-required');

      // Inspect what got persisted into shadow_repair_evidence.
      const rows = await db.getAllAsync<{ id: string; repair_class: string | null; table_name: string | null; row_identity_hash: string | null }>('SELECT id, repair_class, table_name, row_identity_hash FROM shadow_repair_evidence');
      console.log('PERSISTED_EVIDENCE', JSON.stringify(rows));
      raw.close();

      // Cold reopen + reload: this is where the validator runs against the persisted 'current' row.
      const { raw: raw2, db: db2 } = await openReal(join(dir, 'b.sqlite'));
      const store2 = new ExpoSQLiteShadowStore(db2 as never, 'ctrlZ', 'hostZ', rootAuth);
      let loadError: unknown = null;
      let loaded: Awaited<ReturnType<typeof store2.load>> | null = null;
      try { loaded = await store2.load(); } catch (e) { loadError = e; }
      console.log('RELOAD_RESULT', loadError ? `THREW: ${(loadError as Error).message}` : `OK connection=${loaded?.connection} entities=${loaded?.repairRecords?.length}`);
      raw2.close();

      // Assert the store can still be reloaded (does NOT brick).
      expect(loadError).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
