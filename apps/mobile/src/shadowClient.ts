import * as SQLite from 'expo-sqlite';
import {
  createMemoryShadowStore,
  derivedShadowPersistedId,
  ShadowMobileClient,
  type ShadowClientOptions,
  type ShadowEntity,
  type ShadowExpectedAuthority,
  type ShadowPreviewState,
  type ShadowState,
  type ShadowStore,
  type ShadowStoreTransaction,
  type ShadowCryptoAdapter,
  type ShadowAuthorityTransitionGrant,
  type ShadowRepairRecord,
  type ShadowRepairEvidence,
  type ShadowVisualControlGrant,
  shadowIdentityDigest,
} from './shadowClientCore';
import type { ByteRange, CommandLifecycleState, ControllerGrantState, Fence, ShadowCursor, ShadowStateEvent } from '@maestro/realtime';
import { isSafeBoundedErrorText } from '@maestro/realtime/shadowErrorSanitize';

export * from './shadowClientCore';

type SQLiteDatabase = {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getAllAsync<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  withTransactionAsync<T>(task: () => Promise<T>): Promise<T>;
  withExclusiveTransactionAsync?<T>(task: () => Promise<T>): Promise<T>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO shadow_schema_version(id, version) VALUES(1, 2);
CREATE TABLE IF NOT EXISTS shadow_authority (id TEXT PRIMARY KEY, controller_device_id TEXT NOT NULL, account_id TEXT NOT NULL, scope_id TEXT NOT NULL, host_device_id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_id TEXT NOT NULL, lease_expires_at INTEGER NOT NULL, cursor_last_seq INTEGER, cursor_last_event_id TEXT, cursor_last_digest TEXT, cursor_json TEXT, connection TEXT NOT NULL, transport TEXT NOT NULL, repair_reason TEXT);
CREATE TABLE IF NOT EXISTS shadow_inbox (event_id TEXT PRIMARY KEY, event_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_entities (collection TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL, payload_digest TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(collection, entity_id));
CREATE TABLE IF NOT EXISTS shadow_commands (command_id TEXT PRIMARY KEY, status TEXT NOT NULL, account_id TEXT NOT NULL, scope_id TEXT NOT NULL, host_device_id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result_seq INTEGER, applied_event_id TEXT, reject_reason TEXT, ack_json TEXT, pending_event_json TEXT, command_json TEXT);
CREATE TABLE IF NOT EXISTS shadow_snapshot_repair (id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_grants (grant_id TEXT PRIMARY KEY, controller_device_id TEXT NOT NULL, account_id TEXT NOT NULL, scope_id TEXT NOT NULL, host_device_id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_id TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, shadow_only INTEGER NOT NULL DEFAULT 0, grant_json TEXT);
CREATE TABLE IF NOT EXISTS shadow_revocations (controller_device_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_visual_grants (grant_id TEXT PRIMARY KEY, visual_session_id TEXT NOT NULL, controller_device_id TEXT NOT NULL, account_id TEXT NOT NULL, scope_id TEXT NOT NULL, host_device_id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_id TEXT NOT NULL, mode TEXT NOT NULL, project_id TEXT, session_id TEXT, surface_id TEXT, expires_at INTEGER NOT NULL, signed_at INTEGER NOT NULL, signature TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_previews (visual_session_id TEXT PRIMARY KEY, controller_device_id TEXT NOT NULL, account_id TEXT NOT NULL, scope_id TEXT NOT NULL, host_device_id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_id TEXT NOT NULL, mode TEXT NOT NULL, input_mode TEXT NOT NULL, project_id TEXT, session_id TEXT, surface_id TEXT, expires_at INTEGER NOT NULL, active_grant_id TEXT, last_input_seq INTEGER NOT NULL, min_frame_seq INTEGER NOT NULL, last_frame_seq INTEGER NOT NULL, preview_json TEXT);
CREATE TABLE IF NOT EXISTS shadow_assets (content_id TEXT PRIMARY KEY, variant TEXT NOT NULL, total_bytes INTEGER NOT NULL, digest TEXT NOT NULL, verified_ranges_json TEXT NOT NULL, last_accessed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_asset_ranges (content_id TEXT NOT NULL, start INTEGER NOT NULL, end_exclusive INTEGER NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(content_id, start, end_exclusive));
CREATE TABLE IF NOT EXISTS shadow_authority_transitions (transition_id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, controller_device_id TEXT NOT NULL, previous_fence_json TEXT NOT NULL, next_fence_json TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, key_id TEXT NOT NULL, signature TEXT NOT NULL, consumed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_repair_evidence (id TEXT PRIMARY KEY, reason TEXT NOT NULL, repair_class TEXT, row_class TEXT, table_name TEXT, row_identity_hash TEXT, account_id TEXT, scope_id TEXT, controller_device_id TEXT, host_device_id TEXT, epoch INTEGER, lease_id TEXT, transition_identity_hash TEXT, asset_id TEXT, range_start INTEGER, range_end_exclusive INTEGER, created_at INTEGER NOT NULL);
`;

type SQLiteTableColumn = { name: string; type: string; notnull?: number; pk?: number };

const REPAIR_EVIDENCE_SCHEMA: readonly { name: string; type: 'TEXT' | 'INTEGER'; base?: true; addSql?: string }[] = [
  { name: 'id', type: 'TEXT', base: true },
  { name: 'reason', type: 'TEXT', base: true },
  { name: 'repair_class', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN repair_class TEXT' },
  { name: 'row_class', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN row_class TEXT' },
  { name: 'table_name', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN table_name TEXT' },
  { name: 'row_identity_hash', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN row_identity_hash TEXT' },
  { name: 'account_id', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN account_id TEXT' },
  { name: 'scope_id', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN scope_id TEXT' },
  { name: 'controller_device_id', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN controller_device_id TEXT' },
  { name: 'host_device_id', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN host_device_id TEXT' },
  { name: 'epoch', type: 'INTEGER', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN epoch INTEGER' },
  { name: 'lease_id', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN lease_id TEXT' },
  { name: 'transition_identity_hash', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN transition_identity_hash TEXT' },
  { name: 'asset_id', type: 'TEXT', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN asset_id TEXT' },
  { name: 'range_start', type: 'INTEGER', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN range_start INTEGER' },
  { name: 'range_end_exclusive', type: 'INTEGER', addSql: 'ALTER TABLE shadow_repair_evidence ADD COLUMN range_end_exclusive INTEGER' },
  { name: 'created_at', type: 'INTEGER', base: true },
];

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function repairIdFor(table: string, row: unknown, ordinal = 0): string {
  return `load:${table}:${rowIdentityHash(table, row, ordinal)}`;
}

function rowIdentityHash(table: string, row: unknown, ordinal = 0): string {
  return shadowIdentityDigest('sqlite-row-identity:v1', { table, pk: rowIdentity(table, row), fallback: rowFallback(row, ordinal) });
}

function rowFallback(row: unknown, ordinal: number): { rowid: unknown; ordinal: number } {
  const value = row as Record<string, unknown>;
  return { rowid: value && typeof value === 'object' ? value.__rowid : null, ordinal };
}

function rowIdentity(table: string, row: unknown): unknown {
  const value = row as Record<string, unknown>;
  if (!value || typeof value !== 'object') return { raw: row };
  if (table === 'shadow_authority') return { id: 'current', controller: value.controller_device_id, scope: value.scope_id };
  if (table === 'shadow_entities') return { collection: value.collection, entity_id: value.entity_id };
  if (table === 'shadow_commands') return { command_id: value.command_id };
  if (table === 'shadow_grants') return { grant_id: value.grant_id };
  if (table === 'shadow_visual_grants') return { grant_id: value.grant_id };
  if (table === 'shadow_previews') return { visual_session_id: value.visual_session_id };
  if (table === 'shadow_assets') return { content_id: value.content_id };
  if (table === 'shadow_asset_ranges') return { content_id: value.content_id, start: value.start, end_exclusive: value.end_exclusive };
  if (table === 'shadow_authority_transitions') return { transition_id: value.transition_id, nonce: value.nonce, consumed_at: value.consumed_at, issued_at: value.issued_at };
  if (table === 'shadow_snapshot_repair') return { id: value.id };
  return value;
}

function repairClass(value: ShadowRepairEvidence): string {
  return value.repairClass ?? value.class;
}

function transitionIdentityHash(value: unknown): string | undefined {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== 'object') return undefined;
  return rowIdentityHash('shadow_authority_transitions', {
    transition_id: row.transition_id,
    nonce: row.nonce,
    consumed_at: row.consumed_at,
    issued_at: row.issued_at,
    __rowid: row.__rowid,
  }, typeof row.__ordinal === 'number' ? row.__ordinal : 0);
}

export class MalformedShadowRowError extends Error {
  constructor(
    readonly table: string,
    readonly rowClass: string,
    readonly rowIdentityHash: string,
    readonly reasonCode: string,
    readonly transitionIdentityHash?: string,
  ) {
    super(reasonCode);
    this.name = 'MalformedShadowRowError';
  }
}

function malformedRow(table: string, rowClass: string, row: unknown, reasonCode: string, ordinal = 0): never {
  throw new MalformedShadowRowError(table, rowClass, rowIdentityHash(table, row, ordinal), reasonCode, table === 'shadow_authority_transitions' ? transitionIdentityHash({ ...(row as Record<string, unknown>), __ordinal: ordinal }) : undefined);
}

function decodeRows<T, U>(table: string, rowClass: string, rows: T[], decode: (row: T, ordinal: number) => U): U[] {
  return rows.map((row, ordinal) => {
    try {
      return decode(row, ordinal);
    } catch (error) {
      if (error instanceof MalformedShadowRowError) throw error;
      const reason = error instanceof Error && isSafeId(error.message) ? error.message : `malformed-${rowClass}-row`;
      return malformedRow(table, rowClass, row, reason, ordinal);
    }
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function validateJsonDomainData(value: unknown, depth = 0, seen = { nodes: 0 }): boolean {
  if (depth > 16 || seen.nodes++ > 2_000) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return typeof value !== 'string' || value.length <= 16_384;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => validateJsonDomainData(item, depth + 1, seen));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > 1_000) return false;
  return keys.every((key) => key.length <= 256 && key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && validateJsonDomainData((value as Record<string, unknown>)[key], depth + 1, seen));
}

function isCommandStatus(value: string): value is CommandLifecycleState['status'] {
  return ['pending-local', 'sent', 'accepted', 'executing', 'awaiting-state-event', 'applied', 'rejected', 'expired', 'cancelled', 'stale-epoch', 'unauthorized', 'conflict', 'revoked'].includes(value);
}

function isConnection(value: string): value is ShadowState['connection'] {
  return ['offline', 'connecting', 'online', 'repair-required', 'revoked'].includes(value);
}

function isTransport(value: string): value is ShadowState['transport'] {
  return ['relay', 'lan', 'webrtc-data'].includes(value);
}

function isPreviewInputMode(value: string): value is ShadowPreviewState['inputMode'] {
  return value === 'view-only' || value === 'control';
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeNullableId(value: unknown): value is string | null {
  return value === null || isSafeId(value);
}

/**
 * A persisted command's `reject_reason` is the ACK error's bounded message (or a
 * safe-id conflict/status reason) — see `advanceCommandLifecycle`. It legitimately
 * contains spaces/punctuation, so it is validated as a BOUNDED reason (matching the
 * protocol `HostCommandAck.error.message` invariant: nullable, 1..512 chars, no
 * control chars, not path-like) rather than a safe-id. A genuinely-corrupt reason
 * (oversized / control chars / filesystem path) is still rejected → the row is
 * quarantined individually.
 */
function isBoundedNullableReason(value: unknown): value is string | null {
  if (value === null) return true;
  // Phase 3B0 NOTE-3: a persisted reject_reason is read back into the product error
  // surface, so on READ it is fail-closed against the same canary set the wire ACK
  // decoder rejects (path / URL / userinfo / host:port / stack / secret / control
  // char) — a tampered SQLite row carrying such text quarantines rather than leaks.
  return isSafeBoundedErrorText(value, 512);
}

function replaceRepairRecord(records: ShadowRepairRecord[], record: ShadowRepairRecord): ShadowRepairRecord[] {
  return [...records.filter((item) => item.id !== record.id), record];
}

function sameFence(a: { accountId: string; scopeId: string; hostDeviceId: string; epoch: number; leaseId: string }, b: { accountId: string; scopeId: string; hostDeviceId: string; epoch: number; leaseId: string }): boolean {
  return a.accountId === b.accountId && a.scopeId === b.scopeId && a.hostDeviceId === b.hostDeviceId && a.epoch === b.epoch && a.leaseId === b.leaseId;
}

function isFenceShape(value: unknown): value is Fence {
  return typeof value === 'object' && value !== null
    && isSafeId((value as Fence).accountId)
    && isSafeId((value as Fence).scopeId)
    && isSafeId((value as Fence).hostDeviceId)
    && isSafeInt((value as Fence).epoch)
    && isSafeId((value as Fence).leaseId);
}

function decodeAckJson(value: string, command: { command_id: string; status: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string }): CommandLifecycleState['ack'] {
  const ack = safeJson(value) as CommandLifecycleState['ack'] | null;
  const fence = { accountId: command.account_id, scopeId: command.scope_id, hostDeviceId: command.host_device_id, epoch: command.epoch, leaseId: command.lease_id };
  if (!ack || ack.family !== 'command-ack' || ack.commandId !== command.command_id || !isFenceShape(ack.fence) || !sameFence(ack.fence, fence) || !isSafeInt(ack.signedAt) || !isSafeId(ack.signature)) throw new Error('malformed-command-ack-json');
  if (command.status === 'accepted' && ack.status !== 'accepted' && ack.status !== 'duplicate') throw new Error('malformed-command-ack-json');
  return ack;
}

function decodePendingEventJson(value: string, command: { command_id: string; status: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string; result_seq: number | null; applied_event_id: string | null }): CommandLifecycleState['pendingEvent'] {
  const event = safeJson(value) as CommandLifecycleState['pendingEvent'] | null;
  if (!event || Object.keys(event).sort().join(',') !== 'commandId,eventId,seq' || event.commandId !== command.command_id || !isSafeInt(event.seq) || !isSafeId(event.eventId)) throw new Error('malformed-command-event-json');
  if (command.result_seq !== null && command.result_seq !== event.seq) throw new Error('malformed-command-event-json');
  if (command.applied_event_id !== null && command.applied_event_id !== event.eventId) throw new Error('malformed-command-event-json');
  return event;
}

function decodeCursorJson(value: string, fence: Fence, lastSeq: number, lastEventId: string | null, lastDigest: string | null): ShadowCursor {
  const cursor = safeJson(value) as ShadowCursor | null;
  if (!cursor || !isFenceShape(cursor.fence) || !sameFence(cursor.fence, fence) || cursor.lastSeq !== lastSeq || cursor.lastEventId !== lastEventId || cursor.lastDigest !== lastDigest) throw new Error('malformed-cursor-json');
  if (cursor.history && (!Array.isArray(cursor.history) || cursor.history.some((item) => !isSafeInt(item.seq) || !isSafeId(item.eventId) || !isSafeId(item.payloadDigest)))) throw new Error('malformed-cursor-json');
  return cursor;
}

function isValidRange(range: ByteRange, totalBytes: number): boolean {
  return isSafeInt(range.start) && isSafeInt(range.endExclusive) && range.start < range.endExclusive && range.endExclusive <= totalBytes;
}

function strictRanges(value: unknown, totalBytes: number): ByteRange[] | null {
  if (!Array.isArray(value)) return null;
  const ranges = value.slice().sort((a, b) => Number(a.start) - Number(b.start) || Number(a.endExclusive) - Number(b.endExclusive));
  const out: ByteRange[] = [];
  for (const range of ranges) {
    if (!isValidRange(range, totalBytes)) return null;
    const previous = out.at(-1);
    if (previous && range.start < previous.endExclusive) return null;
    if (previous && range.start === previous.endExclusive) previous.endExclusive = range.endExclusive;
    else out.push({ start: range.start, endExclusive: range.endExclusive });
  }
  return out;
}

function rangeContains(outer: ByteRange, inner: ByteRange): boolean {
  return inner.start >= outer.start && inner.endExclusive <= outer.endExclusive;
}

function sameRanges(a: ByteRange[], b: ByteRange[]): boolean {
  return a.length === b.length && a.every((range, index) => range.start === b[index]?.start && range.endExclusive === b[index]?.endExclusive);
}

function firstMissingSpan(covered: ByteRange[], requested: ByteRange): ByteRange | null {
  let pos = requested.start;
  for (const range of covered) {
    if (range.endExclusive <= requested.start) continue;
    if (range.start >= requested.endExclusive) break;
    if (range.start > pos) return { start: pos, endExclusive: Math.min(range.start, requested.endExclusive) };
    pos = Math.max(pos, Math.min(range.endExclusive, requested.endExclusive));
  }
  return pos < requested.endExclusive ? { start: pos, endExclusive: requested.endExclusive } : null;
}

function missingSpans(covered: ByteRange[], verified: ByteRange[]): ByteRange[] {
  const missing: ByteRange[] = [];
  for (const wanted of verified) {
    let pos = wanted.start;
    for (const range of covered) {
      if (range.endExclusive <= wanted.start) continue;
      if (range.start >= wanted.endExclusive) break;
      if (range.start > pos) missing.push({ start: pos, endExclusive: Math.min(range.start, wanted.endExclusive) });
      pos = Math.max(pos, Math.min(range.endExclusive, wanted.endExclusive));
    }
    if (pos < wanted.endExclusive) missing.push({ start: pos, endExclusive: wanted.endExclusive });
  }
  return missing;
}

function subtractRanges(ranges: ByteRange[], badRanges: ByteRange[]): ByteRange[] {
  return badRanges.reduce((next, bad) => subtractRange(next, bad), ranges);
}

function subtractRange(ranges: ByteRange[], bad: ByteRange): ByteRange[] {
  const next: ByteRange[] = [];
  for (const range of ranges) {
    if (bad.endExclusive <= range.start || bad.start >= range.endExclusive) next.push({ ...range });
    else {
      if (bad.start > range.start) next.push({ start: range.start, endExclusive: bad.start });
      if (bad.endExclusive < range.endExclusive) next.push({ start: bad.endExclusive, endExclusive: range.endExclusive });
    }
  }
  return next;
}

function cloneExpectedAuthority(expected: ShadowExpectedAuthority): ShadowExpectedAuthority {
  return { ...expected, fence: { ...expected.fence } };
}

function baseState(controllerDeviceId: string, hostDeviceId: string, expectedAuthority: ShadowExpectedAuthority): ShadowState {
  return {
    controllerDeviceId,
    hostDeviceId,
    expectedAuthority: cloneExpectedAuthority(expectedAuthority),
    cursor: null,
    connection: 'offline',
    transport: 'relay',
    readonlyOffline: true,
    entities: [],
    commands: [],
    assetEntries: [],
    grants: [],
    visualGrants: [],
    previews: [],
    usedTransitionIds: [],
    usedTransitionNonces: [],
    authorityTransitions: [],
    repairRecords: [],
  };
}

class SQLiteShadowTransaction implements ShadowStoreTransaction {
  private pending: (() => Promise<unknown>)[] = [];
  private readonly inboxIds: Set<string>;

  constructor(private state: ShadowState, private db: SQLiteDatabase, inboxIds: Iterable<string>) {
    this.inboxIds = new Set(inboxIds);
  }

  async flush(): Promise<void> {
    for (const thunk of this.pending) await thunk();
  }

  private enqueue(thunk: () => Promise<unknown>): void {
    this.pending.push(thunk);
  }

  getState(): ShadowState { return this.state; }
  setAuthorityCursor(cursor: ShadowCursor | null): void { this.state.cursor = cursor; }
  setExpectedAuthority(expected: ShadowExpectedAuthority): void { this.state.expectedAuthority = cloneExpectedAuthority(expected); }
  setConnection(connection: ShadowState['connection'], repairReason?: string): void {
    this.state.connection = connection;
    this.state.readonlyOffline = connection !== 'online';
    this.state.repairReason = repairReason;
  }
  setTransport(transport: ShadowState['transport']): void { this.state.transport = transport; }
  putInbox(event: ShadowStateEvent): void {
    this.inboxIds.add(event.eventId);
    this.enqueue(() => this.db.runAsync('INSERT OR REPLACE INTO shadow_inbox(event_id, event_json) VALUES(?, ?)', event.eventId, json(event)));
  }
  hasInbox(eventId: string): boolean { return this.inboxIds.has(eventId); }
  deleteInbox(eventId: string): void {
    this.inboxIds.delete(eventId);
    this.enqueue(() => this.db.runAsync('DELETE FROM shadow_inbox WHERE event_id = ?', eventId));
  }
  putEntity(entity: ShadowEntity): void {
    this.state.entities = [...this.state.entities.filter((item) => item.collection !== entity.collection || item.id !== entity.id), entity];
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_entities(collection, entity_id, revision, updated_at, deleted, payload_digest, data_json) VALUES(?, ?, ?, ?, ?, ?, ?)',
      entity.collection,
      entity.id,
      entity.revision,
      entity.updatedAt,
      entity.deleted ? 1 : 0,
      entity.payloadDigest,
      json(entity.data),
    ));
  }
  putCommand(command: CommandLifecycleState): void {
    this.state.commands = [...this.state.commands.filter((item) => item.commandId !== command.commandId), command];
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_commands(command_id, status, account_id, scope_id, host_device_id, epoch, lease_id, created_at, expires_at, result_seq, applied_event_id, reject_reason, ack_json, pending_event_json, command_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      command.commandId,
      command.status,
      command.fence.accountId,
      command.fence.scopeId,
      command.fence.hostDeviceId,
      command.fence.epoch,
      command.fence.leaseId,
      command.createdAt,
      command.expiresAt,
      command.resultSeq ?? null,
      command.appliedEventId ?? null,
      command.rejectReason ?? null,
      command.ack ? json(command.ack) : null,
      command.pendingEvent ? json(command.pendingEvent) : null,
      json(command),
    ));
  }
  deleteCommand(commandId: string): void {
    this.state.commands = this.state.commands.filter((item) => item.commandId !== commandId);
    this.enqueue(() => this.db.runAsync('DELETE FROM shadow_commands WHERE command_id = ?', commandId));
  }
  putGrant(grant: ControllerGrantState): void {
    this.state.grants = [...this.state.grants.filter((item) => item.grantId !== grant.grantId), grant];
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_grants(grant_id, controller_device_id, account_id, scope_id, host_device_id, epoch, lease_id, expires_at, revoked_at, shadow_only, grant_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      grant.grantId,
      grant.controllerDeviceId,
      grant.fence.accountId,
      grant.fence.scopeId,
      grant.fence.hostDeviceId,
      grant.fence.epoch,
      grant.fence.leaseId,
      grant.expiresAt,
      grant.revokedAt ?? null,
      grant.shadowOnly ? 1 : 0,
      json(grant),
    ));
  }
  putVisualGrant(grant: ShadowVisualControlGrant): void {
    this.state.visualGrants = [...this.state.visualGrants.filter((item) => item.grantId !== grant.grantId), grant];
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_visual_grants(grant_id, visual_session_id, controller_device_id, account_id, scope_id, host_device_id, epoch, lease_id, mode, project_id, session_id, surface_id, expires_at, signed_at, signature) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      grant.grantId,
      grant.visualSessionId,
      grant.controllerDeviceId,
      grant.fence.accountId,
      grant.fence.scopeId,
      grant.fence.hostDeviceId,
      grant.fence.epoch,
      grant.fence.leaseId,
      grant.mode,
      grant.projectId,
      grant.sessionId,
      grant.surfaceId,
      grant.expiresAt,
      grant.signedAt,
      grant.signature,
    ));
  }
  revokeController(controllerDeviceId: string, revokedAt: number): void {
    this.state.grants = this.state.grants.map((grant) => grant.controllerDeviceId === controllerDeviceId ? { ...grant, revokedAt } : grant);
    this.state.visualGrants = this.state.visualGrants.filter((grant) => grant.controllerDeviceId !== controllerDeviceId);
    this.state.previews = this.state.previews.map((preview) => preview.controllerDeviceId === controllerDeviceId ? { ...preview, inputMode: 'view-only', activeGrantId: undefined } : preview);
    this.enqueue(() => this.db.runAsync('UPDATE shadow_grants SET revoked_at = ? WHERE controller_device_id = ?', revokedAt, controllerDeviceId));
    this.enqueue(() => this.db.runAsync('DELETE FROM shadow_visual_grants WHERE controller_device_id = ?', controllerDeviceId));
    this.enqueue(() => this.db.runAsync('INSERT OR REPLACE INTO shadow_revocations(controller_device_id, revoked_at, reason) VALUES(?, ?, ?)', controllerDeviceId, revokedAt, 'controller-revoked'));
  }
  putPreview(preview: ShadowPreviewState): void {
    this.state.previews = [...this.state.previews.filter((item) => item.visualSessionId !== preview.visualSessionId), preview];
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_previews(visual_session_id, controller_device_id, account_id, scope_id, host_device_id, epoch, lease_id, mode, input_mode, project_id, session_id, surface_id, expires_at, active_grant_id, last_input_seq, min_frame_seq, last_frame_seq, preview_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      preview.visualSessionId,
      preview.controllerDeviceId,
      preview.fence.accountId,
      preview.fence.scopeId,
      preview.fence.hostDeviceId,
      preview.fence.epoch,
      preview.fence.leaseId,
      preview.mode,
      preview.inputMode,
      preview.projectId ?? null,
      preview.sessionId ?? null,
      preview.surfaceId ?? null,
      preview.expiresAt,
      preview.activeGrantId ?? null,
      preview.lastInputSeq,
      preview.minFrameSeq,
      preview.lastFrameSeq,
      json(preview),
    ));
  }
  putAssetMetadata(entry: ShadowState['assetEntries'][number]): void {
    this.state.assetEntries = [...this.state.assetEntries.filter((item) => item.contentId !== entry.contentId), entry];
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_assets(content_id, variant, total_bytes, digest, verified_ranges_json, last_accessed_at) VALUES(?, ?, ?, ?, ?, ?)',
      entry.contentId,
      entry.variant,
      entry.totalBytes,
      entry.digest,
      json(entry.verifiedRanges),
      entry.lastAccessedAt,
    ));
  }
  putAssetChunk(contentId: string, range: ByteRange, bytes: Uint8Array, digest: string): void {
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_asset_ranges(content_id, start, end_exclusive, digest, bytes) VALUES(?, ?, ?, ?, ?)',
      contentId,
      range.start,
      range.endExclusive,
      digest,
      bytes,
    ));
  }
  consumeAuthorityTransition(grant: ShadowAuthorityTransitionGrant, expected: ShadowExpectedAuthority, staleEntityScope: { accountId: string; scopeId: string }): void {
    this.state.expectedAuthority = cloneExpectedAuthority(expected);
    // Same-fence lease-renewal preserves cursor/entities/commands/grants + stays
    // online (only the lease expiry advances); epoch/leaseId transitions quiesce.
    const renewal = grant.kind === 'lease-renewal';
    if (!renewal) {
      this.state.cursor = null;
      this.state.connection = 'repair-required';
      this.state.readonlyOffline = true;
      this.state.repairReason = 'authority-transition';
      this.state.commands = this.state.commands.map((command) => ['applied', 'rejected', 'expired', 'cancelled'].includes(command.status) ? command : { ...command, status: 'stale-epoch' });
      this.state.grants = [];
      this.state.visualGrants = [];
      this.state.previews = [];
      this.state.entities = this.state.entities.filter(() => staleEntityScope.accountId === expected.fence.accountId && staleEntityScope.scopeId === expected.fence.scopeId);
    }
    this.state.usedTransitionIds = [...new Set([...this.state.usedTransitionIds, grant.transitionId])];
    this.state.usedTransitionNonces = [...new Set([...this.state.usedTransitionNonces, grant.nonce])];
    const consumedAt = Date.now();
    this.state.authorityTransitions = [...this.state.authorityTransitions, {
      transitionId: grant.transitionId,
      nonce: grant.nonce,
      kind: grant.kind,
      controllerDeviceId: grant.controllerDeviceId,
      previousFence: { ...grant.previousFence },
      nextFence: { ...grant.nextFence },
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      keyId: grant.keyId,
      signature: grant.signature,
      consumedAt,
    }];
    if (!renewal) {
      this.enqueue(() => this.db.runAsync('DELETE FROM shadow_grants'));
      this.enqueue(() => this.db.runAsync('DELETE FROM shadow_visual_grants'));
      this.enqueue(() => this.db.runAsync('DELETE FROM shadow_previews'));
      this.enqueue(() => this.db.runAsync('DELETE FROM shadow_entities WHERE NOT (? = ? AND ? = ?)', staleEntityScope.accountId, expected.fence.accountId, staleEntityScope.scopeId, expected.fence.scopeId));
      this.enqueue(() => this.db.runAsync('UPDATE shadow_commands SET status = ? WHERE status NOT IN (?, ?, ?, ?)', 'stale-epoch', 'applied', 'rejected', 'expired', 'cancelled'));
    }
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_authority_transitions(transition_id, nonce, kind, controller_device_id, previous_fence_json, next_fence_json, issued_at, expires_at, key_id, signature, consumed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      grant.transitionId,
      grant.nonce,
      grant.kind,
      grant.controllerDeviceId,
      json(grant.previousFence),
      json(grant.nextFence),
      grant.issuedAt,
      grant.expiresAt,
      grant.keyId,
      grant.signature,
      consumedAt,
    ));
    this.recordRepair({ id: derivedShadowPersistedId('transition', { transitionId: grant.transitionId, nonce: grant.nonce, previousFence: grant.previousFence, nextFence: grant.nextFence }), reason: 'authority-transition', createdAt: consumedAt });
  }
  recordRepair(record: ShadowRepairRecord): void {
    if (!isSafeId(record.id) || !isSafeId(record.reason)) throw new Error('invalid-repair-record');
    this.state.repairRecords = [...this.state.repairRecords.filter((item) => item.id !== record.id), record];
    this.enqueue(() => this.db.runAsync('INSERT OR REPLACE INTO shadow_snapshot_repair(id, reason, created_at) VALUES(?, ?, ?)', record.id, record.reason, record.createdAt));
    this.enqueue(() => this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_repair_evidence(id, reason, repair_class, row_class, table_name, row_identity_hash, account_id, scope_id, controller_device_id, host_device_id, epoch, lease_id, transition_identity_hash, asset_id, range_start, range_end_exclusive, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      record.id,
      record.reason,
      record.class ?? (record.assetId ? 'asset' : 'store-load'),
      record.class ?? (record.assetId ? 'asset' : 'authority'),
      record.table ?? (record.class === 'store-load' || (!record.class && !record.assetId) ? 'shadow_authority' : null),
      record.rowIdentityHash ?? (record.class === 'store-load' || (!record.class && !record.assetId) ? rowIdentityHash('shadow_authority', { id: 'current', controller_device_id: this.state.expectedAuthority.controllerDeviceId, scope_id: this.state.expectedAuthority.fence.scopeId }) : null),
      record.authorityScope?.accountId ?? this.state.expectedAuthority.fence.accountId,
      record.authorityScope?.scopeId ?? this.state.expectedAuthority.fence.scopeId,
      record.authorityScope?.controllerDeviceId ?? this.state.expectedAuthority.controllerDeviceId,
      record.authorityScope?.hostDeviceId ?? this.state.expectedAuthority.fence.hostDeviceId,
      record.authorityScope?.epoch ?? this.state.expectedAuthority.fence.epoch,
      record.authorityScope?.leaseId ?? this.state.expectedAuthority.fence.leaseId,
      record.transitionIdentityHash ?? null,
      record.assetId ?? null,
      record.range?.start ?? null,
      record.range?.endExclusive ?? null,
      record.createdAt,
    ));
  }
  deleteAsset(contentId: string): void {
    this.state.assetEntries = this.state.assetEntries.filter((item) => item.contentId !== contentId);
    this.enqueue(() => this.db.runAsync('DELETE FROM shadow_assets WHERE content_id = ?', contentId));
    this.enqueue(() => this.db.runAsync('DELETE FROM shadow_asset_ranges WHERE content_id = ?', contentId));
  }
}

export class ExpoSQLiteShadowStore implements ShadowStore {
  private initialized = false;

  constructor(
    private readonly db: SQLiteDatabase,
    private readonly controllerDeviceId: string,
    private readonly hostDeviceId: string,
    private readonly expectedAuthority: ShadowExpectedAuthority,
  ) {}

  async load(): Promise<ShadowState> {
    try {
      return await this.loadUnsafe();
    } catch (error) {
      if (error instanceof MalformedShadowRowError) {
        await this.recordRepairEvidence(this.malformedRowEvidence(error, Date.now()));
      } else {
        const reason = error instanceof Error && isSafeId(error.message) ? error.message : 'malformed-row';
        await this.persistLoadRepair('shadow_load', { controllerDeviceId: this.controllerDeviceId, hostDeviceId: this.hostDeviceId }, reason);
      }
      throw error;
    }
  }

  private async loadUnsafe(): Promise<ShadowState> {
    await this.init();
    const state = baseState(this.controllerDeviceId, this.hostDeviceId, this.expectedAuthority);
    const authority = await this.db.getAllAsync<{ __rowid?: number; controller_device_id: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string; lease_expires_at: number; cursor_last_seq: number | null; cursor_last_event_id: string | null; cursor_last_digest: string | null; cursor_json: string | null; connection: string; transport: string; repair_reason: string | null }>('SELECT rowid AS __rowid, * FROM shadow_authority WHERE id = ?', 'current');
    const row = authority[0];
    if (row) {
      if (!isConnection(row.connection) || !isTransport(row.transport) || !isSafeInt(row.epoch) || !isSafeInt(row.lease_expires_at) || !isSafeId(row.controller_device_id) || !isSafeId(row.account_id) || !isSafeId(row.scope_id) || !isSafeId(row.host_device_id) || !isSafeId(row.lease_id)) malformedRow('shadow_authority', 'authority', row, 'malformed-authority-row');
      state.expectedAuthority = { controllerDeviceId: row.controller_device_id, leaseExpiresAt: row.lease_expires_at, fence: { accountId: row.account_id, scopeId: row.scope_id, hostDeviceId: row.host_device_id, epoch: row.epoch, leaseId: row.lease_id } };
      state.cursor = row.cursor_last_seq === null ? null : {
        fence: { ...state.expectedAuthority.fence },
        lastSeq: row.cursor_last_seq,
        lastEventId: row.cursor_last_event_id,
        lastDigest: row.cursor_last_digest,
        history: row.cursor_json ? decodeCursorJson(row.cursor_json, state.expectedAuthority.fence, row.cursor_last_seq, row.cursor_last_event_id, row.cursor_last_digest).history : undefined,
      };
      state.connection = row.connection;
      state.transport = row.transport;
      state.readonlyOffline = row.connection !== 'online';
      state.repairReason = row.repair_reason ?? undefined;
    }
    state.entities = decodeRows('shadow_entities', 'entity', await this.db.getAllAsync<{ __rowid?: number; collection: ShadowEntity['collection']; entity_id: string; revision: number; updated_at: number; deleted: number; payload_digest: string; data_json: string }>('SELECT rowid AS __rowid, * FROM shadow_entities'), (entity) => {
      const data = safeJson(entity.data_json);
      if (!['workspace', 'project', 'session', 'job', 'approval', 'schedule', 'asset', 'event', 'settings', 'question', 'diff-summary', 'blob-manifest', 'command', 'audit', 'host-status'].includes(entity.collection) || !isSafeId(entity.entity_id) || !isSafeInt(entity.revision) || !isSafeInt(entity.updated_at) || (entity.deleted !== 0 && entity.deleted !== 1) || !isSafeId(entity.payload_digest) || entity.data_json.length > 131_072 || !validateJsonDomainData(data)) throw new Error('malformed-entity-row');
      return {
        id: entity.entity_id,
        collection: entity.collection,
        revision: entity.revision,
        updatedAt: entity.updated_at,
        deleted: entity.deleted === 1,
        payloadDigest: entity.payload_digest,
        data,
      };
    });
    state.commands = decodeRows('shadow_commands', 'command', await this.db.getAllAsync<{ __rowid?: number; command_id: string; status: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string; created_at: number; expires_at: number; result_seq: number | null; applied_event_id: string | null; reject_reason: string | null; ack_json: string | null; pending_event_json: string | null }>('SELECT rowid AS __rowid, * FROM shadow_commands'), (command) => {
      if (!isSafeId(command.command_id) || !isCommandStatus(command.status) || !isSafeId(command.account_id) || !isSafeId(command.scope_id) || !isSafeId(command.host_device_id) || !isSafeInt(command.epoch) || !isSafeId(command.lease_id) || !isSafeInt(command.created_at) || !isSafeInt(command.expires_at) || command.created_at >= command.expires_at || (command.result_seq !== null && !isSafeInt(command.result_seq)) || !isSafeNullableId(command.applied_event_id) || !isBoundedNullableReason(command.reject_reason)) throw new Error('malformed-command-row');
      return {
        commandId: command.command_id,
        status: command.status,
        fence: { accountId: command.account_id, scopeId: command.scope_id, hostDeviceId: command.host_device_id, epoch: command.epoch, leaseId: command.lease_id },
        createdAt: command.created_at,
        expiresAt: command.expires_at,
        resultSeq: command.result_seq ?? undefined,
        appliedEventId: command.applied_event_id ?? undefined,
        rejectReason: command.reject_reason ?? undefined,
        ack: command.ack_json ? decodeAckJson(command.ack_json, command) : undefined,
        pendingEvent: command.pending_event_json ? decodePendingEventJson(command.pending_event_json, command) : undefined,
      };
    });
    state.grants = decodeRows('shadow_grants', 'grant', await this.db.getAllAsync<{ __rowid?: number; grant_id: string; controller_device_id: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string; expires_at: number; revoked_at: number | null; shadow_only: number }>('SELECT rowid AS __rowid, * FROM shadow_grants'), (grant) => {
      if (!isSafeId(grant.grant_id) || !isSafeId(grant.controller_device_id) || !isSafeId(grant.account_id) || !isSafeId(grant.scope_id) || !isSafeId(grant.host_device_id) || !isSafeInt(grant.epoch) || !isSafeId(grant.lease_id) || !isSafeInt(grant.expires_at) || (grant.revoked_at !== null && !isSafeInt(grant.revoked_at)) || (grant.shadow_only !== 0 && grant.shadow_only !== 1)) throw new Error('malformed-grant-row');
      return {
        grantId: grant.grant_id,
        controllerDeviceId: grant.controller_device_id,
        fence: { accountId: grant.account_id, scopeId: grant.scope_id, hostDeviceId: grant.host_device_id, epoch: grant.epoch, leaseId: grant.lease_id },
        expiresAt: grant.expires_at,
        revokedAt: grant.revoked_at ?? undefined,
        shadowOnly: grant.shadow_only === 1,
      };
    });
    state.visualGrants = decodeRows('shadow_visual_grants', 'visual-grant', await this.db.getAllAsync<{ __rowid?: number; grant_id: string; visual_session_id: string; controller_device_id: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string; mode: 'view-only' | 'control'; project_id: string | null; session_id: string | null; surface_id: string | null; expires_at: number; signed_at: number; signature: string }>('SELECT rowid AS __rowid, * FROM shadow_visual_grants'), (grant) => {
      if (!isSafeId(grant.grant_id) || !isSafeId(grant.visual_session_id) || !isSafeId(grant.controller_device_id) || !isSafeId(grant.account_id) || !isSafeId(grant.scope_id) || !isSafeId(grant.host_device_id) || !isSafeInt(grant.epoch) || !isSafeId(grant.lease_id) || !isPreviewInputMode(grant.mode) || !isSafeInt(grant.expires_at) || !isSafeInt(grant.signed_at) || grant.signed_at >= grant.expires_at || !isSafeId(grant.signature)) throw new Error('malformed-visual-grant-row');
      return {
        grantId: grant.grant_id,
        visualSessionId: grant.visual_session_id,
        controllerDeviceId: grant.controller_device_id,
        fence: { accountId: grant.account_id, scopeId: grant.scope_id, hostDeviceId: grant.host_device_id, epoch: grant.epoch, leaseId: grant.lease_id },
        mode: grant.mode,
        projectId: grant.project_id,
        sessionId: grant.session_id,
        surfaceId: grant.surface_id,
        expiresAt: grant.expires_at,
        signedAt: grant.signed_at,
        signature: grant.signature,
      };
    });
    state.previews = decodeRows('shadow_previews', 'preview', await this.db.getAllAsync<{ __rowid?: number; visual_session_id: string; controller_device_id: string; account_id: string; scope_id: string; host_device_id: string; epoch: number; lease_id: string; mode: ShadowPreviewState['mode']; input_mode: string; project_id: string | null; session_id: string | null; surface_id: string | null; expires_at: number; active_grant_id: string | null; last_input_seq: number; min_frame_seq: number; last_frame_seq: number }>('SELECT rowid AS __rowid, * FROM shadow_previews'), (preview) => {
      if (!isSafeId(preview.visual_session_id) || !isSafeId(preview.controller_device_id) || !isSafeId(preview.account_id) || !isSafeId(preview.scope_id) || !isSafeId(preview.host_device_id) || !isSafeInt(preview.epoch) || !isSafeId(preview.lease_id) || !['artifact', 'web-tunnel', 'pixel-stream'].includes(preview.mode) || !isPreviewInputMode(preview.input_mode) || !isSafeInt(preview.expires_at) || !isSafeInt(preview.last_input_seq) || !isSafeInt(preview.min_frame_seq) || !isSafeInt(preview.last_frame_seq)) throw new Error('malformed-preview-row');
      return {
        visualSessionId: preview.visual_session_id,
        controllerDeviceId: preview.controller_device_id,
        fence: { accountId: preview.account_id, scopeId: preview.scope_id, hostDeviceId: preview.host_device_id, epoch: preview.epoch, leaseId: preview.lease_id },
        mode: preview.mode,
        inputMode: preview.input_mode,
        projectId: preview.project_id ?? undefined,
        sessionId: preview.session_id ?? undefined,
        surfaceId: preview.surface_id ?? undefined,
        expiresAt: preview.expires_at,
        activeGrantId: preview.active_grant_id ?? undefined,
        lastInputSeq: preview.last_input_seq,
        minFrameSeq: preview.min_frame_seq,
        lastFrameSeq: preview.last_frame_seq,
      };
    });
    state.assetEntries = decodeRows('shadow_assets', 'asset', await this.db.getAllAsync<{ __rowid?: number; content_id: string; variant: string; total_bytes: number; digest: string; verified_ranges_json: string; last_accessed_at: number }>('SELECT rowid AS __rowid, * FROM shadow_assets'), (assetRow) => {
      const asset = {
        contentId: assetRow.content_id,
        variant: assetRow.variant,
        totalBytes: assetRow.total_bytes,
        digest: assetRow.digest,
        verifiedRanges: parse<ByteRange[]>(assetRow.verified_ranges_json),
        lastAccessedAt: assetRow.last_accessed_at,
      };
      const ranges = strictRanges(asset.verifiedRanges, asset.totalBytes);
      if (!isSafeId(asset.contentId) || !isSafeId(asset.variant) || !isSafeInt(asset.totalBytes) || !isSafeId(asset.digest) || !isSafeInt(asset.lastAccessedAt) || !ranges) throw new Error('malformed-asset-row');
      asset.verifiedRanges = ranges;
      return asset;
    });
    const repairs = await this.db.getAllAsync<{ __rowid?: number; id: string; reason: string; created_at: number }>('SELECT rowid AS __rowid, * FROM shadow_snapshot_repair');
    for (const repair of repairs) {
      if (!isSafeId(repair.id) || !isSafeId(repair.reason) || !isSafeInt(repair.created_at)) malformedRow('shadow_snapshot_repair', 'repair', repair, 'malformed-repair-row');
      state.repairRecords = replaceRepairRecord(state.repairRecords, { id: repair.id, reason: repair.reason, legacy: true, createdAt: repair.created_at });
    }
    const transitions = await this.db.getAllAsync<{ __rowid?: number; transition_id: string; nonce: string; kind: ShadowAuthorityTransitionGrant['kind']; controller_device_id: string; previous_fence_json: string; next_fence_json: string; issued_at: number; expires_at: number; key_id: string; signature: string; consumed_at: number }>('SELECT rowid AS __rowid, * FROM shadow_authority_transitions');
    for (const [ordinal, transition] of transitions.entries()) {
      (transition as typeof transition & { __ordinal?: number }).__ordinal = ordinal;
      const previousFence = safeJson(transition.previous_fence_json) as ShadowAuthorityTransitionGrant['previousFence'];
      const nextFence = safeJson(transition.next_fence_json) as ShadowAuthorityTransitionGrant['nextFence'];
      if (!isSafeId(transition.transition_id) || !isSafeId(transition.nonce) || (transition.kind !== 'handoff' && transition.kind !== 'lease-rotation' && transition.kind !== 'lease-renewal') || !isSafeId(transition.controller_device_id) || !isValidRange({ start: transition.issued_at, endExclusive: transition.expires_at }, Number.MAX_SAFE_INTEGER) || !isSafeId(transition.key_id) || !isSafeId(transition.signature) || !isSafeInt(transition.consumed_at) || !isSafeId(previousFence.accountId) || !isSafeId(previousFence.scopeId) || !isSafeId(previousFence.hostDeviceId) || !isSafeInt(previousFence.epoch) || !isSafeId(previousFence.leaseId) || !isSafeId(nextFence.accountId) || !isSafeId(nextFence.scopeId) || !isSafeInt(nextFence.epoch) || !isSafeId(nextFence.hostDeviceId) || !isSafeId(nextFence.leaseId)) malformedRow('shadow_authority_transitions', 'transition', transition, 'malformed-transition-row', ordinal);
      state.usedTransitionIds.push(transition.transition_id);
      state.usedTransitionNonces.push(transition.nonce);
      state.authorityTransitions.push({
        transitionId: transition.transition_id,
        nonce: transition.nonce,
        kind: transition.kind,
        controllerDeviceId: transition.controller_device_id,
        previousFence,
        nextFence,
        issuedAt: transition.issued_at,
        expiresAt: transition.expires_at,
        keyId: transition.key_id,
        signature: transition.signature,
        consumedAt: transition.consumed_at,
      });
    }
    const evidenceRecords = decodeRows('shadow_repair_evidence', 'repair-evidence', await this.db.getAllAsync<{ __rowid?: number; id: string; reason: string; repair_class: ShadowRepairEvidence['class'] | null; row_class: string | null; table_name: string | null; row_identity_hash: string | null; account_id: string | null; scope_id: string | null; controller_device_id: string | null; host_device_id: string | null; epoch: number | null; lease_id: string | null; transition_identity_hash: string | null; asset_id: string | null; range_start: number | null; range_end_exclusive: number | null; created_at: number }>('SELECT rowid AS __rowid, * FROM shadow_repair_evidence'), (evidence) => {
      if (!isSafeId(evidence.id) || !isSafeId(evidence.reason) || !isSafeInt(evidence.created_at)) throw new Error('malformed-repair-evidence-row');
      const typedValues = [
        evidence.row_class,
        evidence.table_name,
        evidence.row_identity_hash,
        evidence.account_id,
        evidence.scope_id,
        evidence.controller_device_id,
        evidence.host_device_id,
        evidence.epoch,
        evidence.lease_id,
        evidence.transition_identity_hash,
        evidence.asset_id,
        evidence.range_start,
        evidence.range_end_exclusive,
      ];
      const hasTypedPayload = evidence.repair_class !== null || typedValues.some((value) => value !== null && value !== undefined);
      if (!hasTypedPayload) return { id: evidence.id, reason: evidence.reason, legacy: true, createdAt: evidence.created_at };
      if (!['authority-chain', 'malformed-row', 'asset', 'store-load'].includes(evidence.repair_class as string)) throw new Error('malformed-repair-evidence-row');
      if (evidence.table_name !== null && !isSafeId(evidence.table_name)) throw new Error('malformed-repair-evidence-row');
      if (evidence.row_class !== null && !isSafeId(evidence.row_class)) throw new Error('malformed-repair-evidence-row');
      if (evidence.row_identity_hash !== null && !isSafeId(evidence.row_identity_hash)) throw new Error('malformed-repair-evidence-row');
      if (evidence.transition_identity_hash !== null && !isSafeId(evidence.transition_identity_hash)) throw new Error('malformed-repair-evidence-row');
      if (evidence.asset_id !== null && !isSafeId(evidence.asset_id)) throw new Error('malformed-repair-evidence-row');
      if ((evidence.range_start === null) !== (evidence.range_end_exclusive === null)) throw new Error('malformed-repair-evidence-row');
      if (evidence.range_start !== null && !isValidRange({ start: evidence.range_start, endExclusive: evidence.range_end_exclusive ?? -1 }, Number.MAX_SAFE_INTEGER)) throw new Error('malformed-repair-evidence-row');
      const hasScope = evidence.account_id !== null || evidence.scope_id !== null || evidence.controller_device_id !== null || evidence.host_device_id !== null || evidence.epoch !== null || evidence.lease_id !== null;
      if (hasScope && (!isSafeId(evidence.account_id) || !isSafeId(evidence.scope_id) || !isSafeId(evidence.controller_device_id) || (evidence.host_device_id !== null && !isSafeId(evidence.host_device_id)) || (evidence.epoch !== null && !isSafeInt(evidence.epoch)) || (evidence.lease_id !== null && !isSafeId(evidence.lease_id)))) throw new Error('malformed-repair-evidence-row');
      if (evidence.repair_class === 'asset' && (!isSafeId(evidence.table_name) || !isSafeId(evidence.row_class) || !isSafeId(evidence.row_identity_hash) || !hasScope || !isSafeId(evidence.asset_id))) throw new Error('malformed-repair-evidence-row');
      if ((evidence.repair_class === 'malformed-row' || evidence.repair_class === 'store-load') && (!isSafeId(evidence.table_name) || !isSafeId(evidence.row_identity_hash))) throw new Error('malformed-repair-evidence-row');
      if (evidence.repair_class === 'authority-chain' && !hasScope) throw new Error('malformed-repair-evidence-row');
      return {
        id: evidence.id,
        reason: evidence.reason,
        class: evidence.repair_class as ShadowRepairEvidence['class'],
        table: evidence.table_name ?? undefined,
        rowIdentityHash: evidence.row_identity_hash ?? undefined,
        authorityScope: hasScope ? {
          accountId: evidence.account_id as string,
          scopeId: evidence.scope_id as string,
          controllerDeviceId: evidence.controller_device_id as string,
          hostDeviceId: evidence.host_device_id ?? undefined,
          epoch: evidence.epoch ?? undefined,
          leaseId: evidence.lease_id ?? undefined,
        } : undefined,
        transitionIdentityHash: evidence.transition_identity_hash ?? undefined,
        assetId: evidence.asset_id ?? undefined,
        range: evidence.range_start !== null ? { start: evidence.range_start, endExclusive: evidence.range_end_exclusive as number } : undefined,
        createdAt: evidence.created_at,
      };
    });
    for (const record of evidenceRecords) {
      state.repairRecords = replaceRepairRecord(state.repairRecords, record);
    }
    return state;
  }

  private async persistLoadRepair(table: string, row: unknown, reason: string): Promise<void> {
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    try {
      await runTx(async () => {
        const createdAt = Date.now();
        await this.recordRepairEvidenceInTransaction({
          id: repairIdFor(table, row),
          class: 'store-load',
          reason,
          table,
          rowIdentityHash: rowIdentityHash(table, row),
          createdAt,
        });
      });
    } catch (repairError) {
      throw new Error(`load-repair-write-failed:${reason}:${repairError instanceof Error ? repairError.message : 'unknown'}`);
    }
  }

  async recordRepairEvidence(evidence: ShadowRepairEvidence): Promise<void> {
    await this.init();
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    try {
      await runTx(async () => {
        await this.recordRepairEvidenceInTransaction(evidence);
      });
    } catch (repairError) {
      throw new Error(`load-repair-write-failed:${evidence.reason}:${repairError instanceof Error ? repairError.message : 'unknown'}`);
    }
  }

  private async recordRepairEvidenceInTransaction(evidence: ShadowRepairEvidence): Promise<void> {
    if (!isSafeId(evidence.id) || !isSafeId(evidence.reason)) throw new Error('invalid-repair-evidence');
    await this.db.runAsync('INSERT OR REPLACE INTO shadow_snapshot_repair(id, reason, created_at) VALUES(?, ?, ?)', evidence.id, evidence.reason, evidence.createdAt);
    await this.db.runAsync(
      'INSERT OR REPLACE INTO shadow_repair_evidence(id, reason, repair_class, row_class, table_name, row_identity_hash, account_id, scope_id, controller_device_id, host_device_id, epoch, lease_id, transition_identity_hash, asset_id, range_start, range_end_exclusive, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      evidence.id,
      evidence.reason,
      repairClass(evidence),
      evidence.rowClass ?? null,
      evidence.table ?? null,
      evidence.rowIdentityHash ?? null,
      evidence.authorityScope?.accountId ?? null,
      evidence.authorityScope?.scopeId ?? null,
      evidence.authorityScope?.controllerDeviceId ?? null,
      evidence.authorityScope?.hostDeviceId ?? null,
      evidence.authorityScope?.epoch ?? null,
      evidence.authorityScope?.leaseId ?? null,
      evidence.transitionIdentityHash ?? null,
      evidence.assetId ?? null,
      evidence.range?.start ?? null,
      evidence.range?.endExclusive ?? null,
      evidence.createdAt,
    );
  }

  private malformedRowEvidence(error: MalformedShadowRowError, createdAt: number): ShadowRepairEvidence {
    return {
      id: `row:${error.table}:${error.rowIdentityHash}`,
      class: 'malformed-row',
      table: error.table,
      rowClass: error.rowClass,
      rowIdentityHash: error.rowIdentityHash,
      transitionIdentityHash: error.transitionIdentityHash,
      authorityScope: {
        accountId: this.expectedAuthority.fence.accountId,
        scopeId: this.expectedAuthority.fence.scopeId,
        controllerDeviceId: this.controllerDeviceId,
        hostDeviceId: this.expectedAuthority.fence.hostDeviceId,
        epoch: this.expectedAuthority.fence.epoch,
        leaseId: this.expectedAuthority.fence.leaseId,
      },
      reason: error.reasonCode,
      createdAt,
    };
  }

  async transaction<T>(fn: (tx: ShadowStoreTransaction) => Promise<T> | T): Promise<T> {
    await this.init();
    let result: T | undefined;
    let loadError: unknown;
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    await runTx(async () => {
      let state: ShadowState;
      try {
        state = await this.loadUnsafe();
      } catch (error) {
        if (error instanceof MalformedShadowRowError) {
          loadError = error;
          try {
            await this.recordRepairEvidenceInTransaction(this.malformedRowEvidence(error, Date.now()));
          } catch (repairError) {
            throw new Error(`load-repair-write-failed:${error.reasonCode}:${error.table}:${error.rowIdentityHash}:${repairError instanceof Error ? repairError.message : 'unknown'}`);
          }
          return;
        }
        throw error;
      }
      const inboxRows = await this.db.getAllAsync<{ event_id: string }>('SELECT event_id FROM shadow_inbox');
      const tx = new SQLiteShadowTransaction(state, this.db, inboxRows.map((row) => row.event_id));
      result = await fn(tx);
      await tx.flush();
      await this.db.runAsync(
        'INSERT OR REPLACE INTO shadow_authority(id, controller_device_id, account_id, scope_id, host_device_id, epoch, lease_id, lease_expires_at, cursor_last_seq, cursor_last_event_id, cursor_last_digest, cursor_json, connection, transport, repair_reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'current',
        state.expectedAuthority.controllerDeviceId,
        state.expectedAuthority.fence.accountId,
        state.expectedAuthority.fence.scopeId,
        state.expectedAuthority.fence.hostDeviceId,
        state.expectedAuthority.fence.epoch,
        state.expectedAuthority.fence.leaseId,
        state.expectedAuthority.leaseExpiresAt,
        state.cursor?.lastSeq ?? null,
        state.cursor?.lastEventId ?? null,
        state.cursor?.lastDigest ?? null,
        state.cursor ? json(state.cursor) : null,
        state.connection,
        state.transport,
        state.repairReason ?? null,
      );
      if (state.connection === 'repair-required' && state.repairReason) {
        await this.recordRepairEvidenceInTransaction({
          id: 'current',
          class: 'store-load',
          reason: isSafeId(state.repairReason) ? state.repairReason : 'corrupt-store',
          table: 'shadow_authority',
          rowClass: 'authority',
          rowIdentityHash: rowIdentityHash('shadow_authority', {
            id: 'current',
            controller_device_id: state.expectedAuthority.controllerDeviceId,
            account_id: state.expectedAuthority.fence.accountId,
            scope_id: state.expectedAuthority.fence.scopeId,
            host_device_id: state.expectedAuthority.fence.hostDeviceId,
            epoch: state.expectedAuthority.fence.epoch,
            lease_id: state.expectedAuthority.fence.leaseId,
          }),
          authorityScope: {
            accountId: state.expectedAuthority.fence.accountId,
            scopeId: state.expectedAuthority.fence.scopeId,
            controllerDeviceId: state.expectedAuthority.controllerDeviceId,
            hostDeviceId: state.expectedAuthority.fence.hostDeviceId,
            epoch: state.expectedAuthority.fence.epoch,
            leaseId: state.expectedAuthority.fence.leaseId,
          },
          createdAt: Date.now(),
        });
      }
    });
    if (loadError) throw loadError;
    return result as T;
  }

  async readAssetRange(contentId: string, range: ByteRange | undefined, crypto: Pick<ShadowCryptoAdapter, 'digest'>): Promise<Uint8Array | null> {
    await this.init();
    if (!isSafeId(contentId)) return null;
    const assetRows = await this.db.getAllAsync<{ total_bytes: number; digest: string; verified_ranges_json: string; last_accessed_at: number }>('SELECT total_bytes, digest, verified_ranges_json FROM shadow_assets WHERE content_id = ?', contentId);
    const asset = assetRows[0];
    if (!asset) return null;
    const requested = range ?? { start: 0, endExclusive: asset.total_bytes };
    const verifiedRanges = strictRanges(parse<ByteRange[]>(asset.verified_ranges_json), asset.total_bytes);
    if (!verifiedRanges || !isValidRange(requested, asset.total_bytes) || !verifiedRanges.some((verified) => rangeContains(verified, requested))) {
      return this.quarantineAsset(contentId, 'asset-metadata-corrupt');
    }
    const chunks = await this.db.getAllAsync<{ start: number; end_exclusive: number; digest: string; bytes: Uint8Array }>(
      'SELECT start, end_exclusive, digest, bytes FROM shadow_asset_ranges WHERE content_id = ? ORDER BY start ASC, end_exclusive ASC',
      contentId,
    );
    const chunkRanges = strictRanges(chunks.map((chunk) => ({ start: chunk.start, endExclusive: chunk.end_exclusive })), asset.total_bytes);
    if (!chunkRanges || !sameRanges(chunkRanges, verifiedRanges)) {
      const missing = chunkRanges ? missingSpans(chunkRanges, verifiedRanges) : [];
      const requestedHole = chunkRanges ? firstMissingSpan(chunkRanges, requested) : null;
      if (requestedHole) return this.quarantineAssetMissingSpans(contentId, [requestedHole], verifiedRanges, 'asset-range-hole');
      if (missing.length > 0) return this.quarantineAssetMissingSpans(contentId, missing, verifiedRanges, 'asset-range-gap');
      return this.quarantineAsset(contentId, 'asset-range-ambiguous');
    }
    for (const chunk of chunks) {
      const bytes = Uint8Array.from(chunk.bytes);
      if (chunk.end_exclusive <= chunk.start || bytes.byteLength !== chunk.end_exclusive - chunk.start || await crypto.digest(bytes) !== chunk.digest) {
        return this.quarantineAssetChunk(contentId, { start: chunk.start, endExclusive: chunk.end_exclusive }, verifiedRanges, asset, 'asset-chunk-corrupt');
      }
    }
    const relevant = chunks.filter((chunk) => chunk.end_exclusive > requested.start && chunk.start < requested.endExclusive);
    const out = new Uint8Array(requested.endExclusive - requested.start);
    let cursor = requested.start;
    let offset = 0;
    for (const chunk of relevant) {
      if (chunk.start > cursor || !isValidRange({ start: chunk.start, endExclusive: chunk.end_exclusive }, asset.total_bytes)) return this.quarantineAsset(contentId, 'asset-range-gap');
      const bytes = Uint8Array.from(chunk.bytes);
      const takeStart = Math.max(cursor, chunk.start);
      const takeEnd = Math.min(requested.endExclusive, chunk.end_exclusive);
      if (takeEnd <= takeStart) continue;
      out.set(bytes.slice(takeStart - chunk.start, takeEnd - chunk.start), offset);
      offset += takeEnd - takeStart;
      cursor = takeEnd;
    }
    if (cursor < requested.endExclusive) return this.quarantineAsset(contentId, 'asset-range-hole');
    if (requested.start === 0 && requested.endExclusive === asset.total_bytes && await crypto.digest(out) !== asset.digest) {
      return this.quarantineAsset(contentId, 'asset-full-digest-mismatch');
    }
    await this.db.runAsync('UPDATE shadow_assets SET last_accessed_at = ? WHERE content_id = ?', Date.now(), contentId);
    return out;
  }

  private async quarantineAsset(contentId: string, reason: string): Promise<null> {
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    await runTx(async () => {
      const createdAt = Date.now();
      await this.db.runAsync('DELETE FROM shadow_asset_ranges WHERE content_id = ?', contentId);
      await this.db.runAsync('DELETE FROM shadow_assets WHERE content_id = ?', contentId);
      await this.recordRepairEvidenceInTransaction(this.assetRepairEvidence(`asset:${contentId}`, reason, contentId, undefined, createdAt, 'shadow_assets'));
    });
    return null;
  }

  private async quarantineAssetChunk(contentId: string, badRange: ByteRange, verifiedRanges: ByteRange[], asset: { total_bytes: number; digest: string; verified_ranges_json: string; last_accessed_at: number }, reason: string, deleteRow = true): Promise<null> {
    const nextRanges = subtractRange(verifiedRanges, badRange);
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    await runTx(async () => {
      const createdAt = Date.now();
      if (deleteRow) await this.db.runAsync('DELETE FROM shadow_asset_ranges WHERE content_id = ? AND start = ? AND end_exclusive = ?', contentId, badRange.start, badRange.endExclusive);
      await this.db.runAsync('UPDATE shadow_assets SET verified_ranges_json = ? WHERE content_id = ?', json(nextRanges), contentId);
      await this.recordRepairEvidenceInTransaction(this.assetRepairEvidence(`asset:${contentId}:${badRange.start}-${badRange.endExclusive}`, reason, contentId, badRange, createdAt, 'shadow_asset_ranges'));
    });
    return null;
  }

  private async quarantineAssetMissingSpans(contentId: string, missing: ByteRange[], verifiedRanges: ByteRange[], reason: string): Promise<null> {
    const nextRanges = subtractRanges(verifiedRanges, missing);
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    await runTx(async () => {
      const createdAt = Date.now();
      await this.db.runAsync('UPDATE shadow_assets SET verified_ranges_json = ? WHERE content_id = ?', json(nextRanges), contentId);
      for (const span of missing) {
        await this.recordRepairEvidenceInTransaction(this.assetRepairEvidence(`asset:${contentId}:${span.start}-${span.endExclusive}`, reason, contentId, span, createdAt, 'shadow_asset_ranges'));
      }
    });
    return null;
  }

  private assetRepairEvidence(id: string, reason: string, contentId: string, range: ByteRange | undefined, createdAt: number, table: string): ShadowRepairEvidence {
    return {
      id: derivedShadowPersistedId('asset', { id, reason, contentId, range, table }),
      class: 'asset',
      repairClass: 'asset',
      reason,
      table,
      rowClass: range ? 'asset-range' : 'asset',
      rowIdentityHash: rowIdentityHash(table, range ? { content_id: contentId, start: range.start, end_exclusive: range.endExclusive } : { content_id: contentId }),
      authorityScope: {
        accountId: this.expectedAuthority.fence.accountId,
        scopeId: this.expectedAuthority.fence.scopeId,
        controllerDeviceId: this.controllerDeviceId,
        hostDeviceId: this.expectedAuthority.fence.hostDeviceId,
        epoch: this.expectedAuthority.fence.epoch,
        leaseId: this.expectedAuthority.fence.leaseId,
      },
      assetId: contentId,
      range,
      createdAt,
    };
  }

  private static readonly RESET_TABLES = ['shadow_authority', 'shadow_inbox', 'shadow_entities', 'shadow_commands', 'shadow_snapshot_repair', 'shadow_repair_evidence', 'shadow_grants', 'shadow_revocations', 'shadow_visual_grants', 'shadow_previews', 'shadow_assets', 'shadow_asset_ranges', 'shadow_authority_transitions'];

  /**
   * Phase 3B0 NOTE-1 + O-2: DURABLY erase the decrypted cache, robust to ANY
   * journal configuration. The shadow DB stores DECRYPTED host entity `data_json`
   * at rest, and a `-wal`/`-journal` sidecar can retain that plaintext, so:
   *   1. flush + truncate any pre-existing WAL (`wal_checkpoint(TRUNCATE)`);
   *   2. switch the journal to DELETE (outside a tx) so the destructive work uses a
   *      rollback journal that is removed on commit, not a persistent WAL;
   *   3. DELETE every table in an exclusive tx;
   *   4. VACUUM — rebuild the file, scrubbing freed pages;
   *   5. checkpoint(TRUNCATE) again to truncate any WAL a concurrent reader created.
   * The VACUUM and final checkpoint are CONFIDENTIALITY-CRITICAL: a failure THROWS
   * so the caller keeps the durable purge tombstone and fails closed (never a
   * swallowed "best-effort" leak).
   */
  async reset(): Promise<void> {
    await this.init();
    await this.checkpointTruncateBestEffort();   // flush any pre-existing WAL
    await this.switchJournalToDeleteBestEffort(); // destructive work → rollback journal, not WAL
    const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
    await runTx(async () => {
      for (const table of ExpoSQLiteShadowStore.RESET_TABLES) {
        await this.db.runAsync(`DELETE FROM ${table}`);
      }
    });
    await this.db.execAsync('VACUUM');                       // scrub freed pages — throws on failure
    await this.db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)'); // truncate any WAL — throws on failure
  }

  private async checkpointTruncateBestEffort(): Promise<void> {
    try { await this.db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* no WAL / unsupported — the strict post-checkpoint still runs */ }
  }

  private async switchJournalToDeleteBestEffort(): Promise<void> {
    // Switching WAL→DELETE performs a checkpoint then removes the -wal/-shm; if it
    // cannot switch (locked), the mandatory VACUUM + final checkpoint still scrub.
    try { await this.db.execAsync('PRAGMA journal_mode=DELETE'); } catch { /* leave mode; VACUUM + strict checkpoint cover it */ }
  }

  /** O-1 verification helper: total rows across every purge-managed table (0 after a successful reset). */
  async totalRowCountForPurgeVerification(): Promise<number> {
    await this.init();
    let total = 0;
    for (const table of ExpoSQLiteShadowStore.RESET_TABLES) {
      const rows = await this.db.getAllAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      total += Number(rows[0]?.c ?? 0);
    }
    return total;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.execAsync(SCHEMA);
    await this.migrateRepairEvidenceSchema();
    this.initialized = true;
  }

  private async migrateRepairEvidenceSchema(): Promise<void> {
    let columns = await this.repairEvidenceColumns();
    this.assertRepairEvidenceBaseColumns(columns);
    const missing = REPAIR_EVIDENCE_SCHEMA.filter((expected) => !columns.has(expected.name));
    if (missing.length > 0) {
      const runTx = this.db.withExclusiveTransactionAsync?.bind(this.db) ?? this.db.withTransactionAsync.bind(this.db);
      await runTx(async () => {
        for (const column of missing) {
          if (!column.addSql) throw new Error(`incompatible-repair-evidence-schema:${column.name}`);
          await this.db.runAsync(column.addSql);
        }
      });
    }
    columns = await this.repairEvidenceColumns();
    this.assertRepairEvidenceBaseColumns(columns);
    for (const expected of REPAIR_EVIDENCE_SCHEMA) {
      const actual = columns.get(expected.name);
      if (!actual || actual.type.toUpperCase() !== expected.type) throw new Error(`incompatible-repair-evidence-schema:${expected.name}`);
    }
  }

  private async repairEvidenceColumns(): Promise<Map<string, SQLiteTableColumn>> {
    const rows = await this.db.getAllAsync<SQLiteTableColumn>('PRAGMA table_info(shadow_repair_evidence)');
    return new Map(rows.map((row) => [row.name, { ...row, type: row.type.toUpperCase() }]));
  }

  private assertRepairEvidenceBaseColumns(columns: Map<string, SQLiteTableColumn>): void {
    for (const expected of REPAIR_EVIDENCE_SCHEMA.filter((column) => column.base)) {
      const actual = columns.get(expected.name);
      if (!actual || actual.type.toUpperCase() !== expected.type) throw new Error(`incompatible-repair-evidence-schema:${expected.name}`);
    }
  }
}

export async function createExpoSQLiteShadowStore(options: { databaseName?: string; controllerDeviceId: string; hostDeviceId: string; expectedAuthority: ShadowExpectedAuthority }): Promise<ExpoSQLiteShadowStore> {
  const opener = SQLite as unknown as { openDatabaseAsync?: (name: string) => Promise<SQLiteDatabase>; openDatabaseSync?: (name: string) => SQLiteDatabase };
  const db = opener.openDatabaseAsync
    ? await opener.openDatabaseAsync(options.databaseName ?? 'maestro-shadow.db')
    : opener.openDatabaseSync?.(options.databaseName ?? 'maestro-shadow.db');
  if (!db) throw new Error('expo-sqlite database opener unavailable');
  return new ExpoSQLiteShadowStore(db, options.controllerDeviceId, options.hostDeviceId, options.expectedAuthority);
}

export async function createExpoSQLiteShadowClient(options: Omit<ShadowClientOptions, 'store'> & { databaseName?: string; store?: ShadowStore }): Promise<ShadowMobileClient> {
  const store = options.store ?? await createExpoSQLiteShadowStore({
    databaseName: options.databaseName,
    controllerDeviceId: options.controllerDeviceId,
    hostDeviceId: options.hostDeviceId,
    expectedAuthority: options.expectedAuthority,
  });
  return new ShadowMobileClient({ ...options, store });
}

export function createInMemoryShadowClient(options: Omit<ShadowClientOptions, 'store'> & { store?: ShadowStore }): ShadowMobileClient {
  return new ShadowMobileClient({
    ...options,
    store: options.store ?? createMemoryShadowStore(options.controllerDeviceId, options.hostDeviceId, options.expectedAuthority),
  });
}
