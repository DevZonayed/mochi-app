import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { makeTempDir } from './test-helpers.js';
import { ShadowHostCore, StaticShadowKeyProvider, type ShadowAuthority, type ShadowHostRelayPort } from './shadow-host.js';
import { validateAuthorityFence, type Fence, type HostCommandAck } from '@maestro/realtime';

const execFileAsync = promisify(execFile);
const now = 1_800_000_000_000;
const key = Buffer.alloc(32, 7);
const oldKey = Buffer.alloc(32, 9);
const fence: Fence = {
  accountId: 'acct_1',
  scopeId: 'account:user_1',
  hostDeviceId: 'host_mac_1',
  epoch: 1,
  leaseId: 'lease_1',
};

function authority(patch: Partial<ShadowAuthority> = {}): ShadowAuthority {
  return {
    accountId: fence.accountId,
    scopeId: fence.scopeId,
    hostDeviceId: fence.hostDeviceId,
    epoch: fence.epoch,
    leaseId: fence.leaseId,
    leaseExpiresAt: now + 60_000,
    ...patch,
  };
}

function coreAt(dir: string): ShadowHostCore {
  const core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
  core.setAuthority(authority());
  return core;
}

function materialization(core: ShadowHostCore, scopeId = fence.scopeId, epoch = 1, segmentId = 'seg-1-0'): string {
  return core.debugMaterializationPathForTest(scopeId, epoch, segmentId);
}

function acceptedAck(commandId: string, resultSeq?: number): HostCommandAck {
  return {
    family: 'command-ack',
    v: 1,
    commandId,
    status: 'accepted',
    fence,
    acceptedSeq: 1,
    resultSeq,
    signedAt: now + 1,
    signature: 'a'.repeat(64),
  };
}

class RotatingKeyProvider extends StaticShadowKeyProvider {
  current = 'old';
  constructor() { super('unused', key); }
  override currentKey() {
    return this.current === 'old' ? { keyId: 'old', key: oldKey } : { keyId: 'k1', key };
  }
  override keyFor(keyId: string) {
    if (keyId === 'old') return oldKey;
    if (keyId === 'k1') return key;
    return null;
  }
}

function stableJsonForTest(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJsonForTest(obj[k])}`).join(',')}}`;
}

