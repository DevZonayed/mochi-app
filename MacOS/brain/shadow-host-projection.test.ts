import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { makeTempDir } from './test-helpers.js';
import { ShadowHostCore, StaticShadowKeyProvider, type ShadowAuthority } from './shadow-host.js';
import type { Fence } from '@maestro/realtime';

const now = 1_800_000_000_000;
const key = Buffer.alloc(32, 7);
const fence: Fence = { accountId: 'acct_1', scopeId: 'account:user_1', hostDeviceId: 'host_mac_1', epoch: 1, leaseId: 'lease_1' };
function authority(): ShadowAuthority {
  return { accountId: fence.accountId, scopeId: fence.scopeId, hostDeviceId: fence.hostDeviceId, epoch: fence.epoch, leaseId: fence.leaseId, leaseExpiresAt: now + 60_000 };
}
function coreAt(dir: string, opts?: { keyId?: string; key?: Buffer; auth?: ShadowAuthority }): ShadowHostCore {
  const core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider(opts?.keyId ?? 'k1', opts?.key ?? key));
  core.setAuthority(opts?.auth ?? authority());
  return core;
}
const dirs: string[] = [];
function tmp(): string { const d = makeTempDir(); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function proj(core: ShadowHostCore, entityId: string, digest: string, data: unknown, op: 'upsert' | 'delete' = 'upsert') {
  return core.projectEntity({ fence, collection: 'project', entityId, digest, op, payload: data, now });
}

describe('ShadowHostCore.projectEntity — revision/tombstone coherence', () => {
  it('appends a new entity at revision 1, no-ops an unchanged digest, bumps on change', () => {
    const core = coreAt(tmp());
    const r1 = proj(core, 'p1', 'd1', { name: 'Alpha' });
    expect(r1.appended).toBe(true); expect(r1.revision).toBe(1);
    expect(r1.event!.op).toBe('upsert');
    expect(core.decryptEventPayload(r1.event!.eventId)).toEqual({ name: 'Alpha' });

    const r2 = proj(core, 'p1', 'd1', { name: 'Alpha' });
    expect(r2.appended).toBe(false); expect(r2.revision).toBe(1); // no-op

    const r3 = proj(core, 'p1', 'd2', { name: 'Alpha Renamed' });
    expect(r3.appended).toBe(true); expect(r3.revision).toBe(2);
    core.close();
  });

  it('emits a deterministic tombstone exactly once; reappearance bumps again', () => {
    const core = coreAt(tmp());
    proj(core, 'p1', 'd1', { name: 'Alpha' }); // rev 1
    const del = proj(core, 'p1', 'dt', { tombstone: true }, 'delete');
    expect(del.appended).toBe(true); expect(del.revision).toBe(2); expect(del.event!.op).toBe('delete');
    const del2 = proj(core, 'p1', 'dt', { tombstone: true }, 'delete');
    expect(del2.appended).toBe(false); expect(del2.revision).toBe(2); // idempotent delete

    const back = proj(core, 'p1', 'd3', { name: 'Alpha Reborn' });
    expect(back.appended).toBe(true); expect(back.revision).toBe(3);
    // index reflects live (not-deleted) now
    const live = core.projectionIndexEntities(fence.scopeId, 'project').find((e) => e.entityId === 'p1');
    expect(live).toMatchObject({ deleted: false, revision: 3 });
    core.close();
  });

  it('persists the projection index across restart — no duplicate events for unchanged state', () => {
    const dir = tmp();
    const core = coreAt(dir);
    proj(core, 'p1', 'd1', { name: 'Alpha' });
    proj(core, 'p2', 'd2', { name: 'Beta' });
    core.close();

    const reopened = coreAt(dir);
    const r = proj(reopened, 'p1', 'd1', { name: 'Alpha' }); // same digest after restart
    expect(r.appended).toBe(false); expect(r.revision).toBe(1); // recovered, no duplicate
    const changed = proj(reopened, 'p2', 'd2b', { name: 'Beta Prime' });
    expect(changed.appended).toBe(true); expect(changed.revision).toBe(2);
    reopened.close();
  });

  it('reprojects unchanged entities after authority epoch and scope key rotation', () => {
    const dir = tmp();
    const core = coreAt(dir, { keyId: 'wk_old', key: Buffer.alloc(32, 1) });
    const r1 = proj(core, 'p1', 'd1', { name: 'Alpha' });
    expect(r1.appended).toBe(true);
    core.close();

    const rotatedFence: Fence = { ...fence, epoch: 2, leaseId: 'lease_2' };
    const rotated = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('wk_new', Buffer.alloc(32, 2)));
    rotated.setAuthority({ accountId: rotatedFence.accountId, scopeId: rotatedFence.scopeId, hostDeviceId: rotatedFence.hostDeviceId, epoch: 2, leaseId: rotatedFence.leaseId, leaseExpiresAt: now + 60_000 });
    const r2 = rotated.projectEntity({ fence: rotatedFence, collection: 'project', entityId: 'p1', digest: 'd1', op: 'upsert', payload: { name: 'Alpha' }, now });
    expect(r2.appended).toBe(true);
    expect(r2.revision).toBe(1);

    const raw = new Database(join(dir, 'shadow', 'shadow.sqlite'));
    const counts = raw.prepare('SELECT epoch,key_id,COUNT(*) AS n FROM projection_index GROUP BY epoch,key_id ORDER BY epoch,key_id').all() as Array<{ epoch: number; key_id: string; n: number }>;
    const eventRows = raw.prepare('SELECT epoch,payload_envelope FROM events ORDER BY epoch ASC').all() as Array<{ epoch: number; payload_envelope: string }>;
    raw.close();
    expect(counts).toEqual([{ epoch: 1, key_id: 'wk_old', n: 1 }, { epoch: 2, key_id: 'wk_new', n: 1 }]);
    expect(eventRows.map((r) => ({ epoch: r.epoch, keyId: (JSON.parse(r.payload_envelope) as { keyId: string }).keyId }))).toEqual([
      { epoch: 1, keyId: 'wk_old' },
      { epoch: 2, keyId: 'wk_new' },
    ]);
    rotated.close();
  });

  it('quarantines a corrupt index row fail-closed without resetting other entities', () => {
    const dir = tmp();
    const core = coreAt(dir);
    proj(core, 'good', 'dg', { name: 'Good' }); // rev 1
    proj(core, 'bad', 'db', { name: 'Bad' });   // rev 1
    core.close();

    // Corrupt ONLY the 'bad' row's revision to a non-integer via a second connection.
    const raw = new Database(join(dir, 'shadow', 'shadow.sqlite'));
    raw.prepare("UPDATE projection_index SET revision=1.5 WHERE entity_id='bad'").run();
    raw.close();

    const core2 = coreAt(dir);
    const bad = proj(core2, 'bad', 'db2', { name: 'Bad Changed' });
    expect(bad.quarantined).toBe(true);
    expect(bad.appended).toBe(false);
    // The other entity is untouched + still projectable.
    const good = proj(core2, 'good', 'dg2', { name: 'Good Changed' });
    expect(good.appended).toBe(true); expect(good.revision).toBe(2);
    core2.close();
  });

  it('recovers atomically after a crash between commit and materialize (no duplicate)', () => {
    const dir = tmp();
    const core = coreAt(dir);
    core.debugSetCrashPointForTest('after-db-commit-before-materialize');
    expect(() => proj(core, 'p1', 'd1', { name: 'Alpha' })).toThrow(/crash-after-db-commit/);
    core.close();

    // Reopen: the index row + event committed atomically before the crash, so a
    // re-project of the SAME digest is a no-op (exactly-once).
    const core2 = coreAt(dir);
    const again = proj(core2, 'p1', 'd1', { name: 'Alpha' });
    expect(again.appended).toBe(false);
    expect(again.revision).toBe(1);
    core2.close();
  });

  it('rejects an invalid digest and an unsafe entity id', () => {
    const core = coreAt(tmp());
    expect(() => core.projectEntity({ fence, collection: 'project', entityId: 'p1', digest: '', op: 'upsert', payload: {}, now })).toThrow(/digest/);
    expect(() => core.projectEntity({ fence, collection: 'project', entityId: 'bad id!', digest: 'd', op: 'upsert', payload: {}, now })).toThrow();
    core.close();
  });
});
