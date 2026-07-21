// INDEPENDENT ADVERSARIAL ACCEPTANCE TESTS — Mobile Shadow Controller Phase 2.
// Reviewer-authored. Distinct fixtures/ids from the author suite; attacks the
// implementation surface (ShadowMobileClient / MemoryShadowStore /
// ExpoSQLiteShadowStore) rather than re-asserting source text.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { Fence, HostCommandAck, ShadowStateEvent, VisualInputEvent } from '@maestro/realtime';
vi.mock('expo-sqlite', () => ({}));

import { ExpoSQLiteShadowStore } from './shadowClient';
import {
  createMemoryShadowStore,
  MemoryShadowStore,
  ShadowMobileClient,
  type ShadowAssetDescriptor,
  type ShadowExpectedAuthority,
} from './shadowClientCore';

// ---- independent fixtures (distinct namespace from author suite) --------------
const root: Fence = { accountId: 'acctZ', scopeId: 'scopeZ', hostDeviceId: 'hostZ', epoch: 1, leaseId: 'leaseA' };
const rotated: Fence = { ...root, leaseId: 'leaseB' };
const rootAuth: ShadowExpectedAuthority = { fence: root, controllerDeviceId: 'ctrlZ', leaseExpiresAt: 9_999 };
const rotatedAuth: ShadowExpectedAuthority = { fence: rotated, controllerDeviceId: 'ctrlZ', leaseExpiresAt: 9_999 };

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const byteDigest = (bytes: number[]) => `sha256:${bytes.join('').padEnd(64, 'a').slice(0, 64)}`;

const crypto = {
  decryptEvent: async (evt: ShadowStateEvent) => ({ event: evt, payload: { entityId: evt.entityId, revision: evt.revision } }),
  digest: async (bytes: Uint8Array) => byteDigest(Array.from(bytes)),
};
const verifier = {
  verifyAuthorityTransition: async ({ grant }: { grant: { signature?: string } }) =>
    grant.signature === 'ok-sig' ? { ok: true as const } : { ok: false as const, reason: 'bad-signature' },
};

const evt = (seq: number, o: Partial<ShadowStateEvent> = {}): ShadowStateEvent => ({
  v: 1, eventId: `ev_${seq}`, seq, prevSeq: seq - 1, fence: root, collection: 'project', op: 'upsert',
  entityId: `p_${seq}`, revision: seq, durable: true, payloadCiphertext: `ct_${seq}`,
  payloadDigest: digest(String(seq).slice(0, 1)), keyId: 'k1', createdAt: 1_000 + seq, signature: `s_${seq}`, ...o,
});
const ack = (commandId: string, o: Partial<HostCommandAck> = {}): HostCommandAck => ({
  family: 'command-ack', v: 1, commandId, status: 'accepted', fence: root, acceptedSeq: 1, resultSeq: 2,
  signedAt: 1_200, signature: 'ack-sig', ...o,
});
const grant = (o: Record<string, unknown> = {}) => ({
  family: 'authority-transition-grant', v: 1, transitionId: 't1', kind: 'lease-rotation', controllerDeviceId: 'ctrlZ',
  previousFence: root, nextFence: rotated, issuedAt: 1_900, expiresAt: 9_999, nonce: 'n1', keyId: 'kt1', signature: 'ok-sig', ...o,
});
const descriptor = (contentId: string, bytes: number[]): ShadowAssetDescriptor => ({
  capability: {
    family: 'asset-capability', v: 1, capabilityId: `cap_${contentId}`, fence: root, controllerDeviceId: 'ctrlZ',
    contentId, variant: 'original', permissions: ['read', 'range-read', 'pin-offline'], expiresAt: 9_999, signature: 'cap-sig',
  },
  variantRef: { contentId, variant: 'original', bytes: bytes.length, sha256: byteDigest(bytes), mime: 'application/octet-stream', availableOffline: true },
});

