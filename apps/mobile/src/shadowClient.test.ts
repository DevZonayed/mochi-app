import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BlobCapability, BlobVariantRef, CommandLifecycleState, Fence, HostCommandAck, ShadowStateEvent, ShadowWireMessage, VisualInputEvent } from '@maestro/realtime';
vi.mock('expo-sqlite', () => ({}));

import { ExpoSQLiteShadowStore } from './shadowClient';
import { createMemoryShadowStore, derivedShadowPersistedId, sha256Hex, shadowIdentityDigest, ShadowMobileClient, type ShadowAssetDescriptor, type ShadowAuthorityTransitionGrant, type ShadowExpectedAuthority, type ShadowRepairEvidence, type ShadowState, type ShadowStore } from './shadowClientCore';

const fence: Fence = {
  accountId: 'acct_1',
  scopeId: 'scope_1',
  hostDeviceId: 'host_1',
  epoch: 1,
  leaseId: 'lease_1',
};

const otherFence: Fence = { ...fence, leaseId: 'lease_2' };
const expectedAuthority: ShadowExpectedAuthority = { fence, controllerDeviceId: 'ctrl_1', leaseExpiresAt: 9_999 };

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const byteDigest = (bytes: number[]) => `sha256:${bytes.join('').padEnd(64, 'a').slice(0, 64)}`;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const maxSafeId = (prefix: string) => prefix + 'x'.repeat(128 - prefix.length);

const event = (seq: number, overrides: Partial<ShadowStateEvent> = {}): ShadowStateEvent => ({
  v: 1,
  eventId: `event_${seq}`,
  seq,
  prevSeq: seq - 1,
  fence,
  collection: 'project',
  op: 'upsert',
  entityId: `project_${seq}`,
  revision: seq,
  durable: true,
  payloadCiphertext: `ciphertext_${seq}`,
  payloadDigest: digest(String(seq).slice(0, 1)),
  keyId: 'key_1',
  createdAt: 1_000 + seq,
  signature: `sig_${seq}`,
  ...overrides,
});

const acceptedAck = (commandId: string, overrides: Partial<HostCommandAck> = {}): HostCommandAck => ({
  family: 'command-ack',
  v: 1,
  commandId,
  status: 'accepted',
  fence,
  acceptedSeq: 1,
  resultSeq: 2,
  signedAt: 1_200,
  signature: 'sig_ack',
  ...overrides,
});

const descriptor = (contentId: string, totalBytes: number, sha256 = digest('a')): ShadowAssetDescriptor => {
  const variantRef: BlobVariantRef = {
    contentId,
    variant: 'original',
    bytes: totalBytes,
    sha256,
    mime: 'application/octet-stream',
    availableOffline: true,
  };
  const capability: BlobCapability = {
    family: 'asset-capability',
    v: 1,
    capabilityId: `cap_${contentId}`,
    fence,
    controllerDeviceId: 'ctrl_1',
    contentId,
    variant: variantRef.variant,
    permissions: ['read', 'range-read', 'pin-offline'],
    expiresAt: 9_999,
    signature: 'sig_cap',
  };
  return { capability, variantRef };
};

function makeClient(store: ShadowStore = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority), now = 2_000, expected = expectedAuthority) {
  return new ShadowMobileClient({
    controllerDeviceId: 'ctrl_1',
    hostDeviceId: 'host_1',
    expectedAuthority: expected,
    store,
    now: () => now,
    crypto: {
      decryptEvent: async (evt) => ({ event: evt, payload: { entityId: evt.entityId, revision: evt.revision } }),
      digest: async (bytes) => `sha256:${Array.from(bytes).join('').padEnd(64, 'a').slice(0, 64)}`,
    },
    authorityTransitionVerifier: {
      verifyAuthorityTransition: async ({ grant }) => grant.signature === 'sig_transition' ? { ok: true } : { ok: false, reason: 'bad-signature' },
    },
    controlMessageVerifier: {
      verifyControlMessage: async () => ({ ok: true }),
    },
  });
}

const transitionGrant = (overrides: Record<string, unknown> = {}): ShadowAuthorityTransitionGrant => ({
  family: 'authority-transition-grant',
  v: 1,
  transitionId: 'transition_1',
  kind: 'lease-rotation',
  controllerDeviceId: 'ctrl_1',
  previousFence: fence,
  nextFence: otherFence,
  issuedAt: 1_900,
  expiresAt: 9_999,
  nonce: 'nonce_1',
  keyId: 'key_transition_1',
  signature: 'sig_transition',
  ...overrides,
}) as ShadowAuthorityTransitionGrant;

const commandState = (status: CommandLifecycleState['status'], commandId = `cmd_${status.replace(/[^A-Za-z0-9]/g, '_')}`): CommandLifecycleState => ({
  commandId,
  status,
  fence,
  createdAt: 1_000,
  expiresAt: 9_999,
  ...(status === 'applied' ? { appliedEventId: `event_${commandId}` } : {}),
  ...(status === 'rejected' ? { rejectReason: 'denied' } : {}),
});

class FakeSQLiteDatabase {
  repairEvidenceColumns = new Map<string, string>([
    ['id', 'TEXT'],
    ['reason', 'TEXT'],
    ['repair_class', 'TEXT'],
    ['row_class', 'TEXT'],
    ['table_name', 'TEXT'],
    ['row_identity_hash', 'TEXT'],
    ['account_id', 'TEXT'],
    ['scope_id', 'TEXT'],
    ['controller_device_id', 'TEXT'],
    ['host_device_id', 'TEXT'],
    ['epoch', 'INTEGER'],
    ['lease_id', 'TEXT'],
    ['transition_identity_hash', 'TEXT'],
    ['asset_id', 'TEXT'],
    ['range_start', 'INTEGER'],
    ['range_end_exclusive', 'INTEGER'],
    ['created_at', 'INTEGER'],
  ]);
  assets = new Map<string, { content_id: string; variant: string; total_bytes: number; digest: string; verified_ranges_json: string; last_accessed_at: number }>();
  ranges: { content_id: string; start: number; end_exclusive: number; digest: string; bytes: Uint8Array }[] = [];
  repairs: { id: string; reason: string; created_at: number }[] = [];
  repairEvidence: Record<string, unknown>[] = [];
  authorityRows: Record<string, unknown>[] = [];
  entityRows: Record<string, unknown>[] = [];
  commandRows: Record<string, unknown>[] = [];
  grantRows: Record<string, unknown>[] = [];
  visualGrantRows: Record<string, unknown>[] = [];
  previewRows: Record<string, unknown>[] = [];
  transitionRows: Record<string, unknown>[] = [];

  async execAsync(): Promise<void> {}
  async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> { return task(); }
  async withExclusiveTransactionAsync<T>(task: () => Promise<T>): Promise<T> { return task(); }

  async runAsync(sql: string, ...params: unknown[]): Promise<void> {
    if (sql.startsWith('ALTER TABLE shadow_repair_evidence ADD COLUMN')) {
      const match = /^ALTER TABLE shadow_repair_evidence ADD COLUMN ([a-z_]+) (TEXT|INTEGER)$/.exec(sql);
      if (!match) throw new Error(`unexpected alter: ${sql}`);
      this.repairEvidenceColumns.set(match[1], match[2]);
      return;
    }
    if (sql.startsWith('INSERT OR REPLACE INTO shadow_assets')) {
      this.assets.set(String(params[0]), {
        content_id: String(params[0]),
        variant: String(params[1]),
        total_bytes: Number(params[2]),
        digest: String(params[3]),
        verified_ranges_json: String(params[4]),
        last_accessed_at: Number(params[5]),
      });
      return;
    }
    if (sql.startsWith('INSERT OR REPLACE INTO shadow_asset_ranges')) {
      this.ranges = this.ranges.filter((range) => !(range.content_id === params[0] && range.start === params[1] && range.end_exclusive === params[2]));
      this.ranges.push({ content_id: String(params[0]), start: Number(params[1]), end_exclusive: Number(params[2]), digest: String(params[3]), bytes: Uint8Array.from(params[4] as Uint8Array) });
      return;
    }
    if (sql.startsWith('UPDATE shadow_assets SET last_accessed_at')) {
      const asset = this.assets.get(String(params[1]));
      if (asset) asset.last_accessed_at = Number(params[0]);
      return;
    }
    if (sql.startsWith('UPDATE shadow_assets SET verified_ranges_json')) {
      const asset = this.assets.get(String(params[1]));
      if (asset) asset.verified_ranges_json = String(params[0]);
      return;
    }
    if (sql.startsWith('DELETE FROM shadow_asset_ranges')) {
      if (params.length === 3) this.ranges = this.ranges.filter((range) => !(range.content_id === params[0] && range.start === params[1] && range.end_exclusive === params[2]));
      else this.ranges = this.ranges.filter((range) => range.content_id !== params[0]);
      return;
    }
    if (sql.startsWith('DELETE FROM shadow_assets')) {
      this.assets.delete(String(params[0]));
      return;
    }
    if (sql.startsWith('INSERT OR REPLACE INTO shadow_snapshot_repair')) {
      this.repairs.push({ id: String(params[0]), reason: String(params[1]), created_at: Number(params[2]) });
      return;
    }
    if (sql.startsWith('INSERT OR REPLACE INTO shadow_repair_evidence')) {
      const row = {
        id: params[0],
        reason: params[1],
        repair_class: params[2],
        row_class: params[3],
        table_name: params[4],
        row_identity_hash: params[5],
        account_id: params[6],
        scope_id: params[7],
        controller_device_id: params[8],
        host_device_id: params[9],
        epoch: params[10],
        lease_id: params[11],
        transition_identity_hash: params[12],
        asset_id: params[13],
        range_start: params[14],
        range_end_exclusive: params[15],
        created_at: params[16],
      };
      this.repairEvidence = [...this.repairEvidence.filter((item) => item.id !== row.id), row];
      return;
    }
  }

  async getAllAsync<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (sql.includes('FROM shadow_authority WHERE')) return this.withRowid(this.authorityRows) as T[];
    if (sql.includes('FROM shadow_entities')) return this.withRowid(this.entityRows) as T[];
    if (sql.includes('FROM shadow_commands')) return this.withRowid(this.commandRows) as T[];
    if (sql.includes('FROM shadow_grants')) return this.withRowid(this.grantRows) as T[];
    if (sql.includes('FROM shadow_visual_grants')) return this.withRowid(this.visualGrantRows) as T[];
    if (sql.includes('FROM shadow_previews')) return this.withRowid(this.previewRows) as T[];
    if (sql.startsWith('SELECT total_bytes')) {
      const asset = this.assets.get(String(params[0]));
      return (asset ? [asset] : []) as T[];
    }
    if (sql.includes('FROM shadow_authority_transitions')) {
      return this.withRowid(this.transitionRows) as T[];
    }
    if (sql.includes('FROM shadow_assets')) {
      return Array.from(this.assets.values()) as T[];
    }
    if (sql.includes('FROM shadow_snapshot_repair')) return this.withRowid(this.repairs) as T[];
    if (sql.includes('FROM shadow_repair_evidence')) {
      const rows = this.repairEvidence.map((row) => this.normalizeRepairEvidence(row));
      return this.withRowid(rows) as T[];
    }
    if (sql.startsWith('PRAGMA table_info(shadow_repair_evidence)')) {
      return Array.from(this.repairEvidenceColumns.entries()).map(([name, type], cid) => ({ cid, name, type, notnull: 0, dflt_value: null, pk: name === 'id' ? 1 : 0 })) as T[];
    }
    if (sql.startsWith('SELECT start')) {
      return this.ranges
        .filter((range) => range.content_id === params[0] && (params.length === 1 || (range.end_exclusive > Number(params[1]) && range.start < Number(params[2]))))
        .sort((a, b) => a.start - b.start || a.end_exclusive - b.end_exclusive) as T[];
    }
    return [] as T[];
  }

  private withRowid(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((row, index) => ({ __rowid: index + 1, ...row }));
  }

  private normalizeRepairEvidence(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Array.from(this.repairEvidenceColumns.keys()).map((name) => [name, row[name] ?? null]));
  }
}

type NodeSqliteDatabaseSync = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  };
};

async function openRealSQLite(path: string): Promise<{ db: RealSQLiteDatabase; raw: NodeSqliteDatabaseSync }> {
  const sqlite = await import('node:sqlite') as unknown as { DatabaseSync?: new (path: string) => NodeSqliteDatabaseSync };
  if (!sqlite.DatabaseSync) throw new Error('node:sqlite DatabaseSync unavailable');
  const raw = new sqlite.DatabaseSync(path);
  return { db: new RealSQLiteDatabase(raw), raw };
}

