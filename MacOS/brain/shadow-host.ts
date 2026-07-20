import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  advanceCommandLifecycle,
  planCacheResume,
  planRetention,
  validateAuthorityFence,
  type ByteRange,
  type CacheResumePlan,
  type CommandLifecycleState,
  type Fence,
  type HostCommandAck,
  type ShadowCollection,
  type ShadowStateEvent,
} from '@maestro/realtime';

const ZERO_HASH = '0'.repeat(64);
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_SEGMENT_EVENTS = 50_000;
const DEFAULT_COMMAND_DEADLINE_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_COMMAND_ATTEMPTS = 5;
const DEFAULT_MAX_BLOB_BYTES = 4 * 1024 * 1024;

const DEFAULT_LIMITS: ShadowHostStorageLimits = {
  maxEventEnvelopeBytes: MAX_EVENT_BYTES,
  maxTotalJournalBytes: 64 * 1024 * 1024,
  maxSnapshotChunkBytes: DEFAULT_MAX_BLOB_BYTES,
  maxTotalSnapshotBytes: 128 * 1024 * 1024,
  maxBlobBytes: DEFAULT_MAX_BLOB_BYTES,
  maxTotalBlobBytes: 128 * 1024 * 1024,
  maxCommandParamsBytes: 128 * 1024,
  maxCommandRows: 10_000,
  maxQuarantineItemBytes: 64 * 1024,
  maxTotalQuarantineBytes: 2 * 1024 * 1024,
  retainedSnapshots: 2,
  safetyTailEvents: 10,
};

export interface ShadowHostKeyProvider {
  currentKey(): { keyId: string; key: Buffer };
  keyFor(keyId: string): Buffer | null;
}

export interface ShadowAuthority {
  accountId: string;
  scopeId: string;
  hostDeviceId: string;
  epoch: number;
  leaseId: string;
  leaseExpiresAt: number;
  revokedControllerDeviceIds?: readonly string[];
}

export interface AppendShadowEventInput {
  fence: Fence;
  controllerDeviceId?: string;
  collection: ShadowCollection;
  op: ShadowStateEvent['op'];
  entityId: string;
  revision: number;
  commandId?: string;
  payload: unknown;
  now: number;
}

export interface ShadowSnapshotChunk {
  collection: ShadowCollection;
  pageKey: string;
  entities: unknown[];
}

export interface ShadowHostPaths {
  sqlitePath: string;
  journalDir: string;
  snapshotDir: string;
  blobDir: string;
  quarantineDir: string;
}

export interface ShadowHostRelayPort {
  publishOrderedEvents(scopeId: string, fence: Fence, events: ShadowStateEvent[]): Promise<void> | void;
  publishSnapshotManifest(scopeId: string, manifest: unknown): Promise<void> | void;
  publishSnapshotChunk(scopeId: string, contentId: string, encryptedEnvelope: unknown): Promise<void> | void;
  fetchCommands(scopeId: string, limit: number): Promise<unknown[]> | unknown[];
  submitCommandAck(scopeId: string, ack: HostCommandAck): Promise<void> | void;
  submitCursor(scopeId: string, cursor: { controllerDeviceId: string; lastSeq: number; snapshotId?: string }): Promise<void> | void;
}

export interface ShadowHostStorageLimits {
  maxEventEnvelopeBytes: number;
  maxTotalJournalBytes: number;
  maxSnapshotChunkBytes: number;
  maxTotalSnapshotBytes: number;
  maxBlobBytes: number;
  maxTotalBlobBytes: number;
  maxCommandParamsBytes: number;
  maxCommandRows: number;
  maxQuarantineItemBytes: number;
  maxTotalQuarantineBytes: number;
  retainedSnapshots: number;
  safetyTailEvents: number;
}

export interface ClaimedCommand {
  state: CommandLifecycleState;
  ownerId: string;
  claimToken: string;
  leaseUntil: number;
  attempt: number;
}