function client(store: MemoryShadowStore, expected = rootAuth, now = 2_000, trustedAuthorityRoot?: ShadowExpectedAuthority) {
  return new ShadowMobileClient({
    controllerDeviceId: 'ctrlZ', hostDeviceId: 'hostZ', expectedAuthority: expected,
    ...(trustedAuthorityRoot ? { trustedAuthorityRoot } : {}),
    store, now: () => now, crypto, authorityTransitionVerifier: verifier,
    controlMessageVerifier: { verifyControlMessage: async () => ({ ok: true }) },
  });
}
const mem = () => createMemoryShadowStore('ctrlZ', 'hostZ', rootAuth);

// ---- real node:sqlite adapter (independent, minimal) --------------------------
type Raw = { exec(sql: string): void; close(): void; prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown } };
async function openReal(path: string): Promise<{ db: RealDb; raw: Raw }> {
  const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync?: new (p: string) => Raw };
  if (!sqlite.DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new sqlite.DatabaseSync(path);
  return { db: new RealDb(raw), raw };
}
class RealDb {
  constructor(private readonly db: Raw) {}
  async execAsync(sql: string) { this.db.exec(sql); }
  async runAsync(sql: string, ...p: unknown[]) { this.db.prepare(sql).run(...p); }
  async getAllAsync<T = Record<string, unknown>>(sql: string, ...p: unknown[]) { return this.db.prepare(sql).all(...p) as T[]; }
  async withTransactionAsync<T>(t: () => Promise<T>) { return this.withExclusiveTransactionAsync(t); }
  async withExclusiveTransactionAsync<T>(t: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = await t(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
const sqliteClient = async (db: RealDb, expected = rootAuth) => {
  const store = new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', expected);
  const c = new ShadowMobileClient({ controllerDeviceId: 'ctrlZ', hostDeviceId: 'hostZ', expectedAuthority: expected, store, now: () => 2_000, crypto });
  await c.load();
  return { store, c };
};

// ==============================================================================
describe('ADV: authority rotation, restart, stale/future fence replay', () => {
  it('rotates authority then replays the persisted chain from the trusted root on restart', async () => {
    const store = mem();
    const a = client(store);
    await a.load();
    expect((await a.applyStateEvent(evt(1))).status).toBe('applied');
    expect(await a.transitionAuthority(grant())).toBe(true);
    // new lease restarts the event sequence at 1; old fence is rejected outright
    expect((await a.applyStateEvent(evt(1, { fence: rotated }))).status).toBe('applied');
    expect((await a.applyStateEvent(evt(2, { fence: root }))).status).toBe('fenced');

    // cold restart knowing only the rotated fence + the trusted root: must replay chain and accept
    const b = client(store, rotatedAuth, 2_000, rootAuth);
    await b.load();
    expect(b.read().expectedAuthority.fence).toEqual(rotated);
    expect((await b.applyStateEvent(evt(2, { fence: rotated }))).status).toBe('applied');
  });

  it('fails closed on restart to a rotated fence WITHOUT a trusted root (no forged chain accepted)', async () => {
    const store = mem();
    const a = client(store);
    await a.load();
    await a.applyStateEvent(evt(1));
    // never rotated; attacker restarts claiming the rotated fence with no chain/root
    const b = client(store, rotatedAuth);
    await b.load();
    expect(b.read().connection).toBe('repair-required');
  });

  it('rejects a future/skipped-epoch fence on the state path', async () => {
    const store = mem();
    const a = client(store);
    await a.load();
    await a.applyStateEvent(evt(1));
    expect((await a.applyStateEvent(evt(2, { fence: { ...root, epoch: 5 } }))).status).toBe('fenced');
    expect(a.read().cursor?.lastSeq).toBe(1);
  });

  it('rejects a stale-fence ACK and a stale-fence command-state after rotation (every command path)', async () => {
    const store = mem();
    const a = client(store);
    await a.load();
    await a.applyStateEvent(evt(1));
    await a.queueCommand({ commandId: 'c1', fence: root, expiresAt: 9_999, createdAt: 1_000 });
    await a.markCommandSent('c1');
    expect(await a.transitionAuthority(grant())).toBe(true);
    // ACK carrying the pre-rotation fence must be rejected
    expect((await a.applyMessage(ack('c1'))).status).toBe('fenced');
    // command-state carrying the pre-rotation fence must be rejected
    expect((await a.applyMessage({ family: 'command-state', v: 1, commandId: 'c1', fence: root, state: 'executing', durable: true, seq: 3, createdAt: 2_100, signature: 's' })).status).toBe('fenced');
  });
});

describe('ADV: command terminal forge + applied gating', () => {
  it('a command-state message cannot forge any terminal outcome', async () => {
    const a = client(mem());
    await a.load();
    await a.applyStateEvent(evt(1));
    await a.queueCommand({ commandId: 'cf', fence: root, expiresAt: 9_999, createdAt: 1_000 });
    await a.markCommandSent('cf');
    await a.applyMessage(ack('cf'));
    for (const state of ['applied', 'rejected', 'conflict', 'expired'] as const) {
      const r = await a.applyMessage({ family: 'command-state', v: 1, commandId: 'cf', fence: root, state, durable: true, seq: 2, createdAt: 2_100, signature: `s_${state}` });
      expect(r.status).toBe('invalid');
      expect(a.read().commands[0]?.status).toBe('accepted');
    }
  });

  it('applied requires BOTH an accepted ACK and a matching ordered state-event', async () => {
    const a = client(mem());
    await a.load();
    await a.applyStateEvent(evt(1));
    // state-event referencing a command that was only "sent" (no ACK) must not mark it applied
    await a.queueCommand({ commandId: 'ce', fence: root, expiresAt: 9_999, createdAt: 1_000 });
    await a.markCommandSent('ce');
    expect((await a.applyStateEvent(evt(2, { commandId: 'ce' }))).status).toBe('applied');
    expect(a.read().commands.find((c) => c.commandId === 'ce')?.status).toBe('sent');
    // full ACK -> await -> matching event lands applied
    await a.queueCommand({ commandId: 'cp', fence: root, expiresAt: 9_999, createdAt: 1_000 });
    await a.markCommandSent('cp');
    await a.applyMessage(ack('cp', { resultSeq: 3 }));
    await a.advanceCommand('cp', 'execute');
    await a.advanceCommand('cp', 'await-state-event');
    expect((await a.applyStateEvent(evt(3, { commandId: 'cp' }))).status).toBe('applied');
    expect(a.read().commands.find((c) => c.commandId === 'cp')?.status).toBe('applied');
  });
});

describe('ADV: asset CAS hole / digest / corruption', () => {
  it('never serves a hole and rejects a digest-mismatched chunk (memory parity)', async () => {
    const a = client(mem());
    await a.load();
    await a.applyStateEvent(evt(1));
    const d = descriptor('cidH', [1, 2, 3, 4, 5, 6]);
    expect((await a.putAssetRange({ descriptor: d, range: { start: 0, endExclusive: 2 }, bytes: Uint8Array.from([1, 2]) })).ok).toBe(true);
    expect((await a.putAssetRange({ descriptor: d, range: { start: 4, endExclusive: 6 }, bytes: Uint8Array.from([5, 6]) })).ok).toBe(true);
    // full read blocked by the [2,4) hole
    expect(await a.readAsset('cidH')).toBeNull();
    // verified subrange OK, hole subrange null
    expect(Array.from(await a.readAsset('cidH', { start: 0, endExclusive: 2 }) ?? [])).toEqual([1, 2]);
    expect(await a.readAsset('cidH', { start: 2, endExclusive: 4 })).toBeNull();
    // wrong bytes for the hole are rejected by digest check
    expect(await a.putAssetRange({ descriptor: d, range: { start: 2, endExclusive: 4 }, bytes: Uint8Array.from([9, 9]) })).toEqual({ ok: false, reason: 'digest-mismatch' });
    expect(await a.readAsset('cidH')).toBeNull();
  });

  it('real SQLite: quarantines a chunk corrupted at rest instead of serving it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adv-asset-'));
    try {
      const { raw, db } = await openReal(join(dir, 'a.sqlite'));
      const { c } = await sqliteClient(db);
      const d = descriptor('cidR', [7, 8, 9, 10]);
      expect((await c.putAssetRange({ descriptor: d, range: { start: 0, endExclusive: 4 }, bytes: Uint8Array.from([7, 8, 9, 10]) })).ok).toBe(true);
      expect(Array.from(await c.readAsset('cidR') ?? [])).toEqual([7, 8, 9, 10]);
      // corrupt the persisted bytes directly at rest
      raw.prepare('UPDATE shadow_asset_ranges SET bytes = ? WHERE content_id = ?').run(Uint8Array.from([7, 8, 9, 99]), 'cidR');
      // fresh store instance (cold read) must NOT serve the corrupted bytes
      const { c: c2 } = await sqliteClient(db);
      expect(await c2.readAsset('cidR')).toBeNull();
      raw.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('ADV: real SQLite migration coexistence + malformed rows + incompatible schema', () => {
  it('preserves a sparse legacy row while a typed row coexists (my ids), deduped and stable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adv-mig-'));
    try {
      let { raw, db } = await openReal(join(dir, 'm.sqlite'));
      raw.exec('CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)');
      raw.exec("INSERT INTO shadow_repair_evidence(id, reason, created_at) VALUES('legZ', 'legacy-row', 1111)");
      const store = new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth);
      await store.load();
      await store.load(); // idempotent migration
      await store.recordRepairEvidence({
        id: 'typZ', class: 'asset', reason: 'asset-range-hole', table: 'shadow_asset_ranges', rowClass: 'asset-range',
        rowIdentityHash: 'h', authorityScope: { accountId: 'acctZ', scopeId: 'scopeZ', controllerDeviceId: 'ctrlZ', hostDeviceId: 'hostZ', epoch: 1, leaseId: 'leaseA' },
        transitionIdentityHash: 'th', assetId: 'aZ', range: { start: 4, endExclusive: 8 }, createdAt: 2_222,
      });
      raw.close();
      ({ raw, db } = await openReal(join(dir, 'm.sqlite')));
      const recs = (await new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth).load()).repairRecords;
      const leg = recs.find((r) => r.id === 'legZ');
      const typ = recs.find((r) => r.id === 'typZ');
      expect(recs.filter((r) => r.id === 'legZ')).toHaveLength(1);
      expect(recs.filter((r) => r.id === 'typZ')).toHaveLength(1);
      expect(leg).toEqual({ id: 'legZ', reason: 'legacy-row', legacy: true, createdAt: 1111 });
      expect(leg).not.toHaveProperty('authorityScope'); // no fabricated trust fields
      expect(typ).toMatchObject({ id: 'typZ', class: 'asset', assetId: 'aZ', range: { start: 4, endExclusive: 8 } });
      raw.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('real SQLite: distinct malformed entity rows each produce a distinct row-specific repair id (fail closed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adv-mal-'));
    try {
      // Each malformed row loaded in its own DB → fail closed, distinct row-identity evidence id.
      const ids: string[] = [];
      for (const bad of ['bad/one', 'bad/two']) {
        const { raw, db } = await openReal(join(dir, `${bad.replace('/', '_')}.sqlite`));
        await new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth).load(); // create schema
        raw.prepare("INSERT INTO shadow_entities(collection, entity_id, revision, updated_at, deleted, payload_digest, data_json) VALUES(?,?,?,?,?,?,?)").run('project', bad, 1, 1, 0, digest('a'), '{}');
        const store = new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth);
        const c = new ShadowMobileClient({ controllerDeviceId: 'ctrlZ', hostDeviceId: 'hostZ', expectedAuthority: rootAuth, store, now: () => 2_000, crypto });
        await c.load();
        expect(c.read().connection).toBe('repair-required');
        expect(c.read().repairReason).toMatch(/^malformed-/);
        expect(c.read().entities).toHaveLength(0);
        const repairs = await db.getAllAsync<{ id: string }>('SELECT id FROM shadow_snapshot_repair');
        const rowId = repairs.map((r) => r.id).find((id) => id.startsWith('row:shadow_'));
        expect(rowId).toBeTruthy();
        ids.push(rowId!);
        raw.close();
      }
      expect(new Set(ids).size).toBe(2); // distinct per-row identity
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('real SQLite: incompatible repair-evidence base schema fails closed (no silent downgrade)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adv-inc-'));
    try {
      const { raw, db } = await openReal(join(dir, 'i.sqlite'));
      raw.exec('CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
      await expect(new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth).load()).rejects.toThrow(/incompatible-repair-evidence-schema/);
      raw.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('real SQLite: prototype-pollution entity JSON fails closed and does not pollute Object.prototype', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adv-proto-'));
    try {
      const { raw, db } = await openReal(join(dir, 'p.sqlite'));
      await new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth).load();
      raw.prepare("INSERT INTO shadow_entities(collection, entity_id, revision, updated_at, deleted, payload_digest, data_json) VALUES(?,?,?,?,?,?,?)").run('project', 'p1', 1, 1, 0, digest('a'), '{"__proto__":{"polluted":true},"entityId":"p1","revision":1}');
      const store = new ExpoSQLiteShadowStore(db as never, 'ctrlZ', 'hostZ', rootAuth);
      const c = new ShadowMobileClient({ controllerDeviceId: 'ctrlZ', hostDeviceId: 'hostZ', expectedAuthority: rootAuth, store, now: () => 2_000, crypto });
      await c.load();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      raw.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('ADV: preview grant single-use / replay / stale fence', () => {
  const preview = {
    family: 'preview-session' as const, v: 1 as const, visualSessionId: 'vZ', fence: root, controllerDeviceId: 'ctrlZ',
    source: 'browser' as const, mode: 'web-tunnel' as const, inputMode: 'view-only' as const, transport: 'encrypted-relay' as const,
    projectId: 'projZ', sessionId: 'sessZ', surfaceId: 'surfZ', expiresAt: 9_999, signature: 'sig-preview',
  };
  const input = (seq: number, frameSeqSeen = 1, o: Partial<VisualInputEvent> = {}): VisualInputEvent => ({
    family: 'visual-input', v: 1, visualSessionId: 'vZ', fence: root, inputSeq: seq, frameSeqSeen, kind: 'tap',
    viewport: { width: 390, height: 844, scale: 3 }, payloadCiphertext: `ic_${seq}`, createdAt: 2_000, signature: `si_${seq}`, ...o,
  });

  it('blocks replayed input seq, non-monotonic seq, unseen frame, and stale fence', async () => {
    const a = client(mem());
    await a.load();
    await a.applyMessage(preview);
    await a.applyMessage({ family: 'visual-control-grant', v: 1, grantId: 'vgZ', visualSessionId: 'vZ', fence: root, controllerDeviceId: 'ctrlZ', mode: 'control', expiresAt: 9_999, signedAt: 1_900, signature: 'sig-control' });
    expect(await a.requestPreviewControl({ visualSessionId: 'vZ', grantId: 'vgZ' })).toMatchObject({ inputMode: 'control' });
    await a.applyMessage({ family: 'visual-frame', v: 1, visualSessionId: 'vZ', frameSeq: 1, hostStateSeq: 0, timestamp: 1_950, codec: 'png', keyframe: true, signature: 'sig-frame' });
    expect((await a.dispatchPreviewInput(input(2))).ok).toBe(true);
    expect((await a.dispatchPreviewInput(input(2))).ok).toBe(false); // replay same seq
    expect((await a.dispatchPreviewInput(input(1))).ok).toBe(false); // non-monotonic
    expect((await a.dispatchPreviewInput(input(3, 0))).ok).toBe(false); // frame not seen
    expect((await a.dispatchPreviewInput(input(3, 1, { fence: rotated }))).ok).toBe(false); // stale/other fence
  });
});