class RealSQLiteDatabase {
  constructor(private readonly db: NodeSqliteDatabaseSync) {}

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(sql: string, ...params: unknown[]): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async getAllAsync<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
    return this.withExclusiveTransactionAsync(task);
  }

  async withExclusiveTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await task();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const malformedRowCases: [keyof FakeSQLiteDatabase, Record<string, unknown>][] = [
  ['authorityRows', { controller_device_id: 'ctrl_1', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: -1, lease_id: 'lease_1', lease_expires_at: 9_999, cursor_last_seq: null, cursor_last_event_id: null, cursor_last_digest: null, cursor_json: null, connection: 'online', transport: 'relay', repair_reason: null }],
  ['entityRows', { collection: 'project', entity_id: 'bad/id', revision: 1, updated_at: 1, deleted: 0, payload_digest: digest('a'), data_json: '{}' }],
  ['commandRows', { command_id: 'cmd_1', status: 'not-a-status', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: 1, lease_id: 'lease_1', created_at: 1, expires_at: 2, result_seq: null, applied_event_id: null, reject_reason: null, ack_json: null, pending_event_json: null }],
  ['grantRows', { grant_id: 'grant_1', controller_device_id: 'ctrl_1', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: 1, lease_id: 'lease_1', expires_at: -1, revoked_at: null, shadow_only: 0 }],
  ['visualGrantRows', { grant_id: 'vgrant_1', visual_session_id: 'vis_1', controller_device_id: 'ctrl_1', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: 1, lease_id: 'lease_1', mode: 'write', project_id: null, session_id: null, surface_id: null, expires_at: 9_999, signed_at: 1, signature: 'sig' }],
  ['previewRows', { visual_session_id: 'vis_1', controller_device_id: 'ctrl_1', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: 1, lease_id: 'lease_1', mode: 'web-tunnel', input_mode: 'control', project_id: null, session_id: null, surface_id: null, expires_at: 9_999, active_grant_id: null, last_input_seq: -1, min_frame_seq: 0, last_frame_seq: 0 }],
];