interface Envelope {
  alg: 'aes-256-gcm';
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

interface StoredEventRow {
  scope_id: string;
  epoch: number;
  seq: number;
  event_id: string;
  prev_seq: number;
  chain_hash: string;
  payload_digest: string;
  payload_envelope: string;
  wire_event: string;
  segment_id: string;
  created_at: number;
}

interface StoredCommandRow {
  scope_id: string;
  command_id: string;
  idempotency_key: string;
  lifecycle: string;
  params_digest: string;
  result_event_id: string | null;
  attempts: number;
  next_attempt_at: number;
  deadline_at: number;
  leased_until: number | null;
  lease_owner: string | null;
  lease_token: string | null;
}

interface SegmentRecordRow {
  scope_id: string;
  epoch: number;
  segment_id: string;
  seq: number;
  event_id: string;
  chain_hash: string;
  payload_digest: string;
  envelope_digest: string;
  wire_digest: string;
  record_json: string;
  record_hash: string;
  bytes: number;
  created_at: number;
}

interface SnapshotChunkManifest {
  contentId: string;
  collection: ShadowCollection;
  pageKey: string;
  entityCount: number;
  plaintextDigest: string;
  ciphertextDigest: string;
  encryptedBytes: number;
  keyId: string;
}

interface SnapshotManifest {
  family: 'shadow-snapshot-manifest';
  v: 1;
  snapshotId: string;
  fence: Fence;
  scopeId: string;
  epoch: number;
  baseSeq: number;
  baseEventId: string | null;
  basePayloadDigest: string | null;
  baseChainHash: string;
  chunks: SnapshotChunkManifest[];
  createdAt: number;
  manifestDigest: string;
}

interface SnapshotRow {
  scope_id: string;
  snapshot_id: string;
  account_id: string;
  host_device_id: string;
  lease_id: string;
  epoch: number;
  created_at: number;
  base_seq: number;
  base_event_id: string | null;
  base_payload_digest: string | null;
  base_chain_hash: string;
  manifest_json: string;
  manifest_digest: string;
  published_at: number;
  verified: number;
}

interface SnapshotChunkRow {
  snapshot_id: string;
  ordinal: number;
  content_id: string;
  collection: string;
  page_key: string;
  file_path: string;
  key_id: string;
  plaintext_digest: string;
  ciphertext_digest: string;
  bytes: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function protocolDigest(hexDigest: string): string {
  return hexDigest.startsWith('sha256:') ? hexDigest : `sha256:${hexDigest}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function eventIdFor(input: { scopeId: string; epoch: number; seq: number; collection: string; entityId: string; commandId?: string; payloadDigest: string }): string {
  return `shev_${sha256(stableJson(input)).slice(0, 40)}`;
}

function contentIdFor(key: Buffer, parts: unknown): string {
  return `shcid_${createHmac('sha256', key).update(stableJson(parts)).digest('base64url')}`;
}

function assertSafeId(name: string, value: string): void {
  if (!/^[A-Za-z0-9._:@/-]{1,240}$/.test(value)) throw new Error(`${name}-invalid`);
}

function scopeHash(scopeId: string): string {
  return sha256(scopeId).slice(0, 24);
}

function segmentIndexFromId(segmentId: string): number | null {
  const match = /^seg-(\d+)-(\d+)$/.exec(segmentId);
  return match ? Number(match[2]) : null;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function encryptJson(provider: ShadowHostKeyProvider, value: unknown, maxBytes = MAX_EVENT_BYTES): { envelope: Envelope; digest: string; plaintextBytes: number } {
  const plain = Buffer.from(stableJson(value));
  if (plain.length > maxBytes) throw new Error('payload-too-large');
  const { keyId, key } = provider.currentKey();
  if (key.length !== 32) throw new Error('bad-shadow-key');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    digest: sha256(plain),
    plaintextBytes: plain.length,
    envelope: { alg: 'aes-256-gcm', keyId, nonce: nonce.toString('base64url'), tag: tag.toString('base64url'), ciphertext: ciphertext.toString('base64url') },
  };
}

function decryptJson(provider: ShadowHostKeyProvider, envelopeJson: string): unknown {
  const envelope = parseJson<Envelope>(envelopeJson);
  const key = provider.keyFor(envelope.keyId);
  if (!key || key.length !== 32) throw new Error('missing-shadow-key');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function writeAtomic(file: string, payload: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try {
    const dirFd = openSync(dirname(file), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Some filesystems do not support fsync on directories.
  }
}

function fileSizeIfExists(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

function isRetryableCommandState(state: CommandLifecycleState): boolean {
  return state.status === 'sent' || state.status === 'accepted' || state.status === 'executing' || state.status === 'awaiting-state-event';
}

function sameFence(a: Fence, b: Fence): boolean {
  return a.accountId === b.accountId
    && a.scopeId === b.scopeId
    && a.hostDeviceId === b.hostDeviceId
    && a.epoch === b.epoch
    && a.leaseId === b.leaseId;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runWithBusyRetry<T>(fn: () => T, deadlineMs = 5_000): T {
  const started = Date.now();
  let delay = 5;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
      if (!code.startsWith('SQLITE_BUSY') || Date.now() - started >= deadlineMs) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 50);
    }
  }
}

export class StaticShadowKeyProvider implements ShadowHostKeyProvider {
  constructor(private readonly keyId: string, private readonly key: Buffer) {}
  currentKey(): { keyId: string; key: Buffer } { return { keyId: this.keyId, key: this.key }; }
  keyFor(keyId: string): Buffer | null { return keyId === this.keyId ? this.key : null; }
}

export class ShadowHostCore {
  readonly paths: ShadowHostPaths;
  private readonly db: Database.Database;
  private readonly limits: ShadowHostStorageLimits;
  private crashPoint: 'after-db-commit-before-materialize' | 'during-temp-write' | null = null;
  private failNextRecoveryRebuild = false;
  private compactionCalls = { retention: 0, budget: 0 };

  constructor(rootDir: string, private readonly keys: ShadowHostKeyProvider, limits: Partial<ShadowHostStorageLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.paths = {
      sqlitePath: join(rootDir, 'shadow.sqlite'),
      journalDir: join(rootDir, 'shadow-journal'),
      snapshotDir: join(rootDir, 'shadow-snapshots'),
      blobDir: join(rootDir, 'shadow-blobs'),
      quarantineDir: join(rootDir, 'shadow-quarantine'),
    };
    for (const dir of [rootDir, this.paths.journalDir, this.paths.snapshotDir, this.paths.blobDir, this.paths.quarantineDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(this.paths.sqlitePath);
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.rebuildAllMaterializations();
  }

  private migrate(): void {
    runWithBusyRetry(() => this.db.pragma('journal_mode = WAL'));
    runWithBusyRetry(() => this.db.pragma('synchronous = FULL'));
    runWithBusyRetry(() => this.db.pragma('foreign_keys = ON'));
    const tx = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS authority(scope_id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS blocked_scopes(scope_id TEXT PRIMARY KEY, reason TEXT NOT NULL, blocked_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
          scope_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE, prev_seq INTEGER NOT NULL, chain_hash TEXT NOT NULL,
          payload_digest TEXT NOT NULL, payload_envelope TEXT NOT NULL, wire_event TEXT NOT NULL,
          segment_id TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          PRIMARY KEY(scope_id, epoch, seq)
        );
        CREATE TABLE IF NOT EXISTS segment_records(
          scope_id TEXT NOT NULL, epoch INTEGER NOT NULL, segment_id TEXT NOT NULL,
          seq INTEGER NOT NULL, event_id TEXT NOT NULL, chain_hash TEXT NOT NULL,
          payload_digest TEXT NOT NULL, envelope_digest TEXT NOT NULL, wire_digest TEXT NOT NULL,
          record_json TEXT NOT NULL, record_hash TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(scope_id, epoch, seq), UNIQUE(scope_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS command_ledger(
          scope_id TEXT NOT NULL, command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          lifecycle TEXT NOT NULL, params_digest TEXT NOT NULL, result_event_id TEXT, updated_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
          deadline_at INTEGER NOT NULL DEFAULT 0, leased_until INTEGER, lease_owner TEXT, lease_token TEXT,
          PRIMARY KEY(scope_id, command_id), UNIQUE(scope_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS snapshots(scope_id TEXT NOT NULL, snapshot_id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT '', host_device_id TEXT NOT NULL DEFAULT '', lease_id TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, base_seq INTEGER NOT NULL, base_event_id TEXT, base_payload_digest TEXT, base_chain_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL, published_at INTEGER NOT NULL, verified INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks(snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, content_id TEXT NOT NULL, collection TEXT NOT NULL, page_key TEXT NOT NULL, file_path TEXT NOT NULL, key_id TEXT NOT NULL, plaintext_digest TEXT NOT NULL, ciphertext_digest TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(snapshot_id, ordinal), UNIQUE(snapshot_id, content_id), FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS blob_cas(content_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, plaintext_digest TEXT NOT NULL, ciphertext_digest TEXT NOT NULL, bytes INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, ref_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS corruption(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL, details_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projection_index(
          scope_id TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, key_id TEXT NOT NULL DEFAULT '',
          collection TEXT NOT NULL, entity_id TEXT NOT NULL,
          digest TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(scope_id, epoch, key_id, collection, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_events_scope_epoch_seq ON events(scope_id, epoch, seq);
        CREATE INDEX IF NOT EXISTS idx_segment_records_segment ON segment_records(scope_id, epoch, segment_id, seq);
        CREATE INDEX IF NOT EXISTS idx_command_retry ON command_ledger(scope_id, next_attempt_at, deadline_at, leased_until);
      `);
      for (const ddl of [
        'ALTER TABLE command_ledger ADD COLUMN lease_token TEXT',
        'ALTER TABLE snapshots ADD COLUMN base_event_id TEXT',
        'ALTER TABLE snapshots ADD COLUMN base_payload_digest TEXT',
        `ALTER TABLE snapshots ADD COLUMN base_chain_hash TEXT NOT NULL DEFAULT '${ZERO_HASH}'`,
        'ALTER TABLE snapshots ADD COLUMN manifest_digest TEXT NOT NULL DEFAULT ""',
        'ALTER TABLE snapshots ADD COLUMN account_id TEXT NOT NULL DEFAULT ""',
        'ALTER TABLE snapshots ADD COLUMN host_device_id TEXT NOT NULL DEFAULT ""',
        'ALTER TABLE snapshots ADD COLUMN lease_id TEXT NOT NULL DEFAULT ""',
        'ALTER TABLE snapshots ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE snapshots ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE chunks ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE chunks ADD COLUMN key_id TEXT NOT NULL DEFAULT ""',
      ]) {
        try { this.db.exec(ddl); } catch {}
      }
      this.migrateProjectionIndexAuthorityFence();
    });
    runWithBusyRetry(() => tx.immediate());
  }

  private migrateProjectionIndexAuthorityFence(): void {
    const cols = this.db.prepare('PRAGMA table_info(projection_index)').all() as Array<{ name: string; pk: number }>;
    const hasEpoch = cols.some((c) => c.name === 'epoch');
    const hasKeyId = cols.some((c) => c.name === 'key_id');
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',');
    if (hasEpoch && hasKeyId && pk === 'scope_id,epoch,key_id,collection,entity_id') return;
    this.db.exec(`
      ALTER TABLE projection_index RENAME TO projection_index_old;
      CREATE TABLE projection_index(
        scope_id TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, key_id TEXT NOT NULL DEFAULT '',
        collection TEXT NOT NULL, entity_id TEXT NOT NULL,
        digest TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope_id, epoch, key_id, collection, entity_id)
      );
      INSERT OR IGNORE INTO projection_index(scope_id, epoch, key_id, collection, entity_id, digest, revision, deleted, updated_at)
      SELECT scope_id, 0, '', collection, entity_id, digest, revision, deleted, updated_at FROM projection_index_old;
      DROP TABLE projection_index_old;
    `);
  }

  private immediate<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return runWithBusyRetry(() => tx.immediate());
  }

  debugSetCrashPointForTest(point: ShadowHostCore['crashPoint']): void {
    this.crashPoint = point;
  }

  debugFailNextRecoveryRebuildForTest(): void {
    this.failNextRecoveryRebuild = true;
  }

  close(): void {
    this.db.close();
  }

  setAuthority(authority: ShadowAuthority): void {
    assertSafeId('scope', authority.scopeId);
    if (authority.epoch < 1 || authority.leaseExpiresAt <= 0) throw new Error('authority-invalid');
    const normalized: ShadowAuthority = { ...authority, revokedControllerDeviceIds: [...(authority.revokedControllerDeviceIds ?? [])] };
    this.db.prepare('INSERT INTO authority(scope_id,json) VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET json=excluded.json').run(authority.scopeId, stableJson(normalized));
  }

  getAuthority(scopeId: string): ShadowAuthority | null {
    const row = this.db.prepare('SELECT json FROM authority WHERE scope_id=? LIMIT 1').get(scopeId) as { json: string } | undefined;
    return row ? parseJson<ShadowAuthority>(row.json) : null;
  }

  requireFence(fence: Fence, controllerDeviceId: string | undefined, now: number): ShadowAuthority {
    const blocked = this.db.prepare('SELECT reason FROM blocked_scopes WHERE scope_id=? LIMIT 1').get(fence.scopeId) as { reason: string } | undefined;
    if (blocked) throw new Error(`scope-blocked-${blocked.reason}`);
    const authority = this.getAuthority(fence.scopeId);
    if (!authority) throw new Error('authority-missing');
    const checked = validateAuthorityFence({
      fence: {
        accountId: authority.accountId,
        scopeId: authority.scopeId,
        hostDeviceId: authority.hostDeviceId,
        epoch: authority.epoch,
        leaseId: authority.leaseId,
      },
      leaseExpiresAt: authority.leaseExpiresAt,
      revokedControllerDeviceIds: new Set(authority.revokedControllerDeviceIds ?? []),
    }, { fence, controllerDeviceId, now });
    if (!checked.ok) throw new Error(`fence-${checked.reason}`);
    return authority;
  }

  /**
   * HIGH-2: the narrow, PUBLIC, synchronous execution-time authority gate. Wraps the
   * authoritative {@link requireFence} (account/scope/host/epoch/leaseExpiresAt +
   * revokedControllerDeviceIds) and throws a TAGGED `authorityError` on any failure so
   * the data-service driver + the in-adapter guard can fail closed BEFORE a product
   * mutation. Reads the persisted authority row synchronously (no await), so when it is
   * called immediately before a synchronous Store mutation the pair is a single
   * linearization point: a revoke/expiry committed before it → zero effect.
   */
  assertCurrentAuthority(fence: Fence, controllerDeviceId: string | undefined, now: number): void {
    try {
      this.requireFence(fence, controllerDeviceId, now);
    } catch (e) {
      throw Object.assign(new Error(`authority-invalid:${(e as Error).message}`), { authorityError: true });
    }
  }

  /**
   * HIGH-2: terminalize a CLAIMED command locally without any product mutation, receipt,
   * or published event — used when authority is invalid at drive/mutation time. Advances
   * the ledger row to a terminal (non-retryable) state and forces its deadline to `now`
   * so it is never re-claimed hot. Verifies the caller still owns the claim; a no-op if
   * the row is missing / already terminal / owned by someone else.
   */
  terminalizeCommandLocally(scopeId: string, commandId: string, ownerId: string, claimToken: string, now: number): void {
    this.immediate(() => {
      const row = this.db.prepare('SELECT * FROM command_ledger WHERE scope_id=? AND command_id=? LIMIT 1').get(scopeId, commandId) as StoredCommandRow | undefined;
      if (!row) return;
      if (row.lease_owner !== ownerId || row.lease_token !== claimToken) return; // not our claim
      const state = parseJson<CommandLifecycleState>(row.lifecycle);
      if (!isRetryableCommandState(state)) return; // already terminal
      const advanced = advanceCommandLifecycle(state, { type: 'expire', now });
      if (advanced.outcome !== 'advanced') return;
      this.db.prepare('UPDATE command_ledger SET lifecycle=?, leased_until=NULL, lease_owner=NULL, lease_token=NULL, deadline_at=?, next_attempt_at=?, updated_at=? WHERE scope_id=? AND command_id=?')
        .run(stableJson(advanced.state), now, now, now, scopeId, commandId);
    });
  }

  appendEvent(input: AppendShadowEventInput): ShadowStateEvent {
    const authority = this.requireFence(input.fence, input.controllerDeviceId, input.now);
    assertSafeId('entity', input.entityId);
    const encrypted = encryptJson(this.keys, input.payload, this.limits.maxEventEnvelopeBytes);
    const envelopeJson = stableJson(encrypted.envelope);
    if (Buffer.byteLength(envelopeJson) > this.limits.maxEventEnvelopeBytes) throw new Error('event-envelope-too-large');
    const event = this.immediate(() => this.insertEventInTransaction(authority, encrypted, envelopeJson, input));
    if (this.crashPoint === 'after-db-commit-before-materialize') throw new Error('crash-after-db-commit-before-materialize');
    this.materializeSegment(authority.scopeId, authority.epoch, `seg-${authority.epoch}-${Math.floor((event.seq - 1) / MAX_SEGMENT_EVENTS)}`);
    this.rebuildAllMaterializations();
    this.enforceJournalBudgetAfterMaterialization(authority.scopeId, authority.epoch, input.now);
    return event;
  }

  /**
   * The shared, in-transaction event insert (extracted from {@link appendEvent} so
   * {@link projectEntity} can append + update the projection index ATOMICALLY in the
   * same transaction). MUST be called inside `this.immediate(...)`. Behaviour is
   * byte-identical to the prior inline block — dedup by content-addressed eventId,
   * chain-hash advance, command-state application, segment record.
   */
  private insertEventInTransaction(
    authority: ShadowAuthority,
    encrypted: ReturnType<typeof encryptJson>,
    envelopeJson: string,
    input: Pick<AppendShadowEventInput, 'fence' | 'collection' | 'op' | 'entityId' | 'revision' | 'commandId' | 'now'>,
  ): ShadowStateEvent {
    const head = this.headInTransaction(authority.scopeId, authority.epoch);
    const seq = head.seq + 1;
    const payloadDigest = protocolDigest(encrypted.digest);
    const eventId = eventIdFor({ scopeId: authority.scopeId, epoch: authority.epoch, seq, collection: input.collection, entityId: input.entityId, commandId: input.commandId, payloadDigest });
    const existing = this.db.prepare('SELECT wire_event,payload_digest FROM events WHERE event_id=? LIMIT 1').get(eventId) as { wire_event: string; payload_digest: string } | undefined;
    if (existing) {
      if (existing.payload_digest !== payloadDigest) throw new Error('event-conflict');
      return parseJson<ShadowStateEvent>(existing.wire_event);
    }
    const chainHash = sha256(`${head.chainHash}:${eventId}:${payloadDigest}`);
    const segmentId = `seg-${authority.epoch}-${Math.floor((seq - 1) / MAX_SEGMENT_EVENTS)}`;
    const event = {
      family: 'state-event',
      v: 1,
      eventId,
      seq,
      prevSeq: head.seq,
      fence: input.fence,
      collection: input.collection,
      op: input.op,
      entityId: input.entityId,
      revision: input.revision,
      commandId: input.commandId,
      durable: true,
      payloadCiphertext: encrypted.envelope.ciphertext,
      payloadDigest,
      keyId: encrypted.envelope.keyId,
      createdAt: input.now,
      signature: sha256(`${chainHash}:${eventId}`).slice(0, 64),
    } as ShadowStateEvent & { family: 'state-event' };
    const wireJson = stableJson(event);
    const record = {
      segmentId,
      seq,
      eventId,
      chainHash,
      payloadDigest,
      envelopeDigest: sha256(envelopeJson),
      wireDigest: sha256(wireJson),
      wire: event,
      envelope: encrypted.envelope,
    };
    const recordJson = stableJson(record);
    const recordHash = sha256(recordJson);
    this.db.prepare(`
      INSERT INTO events(scope_id,epoch,seq,event_id,prev_seq,chain_hash,payload_digest,payload_envelope,wire_event,segment_id,published,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
    `).run(authority.scopeId, authority.epoch, seq, eventId, head.seq, chainHash, payloadDigest, envelopeJson, wireJson, segmentId, input.now);
    if (input.commandId) this.applyCommandStateFromEventInTransaction(authority.scopeId, input.commandId, event, input.now);
    this.db.prepare(`
      INSERT INTO segment_records(scope_id,epoch,segment_id,seq,event_id,chain_hash,payload_digest,envelope_digest,wire_digest,record_json,record_hash,bytes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(authority.scopeId, authority.epoch, segmentId, seq, eventId, chainHash, payloadDigest, sha256(envelopeJson), sha256(wireJson), recordJson, recordHash, Buffer.byteLength(recordJson) + 1, input.now);
    return event;
  }

  /**
   * Phase 3A2b1 Section B: durable projection-index + event coherence. Compares the
   * caller's canonical `digest` for `(scopeId, collection, entityId)` against the
   * persisted projection index and, ONLY on a semantic change, atomically bumps a
   * monotonic per-entity revision, upserts the index, and appends the corresponding
   * encrypted state event — all in ONE SQLite transaction.
   *
   *   - unchanged digest + same presence → NO-OP (no event, revision preserved);
   *   - new / changed / reappearing entity → revision++ and one `upsert` event;
   *   - deletion (`op: 'delete'`) → revision++ and one deterministic tombstone event
   *     (idempotent: a second delete of an already-deleted entity is a no-op).
   *
   * A corrupt existing index row is quarantined fail-closed (recorded in `corruption`)
   * and the entity is skipped WITHOUT resetting or touching any other entity. Restart
   * reuses the persisted index, so no duplicate events are emitted for unchanged state.
   */
  projectEntity(input: {
    fence: Fence;
    collection: ShadowCollection;
    entityId: string;
    digest: string;
    op: 'upsert' | 'delete';
    payload: unknown;
    now: number;
    commandId?: string;
  }): { appended: boolean; revision: number; event?: ShadowStateEvent; quarantined?: boolean } {
    const authority = this.requireFence(input.fence, undefined, input.now);
    assertSafeId('entity', input.entityId);
    if (typeof input.digest !== 'string' || input.digest.length === 0 || input.digest.length > 128) throw new Error('projection-digest-invalid');
    const desiredDeleted = input.op === 'delete';
    const result = this.immediate(() => {
      const keyId = this.keys.currentKey().keyId;
      const row = this.db.prepare('SELECT digest,revision,deleted FROM projection_index WHERE scope_id=? AND epoch=? AND key_id=? AND collection=? AND entity_id=? LIMIT 1')
        .get(authority.scopeId, authority.epoch, keyId, input.collection, input.entityId) as { digest: string; revision: number; deleted: number } | undefined;
      if (row) {
        // Quarantine a corrupt index row fail-closed (do not emit a possibly-wrong event).
        if (typeof row.digest !== 'string' || !Number.isInteger(row.revision) || row.revision < 0 || (row.deleted !== 0 && row.deleted !== 1)) {
          this.quarantineInTransaction(authority.scopeId, `projection-index-corrupt:${input.collection}`, { collection: input.collection, entityId: input.entityId }, input.now);
          return { appended: false as const, revision: 0, quarantined: true as const };
        }
        const sameDeleted = (row.deleted === 1) === desiredDeleted;
        if (row.digest === input.digest && sameDeleted) {
          return { appended: false as const, revision: row.revision };
        }
      }
      const nextRevision = (row?.revision ?? 0) + 1;
      const encrypted = encryptJson(this.keys, input.payload, this.limits.maxEventEnvelopeBytes);
      const envelopeJson = stableJson(encrypted.envelope);
      if (Buffer.byteLength(envelopeJson) > this.limits.maxEventEnvelopeBytes) throw new Error('event-envelope-too-large');
      const event = this.insertEventInTransaction(authority, encrypted, envelopeJson, {
        fence: input.fence, collection: input.collection, op: input.op, entityId: input.entityId,
        revision: nextRevision, commandId: input.commandId, now: input.now,
      });
      this.db.prepare(`
        INSERT INTO projection_index(scope_id,epoch,key_id,collection,entity_id,digest,revision,deleted,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_id,epoch,key_id,collection,entity_id) DO UPDATE SET digest=excluded.digest, revision=excluded.revision, deleted=excluded.deleted, updated_at=excluded.updated_at
      `).run(authority.scopeId, authority.epoch, keyId, input.collection, input.entityId, input.digest, nextRevision, desiredDeleted ? 1 : 0, input.now);
      return { appended: true as const, revision: nextRevision, event };
    });
    if (result.appended) {
      if (this.crashPoint === 'after-db-commit-before-materialize') throw new Error('crash-after-db-commit-before-materialize');
      const seq = result.event!.seq;
      this.materializeSegment(authority.scopeId, authority.epoch, `seg-${authority.epoch}-${Math.floor((seq - 1) / MAX_SEGMENT_EVENTS)}`);
      this.rebuildAllMaterializations();
      this.enforceJournalBudgetAfterMaterialization(authority.scopeId, authority.epoch, input.now);
    }
    return result;
  }

  /**
   * The live (non-deleted) projection-index entities for a scope+collection — used
   * by the projection driver to detect entities that DISAPPEARED from the Store and
   * must be tombstoned. Corrupt rows are skipped (they are quarantined lazily on the
   * next `projectEntity` touch).
   */
  projectionIndexEntities(scopeId: string, collection: ShadowCollection): Array<{ entityId: string; digest: string; revision: number; deleted: boolean }> {
    const authority = this.getAuthority(scopeId);
    if (!authority) return [];
    const keyId = this.keys.currentKey().keyId;
    const rows = this.db.prepare('SELECT entity_id,digest,revision,deleted FROM projection_index WHERE scope_id=? AND epoch=? AND key_id=? AND collection=? ORDER BY entity_id ASC')
      .all(scopeId, authority.epoch, keyId, collection) as Array<{ entity_id: string; digest: string; revision: number; deleted: number }>;
    const out: Array<{ entityId: string; digest: string; revision: number; deleted: boolean }> = [];
    for (const r of rows) {
      if (typeof r.entity_id !== 'string' || typeof r.digest !== 'string' || !Number.isInteger(r.revision)) continue;
      out.push({ entityId: r.entity_id, digest: r.digest, revision: r.revision, deleted: r.deleted === 1 });
    }
    return out;
  }

  private quarantineInTransaction(scopeId: string, reason: string, details: unknown, now: number): void {
    const id = sha256(`${scopeId}:${reason}:${stableJson(details)}`).slice(0, 32);
    this.db.prepare('INSERT OR IGNORE INTO corruption(id,scope_id,reason,quarantined_at,details_json) VALUES(?,?,?,?,?)')
      .run(id, scopeId, reason, now, stableJson(details));
  }

  private headInTransaction(scopeId: string, epoch: number): { seq: number; chainHash: string } {
    const row = this.db.prepare('SELECT seq,chain_hash FROM events WHERE scope_id=? AND epoch=? ORDER BY seq DESC LIMIT 1').get(scopeId, epoch) as { seq: number; chain_hash: string } | undefined;
    return row ? { seq: row.seq, chainHash: row.chain_hash } : { seq: 0, chainHash: ZERO_HASH };
  }

  private materializationPath(scopeId: string, epoch: number, segmentId: string): string {
    const index = segmentIndexFromId(segmentId);
    if (index === null) throw new Error('segment-id-invalid');
    return join(this.paths.journalDir, `scope-${scopeHash(scopeId)}`, `epoch-${epoch}`, `segment-${index}.mjlog`);
  }

  private materializeSegment(scopeId: string, epoch: number, segmentId: string): void {
    const file = this.materializationPath(scopeId, epoch, segmentId);
    const lock = `${file}.lock`;
    mkdirSync(dirname(file), { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        closeSync(fd);
        break;
      } catch {
        try {
          if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
        } catch {
          // Another materializer can release the lock between exists/stat.
        }
        if (Date.now() - started > 5_000) throw new Error('segment-materialize-lock-timeout');
        sleepSync(10);
      }
    }
    try {
      const rows = this.db.prepare('SELECT record_json FROM segment_records WHERE scope_id=? AND epoch=? AND segment_id=? ORDER BY seq ASC').all(scopeId, epoch, segmentId) as { record_json: string }[];
      const payload = rows.map((r) => r.record_json).join('\n') + (rows.length ? '\n' : '');
      if (this.crashPoint === 'during-temp-write') {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp-stale`, payload.slice(0, Math.max(0, Math.floor(payload.length / 2))), { mode: 0o600 });
        throw new Error('crash-during-temp-write');
      }
      writeAtomic(file, payload);
      rmSync(`${file}.tmp-stale`, { force: true });
    } finally {
      rmSync(lock, { force: true });
    }
  }

  private rebuildAllMaterializations(): void {
    const rows = this.db.prepare('SELECT DISTINCT scope_id,epoch,segment_id FROM segment_records ORDER BY scope_id,epoch,segment_id').all() as { scope_id: string; epoch: number; segment_id: string }[];
    const expected = new Set<string>();
    for (const row of rows) {
      const file = this.materializationPath(row.scope_id, row.epoch, row.segment_id);
      expected.add(file);
      this.materializeSegment(row.scope_id, row.epoch, row.segment_id);
    }
    this.removeOwnedOrphanMaterializations(expected);
  }

  private removeOwnedOrphanMaterializations(expectedFiles: Set<string>): void {
    if (!existsSync(this.paths.journalDir)) return;
    for (const scopeName of readdirSync(this.paths.journalDir)) {
      if (!/^scope-[0-9a-f]{24}$/.test(scopeName)) continue;
      const scopeDir = join(this.paths.journalDir, scopeName);
      if (!statSync(scopeDir).isDirectory()) continue;
      for (const epochName of readdirSync(scopeDir)) {
        if (!/^epoch-\d+$/.test(epochName)) continue;
        const epochDir = join(scopeDir, epochName);
        if (!statSync(epochDir).isDirectory()) continue;
        for (const name of readdirSync(epochDir)) {
          const file = join(epochDir, name);
          if (/^segment-\d+\.mjlog$/.test(name)) {
            if (!expectedFiles.has(file)) rmSync(file, { force: true });
          } else if (/^segment-\d+\.mjlog\.(tmp-|lock|tmp-stale)/.test(name) || /^segment-\d+\.mjlog\.lock$/.test(name)) {
            try {
              if (Date.now() - statSync(file).mtimeMs > 10_000) rmSync(file, { force: true });
            } catch {
              // Concurrent materializers can finish and remove temp/lock files between readdir and stat.
            }
          }
        }
      }
    }
  }

  private enforceJournalBudgetAfterMaterialization(scopeId: string, epoch: number, now: number): void {
    const total = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) as b FROM segment_records WHERE scope_id=? AND epoch=?').get(scopeId, epoch) as { b: number }).b;
    if (total <= this.limits.maxTotalJournalBytes) return;
    const head = this.headInTransaction(scopeId, epoch);
    const result = this.compactJournalPrefix({ scopeId, epoch, now, maxEvents: this.limits.safetyTailEvents, reason: 'budget' });
    if (result.kept > Math.max(this.limits.safetyTailEvents, head.seq)) throw new Error('journal-budget-compact-invariant');
    const after = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) as b FROM segment_records WHERE scope_id=? AND epoch=?').get(scopeId, epoch) as { b: number }).b;
    if (after > this.limits.maxTotalJournalBytes) throw new Error('journal-budget-exceeded');
  }

  readEvents(input: { fence: Fence; fromSeq: number; toSeq: number; controllerDeviceId?: string; now: number }): ShadowStateEvent[] {
    const authority = this.requireFence(input.fence, input.controllerDeviceId, input.now);
    if (!isSafeNonNegativeInteger(input.fromSeq) || !isSafeNonNegativeInteger(input.toSeq) || input.toSeq < input.fromSeq) throw new Error('event-range-invalid');
    const rows = this.db.prepare(`
      SELECT wire_event FROM events
      WHERE scope_id=? AND epoch=? AND seq>=? AND seq<=?
      ORDER BY seq ASC,event_id ASC
    `).all(authority.scopeId, authority.epoch, input.fromSeq, input.toSeq) as { wire_event: string }[];
    return rows.map((r) => {
      const event = parseJson<ShadowStateEvent>(r.wire_event);
      if (!sameFence(event.fence, input.fence)) throw new Error('event-fence-mismatch');
      return event;
    });
  }

  decryptEventPayload(eventId: string): unknown {
    const row = this.db.prepare('SELECT payload_envelope,payload_digest FROM events WHERE event_id=? LIMIT 1').get(eventId) as { payload_envelope: string; payload_digest: string } | undefined;
    if (!row) throw new Error('event-missing');
    const value = decryptJson(this.keys, row.payload_envelope);
    if (protocolDigest(sha256(Buffer.from(stableJson(value)))) !== row.payload_digest) throw new Error('payload-digest-mismatch');
    return value;
  }

  createOrRetryCommand(input: { scopeId: string; commandId: string; idempotencyKey: string; fence: Fence; params: unknown; now: number; deadlineAt?: number; retryDelayMs?: number }): CommandLifecycleState {
    this.requireFence(input.fence, undefined, input.now);
    const paramsJson = stableJson(input.params);
    if (Buffer.byteLength(paramsJson) > this.limits.maxCommandParamsBytes) throw new Error('command-params-too-large');
    const paramsDigest = sha256(paramsJson);
    const deadlineAt = input.deadlineAt ?? input.now + DEFAULT_COMMAND_DEADLINE_MS;
    const lifecycle = { commandId: input.commandId, fence: input.fence, status: 'sent' as const, createdAt: input.now, expiresAt: deadlineAt };
    return this.immediate(() => {
      const existing = this.db.prepare('SELECT * FROM command_ledger WHERE scope_id=? AND (command_id=? OR idempotency_key=?) LIMIT 1').get(input.scopeId, input.commandId, input.idempotencyKey) as StoredCommandRow | undefined;
      if (existing) {
        if (existing.params_digest !== paramsDigest || existing.command_id !== input.commandId || existing.idempotency_key !== input.idempotencyKey) throw new Error('command-conflict');
        return parseJson<CommandLifecycleState>(existing.lifecycle);
      }
      const rows = (this.db.prepare('SELECT COUNT(*) as c FROM command_ledger WHERE scope_id=?').get(input.scopeId) as { c: number }).c;
      if (rows >= this.limits.maxCommandRows) {
        this.pruneCommandsInTransaction(input.scopeId, input.now);
        const afterPrune = (this.db.prepare('SELECT COUNT(*) as c FROM command_ledger WHERE scope_id=?').get(input.scopeId) as { c: number }).c;
        if (afterPrune >= this.limits.maxCommandRows) throw new Error('command-row-budget-exceeded');
      }
      try {
        this.db.prepare(`
          INSERT INTO command_ledger(scope_id,command_id,idempotency_key,lifecycle,params_digest,updated_at,attempts,next_attempt_at,deadline_at)
          VALUES(?,?,?,?,?,?,?,?,?)
        `).run(input.scopeId, input.commandId, input.idempotencyKey, stableJson(lifecycle), paramsDigest, input.now, 0, input.now + (input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS), deadlineAt);
      } catch (err) {
        const raced = this.db.prepare('SELECT * FROM command_ledger WHERE scope_id=? AND (command_id=? OR idempotency_key=?) LIMIT 1').get(input.scopeId, input.commandId, input.idempotencyKey) as StoredCommandRow | undefined;
        if (raced && raced.params_digest === paramsDigest && raced.command_id === input.commandId && raced.idempotency_key === input.idempotencyKey) return parseJson<CommandLifecycleState>(raced.lifecycle);
        throw err;
      }
      return lifecycle;
    });
  }

  private pruneCommandsInTransaction(scopeId: string, now: number): void {
    const rows = this.db.prepare('SELECT command_id,lifecycle,deadline_at FROM command_ledger WHERE scope_id=? ORDER BY updated_at ASC').all(scopeId) as StoredCommandRow[];
    for (const row of rows) {
      const state = parseJson<CommandLifecycleState>(row.lifecycle);
      if (!isRetryableCommandState(state) || row.deadline_at <= now) {
        this.db.prepare('DELETE FROM command_ledger WHERE scope_id=? AND command_id=?').run(scopeId, row.command_id);
      }
    }
  }

  claimRetryableCommands(input: { scopeId: string; ownerId: string; now: number; leaseMs: number; limit: number; maxAttempts?: number }): ClaimedCommand[] {
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_COMMAND_ATTEMPTS;
    return this.immediate(() => {
      const rows = this.db.prepare(`
        SELECT * FROM command_ledger
        WHERE scope_id=? AND next_attempt_at<=? AND deadline_at>? AND attempts<? AND (leased_until IS NULL OR leased_until<=?)
        ORDER BY next_attempt_at ASC, updated_at ASC LIMIT ?
      `).all(input.scopeId, input.now, input.now, maxAttempts, input.now, input.limit) as StoredCommandRow[];
      const claimed: ClaimedCommand[] = [];
      for (const row of rows) {
        const state = parseJson<CommandLifecycleState>(row.lifecycle);
        if (!isRetryableCommandState(state)) continue;
        const token = `claim_${sha256(stableJson({ owner: input.ownerId, commandId: row.command_id, attempt: row.attempts + 1, now: input.now, nonce: randomBytes(8).toString('hex') })).slice(0, 32)}`;
        const result = this.db.prepare(`
          UPDATE command_ledger
          SET attempts=attempts+1, leased_until=?, lease_owner=?, lease_token=?, updated_at=?
          WHERE scope_id=? AND command_id=? AND next_attempt_at<=? AND deadline_at>? AND attempts=? AND (leased_until IS NULL OR leased_until<=?)
        `).run(input.now + input.leaseMs, input.ownerId, token, input.now, input.scopeId, row.command_id, input.now, input.now, row.attempts, input.now);
        if (result.changes === 1) claimed.push({ state, ownerId: input.ownerId, claimToken: token, leaseUntil: input.now + input.leaseMs, attempt: row.attempts + 1 });
      }
      return claimed;
    });
  }

  releaseCommandLease(input: { scopeId: string; commandId: string; ownerId: string; claimToken?: string; now: number; nextAttemptAt: number }): boolean {
    return this.immediate(() => {
      const result = this.db.prepare('UPDATE command_ledger SET leased_until=NULL, lease_owner=NULL, lease_token=NULL, next_attempt_at=?, updated_at=? WHERE scope_id=? AND command_id=? AND lease_owner=? AND (? IS NULL OR lease_token=?)')
        .run(input.nextAttemptAt, input.now, input.scopeId, input.commandId, input.ownerId, input.claimToken ?? null, input.claimToken ?? null);
      return result.changes === 1;
    });
  }

  expireRetryDeadlines(scopeId: string, now: number): number {
    const rows = this.db.prepare('SELECT * FROM command_ledger WHERE scope_id=? AND deadline_at<=?').all(scopeId, now) as StoredCommandRow[];
    let changed = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const state = parseJson<CommandLifecycleState>(row.lifecycle);
        if (!isRetryableCommandState(state)) continue;
        const expired = advanceCommandLifecycle(state, { type: 'expire', now });
        if (expired.outcome === 'advanced') {
          this.db.prepare('UPDATE command_ledger SET lifecycle=?, leased_until=NULL, lease_owner=NULL, lease_token=NULL, updated_at=? WHERE scope_id=? AND command_id=?')
            .run(stableJson(expired.state), now, scopeId, row.command_id);
          changed += 1;
        }
      }
    });
    tx();
    return changed;
  }

  applyCommandAck(scopeId: string, ack: HostCommandAck, now: number, claim?: { ownerId: string; claimToken: string }): CommandLifecycleState {
    return this.immediate(() => {
      const row = this.db.prepare('SELECT * FROM command_ledger WHERE scope_id=? AND command_id=? LIMIT 1').get(scopeId, ack.commandId) as StoredCommandRow | undefined;
      if (!row) throw new Error('command-missing');
      if (claim) {
        if (row.lease_owner !== claim.ownerId || row.lease_token !== claim.claimToken || row.leased_until === null || row.leased_until <= now) throw new Error('command-claim-mismatch');
      } else if (row.leased_until !== null) {
        throw new Error('command-claimed');
      }
      const current = parseJson<CommandLifecycleState>(row.lifecycle);
      const advanced = advanceCommandLifecycle(current, { type: 'host-ack', ack, now });
      if (advanced.outcome === 'invalid' || advanced.outcome === 'fenced') throw new Error(`command-${advanced.outcome}`);
      const result = claim
        ? this.db.prepare('UPDATE command_ledger SET lifecycle=?, leased_until=NULL, lease_owner=NULL, lease_token=NULL, updated_at=? WHERE scope_id=? AND command_id=? AND lease_owner=? AND lease_token=? AND leased_until>?')
          .run(stableJson(advanced.state), now, scopeId, ack.commandId, claim.ownerId, claim.claimToken, now)
        : this.db.prepare('UPDATE command_ledger SET lifecycle=?, leased_until=NULL, lease_owner=NULL, lease_token=NULL, updated_at=? WHERE scope_id=? AND command_id=? AND leased_until IS NULL')
          .run(stableJson(advanced.state), now, scopeId, ack.commandId);
      if (result.changes !== 1) throw new Error('command-ack-lost-race');
      return advanced.state;
    });
  }

  private applyCommandStateFromEventInTransaction(scopeId: string, commandId: string, event: ShadowStateEvent, now: number): void {
    const row = this.db.prepare('SELECT * FROM command_ledger WHERE scope_id=? AND command_id=? LIMIT 1').get(scopeId, commandId) as StoredCommandRow | undefined;
    if (!row) return;
    let current = parseJson<CommandLifecycleState>(row.lifecycle);
    if (current.status === 'accepted') {
      const executing = advanceCommandLifecycle(current, { type: 'execute', now });
      if (executing.outcome === 'advanced') current = executing.state;
    }
    if (current.status === 'executing') {
      const awaiting = advanceCommandLifecycle(current, { type: 'await-state-event', now });
      if (awaiting.outcome === 'advanced') current = awaiting.state;
    }
    const advanced = advanceCommandLifecycle(current, { type: 'state-event', event, now });
    if (advanced.outcome === 'advanced' || advanced.outcome === 'idempotent') {
      this.db.prepare('UPDATE command_ledger SET lifecycle=?, result_event_id=?, leased_until=NULL, lease_owner=NULL, lease_token=NULL, updated_at=? WHERE scope_id=? AND command_id=?')
        .run(stableJson(advanced.state), event.eventId, now, scopeId, commandId);
    }
  }

  createSnapshot(input: { fence: Fence; chunks: ShadowSnapshotChunk[]; now: number; maxChunkBytes?: number }): { snapshotId: string; baseSeq: number; chunkIds: string[] } {
    const authority = this.requireFence(input.fence, undefined, input.now);
    const head = this.headInTransaction(authority.scopeId, authority.epoch);
    const base = head.seq === 0 ? null : this.db.prepare('SELECT event_id,payload_digest,chain_hash FROM events WHERE scope_id=? AND epoch=? AND seq=?').get(authority.scopeId, authority.epoch, head.seq) as { event_id: string; payload_digest: string; chain_hash: string };
    const key = this.keys.currentKey();
    const maxChunkBytes = Math.min(input.maxChunkBytes ?? this.limits.maxSnapshotChunkBytes, this.limits.maxSnapshotChunkBytes);
    const prepared = input.chunks.map((chunk) => {
      const plain = Buffer.from(stableJson(chunk.entities));
      if (plain.length > maxChunkBytes) throw new Error('chunk-too-large');
      const cid = contentIdFor(key.key, { scopeId: authority.scopeId, collection: chunk.collection, pageKey: chunk.pageKey, digest: sha256(plain) });
      const existing = this.db.prepare('SELECT file_path,key_id,plaintext_digest,ciphertext_digest,bytes FROM chunks WHERE content_id=? LIMIT 1').get(cid) as { file_path: string; key_id: string; plaintext_digest: string; ciphertext_digest: string; bytes: number } | undefined;
      if (existing) {
        if (existing.plaintext_digest !== sha256(plain) || !existsSync(existing.file_path)) throw new Error('snapshot-content-conflict');
        return { chunk, cid, encrypted: { digest: existing.plaintext_digest, envelope: { keyId: existing.key_id } }, envelopeJson: null, ciphertextDigest: existing.ciphertext_digest, bytes: existing.bytes, file: existing.file_path };
      }
      const encrypted = encryptJson(this.keys, chunk.entities, maxChunkBytes);
      const envelopeJson = stableJson(encrypted.envelope);
      if (Buffer.byteLength(envelopeJson) > maxChunkBytes) throw new Error('chunk-too-large');
      return { chunk, cid, encrypted, envelopeJson, ciphertextDigest: sha256(envelopeJson), bytes: Buffer.byteLength(envelopeJson), file: join(this.paths.snapshotDir, `${cid}.chunk`) };
    });
    const snapshotId = `shsnap_${sha256(stableJson({ fence: input.fence, createdAt: input.now, baseSeq: head.seq, chunkIds: prepared.map((p) => p.cid) })).slice(0, 40)}`;
    const manifestChunks = prepared.map((p) => ({ contentId: p.cid, collection: p.chunk.collection, pageKey: p.chunk.pageKey, entityCount: p.chunk.entities.length, plaintextDigest: p.encrypted.digest, ciphertextDigest: p.ciphertextDigest, encryptedBytes: p.bytes, keyId: p.encrypted.envelope.keyId }));
    const manifestWithoutDigest = { family: 'shadow-snapshot-manifest', v: 1, snapshotId, fence: input.fence, scopeId: authority.scopeId, epoch: authority.epoch, baseSeq: head.seq, baseEventId: base?.event_id ?? null, basePayloadDigest: base?.payload_digest ?? null, baseChainHash: base?.chain_hash ?? ZERO_HASH, chunks: manifestChunks, createdAt: input.now };
    const manifestDigest = sha256(stableJson(manifestWithoutDigest));
    const manifest = { ...manifestWithoutDigest, manifestDigest };
    this.immediate(() => {
      const total = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) as b FROM chunks c JOIN snapshots s ON s.snapshot_id=c.snapshot_id WHERE s.scope_id=?').get(authority.scopeId) as { b: number }).b + prepared.reduce((n, p) => n + p.bytes, 0);
      if (total > this.limits.maxTotalSnapshotBytes) throw new Error('snapshot-budget-exceeded');
      this.db.prepare('INSERT INTO snapshots(scope_id,snapshot_id,account_id,host_device_id,lease_id,epoch,created_at,base_seq,base_event_id,base_payload_digest,base_chain_hash,manifest_json,manifest_digest,published_at,verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)')
        .run(authority.scopeId, snapshotId, authority.accountId, authority.hostDeviceId, authority.leaseId, authority.epoch, input.now, head.seq, base?.event_id ?? null, base?.payload_digest ?? null, base?.chain_hash ?? ZERO_HASH, stableJson(manifest), manifestDigest, input.now);
      for (const [ordinal, p] of prepared.entries()) {
        const file = p.file;
        if (p.envelopeJson !== null && !existsSync(file)) writeAtomic(file, p.envelopeJson);
        this.db.prepare('INSERT INTO chunks(snapshot_id,ordinal,content_id,collection,page_key,file_path,key_id,plaintext_digest,ciphertext_digest,bytes) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(snapshotId, ordinal, p.cid, p.chunk.collection, p.chunk.pageKey, file, p.encrypted.envelope.keyId, p.encrypted.digest, p.ciphertextDigest, p.bytes);
      }
      if (!this.verifySnapshotInTransaction(authority.scopeId, snapshotId)) throw new Error('snapshot-verify-failed');
      this.db.prepare('UPDATE snapshots SET verified=1 WHERE scope_id=? AND snapshot_id=?').run(authority.scopeId, snapshotId);
      this.evictSnapshotsInTransaction(authority.scopeId);
    });
    return { snapshotId, baseSeq: head.seq, chunkIds: prepared.map((p) => p.cid) };
  }

  private verifySnapshotInTransaction(scopeId: string, snapshotId: string): boolean {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE scope_id=? AND snapshot_id=? LIMIT 1').get(scopeId, snapshotId) as SnapshotRow | undefined;
    if (!row) return false;
    let manifest: SnapshotManifest;
    try { manifest = parseJson(row.manifest_json); } catch { return false; }
    const allowed = ['family', 'v', 'snapshotId', 'fence', 'scopeId', 'epoch', 'baseSeq', 'baseEventId', 'basePayloadDigest', 'baseChainHash', 'chunks', 'createdAt', 'manifestDigest'].sort();
    if (Object.keys(manifest as unknown as Record<string, unknown>).sort().join('|') !== allowed.join('|')) return false;
    const { manifestDigest: _digest, ...withoutDigest } = manifest as unknown as Record<string, unknown>;
    if (sha256(stableJson(withoutDigest)) !== row.manifest_digest || manifest.manifestDigest !== row.manifest_digest) return false;
    if (manifest.family !== 'shadow-snapshot-manifest' || manifest.v !== 1 || manifest.snapshotId !== snapshotId || manifest.scopeId !== scopeId) return false;
    if (!isSafeTimestamp(manifest.createdAt) || manifest.createdAt !== row.created_at) return false;
    if (!isSafeNonNegativeInteger(manifest.baseSeq) || !Number.isSafeInteger(manifest.epoch) || manifest.epoch < 1) return false;
    if (!manifest.fence || Object.keys(manifest.fence as unknown as Record<string, unknown>).sort().join('|') !== ['accountId', 'epoch', 'hostDeviceId', 'leaseId', 'scopeId'].sort().join('|')) return false;
    if (manifest.fence.accountId !== row.account_id || manifest.fence.scopeId !== row.scope_id || manifest.fence.hostDeviceId !== row.host_device_id || manifest.fence.leaseId !== row.lease_id || manifest.fence.epoch !== row.epoch) return false;
    if (manifest.epoch !== row.epoch || manifest.epoch !== manifest.fence.epoch) return false;
    const expectedSnapshotId = `shsnap_${sha256(stableJson({ fence: manifest.fence, createdAt: manifest.createdAt, baseSeq: manifest.baseSeq, chunkIds: manifest.chunks.map((chunk) => chunk.contentId) })).slice(0, 40)}`;
    if (expectedSnapshotId !== snapshotId) return false;
    if (manifest.baseSeq !== row.base_seq || manifest.baseEventId !== row.base_event_id || manifest.basePayloadDigest !== row.base_payload_digest || manifest.baseChainHash !== row.base_chain_hash) return false;
    if (row.base_seq === 0) {
      if (row.base_chain_hash !== ZERO_HASH || row.base_event_id !== null || row.base_payload_digest !== null) return false;
    } else {
      const base = this.db.prepare('SELECT event_id,payload_digest,chain_hash FROM events WHERE scope_id=? AND epoch=? AND seq=? LIMIT 1').get(scopeId, manifest.epoch, row.base_seq) as { event_id: string; payload_digest: string; chain_hash: string } | undefined;
      if (base && (base.event_id !== row.base_event_id || base.payload_digest !== row.base_payload_digest || base.chain_hash !== row.base_chain_hash)) return false;
    }
    if (!Array.isArray(manifest.chunks)) return false;
    const chunks = this.db.prepare('SELECT * FROM chunks WHERE snapshot_id=? ORDER BY ordinal ASC').all(snapshotId) as SnapshotChunkRow[];
    if (chunks.length !== manifest.chunks.length) return false;
    const seenOrdinals = new Set<number>();
    for (let i = 0; i < manifest.chunks.length; i += 1) {
      const manifestChunk = manifest.chunks[i];
      const chunkAllowed = ['contentId', 'collection', 'pageKey', 'entityCount', 'plaintextDigest', 'ciphertextDigest', 'encryptedBytes', 'keyId'].sort();
      if (Object.keys(manifestChunk as unknown as Record<string, unknown>).sort().join('|') !== chunkAllowed.join('|')) return false;
      const chunk = chunks[i];
      if (chunk.ordinal !== i || seenOrdinals.has(chunk.ordinal)) return false;
      seenOrdinals.add(chunk.ordinal);
      if (chunk.snapshot_id !== snapshotId || chunk.content_id !== manifestChunk.contentId || chunk.collection !== manifestChunk.collection || chunk.page_key !== manifestChunk.pageKey || chunk.key_id !== manifestChunk.keyId || chunk.plaintext_digest !== manifestChunk.plaintextDigest || chunk.ciphertext_digest !== manifestChunk.ciphertextDigest || chunk.bytes !== manifestChunk.encryptedBytes) return false;
      const key = this.keys.keyFor(chunk.key_id);
      if (!key) return false;
      const expectedContentId = contentIdFor(key, { scopeId, collection: chunk.collection, pageKey: chunk.page_key, digest: chunk.plaintext_digest });
      if (expectedContentId !== chunk.content_id) return false;
      if (!existsSync(chunk.file_path) || statSync(chunk.file_path).size !== chunk.bytes) return false;
      const envelopeJson = readFileSync(chunk.file_path, 'utf8');
      if (sha256(envelopeJson) !== chunk.ciphertext_digest) return false;
      let envelope: Envelope;
      try { envelope = parseJson<Envelope>(envelopeJson); } catch { return false; }
      if (envelope.keyId !== chunk.key_id) return false;
      let value: unknown;
      try { value = decryptJson(this.keys, envelopeJson); } catch { return false; }
      if (!Array.isArray(value) || value.length !== manifestChunk.entityCount) return false;
      if (sha256(Buffer.from(stableJson(value))) !== chunk.plaintext_digest) return false;
      if (!chunk.content_id.startsWith('shcid_')) return false;
    }
    return true;
  }

  verifySnapshot(scopeId: string, snapshotId: string): { ok: true } | { ok: false; reason: string } {
    return this.verifySnapshotInTransaction(scopeId, snapshotId) ? { ok: true } : { ok: false, reason: 'snapshot-invalid' };
  }

  private evictSnapshotsInTransaction(scopeId: string): void {
    const retained = this.db.prepare('SELECT snapshot_id FROM snapshots WHERE scope_id=? AND verified=1 ORDER BY base_seq DESC,published_at DESC LIMIT ?').all(scopeId, this.limits.retainedSnapshots) as { snapshot_id: string }[];
    const keep = new Set(retained.map((r) => r.snapshot_id));
    const old = this.db.prepare('SELECT snapshot_id FROM snapshots WHERE scope_id=? AND verified=1 ORDER BY base_seq DESC,published_at DESC').all(scopeId) as { snapshot_id: string }[];
    for (const row of old) {
      if (keep.has(row.snapshot_id)) continue;
      const chunks = this.db.prepare('SELECT file_path,content_id FROM chunks WHERE snapshot_id=?').all(row.snapshot_id) as { file_path: string; content_id: string }[];
      this.db.prepare('DELETE FROM chunks WHERE snapshot_id=?').run(row.snapshot_id);
      this.db.prepare('DELETE FROM snapshots WHERE snapshot_id=?').run(row.snapshot_id);
      for (const chunk of chunks) {
        const refs = (this.db.prepare('SELECT COUNT(*) as c FROM chunks WHERE content_id=?').get(chunk.content_id) as { c: number }).c;
        if (refs === 0) rmSync(chunk.file_path, { force: true });
      }
    }
  }

  planGapRepair(input: { scopeId: string; epoch: number; lastSeq: number; retainedMinSeq: number; latestSnapshotId: string; latestSnapshotBaseSeq: number }): { kind: 'events'; fromSeq: number; toSeq: number } | { kind: 'snapshot'; snapshotId: string; replayFromSeq: number } {
    const head = this.headInTransaction(input.scopeId, input.epoch);
    if (input.lastSeq >= input.retainedMinSeq) return { kind: 'events', fromSeq: input.lastSeq + 1, toSeq: head.seq };
    return { kind: 'snapshot', snapshotId: input.latestSnapshotId, replayFromSeq: input.latestSnapshotBaseSeq + 1 };
  }

  private latestVerifiedSnapshotAnchor(scopeId: string, epoch: number): { baseSeq: number; baseChainHash: string; snapshotId: string } | null {
    const rows = this.db.prepare('SELECT snapshot_id,base_seq,base_chain_hash,epoch FROM snapshots WHERE scope_id=? AND epoch=? AND verified=1 ORDER BY base_seq DESC,published_at DESC').all(scopeId, epoch) as { snapshot_id: string; base_seq: number; base_chain_hash: string; epoch: number }[];
    for (const row of rows) {
      if (!this.verifySnapshotInTransaction(scopeId, row.snapshot_id)) continue;
      return { baseSeq: row.base_seq, baseChainHash: row.base_chain_hash, snapshotId: row.snapshot_id };
    }
    return null;
  }

  private verifyIntegrityAnchored(scopeId: string, epoch: number, anchor: { baseSeq: number; baseChainHash: string } | null): { ok: true } | { ok: false; reason: string; seq?: number } {
    const baseSeq = anchor?.baseSeq ?? 0;
    const baseHash = anchor?.baseChainHash ?? ZERO_HASH;
    const rows = this.db.prepare('SELECT * FROM events WHERE scope_id=? AND epoch=? AND seq>? ORDER BY seq ASC').all(scopeId, epoch, baseSeq) as StoredEventRow[];
    const segmentRows = this.db.prepare('SELECT * FROM segment_records WHERE scope_id=? AND epoch=? AND seq>? ORDER BY seq ASC').all(scopeId, epoch, baseSeq) as SegmentRecordRow[];
    const allSegmentRows = this.db.prepare('SELECT * FROM segment_records WHERE scope_id=? AND epoch=? ORDER BY seq ASC').all(scopeId, epoch) as SegmentRecordRow[];
    if (segmentRows.length !== rows.length) return { ok: false, reason: 'segment-record-count' };
    const eventsBySeq = new Map((this.db.prepare('SELECT * FROM events WHERE scope_id=? AND epoch=? ORDER BY seq ASC').all(scopeId, epoch) as StoredEventRow[]).map((row) => [row.seq, row]));
    for (const record of allSegmentRows) {
      const event = eventsBySeq.get(record.seq);
      if (!event || event.event_id !== record.event_id || event.chain_hash !== record.chain_hash || event.payload_digest !== record.payload_digest) return { ok: false, reason: 'segment-record-mismatch', seq: record.seq };
      if (record.envelope_digest !== sha256(event.payload_envelope) || record.wire_digest !== sha256(event.wire_event) || record.record_hash !== sha256(record.record_json)) return { ok: false, reason: 'segment-record-digest', seq: record.seq };
      try {
        const parsed = parseJson<{ seq: number; eventId: string; chainHash: string; payloadDigest: string; envelopeDigest: string; wireDigest: string; wire: ShadowStateEvent; envelope: Envelope }>(record.record_json);
        if (parsed.seq !== event.seq || parsed.eventId !== event.event_id || parsed.chainHash !== event.chain_hash || parsed.payloadDigest !== event.payload_digest) return { ok: false, reason: 'segment-record-json', seq: record.seq };
        if (stableJson(parsed.wire) !== event.wire_event || stableJson(parsed.envelope) !== event.payload_envelope) return { ok: false, reason: 'segment-record-json-row', seq: record.seq };
      } catch { return { ok: false, reason: 'payload-corrupt', seq: record.seq }; }
    }
    let prevSeq = baseSeq;
    let prevHash = baseHash;
    const recordsBySeq = new Map(segmentRows.map((r) => [r.seq, r]));
    const seenSegments = new Set<string>();
    for (const row of rows) {
      if (row.prev_seq !== prevSeq || row.seq !== prevSeq + 1) return { ok: false, reason: 'sequence-gap', seq: row.seq };
      const expected = sha256(`${prevHash}:${row.event_id}:${row.payload_digest}`);
      if (expected !== row.chain_hash) return { ok: false, reason: 'chain-mismatch', seq: row.seq };
      const record = recordsBySeq.get(row.seq);
      if (!record || record.event_id !== row.event_id || record.chain_hash !== row.chain_hash || record.payload_digest !== row.payload_digest) return { ok: false, reason: 'segment-record-mismatch', seq: row.seq };
      if (record.envelope_digest !== sha256(row.payload_envelope) || record.wire_digest !== sha256(row.wire_event) || record.record_hash !== sha256(record.record_json)) return { ok: false, reason: 'segment-record-digest', seq: row.seq };
      try {
        const parsed = parseJson<{ seq: number; eventId: string; chainHash: string; payloadDigest: string; envelopeDigest: string; wireDigest: string; wire: ShadowStateEvent; envelope: Envelope }>(record.record_json);
        if (parsed.seq !== row.seq || parsed.eventId !== row.event_id || parsed.chainHash !== row.chain_hash || parsed.payloadDigest !== row.payload_digest) return { ok: false, reason: 'segment-record-json', seq: row.seq };
        if (stableJson(parsed.wire) !== row.wire_event || stableJson(parsed.envelope) !== row.payload_envelope) return { ok: false, reason: 'segment-record-json-row', seq: row.seq };
        this.decryptEventPayload(row.event_id);
      } catch { return { ok: false, reason: 'payload-corrupt', seq: row.seq }; }
      seenSegments.add(row.segment_id);
      prevSeq = row.seq;
      prevHash = row.chain_hash;
    }
    const allSegmentIds = new Set(allSegmentRows.map((row) => row.segment_id));
    for (const segmentId of allSegmentIds) {
      const segment = allSegmentRows.filter((r) => r.segment_id === segmentId);
      const segmentFile = this.materializationPath(scopeId, epoch, segmentId);
      if (!existsSync(segmentFile) || fileSizeIfExists(segmentFile) <= 0) return { ok: false, reason: 'segment-missing' };
      const lines = readFileSync(segmentFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length !== segment.length) return { ok: false, reason: 'segment-line-count' };
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] !== segment[i].record_json || sha256(lines[i]) !== segment[i].record_hash) return { ok: false, reason: 'segment-line-mismatch', seq: segment[i].seq };
      }
    }
    const expected = new Set([...allSegmentIds].map((segmentId) => this.materializationPath(scopeId, epoch, segmentId)));
    const epochDir = join(this.paths.journalDir, `scope-${scopeHash(scopeId)}`, `epoch-${epoch}`);
    if (existsSync(epochDir)) {
      for (const name of readdirSync(epochDir)) {
        if (/^segment-\d+\.mjlog$/.test(name) && !expected.has(join(epochDir, name))) return { ok: false, reason: 'segment-extra' };
        if (/^segment-\d+\.mjlog\.(tmp-|lock|tmp-stale)/.test(name) || /^segment-\d+\.mjlog\.lock$/.test(name)) return { ok: false, reason: 'segment-extra' };
      }
    }
    return { ok: true };
  }

  verifyIntegrity(scopeId: string, epoch: number): { ok: true } | { ok: false; reason: string; seq?: number } {
    const anchor = this.latestVerifiedSnapshotAnchor(scopeId, epoch);
    return this.verifyIntegrityAnchored(scopeId, epoch, anchor);
  }

  startupRecovery(scopeId: string, epoch: number, now: number): { ok: true } | { ok: false; quarantineId: string; blocked: true; reason: string } {
    this.rebuildAllMaterializations();
    const integrity = this.verifyIntegrity(scopeId, epoch);
    if (integrity.ok) return integrity;
    const quarantineId = this.quarantineCorruption(scopeId, integrity.reason, integrity, now);
    this.db.prepare('INSERT OR REPLACE INTO blocked_scopes(scope_id,reason,blocked_at) VALUES(?,?,?)').run(scopeId, integrity.reason, now);
    return { ok: false, quarantineId, blocked: true, reason: integrity.reason };
  }

  recoverScopeFromVerifiedSnapshot(input: { scopeId: string; snapshotId: string; now: number }): { ok: true; baseSeq: number } | { ok: false; reason: 'snapshot-missing' | 'snapshot-unverified' | 'journal-still-corrupt' } {
    const row = this.db.prepare('SELECT base_seq,base_chain_hash,verified,epoch FROM snapshots WHERE scope_id=? AND snapshot_id=? LIMIT 1').get(input.scopeId, input.snapshotId) as { base_seq: number; base_chain_hash: string; verified: number; epoch: number } | undefined;
    if (!row) return { ok: false, reason: 'snapshot-missing' };
    if (row.verified !== 1 || !this.verifySnapshotInTransaction(input.scopeId, input.snapshotId)) return { ok: false, reason: 'snapshot-unverified' };
    this.immediate(() => {
      this.db.prepare('DELETE FROM events WHERE scope_id=? AND epoch=? AND seq>?').run(input.scopeId, row.epoch, row.base_seq);
      this.db.prepare('DELETE FROM segment_records WHERE scope_id=? AND epoch=? AND seq>?').run(input.scopeId, row.epoch, row.base_seq);
    });
    this.rebuildAllMaterializations();
    if (this.failNextRecoveryRebuild) {
      this.failNextRecoveryRebuild = false;
      return { ok: false, reason: 'journal-still-corrupt' };
    }
    const integrity = this.verifyIntegrityAnchored(input.scopeId, row.epoch, { baseSeq: row.base_seq, baseChainHash: row.base_chain_hash });
    if (!integrity.ok || !this.verifySnapshotInTransaction(input.scopeId, input.snapshotId)) return { ok: false, reason: 'journal-still-corrupt' };
    this.immediate(() => {
      this.db.prepare('DELETE FROM blocked_scopes WHERE scope_id=?').run(input.scopeId);
    });
    return { ok: true, baseSeq: row.base_seq };
  }

  quarantineCorruption(scopeId: string, reason: string, details: unknown, now: number): string {
    const id = `shq_${sha256(stableJson({ scopeId, reason, details, now })).slice(0, 32)}`;
    const file = join(this.paths.quarantineDir, `${id}.json`);
    let payload = stableJson({ scopeId, reason, details, now });
    if (Buffer.byteLength(payload) > this.limits.maxQuarantineItemBytes) payload = stableJson({ scopeId, reason, redacted: true, now, digest: sha256(payload) });
    if (Buffer.byteLength(payload) > this.limits.maxQuarantineItemBytes) throw new Error('quarantine-item-too-large');
    this.db.prepare('INSERT OR REPLACE INTO corruption(id,scope_id,reason,quarantined_at,details_json) VALUES(?,?,?,?,?)').run(id, scopeId, reason, now, payload);
    writeAtomic(file, payload);
    this.enforceQuarantineBudget();
    return id;
  }

  private enforceQuarantineBudget(): void {
    const rows = this.db.prepare('SELECT id FROM corruption ORDER BY quarantined_at ASC').all() as { id: string }[];
    let total = rows.reduce((n, r) => n + fileSizeIfExists(join(this.paths.quarantineDir, `${r.id}.json`)), 0);
    for (const row of rows) {
      if (total <= this.limits.maxTotalQuarantineBytes) break;
      const file = join(this.paths.quarantineDir, `${row.id}.json`);
      total -= fileSizeIfExists(file);
      rmSync(file, { force: true });
      this.db.prepare('DELETE FROM corruption WHERE id=?').run(row.id);
    }
  }

  private compactJournalPrefix(input: { scopeId: string; epoch: number; now: number; maxEvents: number; controllerFloorSeq?: number; reason: 'retention' | 'budget' }): { deleted: number; kept: number } {
    this.compactionCalls[input.reason] += 1;
    const anchor = this.latestVerifiedSnapshotAnchor(input.scopeId, input.epoch);
    if (!anchor) throw new Error(input.reason === 'budget' ? 'journal-budget-requires-verified-snapshot' : 'retention-requires-verified-snapshot');
    const head = this.headInTransaction(input.scopeId, input.epoch);
    const controllerFloor = input.controllerFloorSeq ?? anchor.baseSeq;
    const preserveFrom = Math.min(anchor.baseSeq + 1, Math.max(1, controllerFloor + 1), Math.max(1, head.seq - this.limits.safetyTailEvents + 1));
    const rows = this.db.prepare('SELECT seq FROM events WHERE scope_id=? AND epoch=? ORDER BY seq DESC LIMIT ?').all(input.scopeId, input.epoch, input.maxEvents) as { seq: number }[];
    const minKeptByCount = rows.length ? rows[rows.length - 1].seq : head.seq;
    const deleteBefore = Math.min(preserveFrom, minKeptByCount);
    if (deleteBefore <= 1 || deleteBefore > anchor.baseSeq + 1) throw new Error(input.reason === 'budget' ? 'journal-budget-requires-covered-snapshot' : 'retention-anchor-refused');
    const retainedAnchor = deleteBefore === anchor.baseSeq + 1
      ? { baseSeq: anchor.baseSeq, baseChainHash: anchor.baseChainHash }
      : (() => {
          const row = this.db.prepare('SELECT seq,chain_hash FROM events WHERE scope_id=? AND epoch=? AND seq=? LIMIT 1').get(input.scopeId, input.epoch, deleteBefore - 1) as { seq: number; chain_hash: string } | undefined;
          return row ? { baseSeq: row.seq, baseChainHash: row.chain_hash } : null;
        })();
    if (!retainedAnchor) throw new Error('retention-anchor-missing');
    if (!this.verifySnapshotInTransaction(input.scopeId, anchor.snapshotId)) throw new Error('retention-anchor-invalid');
    const before = (this.db.prepare('SELECT COUNT(*) as c FROM events WHERE scope_id=? AND epoch=?').get(input.scopeId, input.epoch) as { c: number }).c;
    this.immediate(() => {
      this.db.prepare('DELETE FROM segment_records WHERE scope_id=? AND epoch=? AND seq < ?').run(input.scopeId, input.epoch, deleteBefore);
      this.db.prepare('DELETE FROM events WHERE scope_id=? AND epoch=? AND seq < ?').run(input.scopeId, input.epoch, deleteBefore);
    });
    this.rebuildAllMaterializations();
    const integrity = this.verifyIntegrityAnchored(input.scopeId, input.epoch, retainedAnchor);
    if (!integrity.ok) throw new Error(`retention-integrity-${integrity.reason}`);
    if (!this.verifySnapshotInTransaction(input.scopeId, anchor.snapshotId)) throw new Error('retention-snapshot-reverify');
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    const after = (this.db.prepare('SELECT COUNT(*) as c FROM events WHERE scope_id=? AND epoch=?').get(input.scopeId, input.epoch) as { c: number }).c;
    return { deleted: before - after, kept: after };
  }

  enforceRetention(input: { scopeId: string; now: number; retainedMinSeq?: number; headSeq?: number; maxEvents: number; controllerFloorSeq?: number }): { deleted: number; kept: number } {
    const authority = this.getAuthority(input.scopeId);
    if (!authority) throw new Error('authority-missing');
    return this.compactJournalPrefix({ scopeId: input.scopeId, epoch: authority.epoch, now: input.now, maxEvents: input.maxEvents, controllerFloorSeq: input.controllerFloorSeq, reason: 'retention' });
  }

  putBlob(input: { plaintext: Buffer; now: number; pinned?: boolean }): { contentId: string; bytes: number } {
    if (input.plaintext.length > this.limits.maxBlobBytes) throw new Error('blob-too-large');
    const encrypted = encryptJson(this.keys, input.plaintext.toString('base64'), this.limits.maxBlobBytes);
    const envelopeJson = stableJson(encrypted.envelope);
    const bytes = Buffer.byteLength(envelopeJson);
    if (bytes > this.limits.maxBlobBytes) throw new Error('blob-too-large');
    const contentId = contentIdFor(this.keys.currentKey().key, { digest: sha256(input.plaintext), bytes: input.plaintext.length });
    const file = join(this.paths.blobDir, `${contentId}.blob`);
    this.immediate(() => {
      writeAtomic(file, envelopeJson);
      this.db.prepare('INSERT OR REPLACE INTO blob_cas(content_id,file_path,plaintext_digest,ciphertext_digest,bytes,pinned,ref_count,created_at,last_accessed_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(contentId, file, sha256(input.plaintext), sha256(envelopeJson), bytes, input.pinned ? 1 : 0, input.pinned ? 1 : 0, input.now, input.now);
      this.evictBlobsInTransaction();
    });
    return { contentId, bytes };
  }

  readBlobRange(input: { contentId: string; start: number; endExclusive: number; now: number }): { bytes: Buffer; range: ByteRange; totalBytes: number; plaintextDigest: string } {
    if (!/^shcid_[A-Za-z0-9_-]+$/.test(input.contentId)) throw new Error('blob-content-id-invalid');
    if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.endExclusive)) throw new Error('blob-range-invalid');
    const row = this.db.prepare('SELECT * FROM blob_cas WHERE content_id=? LIMIT 1').get(input.contentId) as { file_path: string; plaintext_digest: string; ciphertext_digest: string } | undefined;
    if (!row || !existsSync(row.file_path)) throw new Error('blob-missing');
    const envelopeJson = readFileSync(row.file_path, 'utf8');
    if (sha256(envelopeJson) !== row.ciphertext_digest) throw new Error('blob-ciphertext-digest');
    const value = decryptJson(this.keys, envelopeJson);
    const plain = Buffer.from(String(value), 'base64');
    if (sha256(plain) !== row.plaintext_digest) throw new Error('blob-plaintext-digest');
    if (input.start < 0 || input.endExclusive <= input.start || input.endExclusive > plain.length) throw new Error('blob-range-invalid');
    this.db.prepare('UPDATE blob_cas SET last_accessed_at=? WHERE content_id=?').run(input.now, input.contentId);
    return { bytes: plain.subarray(input.start, input.endExclusive), range: { start: input.start, endExclusive: input.endExclusive }, totalBytes: plain.length, plaintextDigest: row.plaintext_digest };
  }

  private evictBlobsInTransaction(): void {
    let total = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) as b FROM blob_cas').get() as { b: number }).b;
    const rows = this.db.prepare('SELECT content_id,file_path,bytes FROM blob_cas WHERE pinned=0 AND ref_count=0 ORDER BY last_accessed_at ASC, created_at ASC, content_id ASC').all() as { content_id: string; file_path: string; bytes: number }[];
    for (const row of rows) {
      if (total <= this.limits.maxTotalBlobBytes) break;
      rmSync(row.file_path, { force: true });
      this.db.prepare('DELETE FROM blob_cas WHERE content_id=?').run(row.content_id);
      total -= row.bytes;
    }
    if (total > this.limits.maxTotalBlobBytes) throw new Error('blob-budget-exceeded');
  }

  planBlobRange(input: { contentId: string; totalBytes: number; verifiedRanges: readonly ByteRange[]; requestedRange?: ByteRange }): CacheResumePlan {
    return planCacheResume(input);
  }

  retentionSegmentsForReview(scopeId: string, now: number) {
    const rows = this.db.prepare('SELECT segment_id, MIN(seq) as first_seq, MAX(seq) as last_seq, MAX(created_at) as closed_at FROM events WHERE scope_id=? GROUP BY segment_id ORDER BY first_seq ASC').all(scopeId) as { segment_id: string; first_seq: number; last_seq: number; closed_at: number }[];
    return planRetention({
      now,
      snapshot: { snapshotId: 'review', baseSeq: 0, verified: true, publishedAt: now },
      segments: rows.map((r) => ({ segmentId: r.segment_id, firstSeq: r.first_seq, lastSeq: r.last_seq, closed: true, verified: true })),
      controllers: [],
      staleAfterMs: 24 * 60 * 60 * 1000,
      safetyTailEvents: 10,
      snapshotSafetyMs: 24 * 60 * 60 * 1000,
    });
  }

  async publishPending(relay: ShadowHostRelayPort, input: { fence: Fence; now: number; controllerDeviceId?: string; limit?: number }): Promise<number> {
    const authority = this.requireFence(input.fence, input.controllerDeviceId, input.now);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('publish-limit-invalid');
    const rows = this.db.prepare(`
      SELECT seq,event_id,payload_digest,wire_event FROM events
      WHERE scope_id=? AND epoch=? AND published=0
      ORDER BY seq ASC,event_id ASC LIMIT ?
    `).all(authority.scopeId, authority.epoch, limit) as { seq: number; event_id: string; payload_digest: string; wire_event: string }[];
    const events = rows.map((r) => {
      const event = parseJson<ShadowStateEvent>(r.wire_event);
      if (!sameFence(event.fence, input.fence)) throw new Error('publish-fence-mismatch');
      if (event.eventId !== r.event_id || event.payloadDigest !== r.payload_digest || event.seq !== r.seq) throw new Error('publish-row-mismatch');
      return event;
    });
    if (events.length === 0) return 0;
    await relay.publishOrderedEvents(authority.scopeId, input.fence, events);
    for (const row of rows) {
      const result = this.db.prepare(`
        UPDATE events SET published=1
        WHERE scope_id=? AND epoch=? AND seq=? AND event_id=? AND payload_digest=? AND published=0
      `).run(authority.scopeId, authority.epoch, row.seq, row.event_id, row.payload_digest);
      if (result.changes !== 1) throw new Error('publish-mark-race');
    }
    return events.length;
  }

  debugMutateEventForTest(seq: number, patch: Partial<Pick<StoredEventRow, 'payload_envelope' | 'chain_hash' | 'prev_seq'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${key}=?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE events SET ${sets.join(',')} WHERE seq=?`).run(...values, seq);
  }

  debugMaterializationPathForTest(scopeId: string, epoch: number, segmentId: string): string {
    return this.materializationPath(scopeId, epoch, segmentId);
  }

  debugSqlForTest(sql: string, ...values: unknown[]): unknown[] {
    if (!/^(SELECT|UPDATE|INSERT|DELETE) /i.test(sql.trim())) throw new Error('debug-sql-refused');
    const stmt = this.db.prepare(sql);
    if (/^SELECT /i.test(sql.trim())) return stmt.all(...values) as unknown[];
    stmt.run(...values);
    return [];
  }

  debugSnapshotManifestForTest(snapshotId: string): SnapshotManifest {
    const row = this.db.prepare('SELECT manifest_json FROM snapshots WHERE snapshot_id=? LIMIT 1').get(snapshotId) as { manifest_json: string } | undefined;
    if (!row) throw new Error('snapshot-missing');
    return parseJson<SnapshotManifest>(row.manifest_json);
  }

  debugCompactionCallsForTest(): { retention: number; budget: number } {
    return { ...this.compactionCalls };
  }

  destroyForTest(): void {
    this.close();
    rmSync(dirname(this.paths.sqlitePath), { recursive: true, force: true });
  }
}