function sha256ForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('ShadowHostCore durable host authority', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('enforces account scope host lease fence before allocating a durable sequence', () => {
    const core = coreAt(dir);
    const good = core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_1', revision: 1, payload: { name: 'Alpha' }, now });
    expect(good.seq).toBe(1);
    expect(good.prevSeq).toBe(0);

    expect(() => core.appendEvent({
      fence: { ...fence, hostDeviceId: 'other_host' },
      collection: 'project',
      op: 'upsert',
      entityId: 'proj_2',
      revision: 1,
      payload: { name: 'Blocked' },
      now,
    })).toThrow(/fence-wrong-host/);
  });

  it('uses the accepted authority context shape and covers all fence outcomes before append', () => {
    const core = coreAt(dir);
    const ctx = {
      fence,
      leaseExpiresAt: now + 60_000,
      revokedControllerDeviceIds: new Set(['ctrl_revoked']),
    };
    expect(validateAuthorityFence(ctx, { fence, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: true });
    expect(validateAuthorityFence(ctx, { fence: { ...fence, accountId: 'acct_2' }, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: false, reason: 'wrong-account' });
    expect(validateAuthorityFence(ctx, { fence: { ...fence, scopeId: 'account:user_2' }, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: false, reason: 'wrong-scope' });
    expect(validateAuthorityFence(ctx, { fence: { ...fence, hostDeviceId: 'host_2' }, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: false, reason: 'wrong-host' });
    expect(validateAuthorityFence(ctx, { fence: { ...fence, leaseId: 'lease_2' }, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: false, reason: 'wrong-lease' });
    expect(validateAuthorityFence(ctx, { fence: { ...fence, epoch: 0 }, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: false, reason: 'stale-epoch' });
    expect(validateAuthorityFence(ctx, { fence: { ...fence, epoch: 2 }, controllerDeviceId: 'ctrl_ok', now })).toEqual({ ok: false, reason: 'future-epoch' });
    expect(validateAuthorityFence(ctx, { fence, controllerDeviceId: 'ctrl_ok', now: now + 60_000 })).toEqual({ ok: false, reason: 'expired' });
    expect(validateAuthorityFence(ctx, { fence, controllerDeviceId: 'ctrl_revoked', now })).toEqual({ ok: false, reason: 'revoked' });

    core.setAuthority(authority({ revokedControllerDeviceIds: ['ctrl_revoked'] }));
    expect(() => core.appendEvent({ fence, controllerDeviceId: 'ctrl_revoked', collection: 'project', op: 'upsert', entityId: 'proj_revoked', revision: 1, payload: {}, now })).toThrow(/fence-revoked/);
    expect(core.readEvents({ fence, fromSeq: 1, toSeq: 10, now })).toHaveLength(0);
  });

  it('persists encrypted AES-GCM envelopes and restores after restart without plaintext rows', () => {
    let core = coreAt(dir);
    const event = core.appendEvent({ fence, collection: 'session', op: 'upsert', entityId: 'sess_1', revision: 1, payload: { title: 'Secret session', token: 'never-plaintext' }, now });
    const dbBytes = readFileSync(core.paths.sqlitePath);
    expect(dbBytes.includes(Buffer.from('never-plaintext'))).toBe(false);
    expect(core.decryptEventPayload(event.eventId)).toEqual({ title: 'Secret session', token: 'never-plaintext' });

    core = coreAt(dir);
    expect(core.readEvents({ fence, fromSeq: 1, toSeq: 1, now })[0]?.eventId).toBe(event.eventId);
    expect(core.decryptEventPayload(event.eventId)).toEqual({ title: 'Secret session', token: 'never-plaintext' });
  });

  it('keeps a monotonic integrity chain across overlapping writer processes', async () => {
    const setup = coreAt(dir);
    const workerFile = join(dir, 'append-worker.mjs');
    writeFileSync(workerFile, `
      import { ShadowHostCore, StaticShadowKeyProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'brain/shadow-host.ts')).href)};
      const root = process.argv[2];
      const i = Number(process.argv[3]);
      const fence = ${JSON.stringify(fence)};
      const core = new ShadowHostCore(root, new StaticShadowKeyProvider('k1', Buffer.alloc(32, 7)));
      core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'job_' + i, revision: 1, payload: { i }, now: ${now} + i });
      core.close();
    `);
    await Promise.all(Array.from({ length: 16 }, (_, i) => execFileAsync(process.execPath, ['--import', 'tsx', workerFile, join(dir, 'shadow'), String(i)], {
      cwd: process.cwd(),
      env: process.env,
    })));

    const events = setup.readEvents({ fence, fromSeq: 1, toSeq: 16, now });
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(events.map((e) => e.prevSeq)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    const lines = readFileSync(materialization(setup), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(16);
    for (const [idx, line] of lines.entries()) {
      const record = JSON.parse(line);
      expect(record.seq).toBe(idx + 1);
      expect(record.eventId).toBe(events[idx].eventId);
      expect(record.wire.seq).toBe(idx + 1);
      expect(record.wire.payloadDigest).toBe(record.payloadDigest);
    }
    expect(setup.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
    setup.close();
  });

  it('rebuilds canonical materializations after crash points without phantom lines', () => {
    let core = coreAt(dir);
    core.debugSetCrashPointForTest('after-db-commit-before-materialize');
    expect(() => core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'job_crash_1', revision: 1, payload: { n: 1 }, now })).toThrow(/crash-after-db-commit/);
    core.close();
    core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
    expect(core.readEvents({ fence, fromSeq: 1, toSeq: 10, now })).toHaveLength(1);
    expect(readFileSync(materialization(core), 'utf8').trim().split('\n')).toHaveLength(1);

    core.setAuthority(authority());
    core.debugSetCrashPointForTest('during-temp-write');
    expect(() => core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'job_crash_2', revision: 1, payload: { n: 2 }, now: now + 1 })).toThrow(/crash-during-temp-write/);
    core.close();
    core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
    const lines = readFileSync(materialization(core), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
    expect(existsSync(`${materialization(core)}.tmp-stale`)).toBe(false);
  });

  it('isolates materialization by safe scope hash and reconciles owned orphan/temp/lock files only', () => {
    let core = coreAt(dir);
    const otherFence = { ...fence, scopeId: 'account:user_2' };
    core.setAuthority(authority({ scopeId: otherFence.scopeId }));
    core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'job_a', revision: 1, payload: { a: 1 }, now });
    core.appendEvent({ fence: otherFence, collection: 'job', op: 'upsert', entityId: 'job_b', revision: 1, payload: { b: 1 }, now });
    const first = materialization(core, fence.scopeId);
    const second = materialization(core, otherFence.scopeId);
    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);

    const orphan = core.debugMaterializationPathForTest(fence.scopeId, 1, 'seg-1-99');
    mkdirSync(join(orphan, '..'), { recursive: true });
    writeFileSync(orphan, '{}\n');
    writeFileSync(`${first}.tmp-stale`, 'partial');
    writeFileSync(`${first}.lock`, '');
    utimesSync(`${first}.tmp-stale`, new Date(0), new Date(0));
    utimesSync(`${first}.lock`, new Date(0), new Date(0));
    writeFileSync(join(core.paths.journalDir, 'unrelated.mjlog'), 'keep');
    core.close();

    core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(`${first}.tmp-stale`)).toBe(false);
    expect(existsSync(`${first}.lock`)).toBe(false);
    expect(existsSync(join(core.paths.journalDir, 'unrelated.mjlog'))).toBe(true);
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
    expect(core.verifyIntegrity(otherFence.scopeId, 1)).toEqual({ ok: true });
  });

  it('rejects retained obsolete materialization files and phantom lines', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'job_phantom', revision: 1, payload: { n: 1 }, now });
    writeFileSync(materialization(core), `${readFileSync(materialization(core), 'utf8')}{}\n`);
    expect(core.verifyIntegrity(fence.scopeId, 1)).toMatchObject({ ok: false, reason: 'segment-line-count' });
    core.debugSqlForTest('DELETE FROM segment_records WHERE scope_id=? AND seq=?', fence.scopeId, 1);
    writeFileSync(materialization(core), '{}\n');
    expect(core.verifyIntegrity(fence.scopeId, 1)).toMatchObject({ ok: false, reason: 'segment-record-count' });
  });

  it('dedupes idempotent command retries and rejects conflicting duplicate keys', () => {
    const core = coreAt(dir);
    const first = core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_1', idempotencyKey: 'idem_1', fence, params: { method: 'sendChat', text: 'hi' }, now });
    const retry = core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_1', idempotencyKey: 'idem_1', fence, params: { text: 'hi', method: 'sendChat' }, now: now + 1 });
    expect(retry).toEqual(first);
    expect(() => core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_2', idempotencyKey: 'idem_1', fence, params: { method: 'sendChat', text: 'changed' }, now: now + 2 })).toThrow(/command-conflict/);
  });

  it('creates commands atomically at row cap and across overlapping creators', async () => {
    const core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key), { maxCommandRows: 1 });
    core.setAuthority(authority());
    core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_full', idempotencyKey: 'idem_full', fence, params: { n: 1 }, now });
    expect(() => core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_over', idempotencyKey: 'idem_over', fence, params: { n: 2 }, now })).toThrow(/command-row-budget-exceeded/);
    core.close();

    const workerFile = join(dir, 'command-worker.mjs');
    writeFileSync(workerFile, `
      import { ShadowHostCore, StaticShadowKeyProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'brain/shadow-host.ts')).href)};
      const root = process.argv[2];
      const commandId = process.argv[3];
      const idem = process.argv[4];
      const core = new ShadowHostCore(root, new StaticShadowKeyProvider('k1', Buffer.alloc(32, 7)));
      core.setAuthority(${JSON.stringify(authority())});
      try {
        const state = core.createOrRetryCommand({ scopeId: ${JSON.stringify(fence.scopeId)}, commandId, idempotencyKey: idem, fence: ${JSON.stringify(fence)}, params: { same: true }, now: ${now} });
        console.log(state.commandId + ':' + state.status);
      } finally {
        core.close();
      }
    `);
    const root = join(dir, 'shadow-race');
    const first = await Promise.all([
      execFileAsync(process.execPath, ['--import', 'tsx', workerFile, root, 'cmd_same', 'idem_same'], { cwd: process.cwd(), env: process.env }),
      execFileAsync(process.execPath, ['--import', 'tsx', workerFile, root, 'cmd_same', 'idem_same'], { cwd: process.cwd(), env: process.env }),
    ]);
    expect(first.map((r) => r.stdout.trim()).sort()).toEqual(['cmd_same:sent', 'cmd_same:sent']);
    const raced = new ShadowHostCore(root, new StaticShadowKeyProvider('k1', key));
    expect(raced.debugSqlForTest('SELECT command_id FROM command_ledger WHERE scope_id=?', fence.scopeId)).toHaveLength(1);
    raced.close();
  });

  it('persists retry scheduling, duplicate-safe claims, release, and deadline expiry across restart', () => {
    let core = coreAt(dir);
    core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_retry', idempotencyKey: 'idem_retry', fence, params: { method: 'sync' }, now, deadlineAt: now + 5_000 });
    expect(core.claimRetryableCommands({ scopeId: fence.scopeId, ownerId: 'worker_1', now: now + 999, leaseMs: 1_000, limit: 10 })).toHaveLength(0);
    const firstClaim = core.claimRetryableCommands({ scopeId: fence.scopeId, ownerId: 'worker_1', now: now + 1_000, leaseMs: 1_000, limit: 10 });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0].claimToken).toMatch(/^claim_/);
    expect(core.claimRetryableCommands({ scopeId: fence.scopeId, ownerId: 'worker_2', now: now + 1_001, leaseMs: 1_000, limit: 10 })).toHaveLength(0);
    core.close();

    core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
    expect(core.releaseCommandLease({ scopeId: fence.scopeId, commandId: 'cmd_retry', ownerId: 'worker_stale', claimToken: firstClaim[0].claimToken, now: now + 1_100, nextAttemptAt: now + 1_200 })).toBe(false);
    expect(core.releaseCommandLease({ scopeId: fence.scopeId, commandId: 'cmd_retry', ownerId: 'worker_1', claimToken: firstClaim[0].claimToken, now: now + 1_100, nextAttemptAt: now + 1_200 })).toBe(true);
    expect(core.claimRetryableCommands({ scopeId: fence.scopeId, ownerId: 'worker_2', now: now + 1_200, leaseMs: 1_000, limit: 10 })).toHaveLength(1);
    expect(core.expireRetryDeadlines(fence.scopeId, now + 5_000)).toBe(1);
    expect(core.claimRetryableCommands({ scopeId: fence.scopeId, ownerId: 'worker_3', now: now + 5_001, leaseMs: 1_000, limit: 10 })).toHaveLength(0);
  });

  it('completes command ledger only after accepted ACK plus matching state event', () => {
    const core = coreAt(dir);
    core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_apply', idempotencyKey: 'idem_apply', fence, params: { method: 'runJob' }, now });
    const acked = core.applyCommandAck(fence.scopeId, acceptedAck('cmd_apply', 1), now + 1);
    expect(acked.status).toBe('accepted');

    const event = core.appendEvent({ fence, collection: 'job', op: 'patch', entityId: 'job_1', revision: 2, commandId: 'cmd_apply', payload: { status: 'done' }, now: now + 2 });
    const completed = core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_apply', idempotencyKey: 'idem_apply', fence, params: { method: 'runJob' }, now: now + 3 });
    expect(completed.status).toBe('applied');
    expect(completed.appliedEventId).toBe(event.eventId);
  });

  it('applies exactly one ACK only with a live matching claim or proven unclaimed row', () => {
    const core = coreAt(dir);
    core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_ack', idempotencyKey: 'idem_ack', fence, params: { method: 'run' }, now, deadlineAt: now + 10_000, retryDelayMs: 0 });
    const [claim] = core.claimRetryableCommands({ scopeId: fence.scopeId, ownerId: 'worker_1', now, leaseMs: 1_000, limit: 1 });
    expect(() => core.applyCommandAck(fence.scopeId, acceptedAck('cmd_ack'), now + 1)).toThrow(/command-claimed/);
    expect(() => core.applyCommandAck(fence.scopeId, acceptedAck('cmd_ack'), now + 1, { ownerId: 'worker_2', claimToken: claim.claimToken })).toThrow(/command-claim-mismatch/);
    expect(() => core.applyCommandAck(fence.scopeId, acceptedAck('cmd_ack'), now + 1_001, { ownerId: 'worker_1', claimToken: claim.claimToken })).toThrow(/command-claim-mismatch/);
    const accepted = core.applyCommandAck(fence.scopeId, acceptedAck('cmd_ack'), now + 2, { ownerId: 'worker_1', claimToken: claim.claimToken });
    expect(accepted.status).toBe('accepted');
    expect(core.applyCommandAck(fence.scopeId, acceptedAck('cmd_ack'), now + 3).status).toBe('accepted');
  });

  it('creates content-addressed encrypted snapshot chunks and plans stale cursor repair from snapshot', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_1', revision: 1, payload: { name: 'Alpha' }, now });
    const snap = core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'page_1', entities: [{ id: 'proj_1', name: 'Alpha' }] }], now: now + 1 });
    expect(snap.snapshotId).toMatch(/^shsnap_/);
    expect(snap.chunkIds[0]).toMatch(/^shcid_/);

    const plan = core.planGapRepair({ scopeId: fence.scopeId, epoch: 1, lastSeq: 0, retainedMinSeq: 1, latestSnapshotId: snap.snapshotId, latestSnapshotBaseSeq: snap.baseSeq });
    expect(plan).toEqual({ kind: 'snapshot', snapshotId: snap.snapshotId, replayFromSeq: snap.baseSeq + 1 });
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: true });
  });

  it('deep-verifies snapshot manifest rows, order, content ids, extra rows, and old keys', () => {
    const provider = new RotatingKeyProvider();
    const core = new ShadowHostCore(join(dir, 'shadow'), provider);
    core.setAuthority(authority());
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_old_key', revision: 1, payload: { name: 'Old' }, now });
    const oldSnap = core.createSnapshot({
      fence,
      chunks: [{ collection: 'project', pageKey: 'old', entities: [{ id: 'proj_old_key' }] }],
      now: now + 1,
    });
    provider.current = 'new';
    expect(core.verifySnapshot(fence.scopeId, oldSnap.snapshotId)).toEqual({ ok: true });

    const snap = core.createSnapshot({
      fence,
      chunks: [
        { collection: 'project', pageKey: 'a', entities: [{ id: 'a' }] },
        { collection: 'session', pageKey: 'b', entities: [{ id: 'b' }] },
      ],
      now: now + 2,
    });
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: true });

    const manifest = core.debugSnapshotManifestForTest(snap.snapshotId);
    const mutated = { ...manifest, chunks: [{ ...manifest.chunks[1] }, { ...manifest.chunks[0] }] };
    core.debugSqlForTest('UPDATE snapshots SET manifest_json=? WHERE snapshot_id=?', JSON.stringify(mutated), snap.snapshotId);
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: false, reason: 'snapshot-invalid' });

    core.debugSqlForTest('UPDATE snapshots SET manifest_json=? WHERE snapshot_id=?', JSON.stringify(manifest), snap.snapshotId);
    core.debugSqlForTest('UPDATE chunks SET page_key=? WHERE snapshot_id=? AND content_id=?', 'mutated', snap.snapshotId, manifest.chunks[0].contentId);
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: false, reason: 'snapshot-invalid' });

    core.debugSqlForTest('UPDATE chunks SET page_key=? WHERE snapshot_id=? AND content_id=?', manifest.chunks[0].pageKey, snap.snapshotId, manifest.chunks[0].contentId);
    core.debugSqlForTest("INSERT INTO chunks(snapshot_id,ordinal,content_id,collection,page_key,file_path,key_id,plaintext_digest,ciphertext_digest,bytes) SELECT snapshot_id,99,content_id || '_extra',collection,page_key,file_path,key_id,plaintext_digest,ciphertext_digest,bytes FROM chunks WHERE snapshot_id=? LIMIT 1", snap.snapshotId);
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: false, reason: 'snapshot-invalid' });
    core.debugSqlForTest('DELETE FROM chunks WHERE snapshot_id=? AND content_id LIKE ?', snap.snapshotId, '%_extra');
    core.debugSqlForTest('UPDATE chunks SET content_id=? WHERE snapshot_id=? AND content_id=?', 'shcid_bad', snap.snapshotId, manifest.chunks[0].contentId);
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: false, reason: 'snapshot-invalid' });
  });

  it('rejects immutable snapshot authority and boundary rewrites even with recomputed manifest digest', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_immutable', revision: 1, payload: { n: 1 }, now });
    const snap = core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'p1', entities: [{ n: 1 }] }], now: now + 1 });
    const original = core.debugSnapshotManifestForTest(snap.snapshotId);
    const fields: Array<{ sql: string; value: unknown; mutate?: (manifest: typeof original) => typeof original }> = [
      { sql: 'UPDATE snapshots SET account_id=? WHERE snapshot_id=?', value: 'acct_attacker', mutate: (manifest) => ({ ...manifest, fence: { ...manifest.fence, accountId: 'acct_attacker' } }) },
      { sql: 'UPDATE snapshots SET scope_id=? WHERE snapshot_id=?', value: 'account:attacker', mutate: (manifest) => ({ ...manifest, scopeId: 'account:attacker', fence: { ...manifest.fence, scopeId: 'account:attacker' } }) },
      { sql: 'UPDATE snapshots SET host_device_id=? WHERE snapshot_id=?', value: 'host_attacker', mutate: (manifest) => ({ ...manifest, fence: { ...manifest.fence, hostDeviceId: 'host_attacker' } }) },
      { sql: 'UPDATE snapshots SET lease_id=? WHERE snapshot_id=?', value: 'lease_attacker', mutate: (manifest) => ({ ...manifest, fence: { ...manifest.fence, leaseId: 'lease_attacker' } }) },
      { sql: 'UPDATE snapshots SET epoch=? WHERE snapshot_id=?', value: 2, mutate: (manifest) => ({ ...manifest, epoch: 2, fence: { ...manifest.fence, epoch: 2 } }) },
      { sql: 'UPDATE snapshots SET created_at=? WHERE snapshot_id=?', value: now + 999, mutate: (manifest) => ({ ...manifest, createdAt: now + 999 }) },
      { sql: 'UPDATE snapshots SET base_seq=? WHERE snapshot_id=?', value: 0, mutate: (manifest) => ({ ...manifest, baseSeq: 0, baseEventId: null, basePayloadDigest: null, baseChainHash: '0'.repeat(64) }) },
      { sql: 'UPDATE snapshots SET base_event_id=? WHERE snapshot_id=?', value: 'evil_event', mutate: (manifest) => ({ ...manifest, baseEventId: 'evil_event' }) },
      { sql: 'UPDATE snapshots SET base_payload_digest=? WHERE snapshot_id=?', value: 'f'.repeat(64), mutate: (manifest) => ({ ...manifest, basePayloadDigest: 'f'.repeat(64) }) },
      { sql: 'UPDATE snapshots SET base_chain_hash=? WHERE snapshot_id=?', value: 'e'.repeat(64), mutate: (manifest) => ({ ...manifest, baseChainHash: 'e'.repeat(64) }) },
    ];
    for (const field of fields) {
      const mutatedWithoutDigest = field.mutate ? field.mutate(original) : original;
      const { manifestDigest: _oldDigest, ...withoutDigest } = mutatedWithoutDigest;
      const digest = sha256ForTest(stableJsonForTest(withoutDigest));
      core.debugSqlForTest('UPDATE snapshots SET scope_id=?,account_id=?,host_device_id=?,lease_id=?,epoch=?,created_at=?,base_seq=?,base_event_id=?,base_payload_digest=?,base_chain_hash=?,manifest_json=?,manifest_digest=? WHERE snapshot_id=?',
        fence.scopeId, fence.accountId, fence.hostDeviceId, fence.leaseId, fence.epoch, now + 1, original.baseSeq, original.baseEventId, original.basePayloadDigest, original.baseChainHash, stableJsonForTest({ ...original, manifestDigest: original.manifestDigest }), original.manifestDigest, snap.snapshotId);
      core.debugSqlForTest('UPDATE chunks SET snapshot_id=snapshot_id WHERE snapshot_id=?', snap.snapshotId);
      core.debugSqlForTest('UPDATE snapshots SET manifest_json=?, manifest_digest=? WHERE snapshot_id=?', stableJsonForTest({ ...mutatedWithoutDigest, manifestDigest: digest }), digest, snap.snapshotId);
      core.debugSqlForTest(field.sql, field.value, snap.snapshotId);
      expect(core.verifySnapshot(field.sql.includes('scope_id') ? String(field.value) : fence.scopeId, snap.snapshotId)).toEqual({ ok: false, reason: 'snapshot-invalid' });
    }
  });

  it('keeps shared content ids as snapshot-local memberships across restart', () => {
    let core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key), { retainedSnapshots: 3 });
    core.setAuthority(authority());
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_shared_1', revision: 1, payload: { n: 1 }, now });
    const first = core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'shared', entities: [{ id: 'same' }] }], now: now + 1 });
    core.appendEvent({ fence, collection: 'project', op: 'patch', entityId: 'proj_shared_1', revision: 2, payload: { n: 2 }, now: now + 2 });
    const second = core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'shared', entities: [{ id: 'same' }] }], now: now + 3 });
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(first.chunkIds).toEqual(second.chunkIds);
    expect(core.verifySnapshot(fence.scopeId, first.snapshotId)).toEqual({ ok: true });
    expect(core.verifySnapshot(fence.scopeId, second.snapshotId)).toEqual({ ok: true });
    core.close();

    core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key), { retainedSnapshots: 3 });
    expect(core.verifySnapshot(fence.scopeId, first.snapshotId)).toEqual({ ok: true });
    expect(core.verifySnapshot(fence.scopeId, second.snapshotId)).toEqual({ ok: true });
  });

  it('enforces storage budgets before writes and evicts only unpinned CAS blobs', () => {
    const core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key), {
      maxEventEnvelopeBytes: 80,
      maxBlobBytes: 2_000,
      maxTotalBlobBytes: 1_500,
      maxCommandParamsBytes: 20,
    });
    core.setAuthority(authority());
    expect(() => core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'job_big', revision: 1, payload: { data: 'x'.repeat(200) }, now })).toThrow(/too-large/);
    expect(() => core.createOrRetryCommand({ scopeId: fence.scopeId, commandId: 'cmd_big', idempotencyKey: 'idem_big', fence, params: { data: 'x'.repeat(100) }, now })).toThrow(/command-params-too-large/);

    const pinned = core.putBlob({ plaintext: Buffer.from('pinned'), pinned: true, now });
    const old = core.putBlob({ plaintext: Buffer.from('old'.repeat(100)), now: now + 1 });
    const latest = core.putBlob({ plaintext: Buffer.from('latest'.repeat(100)), now: now + 2 });
    expect(core.readBlobRange({ contentId: pinned.contentId, start: 0, endExclusive: 6, now: now + 3 }).bytes.toString()).toBe('pinned');
    expect(() => core.readBlobRange({ contentId: old.contentId, start: 0, endExclusive: 1, now: now + 4 })).toThrow(/blob-missing/);
    expect(core.readBlobRange({ contentId: latest.contentId, start: 0, endExclusive: 6, now: now + 5 }).bytes.toString()).toBe('latest');
  });

  it('strictly validates blob ranges and only updates access metadata after verified reads', () => {
    const core = coreAt(dir);
    const blob = core.putBlob({ plaintext: Buffer.from('abcdef'), now });
    const full = core.readBlobRange({ contentId: blob.contentId, start: 1, endExclusive: 4, now: now + 1 });
    expect(full.bytes.toString()).toBe('bcd');
    expect(full.range).toEqual({ start: 1, endExclusive: 4 });
    expect(full.totalBytes).toBe(6);
    expect(full.plaintextDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => core.readBlobRange({ contentId: '../bad', start: 0, endExclusive: 1, now })).toThrow(/blob-content-id-invalid/);
    expect(() => core.readBlobRange({ contentId: blob.contentId, start: -1, endExclusive: 1, now })).toThrow(/blob-range-invalid/);
    expect(() => core.readBlobRange({ contentId: blob.contentId, start: 1, endExclusive: 1, now })).toThrow(/blob-range-invalid/);
    expect(() => core.readBlobRange({ contentId: blob.contentId, start: 4, endExclusive: 3, now })).toThrow(/blob-range-invalid/);
    expect(() => core.readBlobRange({ contentId: blob.contentId, start: 0, endExclusive: 7, now })).toThrow(/blob-range-invalid/);
    expect(() => core.readBlobRange({ contentId: blob.contentId, start: Number.MAX_SAFE_INTEGER + 1, endExclusive: Number.MAX_SAFE_INTEGER + 2, now })).toThrow(/blob-range-invalid/);
    const [{ file_path: filePath }] = core.debugSqlForTest('SELECT file_path FROM blob_cas WHERE content_id=?', blob.contentId) as { file_path: string }[];
    writeFileSync(filePath, 'corrupt');
    expect(() => core.readBlobRange({ contentId: blob.contentId, start: 0, endExclusive: 1, now: now + 2 })).toThrow(/blob-ciphertext-digest/);
  });

  it('quarantines torn/corrupt payloads and supports bounded retention', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'event', op: 'upsert', entityId: 'evt_1', revision: 1, payload: { n: 1 }, now });
    core.appendEvent({ fence, collection: 'event', op: 'upsert', entityId: 'evt_2', revision: 1, payload: { n: 2 }, now: now + 1 });

    core.debugMutateEventForTest(2, { payload_envelope: '{}' });
    const integrity = core.verifyIntegrity(fence.scopeId, 1);
    expect(integrity).toEqual({ ok: false, reason: 'segment-record-digest', seq: 2 });
    const recovery = core.startupRecovery(fence.scopeId, 1, now + 2);
    expect(recovery).toMatchObject({ ok: false, blocked: true, reason: 'segment-record-digest' });
    const quarantineId = recovery.ok ? '' : recovery.quarantineId;
    expect(quarantineId).toMatch(/^shq_/);
    expect(() => core.appendEvent({ fence, collection: 'event', op: 'upsert', entityId: 'evt_blocked', revision: 1, payload: {}, now: now + 3 })).toThrow(/scope-blocked-segment-record-digest/);

    expect(() => core.enforceRetention({ scopeId: fence.scopeId, now: now + 4, maxEvents: 1 })).toThrow(/retention-requires-verified-snapshot|retention-anchor/);
  });

  it('recovers a blocked scope only from a verified snapshot boundary', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_1', revision: 1, payload: { n: 1 }, now });
    const snap = core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'p1', entities: [{ n: 1 }] }], now: now + 1 });
    core.appendEvent({ fence, collection: 'project', op: 'patch', entityId: 'proj_1', revision: 2, payload: { n: 2 }, now: now + 2 });
    core.debugMutateEventForTest(2, { chain_hash: 'bad' });
    expect(core.startupRecovery(fence.scopeId, 1, now + 3)).toMatchObject({ ok: false, blocked: true });
    expect(core.recoverScopeFromVerifiedSnapshot({ scopeId: fence.scopeId, snapshotId: 'missing', now: now + 4 })).toEqual({ ok: false, reason: 'snapshot-missing' });
    expect(core.recoverScopeFromVerifiedSnapshot({ scopeId: fence.scopeId, snapshotId: snap.snapshotId, now: now + 4 })).toEqual({ ok: true, baseSeq: 1 });
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
  });

  it('recovers one epoch without deleting or rewriting retained rows from neighboring epochs', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'epoch_1', revision: 1, payload: { n: 1 }, now });
    const epoch1FileBefore = readFileSync(materialization(core, fence.scopeId, 1, 'seg-1-0'), 'utf8');
    core.setAuthority(authority({ epoch: 2, leaseId: 'lease_2' }));
    const fence2 = { ...fence, epoch: 2, leaseId: 'lease_2' };
    core.appendEvent({ fence: fence2, collection: 'project', op: 'upsert', entityId: 'epoch_2a', revision: 1, payload: { n: 2 }, now: now + 1 });
    const snap2 = core.createSnapshot({ fence: fence2, chunks: [{ collection: 'project', pageKey: 'e2', entities: [{ n: 2 }] }], now: now + 2 });
    core.appendEvent({ fence: fence2, collection: 'project', op: 'patch', entityId: 'epoch_2b', revision: 1, payload: { n: 3 }, now: now + 3 });
    core.debugMutateEventForTest(2, { chain_hash: 'bad' });
    expect(core.startupRecovery(fence.scopeId, 2, now + 4)).toMatchObject({ ok: false, blocked: true });
    expect(core.recoverScopeFromVerifiedSnapshot({ scopeId: fence.scopeId, snapshotId: snap2.snapshotId, now: now + 5 })).toEqual({ ok: true, baseSeq: 1 });
    expect(readFileSync(materialization(core, fence.scopeId, 1, 'seg-1-0'), 'utf8')).toBe(epoch1FileBefore);
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
    expect(core.verifyIntegrity(fence.scopeId, 2)).toEqual({ ok: true });
  });

  it('isolates external reads and relay publishing by exact epoch fence', async () => {
    let core = coreAt(dir);
    const epoch1a = core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'epoch_1a', revision: 1, payload: { epoch: 1, n: 1 }, now });
    const epoch1b = core.appendEvent({ fence, collection: 'project', op: 'patch', entityId: 'epoch_1b', revision: 1, payload: { epoch: 1, n: 2 }, now: now + 1 });
    const fence2 = { ...fence, epoch: 2, leaseId: 'lease_2' };
    core.setAuthority(authority({ epoch: 2, leaseId: 'lease_2' }));
    const epoch2a = core.appendEvent({ fence: fence2, collection: 'project', op: 'upsert', entityId: 'epoch_2a', revision: 1, payload: { epoch: 2, n: 1 }, now: now + 2 });
    const epoch2b = core.appendEvent({ fence: fence2, collection: 'project', op: 'patch', entityId: 'epoch_2b', revision: 1, payload: { epoch: 2, n: 2 }, now: now + 3 });

    expect(core.readEvents({ fence: fence2, fromSeq: 1, toSeq: 2, now: now + 4 }).map((event) => event.eventId)).toEqual([epoch2a.eventId, epoch2b.eventId]);
    expect(() => core.readEvents({ fence: { ...fence, leaseId: 'lease_2' }, fromSeq: 1, toSeq: 2, now: now + 4 })).toThrow(/fence-stale-epoch/);
    core.setAuthority(authority());
    expect(core.readEvents({ fence, fromSeq: 1, toSeq: 2, now: now + 5 }).map((event) => event.eventId)).toEqual([epoch1a.eventId, epoch1b.eventId]);
    expect(() => core.readEvents({ fence: { ...fence, scopeId: 'account:missing' }, fromSeq: 1, toSeq: 2, now: now + 5 })).toThrow(/authority-missing/);
    core.close();

    core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key));
    core.setAuthority(authority({ epoch: 2, leaseId: 'lease_2' }));
    expect(core.readEvents({ fence: fence2, fromSeq: 1, toSeq: 2, now: now + 6 }).map((event) => event.eventId)).toEqual([epoch2a.eventId, epoch2b.eventId]);

    const calls: Array<{ scopeId: string; fence: Fence; eventIds: string[]; epochs: number[] }> = [];
    const relay: ShadowHostRelayPort = {
      publishOrderedEvents(scopeId, relayFence, events) {
        calls.push({ scopeId, fence: relayFence, eventIds: events.map((event) => event.eventId), epochs: events.map((event) => event.fence.epoch) });
      },
      publishSnapshotManifest() {},
      publishSnapshotChunk() {},
      fetchCommands() { return []; },
      submitCommandAck() {},
      submitCursor() {},
    };
    await expect(core.publishPending(relay, { fence: fence2, now: now + 7 })).resolves.toBe(2);
    expect(calls).toEqual([{ scopeId: fence.scopeId, fence: fence2, eventIds: [epoch2a.eventId, epoch2b.eventId], epochs: [2, 2] }]);
    expect(core.debugSqlForTest('SELECT epoch,seq,published FROM events WHERE scope_id=? ORDER BY epoch ASC,seq ASC', fence.scopeId)).toEqual([
      { epoch: 1, seq: 1, published: 0 },
      { epoch: 1, seq: 2, published: 0 },
      { epoch: 2, seq: 1, published: 1 },
      { epoch: 2, seq: 2, published: 1 },
    ]);

    core.setAuthority(authority());
    await expect(core.publishPending(relay, { fence, now: now + 8 })).resolves.toBe(2);
    expect(calls[1]).toMatchObject({ scopeId: fence.scopeId, fence, eventIds: [epoch1a.eventId, epoch1b.eventId], epochs: [1, 1] });
    expect(core.debugSqlForTest('SELECT epoch,seq,published FROM events WHERE scope_id=? ORDER BY epoch ASC,seq ASC', fence.scopeId)).toEqual([
      { epoch: 1, seq: 1, published: 1 },
      { epoch: 1, seq: 2, published: 1 },
      { epoch: 2, seq: 1, published: 1 },
      { epoch: 2, seq: 2, published: 1 },
    ]);

    const raceCore = coreAt(join(dir, 'race'));
    const raced = raceCore.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'race_1', revision: 1, payload: { race: true }, now });
    const racingRelay: ShadowHostRelayPort = {
      publishOrderedEvents() {
        raceCore.debugSqlForTest('UPDATE events SET payload_digest=? WHERE scope_id=? AND epoch=? AND seq=? AND event_id=?', 'f'.repeat(64), fence.scopeId, fence.epoch, raced.seq, raced.eventId);
      },
      publishSnapshotManifest() {},
      publishSnapshotChunk() {},
      fetchCommands() { return []; },
      submitCommandAck() {},
      submitCursor() {},
    };
    await expect(raceCore.publishPending(racingRelay, { fence, now: now + 9 })).rejects.toThrow(/publish-mark-race/);
    expect(raceCore.debugSqlForTest('SELECT published FROM events WHERE scope_id=? AND epoch=? AND seq=?', fence.scopeId, fence.epoch, raced.seq)).toEqual([{ published: 0 }]);
  });

  it('verifies anchored retained materializations even when snapshot is at head', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'anchored_1', revision: 1, payload: { n: 1 }, now });
    core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'head', entities: [{ n: 1 }] }], now: now + 1 });
    const file = materialization(core);
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, `${good.trimEnd()}\n{}\n`);
    expect(core.verifyIntegrity(fence.scopeId, 1)).toMatchObject({ ok: false, reason: 'segment-line-count' });
    writeFileSync(file, '');
    expect(core.verifyIntegrity(fence.scopeId, 1)).toMatchObject({ ok: false, reason: 'segment-missing' });
    writeFileSync(file, good.replace('anchored_1', 'anchored_corrupt'));
    expect(core.verifyIntegrity(fence.scopeId, 1)).toMatchObject({ ok: false, reason: 'segment-line-mismatch' });
    writeFileSync(file, good);
    const phantom = core.debugMaterializationPathForTest(fence.scopeId, 1, 'seg-1-99');
    mkdirSync(join(phantom, '..'), { recursive: true });
    writeFileSync(phantom, '{}\n');
    expect(core.verifyIntegrity(fence.scopeId, 1)).toMatchObject({ ok: false, reason: 'segment-extra' });
    rmSync(phantom, { force: true });
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
  });

  it('keeps recovery blocked when post-delete rows still fail anchored verification', () => {
    const core = coreAt(dir);
    core.appendEvent({ fence, collection: 'project', op: 'upsert', entityId: 'proj_1', revision: 1, payload: { n: 1 }, now });
    const snap = core.createSnapshot({ fence, chunks: [{ collection: 'project', pageKey: 'p1', entities: [{ n: 1 }] }], now: now + 1 });
    core.appendEvent({ fence, collection: 'project', op: 'patch', entityId: 'proj_1', revision: 2, payload: { n: 2 }, now: now + 2 });
    core.debugMutateEventForTest(2, { chain_hash: 'bad' });
    expect(core.startupRecovery(fence.scopeId, 1, now + 3)).toMatchObject({ ok: false, blocked: true });
    core.debugFailNextRecoveryRebuildForTest();
    expect(core.recoverScopeFromVerifiedSnapshot({ scopeId: fence.scopeId, snapshotId: snap.snapshotId, now: now + 4 })).toEqual({ ok: false, reason: 'journal-still-corrupt' });
    expect(() => core.appendEvent({ fence, collection: 'project', op: 'patch', entityId: 'blocked', revision: 1, payload: {}, now: now + 5 })).toThrow(/scope-blocked/);
  });

  it('retains journal only behind a deep verified snapshot and removes obsolete materializations', () => {
    const core = new ShadowHostCore(join(dir, 'shadow'), new StaticShadowKeyProvider('k1', key), { safetyTailEvents: 1 });
    core.setAuthority(authority());
    for (let i = 1; i <= 4; i += 1) {
      core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: `job_${i}`, revision: 1, payload: { i }, now: now + i });
    }
    expect(() => core.enforceRetention({ scopeId: fence.scopeId, now: now + 10, maxEvents: 1 })).toThrow(/retention-requires-verified-snapshot/);
    const snap = core.createSnapshot({ fence, chunks: [{ collection: 'job', pageKey: 'all', entities: [{ count: 4 }] }], now: now + 11 });
    core.appendEvent({ fence, collection: 'job', op: 'patch', entityId: 'job_5', revision: 1, payload: { i: 5 }, now: now + 12 });
    const file = materialization(core);
    expect(existsSync(file)).toBe(true);
    const retained = core.enforceRetention({ scopeId: fence.scopeId, now: now + 13, maxEvents: 1 });
    expect(retained.deleted).toBeGreaterThan(0);
    expect(core.verifySnapshot(fence.scopeId, snap.snapshotId)).toEqual({ ok: true });
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
  });

  it('uses the same verified compaction path for explicit retention and journal budget pressure', () => {
    const core = new ShadowHostCore(join(dir, 'shadow-retention'), new StaticShadowKeyProvider('k1', key), { safetyTailEvents: 1, maxTotalJournalBytes: 10_000 });
    core.setAuthority(authority());
    for (let i = 1; i <= 4; i += 1) {
      core.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: `compact_${i}`, revision: 1, payload: { i }, now: now + i });
    }
    core.createSnapshot({ fence, chunks: [{ collection: 'job', pageKey: 'compact', entities: [{ count: 4 }] }], now: now + 5 });
    const retained = core.enforceRetention({ scopeId: fence.scopeId, now: now + 6, maxEvents: 1 });
    expect(retained.deleted).toBeGreaterThan(0);
    const afterRetention = core.debugCompactionCallsForTest();
    expect(afterRetention.retention).toBe(1);
    expect(core.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });

    const budgetCore = new ShadowHostCore(join(dir, 'shadow-budget'), new StaticShadowKeyProvider('k1', key), { safetyTailEvents: 1, maxTotalJournalBytes: 2500 });
    budgetCore.setAuthority(authority());
    budgetCore.appendEvent({ fence, collection: 'job', op: 'upsert', entityId: 'budget_1', revision: 1, payload: { i: 1 }, now });
    budgetCore.createSnapshot({ fence, chunks: [{ collection: 'job', pageKey: 'budget', entities: [{ count: 1 }] }], now: now + 1 });
    budgetCore.appendEvent({ fence, collection: 'job', op: 'patch', entityId: 'budget_2', revision: 1, payload: { pad: 'y'.repeat(300) }, now: now + 2 });
    expect(budgetCore.debugCompactionCallsForTest().budget).toBeGreaterThan(0);
    expect(budgetCore.verifyIntegrity(fence.scopeId, 1)).toEqual({ ok: true });
  });

  it('delegates deterministic blob range resume planning fail-closed', () => {
    const core = coreAt(dir);
    const plan = core.planBlobRange({ contentId: 'shcid_valid_content_1', totalBytes: 10, verifiedRanges: [{ start: 0, endExclusive: 4 }], requestedRange: { start: 0, endExclusive: 9 } });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.missingRanges).toEqual([{ start: 4, endExclusive: 9 }]);
    expect(core.planBlobRange({ contentId: '../bad', totalBytes: 10, verifiedRanges: [] })).toEqual({ ok: false, reason: 'bad-content-id' });
    expect(core.planBlobRange({ contentId: 'shcid_valid_content_1', totalBytes: 10, verifiedRanges: [{ start: 8, endExclusive: 8 }] })).toEqual({ ok: false, reason: 'bad-verified-range' });
    expect(core.planBlobRange({ contentId: 'shcid_valid_content_1', totalBytes: 10, verifiedRanges: [], requestedRange: { start: 8, endExclusive: 8 } })).toEqual({ ok: false, reason: 'bad-requested-range' });
    const full = core.planBlobRange({ contentId: 'shcid_valid_content_1', totalBytes: 10, verifiedRanges: [{ start: 0, endExclusive: 10 }] });
    expect(full).toMatchObject({ ok: true, missingRanges: [] });
    expect(() => core.createSnapshot({ fence, chunks: [{ collection: 'asset', pageKey: 'big', entities: [{ data: 'x'.repeat(200) }] }], now, maxChunkBytes: 20 })).toThrow(/chunk-too-large/);
  });
});