describe('ShadowMobileClient bootstrap, cursor and transactions', () => {
  it('keeps cursor null until a valid first authority event initializes a full ShadowCursor', async () => {
    const client = makeClient();
    await client.load();
    expect(client.read().cursor).toBeNull();

    const gap = await client.applyStateEvent(event(2));
    expect(gap.status).toBe('gap');
    expect(client.read().cursor).toBeNull();
    expect(client.read().connection).toBe('repair-required');

    const repaired = makeClient();
    await repaired.load();
    const first = await repaired.applyStateEvent(event(1));
    expect(first.status).toBe('applied');
    expect(repaired.read().cursor).toMatchObject({
      fence,
      lastSeq: 1,
      lastEventId: 'event_1',
      lastDigest: digest('1'),
    });
  });

  it.each([
    ['accountId', { ...fence, accountId: 'acct_other' }],
    ['scopeId', { ...fence, scopeId: 'scope_other' }],
    ['hostDeviceId', { ...fence, hostDeviceId: 'host_other' }],
    ['epoch', { ...fence, epoch: 2 }],
    ['leaseId', { ...fence, leaseId: 'lease_other' }],
  ] as const)('fails closed on first event with wrong %s authority', async (_field, badFence) => {
    const client = makeClient();
    await client.load();
    expect((await client.applyStateEvent(event(1, { fence: badFence }))).status).toBe('fenced');
    expect(client.read().cursor).toBeNull();
    expect(client.read().entities).toHaveLength(0);
    expect(client.read().connection).toBe('repair-required');
  });

  it('fails closed when configured controller binding does not match expected authority', async () => {
    const client = makeClient(createMemoryShadowStore('ctrl_1', 'host_1', { ...expectedAuthority, controllerDeviceId: 'ctrl_other' }), 2_000, { ...expectedAuthority, controllerDeviceId: 'ctrl_other' });
    await client.load();
    expect((await client.applyStateEvent(event(1))).status).toBe('fenced');
    expect(client.read().cursor).toBeNull();
  });

  it('fails closed on restart when stored authority differs from configured expected authority', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    await client.applyStateEvent(event(1));
    const restarted = makeClient(store, 2_000, { ...expectedAuthority, fence: { ...fence, leaseId: 'lease_other' } });
    await restarted.load();
    expect(restarted.read().connection).toBe('repair-required');
    expect(restarted.read().repairReason).toBe('transition-chain-incomplete');
  });

  it('requires an explicit validated authority transition before accepting a new fence', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    expect((await client.applyStateEvent(event(1, { fence: otherFence }))).status).toBe('fenced');
    expect(await client.transitionAuthority({ expectedAuthority: { ...expectedAuthority, fence: otherFence }, grantSignature: 'sig_handoff', signedAt: 1_900 })).toBe(false);
    expect(await client.transitionAuthority(transitionGrant())).toBe(true);
    expect(await client.transitionAuthority(transitionGrant())).toBe(false);
    expect((await client.applyStateEvent(event(1, { fence: otherFence }))).status).toBe('applied');
    expect((await client.applyStateEvent(event(2, { fence }))).status).toBe('fenced');

    const restartedFromRoot = makeClient(store, 2_000, expectedAuthority);
    await restartedFromRoot.load();
    expect(restartedFromRoot.read().expectedAuthority.fence).toEqual(otherFence);
    expect(restartedFromRoot.read().connection).toBe('repair-required');
    expect((await restartedFromRoot.applyStateEvent(event(2, { fence: otherFence }))).status).toBe('applied');

    const transitioned = makeClient(store, 2_000, { ...expectedAuthority, fence: otherFence });
    await transitioned.load();
    expect(transitioned.read().connection).toBe('repair-required');
    expect(transitioned.read().repairReason).toBe('trusted-root-required');

    const transitionedWithRoot = new ShadowMobileClient({
      controllerDeviceId: 'ctrl_1',
      hostDeviceId: 'host_1',
      expectedAuthority: { ...expectedAuthority, fence: otherFence },
      trustedAuthorityRoot: expectedAuthority,
      store,
      now: () => 2_000,
      crypto: { decryptEvent: async (evt) => ({ event: evt, payload: { entityId: evt.entityId, revision: evt.revision } }), digest: async (bytes) => byteDigest(Array.from(bytes)) },
      authorityTransitionVerifier: { verifyAuthorityTransition: async ({ grant }) => grant.signature === 'sig_transition' ? { ok: true } : { ok: false, reason: 'bad-signature' } },
    });
    await transitionedWithRoot.load();
    expect((await transitionedWithRoot.applyStateEvent(event(1, { fence: otherFence }))).status).toBe('duplicate');

    const unrelatedRoot = makeClient(store, 2_000, { ...expectedAuthority, fence: { ...fence, scopeId: 'scope_other' } });
    await unrelatedRoot.load();
    expect(unrelatedRoot.read().connection).toBe('repair-required');
    expect(unrelatedRoot.read().repairReason).toBe('transition-chain-gap');
  });

  it('fails closed when the persisted authority transition chain is corrupt or replayed', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    expect(await client.transitionAuthority(transitionGrant())).toBe(true);
    const mutable = store as unknown as { state: { authorityTransitions: { previousFence: Fence }[] } };
    mutable.state.authorityTransitions[0] = { ...mutable.state.authorityTransitions[0], previousFence: { ...fence, leaseId: 'lease_missing' } };
    const restarted = makeClient(store, 2_000, expectedAuthority);
    await restarted.load();
    expect(restarted.read().connection).toBe('repair-required');
    expect(restarted.read().repairReason).toBe('transition-chain-gap');
  });

  it('fails closed when persisted transition chain is cleared, duplicated, or reordered', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    expect(await client.transitionAuthority(transitionGrant())).toBe(true);
    const mutable = store as unknown as { state: { authorityTransitions: unknown[] } };
    const original = [...mutable.state.authorityTransitions];
    mutable.state.authorityTransitions = [];
    const cleared = makeClient(store, 2_000, { ...expectedAuthority, fence: otherFence });
    await cleared.load();
    expect(cleared.read().connection).toBe('repair-required');

    mutable.state.authorityTransitions = [original[0], original[0]];
    const duplicated = makeClient(store, 2_000, { ...expectedAuthority, fence: otherFence });
    await duplicated.load();
    expect(duplicated.read().connection).toBe('repair-required');
  });

  it.each([
    ['wrong controller', { controllerDeviceId: 'ctrl_other' }],
    ['cross account', { nextFence: { ...otherFence, accountId: 'acct_other' } }],
    ['epoch skip', { kind: 'handoff', nextFence: { ...otherFence, epoch: 3 } }],
    ['expired', { expiresAt: 1_999 }],
    ['future', { issuedAt: 2_001 }],
    ['bad verifier', { signature: 'sig_bad' }],
  ])('rejects invalid authority transition: %s', async (_name, overrides) => {
    const client = makeClient();
    await client.load();
    const before = client.read();
    expect(await client.transitionAuthority(transitionGrant(overrides))).toBe(false);
    expect(client.read()).toEqual(before);
  });

  it('preserves terminal command history and marks only nonterminal commands stale on authority transition', async () => {
    const terminalStatuses: CommandLifecycleState['status'][] = ['applied', 'rejected', 'expired', 'cancelled'];
    const nonterminalStatuses: CommandLifecycleState['status'][] = ['pending-local', 'sent', 'accepted', 'executing', 'awaiting-state-event'];
    const dir = await mkdtemp(join(tmpdir(), 'shadow-command-transition-'));
    try {
      const memoryStore = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
      let opened = await openRealSQLite(join(dir, 'commands.sqlite'));
      const stores: { store: ShadowStore; close?: () => void }[] = [
        { store: memoryStore },
        { store: new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority), close: () => opened.raw.close() },
      ];
      for (const { store, close } of stores) {
        await store.transaction((tx) => {
          for (const status of [...terminalStatuses, ...nonterminalStatuses]) tx.putCommand(commandState(status));
        });
        const client = makeClient(store, 2_000);
        await client.load();
        expect(await client.transitionAuthority(transitionGrant())).toBe(true);
        const statuses = new Map(client.read().commands.map((command) => [command.commandId, command.status]));
        for (const status of terminalStatuses) expect(statuses.get(commandState(status).commandId)).toBe(status);
        for (const status of nonterminalStatuses) expect(statuses.get(commandState(status).commandId)).toBe('stale-epoch');
        close?.();
      }
      opened = await openRealSQLite(join(dir, 'commands.sqlite'));
      const restarted = makeClient(new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority), 2_000, expectedAuthority);
      await restarted.load();
      const restartedStatuses = new Map(restarted.read().commands.map((command) => [command.commandId, command.status]));
      for (const status of terminalStatuses) expect(restartedStatuses.get(commandState(status).commandId)).toBe(status);
      for (const status of nonterminalStatuses) expect(restartedStatuses.get(commandState(status).commandId)).toBe('stale-epoch');
      opened.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists + reloads a rejected command with a bounded reason (spaces/dots), and quarantines only corrupt reasons', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-rejected-cmd-'));
    try {
      // A realistic host reject reason (from an authenticated ACK error message):
      // capability-denied text with spaces + dotted method ids — NOT a safe-id.
      const reason = 'method controller.session.autopilot.set requires session.autopilot.set';
      const rejected: CommandLifecycleState = {
        commandId: 'cmd_rej_1', status: 'rejected', fence, createdAt: 1_000, expiresAt: 9_999, rejectReason: reason,
      };
      let opened = await openRealSQLite(join(dir, 'rej.sqlite'));
      {
        const store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
        await store.transaction((tx) => tx.putCommand(rejected));
        opened.raw.close();
      }
      // Close + reopen: the rejected command loads with its bounded reason intact.
      opened = await openRealSQLite(join(dir, 'rej.sqlite'));
      {
        const store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
        const client = makeClient(store, 2_000, expectedAuthority);
        await client.load(); // must NOT throw malformed-command-row
        const cmd = client.read().commands.find((c) => c.commandId === 'cmd_rej_1');
        expect(cmd?.status).toBe('rejected');
        expect(cmd?.rejectReason).toBe(reason);
        opened.raw.close();
      }
      // A genuinely-corrupt reject_reason (a filesystem path) is still quarantined
      // individually — the row is dropped, the DB is not poisoned.
      opened = await openRealSQLite(join(dir, 'rej.sqlite'));
      opened.raw.exec("UPDATE shadow_commands SET reject_reason = '/Users/bob/Library/Keychains/login.keychain-db' WHERE command_id = 'cmd_rej_1'");
      {
        const store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
        const client = makeClient(store, 2_000, expectedAuthority);
        await client.load(); // must NOT throw — the one corrupt row is quarantined
        expect(client.read().commands.find((c) => c.commandId === 'cmd_rej_1')).toBeUndefined();
        opened.raw.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves falsy entity data during same-scope authority transition pruning', async () => {
    const payloads = [false, 0, '', null, { ok: true }];
    const dir = await mkdtemp(join(tmpdir(), 'shadow-falsy-entities-'));
    try {
      const memoryStore = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
      let opened = await openRealSQLite(join(dir, 'entities.sqlite'));
      const stores: { store: ShadowStore; close?: () => void }[] = [
        { store: memoryStore },
        { store: new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority), close: () => opened.raw.close() },
      ];
      for (const { store, close } of stores) {
        await store.transaction((tx) => {
          payloads.forEach((data, index) => tx.putEntity({ id: `entity_${index}`, collection: 'project', revision: 1, updatedAt: 1_000 + index, deleted: false, payloadDigest: digest('a'), data }));
        });
        const client = makeClient(store, 2_000);
        await client.load();
        expect(await client.transitionAuthority(transitionGrant())).toBe(true);
        expect(client.read().entities.map((entity) => entity.data)).toEqual(payloads);
        close?.();
      }
      opened = await openRealSQLite(join(dir, 'entities.sqlite'));
      const restarted = makeClient(new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority), 2_000, expectedAuthority);
      await restarted.load();
      expect(restarted.read().entities.map((entity) => entity.data)).toEqual(payloads);
      opened.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches memory and real SQLite transaction-visible authority transition state before commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_500);
    const terminalStatuses: CommandLifecycleState['status'][] = ['applied', 'rejected', 'expired', 'cancelled'];
    const nonterminalStatuses: CommandLifecycleState['status'][] = ['pending-local', 'sent', 'accepted', 'executing', 'awaiting-state-event'];
    const payloads = [false, 0, '', null, { ok: true }];
    const seed = async (store: ShadowStore) => {
      await store.transaction((tx) => {
        for (const status of [...terminalStatuses, ...nonterminalStatuses]) tx.putCommand(commandState(status));
        payloads.forEach((data, index) => tx.putEntity({ id: `entity_${index}`, collection: 'project', revision: 1, updatedAt: 1_000 + index, deleted: false, payloadDigest: digest('a'), data }));
        tx.putEntity({ id: 'other_scope_entity', collection: 'project', revision: 1, updatedAt: 9_000, deleted: false, payloadDigest: digest('b'), data: { drop: true } });
      });
    };
    const normalize = (state: ShadowState) => ({
      connection: state.connection,
      readonlyOffline: state.readonlyOffline,
      repairReason: state.repairReason,
      expectedAuthority: state.expectedAuthority,
      cursor: state.cursor,
      commands: state.commands.map((command) => ({ commandId: command.commandId, status: command.status })).sort((a, b) => a.commandId.localeCompare(b.commandId)),
      entities: state.entities.map((entity) => ({ id: entity.id, data: entity.data })).sort((a, b) => a.id.localeCompare(b.id)),
      grants: state.grants,
      visualGrants: state.visualGrants,
      previews: state.previews,
      usedTransitionIds: state.usedTransitionIds,
      usedTransitionNonces: state.usedTransitionNonces,
      authorityTransitions: state.authorityTransitions,
      repairRecords: state.repairRecords
        .filter((record) => !(record.id === 'current' && record.reason === 'authority-transition'))
        .map((record) => ({ id: record.id, reason: record.reason, createdAt: record.createdAt }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    const dir = await mkdtemp(join(tmpdir(), 'shadow-transition-tx-parity-'));
    try {
      const memoryStore = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
      const opened = await openRealSQLite(join(dir, 'transition.sqlite'));
      const sqliteStore = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      await seed(memoryStore);
      await seed(sqliteStore);
      const grant = transitionGrant();
      let memoryInside: ReturnType<typeof normalize> | undefined;
      let sqliteInside: ReturnType<typeof normalize> | undefined;
      await memoryStore.transaction((tx) => {
        tx.consumeAuthorityTransition(grant, { ...expectedAuthority, fence: otherFence }, { accountId: fence.accountId, scopeId: fence.scopeId });
        memoryInside = normalize(tx.getState());
      });
      await sqliteStore.transaction((tx) => {
        tx.consumeAuthorityTransition(grant, { ...expectedAuthority, fence: otherFence }, { accountId: fence.accountId, scopeId: fence.scopeId });
        sqliteInside = normalize(tx.getState());
      });
      expect(sqliteInside).toEqual(memoryInside);
      const inside = sqliteInside as NonNullable<typeof sqliteInside>;
      for (const status of terminalStatuses) expect(inside.commands.find((command) => command.commandId === commandState(status).commandId)?.status).toBe(status);
      for (const status of nonterminalStatuses) expect(inside.commands.find((command) => command.commandId === commandState(status).commandId)?.status).toBe('stale-epoch');
      expect(inside.entities.map((entity) => entity.data)).toEqual([...payloads, { drop: true }]);
      expect(inside.entities.map((entity) => entity.id)).toContain('other_scope_entity');

      const reopened = await openRealSQLite(join(dir, 'transition.sqlite'));
      const reloaded = await new ExpoSQLiteShadowStore(reopened.db, 'ctrl_1', 'host_1', expectedAuthority).load();
      expect(normalize(reloaded)).toEqual(memoryInside);
      opened.raw.close();
      reopened.raw.close();
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies inbox, entity and cursor atomically under crash injection', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    store.failBeforeCommit = true;
    await expect(client.applyStateEvent(event(1))).rejects.toThrow('injected-crash-before-commit');
    store.failBeforeCommit = false;

    const restarted = makeClient(store);
    await restarted.load();
    expect(restarted.read().cursor).toBeNull();
    expect(restarted.read().entities).toHaveLength(0);

    await restarted.applyStateEvent(event(1));
    expect(restarted.read().cursor?.lastSeq).toBe(1);
    expect(restarted.read().entities[0]?.data).toEqual({ entityId: 'project_1', revision: 1 });
  });

  it('rejects wrong-fence, duplicate/conflict, and stale gaps fail closed', async () => {
    const client = makeClient();
    await client.load();
    await client.applyStateEvent(event(1));
    expect((await client.applyStateEvent(event(1))).status).toBe('duplicate');
    expect((await client.applyStateEvent(event(1, { payloadDigest: digest('b') }))).status).toBe('conflict');
    expect((await client.applyStateEvent(event(2, { fence: otherFence }))).status).toBe('fenced');
    expect((await client.applyStateEvent(event(3))).status).toBe('gap');
    expect(client.read().connection).toBe('repair-required');
  });
});

describe('ShadowMobileClient command lifecycle', () => {
  it('uses accepted protocol transitions through accepted, executing, awaiting-state-event, and applied', async () => {
    const client = makeClient();
    await client.load();
    await client.applyStateEvent(event(1));
    await client.queueCommand({ commandId: 'cmd_1', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_1');

    expect((await client.applyMessage(acceptedAck('cmd_1'))).status).toBe('applied');
    expect(client.read().commands[0]?.status).toBe('accepted');
    await client.advanceCommand('cmd_1', 'execute');
    expect(client.read().commands[0]?.status).toBe('executing');
    await client.advanceCommand('cmd_1', 'await-state-event');
    expect(client.read().commands[0]?.status).toBe('awaiting-state-event');
    await client.applyStateEvent(event(2, { entityId: 'project_2', commandId: 'cmd_1' }));
    expect(client.read().commands[0]?.status).toBe('applied');
    expect(client.read().commands[0]?.appliedEventId).toBe('event_2');
  });

  it('persists canonical three-field pendingEvent for applied commands across real SQLite cold reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-pending-event-'));
    try {
      const path = join(dir, 'pending.sqlite');
      let opened = await openRealSQLite(path);
      let store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      let client = makeClient(store);
      await client.load();
      await client.applyStateEvent(event(1));
      await client.queueCommand({ commandId: 'cmd_pending', fence, expiresAt: 9_999, createdAt: 1_000 });
      await client.markCommandSent('cmd_pending');
      await client.applyMessage(acceptedAck('cmd_pending'));
      await client.advanceCommand('cmd_pending', 'execute');
      await client.advanceCommand('cmd_pending', 'await-state-event');
      await client.applyStateEvent(event(2, { entityId: 'project_2', commandId: 'cmd_pending' }));
      const applied = client.read().commands.find((command) => command.commandId === 'cmd_pending');
      expect(applied).toMatchObject({ status: 'applied', appliedEventId: 'event_2', pendingEvent: { eventId: 'event_2', seq: 2, commandId: 'cmd_pending' } });

      let loaded = await store.load();
      expect(loaded.commands.find((command) => command.commandId === 'cmd_pending')).toMatchObject({
        status: 'applied',
        appliedEventId: 'event_2',
        pendingEvent: { eventId: 'event_2', seq: 2, commandId: 'cmd_pending' },
      });
      opened.raw.close();

      for (let reload = 0; reload < 3; reload += 1) {
        opened = await openRealSQLite(path);
        store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
        loaded = await store.load();
        expect(loaded.commands.find((command) => command.commandId === 'cmd_pending')).toMatchObject({
          status: 'applied',
          appliedEventId: 'event_2',
          pendingEvent: { eventId: 'event_2', seq: 2, commandId: 'cmd_pending' },
        });
        opened.raw.close();
      }

      opened = await openRealSQLite(path);
      store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      client = makeClient(store);
      await client.load();
      await client.queueCommand({ commandId: 'cmd_after_reload', fence, expiresAt: 9_999, createdAt: 1_100 });
      await client.markCommandSent('cmd_after_reload');
      await client.applyMessage(acceptedAck('cmd_after_reload', { resultSeq: 3 }));
      await client.advanceCommand('cmd_after_reload', 'execute');
      await client.advanceCommand('cmd_after_reload', 'await-state-event');
      await client.applyStateEvent(event(3, { entityId: 'project_3', commandId: 'cmd_after_reload' }));
      expect(client.read().commands.find((command) => command.commandId === 'cmd_after_reload')).toMatchObject({
        status: 'applied',
        pendingEvent: { eventId: 'event_3', seq: 3, commandId: 'cmd_after_reload' },
      });
      opened.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['extra field', { eventId: 'event_bad', seq: 2, commandId: 'cmd_bad', payloadDigest: digest('a') }],
    ['missing commandId', { eventId: 'event_bad', seq: 2 }],
    ['wrong commandId', { eventId: 'event_bad', seq: 2, commandId: 'cmd_other' }],
    ['wrong seq type', { eventId: 'event_bad', seq: '2', commandId: 'cmd_bad' }],
  ])('records surgical repair evidence for malformed real SQLite pendingEvent JSON: %s', async (_name, pendingEvent) => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-bad-pending-event-'));
    try {
      const path = join(dir, 'bad-pending.sqlite');
      const opened = await openRealSQLite(path);
      const store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      await store.load();
      await opened.db.runAsync(
        'INSERT OR REPLACE INTO shadow_commands(command_id, status, account_id, scope_id, host_device_id, epoch, lease_id, created_at, expires_at, result_seq, applied_event_id, reject_reason, ack_json, pending_event_json, command_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'cmd_bad',
        'applied',
        fence.accountId,
        fence.scopeId,
        fence.hostDeviceId,
        fence.epoch,
        fence.leaseId,
        1_000,
        9_999,
        2,
        'event_bad',
        null,
        null,
        JSON.stringify(pendingEvent),
        JSON.stringify(commandState('applied', 'cmd_bad')),
      );
      await opened.db.runAsync(
        'INSERT OR REPLACE INTO shadow_commands(command_id, status, account_id, scope_id, host_device_id, epoch, lease_id, created_at, expires_at, result_seq, applied_event_id, reject_reason, ack_json, pending_event_json, command_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'cmd_unrelated',
        'sent',
        fence.accountId,
        fence.scopeId,
        fence.hostDeviceId,
        fence.epoch,
        fence.leaseId,
        1_000,
        9_999,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(commandState('sent', 'cmd_unrelated')),
      );
      const client = makeClient(store);
      await client.load();
      expect(client.read()).toMatchObject({ connection: 'repair-required', repairReason: 'malformed-command-event-json', readonlyOffline: true });
      const evidence = await opened.db.getAllAsync<{ table_name: string; row_class: string; reason: string }>('SELECT table_name, row_class, reason FROM shadow_repair_evidence WHERE reason = ?', 'malformed-command-event-json');
      expect(evidence).toEqual([{ table_name: 'shadow_commands', row_class: 'command', reason: 'malformed-command-event-json' }]);
      const commands = await opened.db.getAllAsync<{ command_id: string }>('SELECT command_id FROM shadow_commands ORDER BY command_id');
      expect(commands.map((row) => row.command_id)).toEqual(['cmd_bad', 'cmd_unrelated']);
      opened.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records malformed pendingEvent evidence inside store.transaction without nested BEGIN', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-transaction-bad-pending-event-'));
    try {
      const path = join(dir, 'bad-pending-transaction.sqlite');
      const opened = await openRealSQLite(path);
      const store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      await store.load();
      for (const [commandId, pendingEvent] of [
        ['cmd_valid', null],
        ['cmd_bad', JSON.stringify({ eventId: 'event_bad', seq: '2', commandId: 'cmd_bad' })],
      ] as const) {
        await opened.db.runAsync(
          'INSERT OR REPLACE INTO shadow_commands(command_id, status, account_id, scope_id, host_device_id, epoch, lease_id, created_at, expires_at, result_seq, applied_event_id, reject_reason, ack_json, pending_event_json, command_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          commandId,
          commandId === 'cmd_bad' ? 'applied' : 'sent',
          fence.accountId,
          fence.scopeId,
          fence.hostDeviceId,
          fence.epoch,
          fence.leaseId,
          1_000,
          9_999,
          commandId === 'cmd_bad' ? 2 : null,
          commandId === 'cmd_bad' ? 'event_bad' : null,
          null,
          null,
          pendingEvent,
          JSON.stringify(commandState(commandId === 'cmd_bad' ? 'applied' : 'sent', commandId)),
        );
      }

      let callbackInvoked = false;
      await expect(store.transaction(() => {
        callbackInvoked = true;
      })).rejects.toMatchObject({ name: 'MalformedShadowRowError', message: 'malformed-command-event-json' });
      expect(callbackInvoked).toBe(false);
      const evidenceAfterFirst = await opened.db.getAllAsync<{ id: string; reason: string; table_name: string; row_class: string; row_identity_hash: string }>(
        'SELECT id, reason, table_name, row_class, row_identity_hash FROM shadow_repair_evidence WHERE reason = ? ORDER BY id',
        'malformed-command-event-json',
      );
      expect(evidenceAfterFirst).toHaveLength(1);
      expect(evidenceAfterFirst[0]).toMatchObject({ reason: 'malformed-command-event-json', table_name: 'shadow_commands', row_class: 'command' });
      expect(evidenceAfterFirst[0]?.id).toBe(`row:shadow_commands:${evidenceAfterFirst[0]?.row_identity_hash}`);
      const commandsAfterFirst = await opened.db.getAllAsync<{ command_id: string; status: string }>('SELECT command_id, status FROM shadow_commands ORDER BY command_id');
      expect(commandsAfterFirst).toEqual([{ command_id: 'cmd_bad', status: 'applied' }, { command_id: 'cmd_valid', status: 'sent' }]);

      await expect(store.transaction(() => {
        callbackInvoked = true;
      })).rejects.toMatchObject({ name: 'MalformedShadowRowError', message: 'malformed-command-event-json' });
      const evidenceAfterRepeat = await opened.db.getAllAsync<{ id: string }>('SELECT id FROM shadow_repair_evidence WHERE reason = ?', 'malformed-command-event-json');
      expect(evidenceAfterRepeat).toEqual([{ id: evidenceAfterFirst[0]?.id }]);

      opened.raw.close();
      const reopened = await openRealSQLite(path);
      const reopenedStore = new ExpoSQLiteShadowStore(reopened.db, 'ctrl_1', 'host_1', expectedAuthority);
      await expect(reopenedStore.transaction(() => {
        callbackInvoked = true;
      })).rejects.toMatchObject({ name: 'MalformedShadowRowError', message: 'malformed-command-event-json' });
      const reopenedEvidence = await reopened.db.getAllAsync<{ id: string; reason: string }>('SELECT id, reason FROM shadow_repair_evidence WHERE reason = ?', 'malformed-command-event-json');
      expect(reopenedEvidence).toEqual([{ id: evidenceAfterFirst[0]?.id, reason: 'malformed-command-event-json' }]);

      await reopened.db.runAsync('DELETE FROM shadow_commands WHERE command_id = ?', 'cmd_bad');
      const loaded = await reopenedStore.load();
      expect(loaded.commands.map((command) => command.commandId)).toEqual(['cmd_valid']);
      expect(loaded.repairRecords.find((record) => record.id === evidenceAfterFirst[0]?.id)).toMatchObject({
        reason: 'malformed-command-event-json',
        class: 'malformed-row',
        table: 'shadow_commands',
      });
      await expect(reopenedStore.transaction((tx) => {
        tx.setConnection('online');
      })).resolves.toBeUndefined();
      const finalCommands = await reopened.db.getAllAsync<{ command_id: string }>('SELECT command_id FROM shadow_commands ORDER BY command_id');
      expect(finalCommands).toEqual([{ command_id: 'cmd_valid' }]);
      reopened.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains malformed row identity when transaction repair evidence writing fails', async () => {
    const db = new FakeSQLiteDatabase();
    const store = new ExpoSQLiteShadowStore(db as unknown as RealSQLiteDatabase, 'ctrl_1', 'host_1', expectedAuthority);
    db.commandRows.push({
      command_id: 'cmd_bad',
      status: 'applied',
      account_id: fence.accountId,
      scope_id: fence.scopeId,
      host_device_id: fence.hostDeviceId,
      epoch: fence.epoch,
      lease_id: fence.leaseId,
      created_at: 1_000,
      expires_at: 9_999,
      result_seq: 2,
      applied_event_id: 'event_bad',
      reject_reason: null,
      ack_json: null,
      pending_event_json: JSON.stringify({ eventId: 'event_bad', seq: '2', commandId: 'cmd_bad' }),
    });
    const originalRun = db.runAsync.bind(db);
    db.runAsync = async (sql: string, ...params: unknown[]) => {
      if (sql.startsWith('INSERT OR REPLACE INTO shadow_repair_evidence')) throw new Error('injected-evidence-write-failure');
      return originalRun(sql, ...params);
    };
    await expect(store.transaction(() => undefined)).rejects.toThrow(/load-repair-write-failed:malformed-command-event-json:shadow_commands:/);
    expect(db.repairEvidence).toHaveLength(0);
  });

  it('keeps wrong-fence ACK invalid and duplicate ACK idempotent while conflicting ACK becomes conflict', async () => {
    const client = makeClient();
    await client.load();
    await client.applyStateEvent(event(1));
    await client.queueCommand({ commandId: 'cmd_1', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_1');
    expect((await client.applyMessage(acceptedAck('cmd_1', { fence: otherFence }))).status).toBe('fenced');
    await client.applyMessage(acceptedAck('cmd_1'));
    expect(client.read().commands[0]?.status).toBe('accepted');
    await client.applyMessage(acceptedAck('cmd_1'));
    expect(client.read().commands[0]?.status).toBe('accepted');
    await client.applyMessage(acceptedAck('cmd_1', { signature: 'sig_other' }));
    expect(client.read().commands[0]?.status).toBe('conflict');
  });

  it('rejects old-fence terminal and nonterminal command ACK/state after authority transition', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    await client.applyStateEvent(event(1));
    await client.queueCommand({ commandId: 'cmd_terminal', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_terminal');
    await client.applyMessage(acceptedAck('cmd_terminal'));
    await client.applyStateEvent(event(2, { commandId: 'cmd_terminal' }));
    await client.queueCommand({ commandId: 'cmd_live', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_live');

    expect(await client.transitionAuthority(transitionGrant())).toBe(true);
    expect((await client.applyMessage(acceptedAck('cmd_terminal'))).status).toBe('fenced');
    expect((await client.applyMessage(acceptedAck('cmd_live'))).status).toBe('fenced');
    expect((await client.applyMessage({ family: 'command-state', v: 1, commandId: 'cmd_live', fence, state: 'executing', durable: true, seq: 3, createdAt: 2_100, signature: 'sig_state' })).status).toBe('fenced');

    await client.queueCommand({ commandId: 'cmd_current', fence: otherFence, expiresAt: 9_999, createdAt: 2_200 });
    await client.markCommandSent('cmd_current');
    expect((await client.applyMessage(acceptedAck('cmd_current', { fence: otherFence }))).status).toBe('applied');
    expect(client.read().commands.find((command) => command.commandId === 'cmd_current')?.status).toBe('accepted');
  });

  it('does not allow command-state progress messages to forge terminal lifecycle outcomes', async () => {
    const client = makeClient();
    await client.load();
    await client.applyStateEvent(event(1));
    await client.queueCommand({ commandId: 'cmd_progress', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_progress');
    await client.applyMessage(acceptedAck('cmd_progress'));
    expect(client.read().commands[0]?.status).toBe('accepted');

    for (const terminal of ['applied', 'rejected', 'conflict', 'expired'] as const) {
      expect((await client.applyMessage({ family: 'command-state', v: 1, commandId: 'cmd_progress', fence, state: terminal, durable: true, seq: 2, createdAt: 2_100, signature: `sig_${terminal}` })).status).toBe('invalid');
      expect(client.read().commands[0]?.status).toBe('accepted');
    }

    expect((await client.applyMessage({ family: 'command-state', v: 1, commandId: 'cmd_progress', fence, state: 'executing', durable: false, createdAt: 2_101, signature: 'sig_exec' })).status).toBe('applied');
    expect((await client.applyMessage({ family: 'command-state', v: 1, commandId: 'cmd_progress', fence, state: 'awaiting-state-event', durable: true, seq: 2, createdAt: 2_102, signature: 'sig_wait' })).status).toBe('applied');
    expect(client.read().commands[0]?.status).toBe('awaiting-state-event');
  });

  it('requires both ACK and matching ordered state-event before applied command state', async () => {
    const client = makeClient();
    await client.load();
    await client.applyStateEvent(event(1));

    await client.queueCommand({ commandId: 'cmd_pair', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_pair');
    await client.applyMessage(acceptedAck('cmd_pair', { resultSeq: 3 }));
    await client.advanceCommand('cmd_pair', 'execute');
    await client.advanceCommand('cmd_pair', 'await-state-event');
    expect(client.read().commands.find((command) => command.commandId === 'cmd_pair')?.status).toBe('awaiting-state-event');

    await client.queueCommand({ commandId: 'cmd_event_only', fence, expiresAt: 9_999, createdAt: 1_000 });
    await client.markCommandSent('cmd_event_only');
    expect((await client.applyStateEvent(event(2, { commandId: 'cmd_event_only' }))).status).toBe('applied');
    expect(client.read().commands.find((command) => command.commandId === 'cmd_event_only')?.status).toBe('sent');

    expect(client.read().commands.find((command) => command.commandId === 'cmd_pair')?.status).toBe('awaiting-state-event');
    expect((await client.applyStateEvent(event(3, { commandId: 'cmd_pair' }))).status).toBe('applied');
    expect(client.read().commands.find((command) => command.commandId === 'cmd_pair')?.status).toBe('applied');
  });
});

describe('ShadowMobileClient assets and reconnect/offline truth', () => {
  it('validates capability binding and returns only fully verified ranges without holes', async () => {
    const client = makeClient();
    await client.load();
    await client.applyStateEvent(event(1));
    const asset = descriptor('cid_asset_1', 4, 'sha256:1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const firstWrite = await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 2 }, bytes: Uint8Array.from([1, 2]) });
    expect(firstWrite).toMatchObject({ ok: true });
    await expect(client.readAsset('cid_asset_1')).resolves.toBeNull();
    expect(Array.from(await client.readAsset('cid_asset_1', { start: 0, endExclusive: 2 }) ?? [])).toEqual([1, 2]);
    expect(await client.putAssetRange({ descriptor: asset, range: { start: 2, endExclusive: 4 }, bytes: Uint8Array.from([3, 5]) })).toEqual({ ok: false, reason: 'digest-mismatch' });
    await expect(client.readAsset('cid_asset_1')).resolves.toBeNull();
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 2, endExclusive: 4 }, bytes: Uint8Array.from([3, 4]) })).ok).toBe(true);
    expect(Array.from(await client.readAsset('cid_asset_1') ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('persists LRU byte budget eviction deterministically', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = new ShadowMobileClient({
      controllerDeviceId: 'ctrl_1',
      hostDeviceId: 'host_1',
      expectedAuthority,
      store,
      assetBudgetBytes: 4,
      now: () => 1_000,
      crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), digest: async (bytes) => byteDigest(Array.from(bytes)) },
    });
    await client.load();
    await client.putAssetRange({ descriptor: descriptor('cid_old_1', 3, byteDigest([1, 1, 1])), range: { start: 0, endExclusive: 3 }, bytes: Uint8Array.from([1, 1, 1]) });
    const second = new ShadowMobileClient({ controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', expectedAuthority, store, assetBudgetBytes: 4, now: () => 2_000, crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), digest: async (bytes) => byteDigest(Array.from(bytes)) } });
    await second.load();
    await second.putAssetRange({ descriptor: descriptor('cid_new_1', 3, byteDigest([2, 2, 2])), range: { start: 0, endExclusive: 3 }, bytes: Uint8Array.from([2, 2, 2]) });
    const restarted = makeClient(store);
    await restarted.load();
    expect(await restarted.readAsset('cid_old_1')).toBeNull();
    expect(Array.from(await restarted.readAsset('cid_new_1') ?? [])).toEqual([2, 2, 2]);
  });

  it('serves valid memory subranges inside larger chunks without repair', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    const bytes = Uint8Array.from(Array.from({ length: 50 }, (_, index) => index));
    expect((await client.putAssetRange({ descriptor: descriptor('cid_mem_slice', 50, byteDigest(Array.from(bytes))), range: { start: 0, endExclusive: 50 }, bytes })).ok).toBe(true);
    expect(Array.from(await client.readAsset('cid_mem_slice', { start: 10, endExclusive: 20 }) ?? [])).toEqual(Array.from({ length: 10 }, (_, index) => index + 10));
    const restarted = makeClient(store);
    await restarted.load();
    expect(restarted.read().repairRecords).toHaveLength(0);
    expect(Array.from(await restarted.readAsset('cid_mem_slice', { start: 10, endExclusive: 20 }) ?? [])).toEqual(Array.from({ length: 10 }, (_, index) => index + 10));
  });

  it('keeps transport switches across restart without cursor reset and reports offline truth', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    await client.applyStateEvent(event(1));
    await client.setTransport('webrtc-data');
    await client.setOnline(false);
    expect(client.getOfflineTruth()).toEqual({ readonly: true, reason: 'offline' });
    const restarted = makeClient(store);
    await restarted.load();
    expect(restarted.read().cursor?.lastSeq).toBe(1);
    expect(restarted.read().transport).toBe('webrtc-data');
    expect(restarted.reconnectPlan({ retainedMinSeq: 1, headSeq: 3, latestSnapshotId: 'snap_1' })).toEqual({ decision: 'delta', fromSeq: 2, toSeq: 3 });
  });
});

describe('ExpoSQLiteShadowStore verified asset reads', () => {
  const crypto = {
    digest: async (bytes: Uint8Array) => `sha256:${Array.from(bytes).join('').padEnd(64, 'a').slice(0, 64)}`,
  };

  async function sqliteStore() {
    const db = new FakeSQLiteDatabase();
    const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
    const client = new ShadowMobileClient({
      controllerDeviceId: 'ctrl_1',
      hostDeviceId: 'host_1',
      expectedAuthority,
      store,
      now: () => 2_000,
      crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), ...crypto },
    });
    await client.load();
    return { db, client, store };
  }

  it('returns verified partial and full ranges and updates LRU only after success', async () => {
    const { db, client } = await sqliteStore();
    const asset = descriptor('cid_sqlite_1', 4, byteDigest([1, 2, 3, 4]));
    expect(await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 2 }, bytes: Uint8Array.from([1, 2]) })).toMatchObject({ ok: true });
    expect(Array.from(await client.readAsset('cid_sqlite_1', { start: 0, endExclusive: 2 }) ?? [])).toEqual([1, 2]);
    expect(db.assets.get('cid_sqlite_1')?.last_accessed_at).toBeGreaterThan(0);
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 2, endExclusive: 4 }, bytes: Uint8Array.from([3, 4]) })).ok).toBe(true);
    expect(Array.from(await client.readAsset('cid_sqlite_1') ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('serves valid SQLite subranges inside larger chunks and across chunk boundaries', async () => {
    const { db, client } = await sqliteStore();
    const hundred = Array.from({ length: 100 }, (_, index) => index % 10);
    const asset = descriptor('cid_sqlite_slice', 100, byteDigest(hundred));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 50 }, bytes: Uint8Array.from(hundred.slice(0, 50)) })).ok).toBe(true);
    expect(Array.from(await client.readAsset('cid_sqlite_slice', { start: 10, endExclusive: 20 }) ?? [])).toEqual(hundred.slice(10, 20));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 50, endExclusive: 100 }, bytes: Uint8Array.from(hundred.slice(50, 100)) })).ok).toBe(true);
    expect(Array.from(await client.readAsset('cid_sqlite_slice', { start: 45, endExclusive: 55 }) ?? [])).toEqual(hundred.slice(45, 55));
    expect(Array.from(await client.readAsset('cid_sqlite_slice', { start: 50, endExclusive: 60 }) ?? [])).toEqual(hundred.slice(50, 60));
    expect(await client.readAsset('cid_sqlite_slice', { start: 20, endExclusive: 20 })).toBeNull();
    expect(db.repairs).toHaveLength(0);
  });

  it('quarantines corrupt chunk bytes instead of returning zero-filled or stale data', async () => {
    const { db, client } = await sqliteStore();
    const asset = descriptor('cid_sqlite_corrupt', 2, byteDigest([1, 2]));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 2 }, bytes: Uint8Array.from([1, 2]) })).ok).toBe(true);
    db.ranges[0] = { ...db.ranges[0], bytes: Uint8Array.from([1, 9]) };
    await expect(client.readAsset('cid_sqlite_corrupt')).resolves.toBeNull();
    expect(db.assets.has('cid_sqlite_corrupt')).toBe(true);
    expect(db.ranges).toHaveLength(0);
    expect(db.assets.get('cid_sqlite_corrupt')?.verified_ranges_json).toBe('[]');
    expect(db.repairs.at(-1)?.reason).toBe('asset-chunk-corrupt');
  });

  it('quarantines overlapping persisted range rows', async () => {
    const { db, client } = await sqliteStore();
    const asset = descriptor('cid_sqlite_overlap', 4, byteDigest([1, 2, 3, 4]));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 4 }, bytes: Uint8Array.from([1, 2, 3, 4]) })).ok).toBe(true);
    db.ranges.push({ content_id: 'cid_sqlite_overlap', start: 2, end_exclusive: 4, digest: await crypto.digest(Uint8Array.from([3, 4])), bytes: Uint8Array.from([3, 4]) });
    await expect(client.readAsset('cid_sqlite_overlap')).resolves.toBeNull();
    expect(db.assets.has('cid_sqlite_overlap')).toBe(false);
  });

  it('blocks a requested subrange when corruption exists outside the requested span', async () => {
    const { db, client } = await sqliteStore();
    const asset = descriptor('cid_sqlite_outside', 4, byteDigest([1, 2, 3, 4]));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 2 }, bytes: Uint8Array.from([1, 2]) })).ok).toBe(true);
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 2, endExclusive: 4 }, bytes: Uint8Array.from([3, 4]) })).ok).toBe(true);
    db.ranges.find((range) => range.start === 2)!.bytes = Uint8Array.from([9, 9]);
    await expect(client.readAsset('cid_sqlite_outside', { start: 0, endExclusive: 2 })).resolves.toBeNull();
    expect(db.assets.get('cid_sqlite_outside')?.verified_ranges_json).toBe('[{"start":0,"endExclusive":2}]');
    expect(db.repairs.at(-1)?.reason).toBe('asset-chunk-corrupt');
    expect(Array.from(await client.readAsset('cid_sqlite_outside', { start: 0, endExclusive: 2 }) ?? [])).toEqual([1, 2]);
    expect(await client.readAsset('cid_sqlite_outside', { start: 2, endExclusive: 4 })).toBeNull();
  });

  it('repairs global missing asset spans outside requested range and preserves valid SQLite rows', async () => {
    const { db, client } = await sqliteStore();
    const asset = descriptor('cid_sqlite_missing', 100, byteDigest(Array.from({ length: 100 }, (_, index) => index % 10)));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 50 }, bytes: Uint8Array.from(Array.from({ length: 50 }, (_, index) => index % 10)) })).ok).toBe(true);
    db.assets.get('cid_sqlite_missing')!.verified_ranges_json = JSON.stringify([{ start: 0, endExclusive: 100 }]);
    expect(Array.from(await client.readAsset('cid_sqlite_missing', { start: 0, endExclusive: 10 }) ?? [])).toEqual([]);
    expect(db.assets.get('cid_sqlite_missing')?.verified_ranges_json).toBe('[{"start":0,"endExclusive":50}]');
    expect(db.repairs.at(-1)).toMatchObject({ reason: 'asset-range-gap' });
    expect(Array.from(await client.readAsset('cid_sqlite_missing', { start: 0, endExclusive: 10 }) ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it.each(malformedRowCases)('fails closed on malformed durable SQLite %s row', async (field, row) => {
    const db = new FakeSQLiteDatabase();
    (db[field] as Record<string, unknown>[]).push(row);
    const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
    const client = new ShadowMobileClient({
      controllerDeviceId: 'ctrl_1',
      hostDeviceId: 'host_1',
      expectedAuthority,
      store,
      now: () => 2_000,
      crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), digest: async (bytes) => byteDigest(Array.from(bytes)) },
    });
    await client.load();
    expect(client.read().connection).toBe('repair-required');
    expect(client.read().repairReason).toMatch(/^malformed-/);
    expect(db.repairs.at(-1)?.reason).toMatch(/^malformed-/);
    expect(db.repairs.at(-1)?.id).toMatch(/^row:shadow_/);
  });

  it('records distinct row-specific repair evidence for multiple malformed SQLite rows', async () => {
    const rows = [
      { collection: 'project', entity_id: 'bad/id_1', revision: 1, updated_at: 1, deleted: 0, payload_digest: digest('a'), data_json: '{}' },
      { collection: 'project', entity_id: 'bad/id_2', revision: 1, updated_at: 1, deleted: 0, payload_digest: digest('a'), data_json: '{}' },
    ];
    const ids: string[] = [];
    for (const row of rows) {
      const db = new FakeSQLiteDatabase();
      db.entityRows.push(row);
      const client = new ShadowMobileClient({ controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', expectedAuthority, store: new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority), now: () => 2_000 });
      await client.load();
      expect(client.read().entities).toHaveLength(0);
      ids.push(db.repairs.at(-1)?.id ?? '');
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('persists and reloads complete bounded repair evidence fields', async () => {
    const db = new FakeSQLiteDatabase();
    const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
    const evidence: ShadowRepairEvidence = {
      id: 'repair_1',
      class: 'asset',
      repairClass: 'asset',
      reason: 'asset-chunk-corrupt',
      table: 'shadow_asset_ranges',
      rowClass: 'asset-range',
      rowIdentityHash: 'hash_1',
      authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
      transitionIdentityHash: 'transition_hash_1',
      assetId: 'asset_1',
      range: { start: 4, endExclusive: 8 },
      createdAt: 2_100,
    };
    await store.recordRepairEvidence(evidence);
    const loaded = await store.load();
    expect(loaded.repairRecords).toContainEqual({
      id: 'repair_1',
      reason: 'asset-chunk-corrupt',
      class: 'asset',
      table: 'shadow_asset_ranges',
      rowIdentityHash: 'hash_1',
      authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
      transitionIdentityHash: 'transition_hash_1',
      assetId: 'asset_1',
      range: { start: 4, endExclusive: 8 },
      createdAt: 2_100,
    });
  });

  it('loads old sparse repair rows as explicit legacy evidence without fabricating trust fields', async () => {
    const db = new FakeSQLiteDatabase();
    db.repairs.push({ id: 'legacy_1', reason: 'malformed-row', created_at: 2_200 });
    const loaded = await new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority).load();
    expect(loaded.repairRecords).toContainEqual({ id: 'legacy_1', reason: 'malformed-row', legacy: true, createdAt: 2_200 });
  });

  it('migrates old and partial repair evidence schemas idempotently before typed access', async () => {
    for (const preexisting of [
      ['id', 'reason', 'created_at'],
      ['id', 'reason', 'repair_class', 'row_class', 'asset_id', 'created_at'],
      ['id', 'reason', 'repair_class', 'row_class', 'table_name', 'row_identity_hash', 'account_id', 'scope_id', 'controller_device_id', 'host_device_id', 'epoch', 'lease_id', 'transition_identity_hash', 'asset_id', 'range_start', 'range_end_exclusive', 'created_at'],
    ]) {
      const db = new FakeSQLiteDatabase();
      db.repairEvidenceColumns = new Map(preexisting.map((name) => [name, name === 'created_at' || name === 'epoch' || name.startsWith('range_') ? 'INTEGER' : 'TEXT']));
      db.repairs.push({ id: 'legacy_1', reason: 'malformed-row', created_at: 2_200 });
      db.repairEvidence.push({ id: 'sparse_1', reason: 'legacy-row', created_at: 2_201 });
      const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
      await store.load();
      await store.load();
      expect(new Set(db.repairEvidenceColumns.keys())).toEqual(new Set([
        'id',
        'reason',
        'repair_class',
        'row_class',
        'table_name',
        'row_identity_hash',
        'account_id',
        'scope_id',
        'controller_device_id',
        'host_device_id',
        'epoch',
        'lease_id',
        'transition_identity_hash',
        'asset_id',
        'range_start',
        'range_end_exclusive',
        'created_at',
      ]));
      const loaded = await store.load();
      expect(loaded.repairRecords).toContainEqual({ id: 'legacy_1', reason: 'malformed-row', legacy: true, createdAt: 2_200 });
      expect(loaded.repairRecords).toContainEqual({ id: 'sparse_1', reason: 'legacy-row', legacy: true, createdAt: 2_201 });
      expect(loaded.repairRecords.find((record) => record.id === 'sparse_1')).not.toHaveProperty('authorityScope');
      await store.recordRepairEvidence({
        id: 'typed_1',
        class: 'asset',
        reason: 'asset-range-gap',
        table: 'shadow_asset_ranges',
        rowClass: 'asset-range',
        rowIdentityHash: 'hash_1',
        authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
        assetId: 'asset_1',
        range: { start: 0, endExclusive: 1 },
        createdAt: 2_300,
      });
      expect((await store.load()).repairRecords).toContainEqual(expect.objectContaining({ id: 'typed_1', class: 'asset', assetId: 'asset_1', range: { start: 0, endExclusive: 1 } }));
      expect((await store.load()).repairRecords.map((record) => record.id)).toEqual((await store.load()).repairRecords.map((record) => record.id));
    }
  });

  it('runs real SQLite DDL repair evidence migrations idempotently without data loss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maestro-shadow-real-sqlite-'));
    const expectedColumns = ['id', 'reason', 'repair_class', 'row_class', 'table_name', 'row_identity_hash', 'account_id', 'scope_id', 'controller_device_id', 'host_device_id', 'epoch', 'lease_id', 'transition_identity_hash', 'asset_id', 'range_start', 'range_end_exclusive', 'created_at'];
    const typedKeepEvidence = {
      id: 'typed_keep',
      class: 'asset' as const,
      reason: 'asset-range-hole',
      table: 'shadow_asset_ranges',
      rowClass: 'asset-range',
      rowIdentityHash: 'hash_typed_keep',
      authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
      transitionIdentityHash: 'transition_hash_typed_keep',
      assetId: 'asset_typed_keep',
      range: { start: 4, endExclusive: 8 },
      createdAt: 2_300,
    };
    const typedKeepRecord = {
      id: typedKeepEvidence.id,
      class: typedKeepEvidence.class,
      reason: typedKeepEvidence.reason,
      table: typedKeepEvidence.table,
      rowIdentityHash: typedKeepEvidence.rowIdentityHash,
      authorityScope: typedKeepEvidence.authorityScope,
      transitionIdentityHash: typedKeepEvidence.transitionIdentityHash,
      assetId: typedKeepEvidence.assetId,
      range: typedKeepEvidence.range,
      createdAt: typedKeepEvidence.createdAt,
    };
    const assertCoexistingRecords = (records: { id: string }[]) => {
      expect(records.map((record) => record.id)).toEqual(['legacy_keep', 'typed_keep']);
      expect(records.filter((record) => record.id === 'legacy_keep')).toHaveLength(1);
      expect(records.filter((record) => record.id === 'typed_keep')).toHaveLength(1);
      const legacy = records.find((record) => record.id === 'legacy_keep');
      expect(legacy).toEqual({ id: 'legacy_keep', reason: 'legacy-row', legacy: true, createdAt: 2_201 });
      expect(legacy).not.toHaveProperty('class');
      expect(legacy).not.toHaveProperty('rowClass');
      expect(legacy).not.toHaveProperty('table');
      expect(legacy).not.toHaveProperty('rowIdentityHash');
      expect(legacy).not.toHaveProperty('authorityScope');
      expect(legacy).not.toHaveProperty('transitionIdentityHash');
      expect(legacy).not.toHaveProperty('assetId');
      expect(legacy).not.toHaveProperty('range');
      expect(records.find((record) => record.id === 'typed_keep')).toEqual(typedKeepRecord);
    };
    const schemaCases = [
      ['old sparse base schema', 'CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)'],
      ['partial typed schema', 'CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, reason TEXT NOT NULL, repair_class TEXT, row_class TEXT, asset_id TEXT, created_at INTEGER NOT NULL)'],
      ['fully current schema', 'CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, reason TEXT NOT NULL, repair_class TEXT, row_class TEXT, table_name TEXT, row_identity_hash TEXT, account_id TEXT, scope_id TEXT, controller_device_id TEXT, host_device_id TEXT, epoch INTEGER, lease_id TEXT, transition_identity_hash TEXT, asset_id TEXT, range_start INTEGER, range_end_exclusive INTEGER, created_at INTEGER NOT NULL)'],
    ] as const;
    try {
      for (const [name, ddl] of schemaCases) {
        const path = join(dir, `${name.replaceAll(' ', '_')}.sqlite`);
        let opened = await openRealSQLite(path);
        opened.raw.exec(ddl);
        opened.raw.exec("INSERT INTO shadow_repair_evidence(id, reason, created_at) VALUES('legacy_keep', 'legacy-row', 2201)");
        const store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
        await store.load();
        await store.load();
        const columns = await opened.db.getAllAsync<{ name: string }>('PRAGMA table_info(shadow_repair_evidence)');
        expect(columns.map((column) => column.name).sort()).toEqual([...expectedColumns].sort());
        await store.recordRepairEvidence(typedKeepEvidence);
        const typedRows = await opened.db.getAllAsync<{ row_class: string | null }>("SELECT row_class FROM shadow_repair_evidence WHERE id = 'typed_keep'");
        expect(typedRows).toEqual([{ row_class: 'asset-range' }]);
        opened.raw.close();
        opened = await openRealSQLite(path);
        const reopened = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
        const once = (await reopened.load()).repairRecords;
        const twice = (await reopened.load()).repairRecords;
        assertCoexistingRecords(once);
        assertCoexistingRecords(twice);
        expect(twice).toEqual(once);
        await expect(opened.db.withExclusiveTransactionAsync(async () => {
          await opened.db.runAsync("INSERT INTO shadow_snapshot_repair(id, reason, created_at) VALUES('rolled_back', 'legacy-row', 2400)");
          throw new Error('rollback_probe');
        })).rejects.toThrow('rollback_probe');
        expect(await opened.db.getAllAsync("SELECT * FROM shadow_snapshot_repair WHERE id = 'rolled_back'")).toEqual([]);
        opened.raw.close();
        opened = await openRealSQLite(path);
        const stable = (await new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority).load()).repairRecords;
        expect(stable).toEqual(once);
        opened.raw.close();
      }

      const overwrite = await openRealSQLite(join(dir, 'same_id_overwrite.sqlite'));
      overwrite.raw.exec('CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)');
      overwrite.raw.exec("INSERT INTO shadow_repair_evidence(id, reason, created_at) VALUES('sparse_1', 'legacy-row', 2201)");
      const overwriteStore = new ExpoSQLiteShadowStore(overwrite.db, 'ctrl_1', 'host_1', expectedAuthority);
      await overwriteStore.load();
      await overwriteStore.recordRepairEvidence({ ...typedKeepEvidence, id: 'sparse_1', rowIdentityHash: 'hash_sparse_1', assetId: 'asset_sparse_1', transitionIdentityHash: 'transition_hash_sparse_1' });
      overwrite.raw.close();
      const reopenedOverwrite = await openRealSQLite(join(dir, 'same_id_overwrite.sqlite'));
      const overwrittenRecords = (await new ExpoSQLiteShadowStore(reopenedOverwrite.db, 'ctrl_1', 'host_1', expectedAuthority).load()).repairRecords;
      expect(overwrittenRecords.filter((record) => record.id === 'sparse_1')).toHaveLength(1);
      expect(overwrittenRecords).toEqual([{
        ...typedKeepRecord,
        id: 'sparse_1',
        rowIdentityHash: 'hash_sparse_1',
        assetId: 'asset_sparse_1',
        transitionIdentityHash: 'transition_hash_sparse_1',
      }]);
      reopenedOverwrite.raw.close();

      const incompatible = await openRealSQLite(join(dir, 'incompatible.sqlite'));
      incompatible.raw.exec('CREATE TABLE shadow_repair_evidence (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
      await expect(new ExpoSQLiteShadowStore(incompatible.db, 'ctrl_1', 'host_1', expectedAuthority).load()).rejects.toThrow('incompatible-repair-evidence-schema:reason');
      incompatible.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on incompatible repair evidence base schema', async () => {
    const db = new FakeSQLiteDatabase();
    db.repairEvidenceColumns = new Map([['id', 'INTEGER'], ['reason', 'TEXT'], ['created_at', 'INTEGER']]);
    const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
    await expect(store.load()).rejects.toThrow('incompatible-repair-evidence-schema:id');
  });

  it('fails closed on partial typed repair evidence instead of downgrading it to legacy', async () => {
    const db = new FakeSQLiteDatabase();
    db.repairEvidence.push({ id: 'partial_1', reason: 'asset-range-hole', repair_class: 'asset', asset_id: 'asset_1', created_at: 2_201 });
    await expect(new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority).load()).rejects.toThrow('malformed-repair-evidence-row');
  });

  it('persists full typed SQLite asset repair evidence for newly generated repair classes', async () => {
    const assetRepairReasons = ['asset-chunk-corrupt', 'asset-range-ambiguous', 'asset-range-gap', 'asset-range-hole', 'asset-metadata-corrupt', 'asset-full-digest-mismatch'] as const;
    async function seedCorrupt(reason: string): Promise<Record<string, unknown>> {
      const { db, client, store } = await sqliteStore();
      const total = reason === 'asset-range-gap' || reason === 'asset-range-hole' ? 8 : 4;
      const asset = descriptor(`cid_${reason.replaceAll('-', '_')}`, total, byteDigest(Array.from({ length: total }, (_, index) => index + 1)));
      expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 4 }, bytes: Uint8Array.from([1, 2, 3, 4]) })).ok).toBe(true);
      if (reason === 'asset-chunk-corrupt') db.ranges[0].bytes = Uint8Array.from([1, 2, 3, 9]);
      if (reason === 'asset-range-ambiguous') db.ranges.push({ ...db.ranges[0], start: 2, end_exclusive: 4, bytes: Uint8Array.from([3, 4]), digest: await crypto.digest(Uint8Array.from([3, 4])) });
      if (reason === 'asset-range-gap') db.assets.get(asset.variantRef.contentId)!.verified_ranges_json = JSON.stringify([{ start: 0, endExclusive: 8 }]);
      if (reason === 'asset-range-hole') db.assets.get(asset.variantRef.contentId)!.verified_ranges_json = JSON.stringify([{ start: 0, endExclusive: 8 }]);
      if (reason === 'asset-metadata-corrupt') db.assets.get(asset.variantRef.contentId)!.verified_ranges_json = JSON.stringify([{ start: 0, endExclusive: 5 }]);
      if (reason === 'asset-full-digest-mismatch') db.assets.get(asset.variantRef.contentId)!.digest = byteDigest([9, 9, 9, 9]);
      const requested = reason === 'asset-range-gap' ? { start: 0, endExclusive: 4 } : { start: 0, endExclusive: total };
      await expect(store.readAssetRange(asset.variantRef.contentId, requested, crypto)).resolves.toBeNull();
      return db.repairEvidence.at(-1) ?? {};
    }

    for (const reason of assetRepairReasons) {
      const evidence = await seedCorrupt(reason);
      expect(evidence).toMatchObject({
        reason,
        repair_class: 'asset',
        account_id: 'acct_1',
        scope_id: 'scope_1',
        controller_device_id: 'ctrl_1',
        host_device_id: 'host_1',
        epoch: 1,
        lease_id: 'lease_1',
      });
      expect(evidence.asset_id).toEqual(expect.stringMatching(/^cid_/));
      expect(evidence.row_identity_hash).toEqual(expect.any(String));
    }
  });

  it('retains exact asset-range-hole evidence in memory and real SQLite while preserving good ranges', async () => {
    const asset = descriptor('cid_range_hole', 8, byteDigest([1, 2, 3, 4, 5, 6, 7, 8]));
    const memoryStore = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const memoryClient = makeClient(memoryStore);
    await memoryClient.load();
    expect((await memoryClient.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 4 }, bytes: Uint8Array.from([1, 2, 3, 4]) })).ok).toBe(true);
    await memoryStore.transaction((tx) => tx.putAssetMetadata({ contentId: 'cid_range_hole', variant: 'original', totalBytes: 8, digest: asset.variantRef.sha256, verifiedRanges: [{ start: 0, endExclusive: 8 }], lastAccessedAt: 1 }));
    await memoryClient.load();
    await expect(memoryClient.readAsset('cid_range_hole', { start: 4, endExclusive: 8 })).resolves.toBeNull();
    expect(Array.from(await memoryClient.readAsset('cid_range_hole', { start: 0, endExclusive: 4 }) ?? [])).toEqual([1, 2, 3, 4]);
    const memoryRepair = (await memoryStore.load()).repairRecords.at(-1);
    expect(memoryRepair).toMatchObject({
      class: 'asset',
      reason: 'asset-range-hole',
      table: 'shadow_asset_ranges',
      assetId: 'cid_range_hole',
      range: { start: 4, endExclusive: 8 },
      authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
    });
    expect(memoryRepair?.legacy).toBeUndefined();
    expect(memoryRepair?.rowIdentityHash).toEqual(expect.any(String));

    const dir = await mkdtemp(join(tmpdir(), 'maestro-shadow-hole-sqlite-'));
    try {
      const path = join(dir, 'hole.sqlite');
      let opened = await openRealSQLite(path);
      let store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      let client = new ShadowMobileClient({
        controllerDeviceId: 'ctrl_1',
        hostDeviceId: 'host_1',
        expectedAuthority,
        store,
        now: () => 2_000,
        crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), ...crypto },
      });
      await client.load();
      expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 4 }, bytes: Uint8Array.from([1, 2, 3, 4]) })).ok).toBe(true);
      await opened.db.runAsync('UPDATE shadow_assets SET verified_ranges_json = ? WHERE content_id = ?', JSON.stringify([{ start: 0, endExclusive: 8 }]), 'cid_range_hole');
      await client.load();
      await expect(client.readAsset('cid_range_hole', { start: 4, endExclusive: 8 })).resolves.toBeNull();
      expect(Array.from(await client.readAsset('cid_range_hole', { start: 0, endExclusive: 4 }) ?? [])).toEqual([1, 2, 3, 4]);
      opened.raw.close();

      opened = await openRealSQLite(path);
      store = new ExpoSQLiteShadowStore(opened.db, 'ctrl_1', 'host_1', expectedAuthority);
      const loaded = await store.load();
      const sqliteRepair = loaded.repairRecords.find((record) => record.reason === 'asset-range-hole' && record.assetId === 'cid_range_hole');
      expect(sqliteRepair?.id).toMatch(/^asset:/);
      expect(sqliteRepair?.id.length).toBeLessThanOrEqual(128);
      expect(sqliteRepair?.id).toMatch(SAFE_ID_RE);
      expect(sqliteRepair).toMatchObject({
        class: 'asset',
        reason: 'asset-range-hole',
        table: 'shadow_asset_ranges',
        assetId: 'cid_range_hole',
        range: { start: 4, endExclusive: 8 },
        authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
      });
      expect(sqliteRepair?.legacy).toBeUndefined();
      expect(loaded.repairRecords.filter((record) => record.id === sqliteRepair?.id)).toHaveLength(1);
      expect((await store.load()).repairRecords).toEqual(loaded.repairRecords);
      opened.raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps memory asset repair evidence parity with SQLite typed fields', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    const asset = descriptor('cid_memory_corrupt', 2, byteDigest([1, 2]));
    expect((await client.putAssetRange({ descriptor: asset, range: { start: 0, endExclusive: 2 }, bytes: Uint8Array.from([1, 2]) })).ok).toBe(true);
    await store.transaction((tx) => tx.putAssetMetadata({ contentId: 'cid_memory_corrupt', variant: 'original', totalBytes: 2, digest: byteDigest([9, 9]), verifiedRanges: [{ start: 0, endExclusive: 2 }], lastAccessedAt: 1 }));
    await expect(client.readAsset('cid_memory_corrupt')).resolves.toBeNull();
    const repair = (await store.load()).repairRecords.at(-1);
    expect(repair).toMatchObject({
      class: 'asset',
      reason: 'asset-full-digest-mismatch',
      table: 'shadow_assets',
      assetId: 'cid_memory_corrupt',
      authorityScope: { accountId: 'acct_1', scopeId: 'scope_1', controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'lease_1' },
      range: { start: 0, endExclusive: 2 },
    });
    expect(repair?.rowIdentityHash).toEqual(expect.any(String));
  });

  it('keeps malformed transition rows distinct when PK values are missing or repeated', async () => {
    const rows = [
      { transition_id: null, nonce: 'nonce_1', kind: 'lease-rotation', controller_device_id: 'ctrl_1', previous_fence_json: JSON.stringify(fence), next_fence_json: JSON.stringify(otherFence), issued_at: 1_900, expires_at: 9_999, key_id: 'key_1', signature: 'sig_1', consumed_at: 2_000 },
      { transition_id: null, nonce: 'nonce_2', kind: 'lease-rotation', controller_device_id: 'ctrl_1', previous_fence_json: JSON.stringify(fence), next_fence_json: JSON.stringify(otherFence), issued_at: 1_900, expires_at: 9_999, key_id: 'key_1', signature: 'sig_1', consumed_at: 2_000 },
    ];
    const ids: string[] = [];
    const hashes: string[] = [];
    for (const row of rows) {
      const db = new FakeSQLiteDatabase();
      db.transitionRows.push(row);
      const client = new ShadowMobileClient({ controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', expectedAuthority, store: new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority), now: () => 2_000 });
      await client.load();
      ids.push(db.repairs.at(-1)?.id ?? '');
      hashes.push(String(db.repairEvidence.at(-1)?.transition_identity_hash ?? ''));
    }
    expect(new Set(ids).size).toBe(2);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes.every(Boolean)).toBe(true);
  });

  it('keeps same-reason malformed rows distinct across tables and row fallbacks', async () => {
    const ids: string[] = [];
    for (const [field, row] of [
      ['entityRows', { collection: 'project', entity_id: 'bad/id', revision: 1, updated_at: 1, deleted: 0, payload_digest: digest('a'), data_json: '{}' }],
      ['commandRows', { command_id: 'bad/id', status: 'accepted', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: 1, lease_id: 'lease_1', created_at: 1, expires_at: 9_999, result_seq: null, applied_event_id: null, reject_reason: null, ack_json: null, pending_event_json: null }],
    ] as const) {
      const db = new FakeSQLiteDatabase();
      db[field].push(row);
      const client = new ShadowMobileClient({ controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', expectedAuthority, store: new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority), now: () => 2_000 });
      await client.load();
      ids.push(db.repairs.at(-1)?.id ?? '');
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('strictly validates command ACK/event JSON and persists repair evidence before failing load', async () => {
    const db = new FakeSQLiteDatabase();
    db.commandRows.push({ command_id: 'cmd_1', status: 'accepted', account_id: 'acct_1', scope_id: 'scope_1', host_device_id: 'host_1', epoch: 1, lease_id: 'lease_1', created_at: 1, expires_at: 9_999, result_seq: 2, applied_event_id: null, reject_reason: null, ack_json: JSON.stringify(acceptedAck('cmd_other')), pending_event_json: null });
    const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
    const client = new ShadowMobileClient({ controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', expectedAuthority, store, now: () => 2_000, crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), digest: async (bytes) => byteDigest(Array.from(bytes)) } });
    await client.load();
    expect(client.read().connection).toBe('repair-required');
    expect(db.repairs.at(-1)?.reason).toBe('malformed-command-ack-json');
  });

  it('rejects prototype pollution entity JSON and persists load repair evidence', async () => {
    const db = new FakeSQLiteDatabase();
    db.entityRows.push({ collection: 'project', entity_id: 'project_1', revision: 1, updated_at: 1, deleted: 0, payload_digest: digest('a'), data_json: '{"__proto__":{"polluted":true}}' });
    const store = new ExpoSQLiteShadowStore(db, 'ctrl_1', 'host_1', expectedAuthority);
    const client = new ShadowMobileClient({ controllerDeviceId: 'ctrl_1', hostDeviceId: 'host_1', expectedAuthority, store, now: () => 2_000, crypto: { decryptEvent: async (evt) => ({ event: evt, payload: {} }), digest: async (bytes) => byteDigest(Array.from(bytes)) } });
    await client.load();
    expect(client.read().connection).toBe('repair-required');
    expect(db.repairs.at(-1)?.reason).toBe('malformed-entity-row');
  });
});

describe('ShadowMobileClient scoped preview input', () => {
  const preview = {
    family: 'preview-session' as const,
    v: 1 as const,
    visualSessionId: 'vis_1',
    fence,
    controllerDeviceId: 'ctrl_1',
    source: 'browser' as const,
    mode: 'web-tunnel' as const,
    inputMode: 'view-only' as const,
    transport: 'encrypted-relay' as const,
    projectId: 'proj_1',
    sessionId: 'sess_1',
    surfaceId: 'surf_1',
    expiresAt: 9_999,
    signature: 'sig_preview',
  };

  const input = (seq: number, frameSeqSeen = 1, overrides: Partial<VisualInputEvent> = {}): VisualInputEvent => ({
    family: 'visual-input',
    v: 1,
    visualSessionId: 'vis_1',
    fence,
    inputSeq: seq,
    frameSeqSeen,
    kind: 'tap',
    viewport: { width: 390, height: 844, scale: 3 },
    payloadCiphertext: `input_cipher_${seq}`,
    createdAt: 2_000,
    signature: `sig_input_${seq}`,
    ...overrides,
  });

  it('requires explicit scoped visual control before dispatching remote input', async () => {
    const client = makeClient();
    await client.load();
    await client.applyMessage(preview);
    await client.applyMessage({ family: 'enrollment-grant', v: 1, grantId: 'enroll_1', fence, controllerDeviceId: 'ctrl_1', expiresAt: 9_999, keyId: 'key_1', signedAt: 1_800, signature: 'sig_enroll' });
    expect(await client.requestPreviewControl({ visualSessionId: 'vis_1', grantId: 'enroll_1' })).toBeNull();
    expect((await client.dispatchPreviewInput(input(1))).ok).toBe(false);
    await client.applyMessage({
      family: 'visual-control-grant',
      v: 1,
      grantId: 'vgrant_1',
      visualSessionId: 'vis_1',
      fence,
      controllerDeviceId: 'ctrl_1',
      mode: 'control',
      expiresAt: 9_999,
      signedAt: 1_900,
      signature: 'sig_control',
    });
    expect(await client.requestPreviewControl({ visualSessionId: 'vis_1', grantId: 'vgrant_1' })).toMatchObject({ inputMode: 'control' });
    await client.applyMessage({ family: 'visual-frame', v: 1, visualSessionId: 'vis_1', frameSeq: 1, hostStateSeq: 0, timestamp: 1_950, codec: 'png', keyframe: true, signature: 'sig_frame' });
    expect((await client.dispatchPreviewInput(input(1))).ok).toBe(true);
    expect((await client.dispatchPreviewInput(input(1))).ok).toBe(false);
    expect((await client.dispatchPreviewInput(input(2, 0))).ok).toBe(false);
    expect((await client.dispatchPreviewInput(input(2, 1, { fence: otherFence }))).ok).toBe(false);
  });

  it('persists last input sequence across restart and revoked state clears control', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    await client.applyMessage(preview);
    await client.applyMessage({ family: 'visual-control-grant', v: 1, grantId: 'vgrant_1', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_900, signature: 'sig_control' });
    await client.requestPreviewControl({ visualSessionId: 'vis_1', grantId: 'vgrant_1' });
    await client.applyMessage({ family: 'visual-frame', v: 1, visualSessionId: 'vis_1', frameSeq: 1, hostStateSeq: 0, timestamp: 1_950, codec: 'png', keyframe: true, signature: 'sig_frame' });
    await client.dispatchPreviewInput(input(1));

    const restarted = makeClient(store);
    await restarted.load();
    expect((await restarted.dispatchPreviewInput(input(1))).ok).toBe(false);
    await restarted.applyMessage({ family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'rotation_1', signature: 'sig_revoke' });
    expect(restarted.getOfflineTruth()).toEqual({ readonly: true, reason: 'revoked' });
    expect((await restarted.dispatchPreviewInput(input(2))).ok).toBe(false);
  });

  it('rejects non-state control messages without an explicit verifier', async () => {
    const client = new ShadowMobileClient({
      controllerDeviceId: 'ctrl_1',
      hostDeviceId: 'host_1',
      expectedAuthority,
      store: createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority),
      now: () => 2_000,
      crypto: {
        decryptEvent: async (evt) => ({ event: evt, payload: { entityId: evt.entityId, revision: evt.revision } }),
        digest: async (bytes) => byteDigest(Array.from(bytes)),
      },
    });
    await client.load();
    expect((await client.applyMessage(preview)).status).toBe('invalid');
    expect(client.read().previews).toHaveLength(0);
  });

  it('rejects forged-looking control messages when verifier returns false', async () => {
    const messages: ShadowWireMessage[] = [
      acceptedAck('cmd_1'),
      { family: 'command-state', v: 1, commandId: 'cmd_1', fence, state: 'executing', durable: true, seq: 1, createdAt: 2_000, signature: 'sig_state' },
      preview,
      { family: 'visual-control-grant', v: 1, grantId: 'vgrant_1', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_900, signature: 'sig_control' },
      { family: 'visual-frame', v: 1, visualSessionId: 'vis_1', frameSeq: 1, hostStateSeq: 0, timestamp: 1_950, codec: 'png', keyframe: true, signature: 'sig_frame' },
      { family: 'enrollment-grant', v: 1, grantId: 'enroll_1', fence, controllerDeviceId: 'ctrl_1', expiresAt: 9_999, keyId: 'key_1', signedAt: 1_800, signature: 'sig_enroll' },
      { family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'rotation_1', signature: 'sig_revoke' },
    ];
    const verifierCases = [
      ['false result', () => ({ ok: false as const, reason: 'bad-signature' })],
      ['sync throw', () => { throw new Error('raw signature verifier stack'); }],
      ['async reject', async () => { throw new Error('raw signature verifier reject'); }],
      ['boolean false', () => false],
      ['malformed true-ish', () => ({ ok: 'true' }) as unknown as { ok: true }],
    ] as const;
    for (const [caseName, verifier] of verifierCases) {
      for (const message of messages) {
        const client = new ShadowMobileClient({
          controllerDeviceId: 'ctrl_1',
          hostDeviceId: 'host_1',
          expectedAuthority,
          store: createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority),
          now: () => 2_000,
          crypto: {
            decryptEvent: async (evt) => ({ event: evt, payload: { entityId: evt.entityId, revision: evt.revision } }),
            digest: async (bytes) => byteDigest(Array.from(bytes)),
          },
          controlMessageVerifier: { verifyControlMessage: verifier },
        });
        await client.load();
        const before = client.read();
        await expect(client.applyMessage(message)).resolves.toEqual({ status: 'invalid', cursor: before.cursor });
        expect(client.read(), `${caseName}:${message.family}`).toEqual(before);
      }
    }
  });

  it('applies a verifier-approved preview control message', async () => {
    const client = makeClient();
    await client.load();
    expect((await client.applyMessage(preview)).status).toBe('applied');
    expect(client.read().previews).toHaveLength(1);
  });

  it('scopes revocation to the live fence and treats same-fence duplicate as idempotent only', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store);
    await client.load();
    expect((await client.applyMessage({ family: 'device-revocation', v: 1, fence: otherFence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'rotation_1', signature: 'sig_revoke' })).status).toBe('invalid');
    expect(client.read().connection).toBe('offline');
    expect((await client.applyMessage({ family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'rotation_1', signature: 'sig_revoke' })).status).toBe('applied');
    expect((await client.applyMessage({ family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'rotation_1', signature: 'sig_revoke' })).status).toBe('duplicate');
    const restarted = makeClient(store);
    await restarted.load();
    expect(restarted.getOfflineTruth()).toEqual({ readonly: true, reason: 'revoked' });
  });

  it('uses bounded derived persisted ids for legal max-length revocations across real SQLite reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-revocation-id-'));
    try {
      const path = join(dir, 'revocation.sqlite');
      const longController = maxSafeId('c');
      const longRotation = maxSafeId('k');
      const longFence: Fence = {
        accountId: maxSafeId('a'),
        scopeId: maxSafeId('s'),
        hostDeviceId: maxSafeId('h'),
        epoch: 1,
        leaseId: maxSafeId('l'),
      };
      const longAuthority: ShadowExpectedAuthority = { fence: longFence, controllerDeviceId: longController, leaseExpiresAt: 9_999 };
      const makeLongClient = (db: RealSQLiteDatabase) => new ShadowMobileClient({
        controllerDeviceId: longController,
        hostDeviceId: longFence.hostDeviceId,
        expectedAuthority: longAuthority,
        store: new ExpoSQLiteShadowStore(db, longController, longFence.hostDeviceId, longAuthority),
        now: () => 2_000,
        controlMessageVerifier: { verifyControlMessage: async () => ({ ok: true }) },
      });
      let opened = await openRealSQLite(path);
      let client = makeLongClient(opened.db);
      await client.load();
      const revocation = { family: 'device-revocation', v: 1, fence: longFence, controllerDeviceId: longController, revokedAt: 2_100, keyRotationId: longRotation, signature: maxSafeId('g') } as const;
      expect((await client.applyMessage(revocation)).status).toBe('applied');
      expect(client.read().connection).toBe('revoked');
      expect((await client.applyMessage(revocation)).status).toBe('duplicate');
      const rows = await opened.db.getAllAsync<{ id: string; reason: string }>('SELECT id, reason FROM shadow_repair_evidence ORDER BY id');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toMatch(/^revoked:/);
      expect(rows[0]?.id.length).toBeLessThanOrEqual(128);
      expect(rows[0]?.id).toMatch(SAFE_ID_RE);
      expect(rows[0]?.reason).toBe('controller-revoked');
      opened.raw.close();

      for (let reload = 0; reload < 3; reload += 1) {
        opened = await openRealSQLite(path);
        client = makeLongClient(opened.db);
        await client.load();
        expect(client.read().connection).toBe('revoked');
        expect(client.getOfflineTruth()).toEqual({ readonly: true, reason: 'revoked' });
        expect(client.read().repairRecords.map((record) => record.id)).toEqual(rows.map((row) => row.id));
        opened.raw.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps derived persisted ids safe and distinct for maximum legal components', () => {
    const ids = [
      derivedShadowPersistedId('revoked', { controllerDeviceId: maxSafeId('c'), keyRotationId: maxSafeId('k'), fence: { accountId: maxSafeId('a'), scopeId: maxSafeId('s'), hostDeviceId: maxSafeId('h'), epoch: Number.MAX_SAFE_INTEGER, leaseId: maxSafeId('l') }, revokedAt: Number.MAX_SAFE_INTEGER, signature: maxSafeId('g') }),
      derivedShadowPersistedId('transition', { transitionId: maxSafeId('t'), nonce: maxSafeId('n'), previousFence: fence, nextFence: otherFence }),
      derivedShadowPersistedId('asset', { id: `asset:${maxSafeId('a')}:0-${Number.MAX_SAFE_INTEGER}`, contentId: maxSafeId('c'), range: { start: 0, endExclusive: Number.MAX_SAFE_INTEGER }, table: 'shadow_asset_ranges' }),
      derivedShadowPersistedId('authority-chain', { reason: maxSafeId('r'), controllerDeviceId: maxSafeId('c'), leaseId: maxSafeId('l') }),
      derivedShadowPersistedId('store-load', { controllerDeviceId: maxSafeId('c'), hostDeviceId: maxSafeId('h'), reason: maxSafeId('r') }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id).toMatch(SAFE_ID_RE);
    }
  });

  it('matches SHA-256 known vectors and uses canonical tuple encoding for persisted identities', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256Hex('বাংলা')).toBe('3bdfce0a268d154828af6e9f5e4b9962d0ee04a148ca64d8994570eed9556afd');
    const first = derivedShadowPersistedId('revoked', { keyRotationId: 'kE3cC', controllerDeviceId: 'ctrl_1', fence, revokedAt: 2_100, signature: 'sig_revoke' });
    const second = derivedShadowPersistedId('revoked', { keyRotationId: 'kaBAD', controllerDeviceId: 'ctrl_1', fence, revokedAt: 2_100, signature: 'sig_revoke' });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^revoked:v2:[0-9a-f]{64}$/);
    expect(second).toMatch(/^revoked:v2:[0-9a-f]{64}$/);
    expect(first).not.toContain('bbbcf594');
    expect(second).not.toContain('bbbcf594');
    expect(shadowIdentityDigest('tuple', { a: 'bc', ab: 'c' })).not.toBe(shadowIdentityDigest('tuple', { a: 'b', c: 'abc' }));
  });

  it('keeps 10000 deterministic canonical security tuples unique and bounded', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const id = derivedShadowPersistedId('revoked', {
        accountId: `acct_${index % 97}`,
        scopeId: `scope_${index % 193}`,
        hostDeviceId: `host_${index % 389}`,
        controllerDeviceId: `ctrl_${index % 997}`,
        epoch: index,
        leaseId: `lease_${index}`,
        keyRotationId: `rotation_${index}`,
        revokedAt: 2_000 + index,
        signature: `sig_${index}`,
      });
      expect(id).toMatch(SAFE_ID_RE);
      expect(id).toMatch(/^revoked:v2:[0-9a-f]{64}$/);
      expect(id).not.toMatch(/^revoked:[0-9a-f]{8}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });

  it('does not alias the reproduced FNV revocation collision pair or trust old 8-hex replay ids', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    await store.transaction((tx) => tx.recordRepair({ id: 'revoked:bbbcf594', reason: 'controller-revoked', createdAt: 1_900 }));
    const client = makeClient(store);
    await client.load();
    const first = { family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'kE3cC', signature: 'sig_revoke' } as const;
    const second = { ...first, keyRotationId: 'kaBAD', signature: 'sig_revoke_2' } as const;
    expect((await client.applyMessage(first)).status).toBe('applied');
    expect((await client.applyMessage(second)).status).toBe('applied');
    const generated = client.read().repairRecords.filter((record) => record.reason === 'controller-revoked').map((record) => record.id).sort();
    expect(generated).toContain('revoked:bbbcf594');
    const current = generated.filter((id) => id.startsWith('revoked:v2:'));
    expect(current).toHaveLength(2);
    expect(new Set(current).size).toBe(2);
    expect(current.every((id) => /^revoked:v2:[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(current.some((id) => /^revoked:[0-9a-f]{8}$/.test(id))).toBe(false);
  });

  it('derives a stable internal replay id for old protocol v1 visual grants without grantId', async () => {
    const client = makeClient();
    await client.load();
    await client.applyMessage(preview);
    const legacyGrant = { family: 'visual-control-grant', v: 1, visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_900, signature: 'sig_control_legacy' } as const;
    expect((await client.applyMessage(legacyGrant)).status).toBe('applied');
    expect((await client.applyMessage(legacyGrant)).status).toBe('applied');
    expect(client.read().visualGrants).toHaveLength(1);
    expect(client.read().visualGrants[0]?.grantId).toMatch(/^v1:/);
  });

  it('derives scope only from stored preview and keeps two visual grants distinct', async () => {
    const client = makeClient();
    await client.load();
    await client.applyMessage(preview);
    await client.applyMessage({ family: 'visual-control-grant', v: 1, grantId: 'vgrant_1', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_900, signature: 'sig_control_1' });
    await client.applyMessage({ family: 'visual-control-grant', v: 1, grantId: 'vgrant_2', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_901, signature: 'sig_control_2' });
    expect(client.read().visualGrants.map((grant) => grant.grantId).sort()).toEqual(['vgrant_1', 'vgrant_2']);
    expect(await client.requestPreviewControl({ visualSessionId: 'vis_1', grantId: 'vgrant_2' })).toMatchObject({ activeGrantId: 'vgrant_2' });

    await client.applyMessage({ ...preview, visualSessionId: 'vis_2', sessionId: 'sess_other' });
    await client.applyMessage({ family: 'visual-control-grant', v: 1, grantId: 'vgrant_mismatch', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_902, signature: 'sig_control_3' });
    const storedMismatch = client.read().visualGrants.find((grant) => grant.grantId === 'vgrant_mismatch');
    expect(storedMismatch?.sessionId).toBe('sess_1');
    expect(await client.requestPreviewControl({ visualSessionId: 'vis_2', grantId: 'vgrant_mismatch' })).toBeNull();

    await client.applyMessage({ family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_1', revokedAt: 2_100, keyRotationId: 'rotation_1', signature: 'sig_revoke' });
    expect(client.read().visualGrants).toHaveLength(0);
    expect((await client.dispatchPreviewInput(input(1))).ok).toBe(false);
  });

  it('downgrades persisted control after preview expiry across restart', async () => {
    const store = createMemoryShadowStore('ctrl_1', 'host_1', expectedAuthority);
    const client = makeClient(store, 2_000);
    await client.load();
    await client.applyMessage(preview);
    await client.applyMessage({ family: 'visual-control-grant', v: 1, grantId: 'vgrant_1', visualSessionId: 'vis_1', fence, controllerDeviceId: 'ctrl_1', mode: 'control', expiresAt: 9_999, signedAt: 1_900, signature: 'sig_control' });
    await client.requestPreviewControl({ visualSessionId: 'vis_1', grantId: 'vgrant_1' });
    const expired = makeClient(store, 10_000);
    await expired.load();
    expect((await expired.dispatchPreviewInput(input(1))).ok).toBe(false);
    expect(expired.read().previews[0]?.inputMode).toBe('view-only');
  });
});
