import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { sql, Kysely, PostgresDialect } from 'kysely';
import {
  SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES,
  decodeShadowMessage,
  type ShadowCollection,
} from '@maestro/realtime/shadowProtocol';
import { Pool } from 'pg';
import { runMigrations, getDb, closeDb } from './db.js';
import { upsertDevice } from './accountDevices.js';
import { buildAccountServer } from './accountServer.js';
import { auth, migrateAuth } from './auth.js';
import * as shadowRelayMigration from './migrations/0002_shadow_relay.js';
import {
  acquireShadowLease,
  ackShadowCommand,
  connectShadowController,
  enqueueShadowCommand,
  pullShadowCommands,
  putShadowBlob,
  pruneShadowRelay,
  readShadowBlobRange,
  readShadowEvents,
  revokeShadowController,
  updateShadowCursor,
  updateShadowTransport,
  uploadShadowEvents,
  publishShadowSnapshot,
} from './shadowRelay.js';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode } from '@maestro/realtime/shadowCrypto';
import { generateShadowIdentity, type ShadowIdentity } from '@maestro/realtime/shadowEnrollment';
import { registerHostIdentity, signHostRegistration } from './shadowEnrollmentService.js';
import { shadowRequestProofBytes } from './shadowRequestAuth.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

// Signed shadow request proof headers (Phase 3A1). Enrolled data routes require
// this in addition to the account session; a fresh nonce is used every call.
let __shadowNonce = 0;
async function signedShadowHeaders(identity: ShadowIdentity, accountId: string, method: string, url: string, body: string): Promise<Record<string, string>> {
  const timestampMs = Date.now();
  const nonce = `srn_${Date.now()}_${__shadowNonce++}`;
  const bytes = shadowRequestProofBytes({ method, rawUrl: url, rawBody: body, accountId, deviceId: identity.deviceId, keyId: identity.signingKeyId, timestampMs, nonce });
  const signature = base64urlEncode(await nodeShadowCrypto.sign(identity.keys.signing.privateKey, bytes));
  return {
    'x-maestro-device-id': identity.deviceId,
    'x-maestro-shadow-key-id': identity.signingKeyId,
    'x-maestro-shadow-timestamp': String(timestampMs),
    'x-maestro-shadow-nonce': nonce,
    'x-maestro-shadow-signature': signature,
    'content-type': 'application/json',
  };
}
const SHADOW_PROTOCOL_VERSION = 1 as const;

interface Fence {
  accountId: string;
  scopeId: string;
  hostDeviceId: string;
  epoch: number;
  leaseId: string;
}

const digest = (n: string): string => `sha256:${'a'.repeat(63)}${n}`;
const sha256 = (value: Buffer | string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const b64 = (value: Buffer | string): string => Buffer.from(value).toString('base64');
const now = 1_800_000_000_000;

function event(fence: Fence, seq: number, patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    family: 'state-event',
    v: SHADOW_PROTOCOL_VERSION,
    eventId: `event_${seq}`,
    seq,
    prevSeq: seq - 1,
    fence,
    collection: 'job',
    op: 'upsert',
    entityId: `job_${seq}`,
    revision: seq,
    durable: true,
    payloadCiphertext: `cipher_event_${seq}`,
    payloadDigest: digest(String(seq)),
    keyId: 'key_scope_1',
    createdAt: now + seq,
    signature: 'sig_event',
    ...patch,
  };
}

function expectSharedDecodeOk(value: unknown): void {
  const decoded = decodeShadowMessage(value, { nowMs: now });
  expect(decoded.ok).toBe(true);
}

type ShadowTableName =
  | 'shadow_lease'
  | 'shadow_revoked_controller'
  | 'shadow_event'
  | 'shadow_cursor'
  | 'shadow_snapshot'
  | 'shadow_chunk'
  | 'shadow_blob'
  | 'shadow_blob_capability'
  | 'shadow_command'
  | 'shadow_transport';

const SHADOW_TABLES: Array<{ name: ShadowTableName; pk: string[] }> = [
  { name: 'shadow_lease', pk: ['account_id', 'scope_id'] },
  { name: 'shadow_revoked_controller', pk: ['account_id', 'scope_id', 'controller_device_id'] },
  { name: 'shadow_event', pk: ['account_id', 'scope_id', 'epoch', 'seq'] },
  { name: 'shadow_cursor', pk: ['account_id', 'scope_id', 'controller_device_id'] },
  { name: 'shadow_snapshot', pk: ['account_id', 'scope_id', 'snapshot_id'] },
  { name: 'shadow_chunk', pk: ['account_id', 'scope_id', 'content_id'] },
  { name: 'shadow_blob', pk: ['account_id', 'scope_id', 'content_id', 'variant'] },
  { name: 'shadow_blob_capability', pk: ['account_id', 'scope_id', 'capability_id'] },
  { name: 'shadow_command', pk: ['account_id', 'scope_id', 'command_id'] },
  { name: 'shadow_transport', pk: ['account_id', 'scope_id', 'controller_device_id', 'transport'] },
];

async function withCapturedMigrationDb<T>(fn: (db: Kysely<unknown>, capturedSql: string[]) => Promise<T>): Promise<T> {
  const capturedSql: string[] = [];
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool }),
    log(event) {
      if (event.level === 'query') capturedSql.push(event.query.sql);
    },
  });
  try {
    return await fn(db, capturedSql);
  } finally {
    await db.destroy();
  }
}

function splitPostgresStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let state: 'normal' | 'single' | 'double' | 'line-comment' | 'block-comment' | 'dollar' = 'normal';
  let blockDepth = 0;
  let dollarTag = '';
  let singleAllowsBackslash = false;

  const pushCurrent = () => {
    const statement = current.trim();
    if (statement.length > 0) statements.push(statement);
    current = '';
  };

  while (i < sqlText.length) {
    const ch = sqlText[i];
    const next = sqlText[i + 1];

    if (state === 'line-comment') {
      current += ch;
      i += 1;
      if (ch === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      current += ch;
      if (ch === '/' && next === '*') {
        current += next;
        blockDepth += 1;
        i += 2;
        continue;
      }
      if (ch === '*' && next === '/') {
        current += next;
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = 'normal';
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'single') {
      current += ch;
      if (singleAllowsBackslash && ch === '\\' && next !== undefined) {
        current += next;
        i += 2;
        continue;
      }
      if (ch === "'" && next === "'") {
        current += next;
        i += 2;
        continue;
      }
      if (ch === "'") state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'double') {
      current += ch;
      if (ch === '"' && next === '"') {
        current += next;
        i += 2;
        continue;
      }
      if (ch === '"') state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'dollar') {
      if (sqlText.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        state = 'normal';
        dollarTag = '';
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === ';') {
      pushCurrent();
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      current += ch + next;
      state = 'line-comment';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      current += ch + next;
      state = 'block-comment';
      blockDepth = 1;
      i += 2;
      continue;
    }

    const dollarMatch = sqlText.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
    if (dollarMatch) {
      dollarTag = dollarMatch[0];
      current += dollarTag;
      state = 'dollar';
      i += dollarTag.length;
      continue;
    }

    if ((ch === 'e' || ch === 'E') && next === "'") {
      current += ch + next;
      state = 'single';
      singleAllowsBackslash = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      current += ch;
      state = 'single';
      singleAllowsBackslash = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      current += ch;
      state = 'double';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (state !== 'normal') {
    throw new Error(`unterminated PostgreSQL lexical region in captured migration SQL: ${state}`);
  }
  pushCurrent();
  return statements;
}

function tokenizePostgresStatement(statement: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;
  let state: 'normal' | 'single' | 'double' | 'line-comment' | 'block-comment' | 'dollar' = 'normal';
  let blockDepth = 0;
  let dollarTag = '';
  let singleAllowsBackslash = false;

  const pushToken = () => {
    if (current.length > 0) {
      tokens.push(current.toLowerCase());
      current = '';
    }
  };

  while (i < statement.length) {
    const ch = statement[i];
    const next = statement[i + 1];

    if (state === 'line-comment') {
      i += 1;
      if (ch === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '/' && next === '*') {
        blockDepth += 1;
        i += 2;
        continue;
      }
      if (ch === '*' && next === '/') {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = 'normal';
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'single') {
      if (singleAllowsBackslash && ch === '\\' && next !== undefined) {
        i += 2;
        continue;
      }
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'double') {
      if (ch === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'dollar') {
      if (statement.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        state = 'normal';
        dollarTag = '';
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      pushToken();
      state = 'line-comment';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      pushToken();
      state = 'block-comment';
      blockDepth = 1;
      i += 2;
      continue;
    }

    const dollarMatch = statement.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
    if (dollarMatch) {
      pushToken();
      dollarTag = dollarMatch[0];
      state = 'dollar';
      i += dollarTag.length;
      continue;
    }

    if ((ch === 'e' || ch === 'E') && next === "'") {
      pushToken();
      state = 'single';
      singleAllowsBackslash = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      pushToken();
      state = 'single';
      singleAllowsBackslash = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      pushToken();
      state = 'double';
      i += 1;
      continue;
    }

    if (/[A-Za-z0-9_]+/.test(ch)) {
      current += ch;
      i += 1;
      continue;
    }

    pushToken();
    i += 1;
  }

  if (state !== 'normal') {
    throw new Error(`unterminated PostgreSQL lexical region in captured migration SQL: ${state}`);
  }
  pushToken();
  return tokens;
}

function assertMigrationStatementIsSchemaSafe(statement: string): void {
  const tokens = tokenizePostgresStatement(statement);
  expect(tokens.length).toBeGreaterThan(0);
  const [firstToken = '', secondToken = '', thirdToken = ''] = tokens;
  expect(['update', 'delete', 'insert', 'copy', 'truncate', 'drop', 'merge']).not.toContain(firstToken);

  if (firstToken === 'alter' && secondToken === 'table') {
    expect(tokens).toEqual(['alter', 'table', 'shadow_event', 'add', 'column', 'if', 'not', 'exists', 'canonical_digest', 'text']);
    return;
  }

  if (firstToken === 'create' && secondToken === 'table') return;
  if (firstToken === 'create' && secondToken === 'index') return;
  if (firstToken === 'create' && secondToken === 'unique' && thirdToken === 'index') return;
  throw new Error(`captured migration SQL statement is not allowlisted schema DDL: ${statement}`);
}

function assertMigrationExecutedOnlySchemaSafeSql(capturedSql: string[]): void {
  expect(capturedSql.length).toBeGreaterThan(0);
  for (const capturedQuery of capturedSql) {
    const statements = splitPostgresStatements(capturedQuery);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      assertMigrationStatementIsSchemaSafe(statement);
    }
  }
}

function canonicalizeDbValue(value: unknown): unknown {
  if (value === null) return { type: 'null' };
  if (Buffer.isBuffer(value)) return { type: 'buffer', encoding: 'hex', length: value.length, value: value.toString('hex') };
  if (value instanceof Date) return { type: 'timestamp', value: value.toISOString() };
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (Array.isArray(value)) return { type: 'array', value: value.map(canonicalizeDbValue) };
  if (typeof value === 'object' && value !== null) {
    return {
      type: 'json',
      value: Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalizeDbValue((value as Record<string, unknown>)[key])])),
    };
  }
  return { type: typeof value, value };
}

function canonicalizeDbRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonicalizeDbValue(row[key])]));
}

async function readCanonicalShadowRows(db = getDb()): Promise<{
  tables: Record<ShadowTableName, Array<Record<string, unknown>>>;
  tableHashes: Record<ShadowTableName, string>;
  combinedHash: string;
  pkSets: Record<ShadowTableName, string[]>;
  rowCounts: Record<ShadowTableName, number>;
}> {
  const tables = {} as Record<ShadowTableName, Array<Record<string, unknown>>>;
  const tableHashes = {} as Record<ShadowTableName, string>;
  const pkSets = {} as Record<ShadowTableName, string[]>;
  const rowCounts = {} as Record<ShadowTableName, number>;
  for (const table of SHADOW_TABLES) {
    let query = db.selectFrom(table.name).selectAll();
    for (const pk of table.pk) query = query.orderBy(sql.ref(pk));
    const rows = (await query.execute()) as Array<Record<string, unknown>>;
    const canonicalRows = rows.map(canonicalizeDbRow);
    tables[table.name] = canonicalRows;
    tableHashes[table.name] = sha256(JSON.stringify(canonicalRows));
    pkSets[table.name] = rows.map((row) => JSON.stringify(Object.fromEntries(table.pk.map((key) => [key, canonicalizeDbValue(row[key])]))));
    rowCounts[table.name] = rows.length;
  }
  return {
    tables,
    tableHashes,
    combinedHash: sha256(JSON.stringify(tableHashes)),
    pkSets,
    rowCounts,
  };
}

async function seedAllShadowRelayTables(): Promise<void> {
  const db = getDb();
  const accountId = 'acct-a';
  const scopeId = 'account:acct-a';
  const hostDeviceId = 'host-a';
  const controllerDeviceId = 'ctrl-a';
  const epoch = 12;
  const leaseId = 'lease_sentinel';
  const createdAt = new Date('2026-07-17T01:02:03.456Z');
  const updatedAt = new Date('2026-07-17T02:03:04.567Z');
  const expiresAt = new Date('2026-07-18T03:04:05.678Z');
  const fence = { accountId, scopeId, hostDeviceId, epoch, leaseId };
  const capJson = capability(fence, {
    capabilityId: 'cap_sentinel',
    controllerDeviceId,
    contentId: 'blob_sentinel',
    variant: 'screen',
    permissions: ['read', 'range-read'],
    expiresAt: expiresAt.getTime(),
    signature: 'sig_sentinel_capability',
  });

  await db.insertInto('shadow_lease').values({ account_id: accountId, scope_id: scopeId, host_device_id: hostDeviceId, epoch, lease_id: leaseId, expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt }).execute();
  await db.insertInto('shadow_revoked_controller').values({ account_id: accountId, scope_id: scopeId, controller_device_id: controllerDeviceId, revoked_at: new Date('2026-07-17T04:05:06.789Z'), key_rotation_effective_seq: 77 }).execute();
  await db.insertInto('shadow_event').values({
    account_id: accountId,
    scope_id: scopeId,
    host_device_id: hostDeviceId,
    epoch,
    lease_id: leaseId,
    seq: 42,
    prev_seq: 41,
    event_id: 'event_sentinel',
    collection: 'job',
    op: 'patch',
    entity_id: 'job_sentinel',
    revision: 9,
    command_id: 'cmd_sentinel',
    payload_ciphertext: 'cipher_event_sentinel',
    payload_digest: digest('e'),
    key_id: 'key_sentinel',
    signature: 'sig_event_sentinel',
    canonical_digest: 'canonical:event:sentinel',
    created_at_ms: 1_800_000_123_456,
    stored_at: new Date('2026-07-17T05:06:07.890Z'),
  }).execute();
  await db.insertInto('shadow_cursor').values({ account_id: accountId, scope_id: scopeId, controller_device_id: controllerDeviceId, host_device_id: hostDeviceId, epoch, lease_id: leaseId, last_seq: 42, last_event_id: 'event_sentinel', last_digest: digest('e'), updated_at: updatedAt }).execute();
  await db.insertInto('shadow_snapshot').values({ account_id: accountId, scope_id: scopeId, host_device_id: hostDeviceId, epoch, lease_id: leaseId, snapshot_id: 'snapshot_sentinel', base_seq: 42, manifest_ciphertext: 'manifest_cipher_sentinel', manifest_digest: digest('m'), key_id: 'key_sentinel', published_at: createdAt, expires_at: null }).execute();
  await db.insertInto('shadow_chunk').values({ account_id: accountId, scope_id: scopeId, host_device_id: hostDeviceId, epoch, lease_id: leaseId, content_id: 'chunk_sentinel', snapshot_id: 'snapshot_sentinel', collection: 'job', page_key: 'page:0001', byte_length: 8, ciphertext: Buffer.from('chunk-01'), plaintext_digest: digest('p'), ciphertext_digest: sha256(Buffer.from('chunk-01')), key_id: 'key_sentinel', created_at: createdAt, expires_at: expiresAt }).execute();
  await db.insertInto('shadow_blob').values({ account_id: accountId, scope_id: scopeId, host_device_id: hostDeviceId, epoch, lease_id: leaseId, content_id: 'blob_sentinel', variant: 'screen', byte_length: 9, ciphertext: Buffer.from('blob-0001'), plaintext_digest: digest('b'), ciphertext_digest: sha256(Buffer.from('blob-0001')), key_id: 'key_sentinel', capability_expires_at: expiresAt, created_at: createdAt }).execute();
  await db.insertInto('shadow_blob_capability').values({ account_id: accountId, scope_id: scopeId, controller_device_id: controllerDeviceId, host_device_id: hostDeviceId, epoch, lease_id: leaseId, content_id: 'blob_sentinel', variant: 'screen', capability_id: 'cap_sentinel', permissions: ['read', 'range-read'], expires_at: expiresAt, revoked_at: null, signature: 'sig_sentinel_capability', canonical_digest: 'canonical:capability:sentinel', capability_json: capJson, created_at: createdAt }).execute();
  await db.insertInto('shadow_command').values({ account_id: accountId, scope_id: scopeId, host_device_id: hostDeviceId, controller_device_id: controllerDeviceId, command_id: 'cmd_sentinel', idempotency_key: 'idem_sentinel', fence, envelope_ciphertext: 'cipher_command_sentinel', payload_digest: digest('c'), status: 'acked', ack_ciphertext: 'cipher_ack_sentinel', ack_digest: digest('a'), created_at: createdAt, updated_at: updatedAt, expires_at: expiresAt }).execute();
  await db.insertInto('shadow_transport').values({ account_id: accountId, scope_id: scopeId, controller_device_id: controllerDeviceId, host_device_id: hostDeviceId, transport: 'relay', state: 'connected:sentinel', updated_at: updatedAt }).execute();
}

function capability(fence: Fence, patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    family: 'asset-capability',
    v: SHADOW_PROTOCOL_VERSION,
    capabilityId: 'cap_screen',
    fence,
    controllerDeviceId: 'ctrl-a',
    contentId: 'cid_screen',
    variant: 'screen',
    permissions: ['read', 'range-read'],
    expiresAt: Date.now() + 60_000,
    signature: 'sig_capability',
    ...patch,
  };
}

describe('shadow relay migration executed-SQL guard', () => {
  it('rejects forbidden data rewrites after allowed DDL in the same captured query', () => {
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(['create table if not exists shadow_safe(id text); update shadow_event set canonical_digest = payload_digest'])).toThrow();
  });

  it('rejects forbidden data rewrites after comments and whitespace', () => {
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(['\n -- leading comment\n /* nested /* inner */ outer */\n insert into shadow_event(account_id) values($$acct;still-string$$)'])).toThrow();
  });

  it('rejects forbidden data rewrites after dollar-quoted bodies', () => {
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(['create table if not exists shadow_safe(id text default $$semi;colon$$); $tag$body ; update ignored inside body$tag$; delete from shadow_event'])).toThrow();
  });

  it('allows multiple additive DDL statements in one captured query', () => {
    expect(() => assertMigrationExecutedOnlySchemaSafeSql([
      'create table if not exists shadow_safe(id text); create unique index if not exists shadow_safe_id_idx on shadow_safe(id); alter table shadow_event add column if not exists canonical_digest text',
    ])).not.toThrow();
  });

  it('does not split on semicolons inside strings, comments, or dollar quotes', () => {
    expect(splitPostgresStatements(
      "create table if not exists shadow_safe(id text default 'semi;colon' /* comment; with ; semicolons */); " +
      '-- line comment ; still comment\n' +
      'create index if not exists shadow_safe_id_idx on shadow_safe(id); ' +
      'create table if not exists shadow_dollar(id text default $tag$semi;colon$tag$)',
    )).toHaveLength(3);
  });

  it('fails closed on COPY and unterminated lexical regions', () => {
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(['copy shadow_event to stdout'])).toThrow();
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(["create table if not exists shadow_bad(id text default 'unterminated)"])).toThrow();
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(['create table if not exists shadow_bad(id text); /* unterminated'])).toThrow();
    expect(() => assertMigrationExecutedOnlySchemaSafeSql(['create table if not exists shadow_bad(id text default $tag$unterminated)'])).toThrow();
  });
});

describe.skipIf(!HAS_DB)('shadow relay persistence contracts', () => {
  beforeEach(async () => {
    await getDb().schema.dropTable('shadow_transport').ifExists().execute();
    await getDb().schema.dropTable('shadow_command').ifExists().execute();
    await getDb().schema.dropTable('shadow_blob_capability').ifExists().execute();
    await getDb().schema.dropTable('shadow_blob').ifExists().execute();
    await getDb().schema.dropTable('shadow_chunk').ifExists().execute();
    await getDb().schema.dropTable('shadow_snapshot').ifExists().execute();
    await getDb().schema.dropTable('shadow_cursor').ifExists().execute();
    await getDb().schema.dropTable('shadow_event').ifExists().execute();
    await getDb().schema.dropTable('shadow_revoked_controller').ifExists().execute();
    await getDb().schema.dropTable('shadow_lease').ifExists().execute();
    await runMigrations();
    await getDb().deleteFrom('shadow_transport').execute();
    await getDb().deleteFrom('shadow_command').execute();
    await getDb().deleteFrom('shadow_blob').execute();
    await getDb().deleteFrom('shadow_chunk').execute();
    await getDb().deleteFrom('shadow_snapshot').execute();
    await getDb().deleteFrom('shadow_cursor').execute();
    await getDb().deleteFrom('shadow_event').execute();
    await getDb().deleteFrom('shadow_revoked_controller').execute();
    await getDb().deleteFrom('shadow_lease').execute();
    await getDb().deleteFrom('device').execute();
    await upsertDevice({ id: 'host-a', userId: 'acct-a', role: 'host', name: 'Mac A', platform: 'macos' });
    await upsertDevice({ id: 'host-b', userId: 'acct-b', role: 'host', name: 'Mac B', platform: 'macos' });
    await upsertDevice({ id: 'ctrl-a', userId: 'acct-a', role: 'remote', name: 'Phone A', platform: 'ios' });
  });
  afterAll(async () => { await closeDb(); });

  it('issues one account-scoped host lease and rejects another account host for that scope', async () => {
    const lease = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    expect(lease.fence).toMatchObject({ accountId: 'acct-a', hostDeviceId: 'host-a', leaseId: 'lease_a', epoch: 1 });

    await expect(acquireShadowLease({ accountId: 'acct-b', hostDeviceId: 'host-b', scopeId: 'account:acct-a', requestedLeaseId: 'lease_b', ttlMs: 60_000 })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('stores opaque ordered state events idempotently and rejects gaps/conflicts', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });

    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 2)] })).rejects.toMatchObject({ statusCode: 409 });

    expect(await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1), event(fence, 2)] })).toEqual({ accepted: 2, headSeq: 2 });
    expect(await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1)] })).toEqual({ accepted: 0, headSeq: 1 });

    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1, { payloadDigest: digest('9') })] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('roundtrips accepted wire state events through PostgreSQL read paths without losing family', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const wire = event(fence, 1, { collection: 'workspace', payloadCiphertext: 'cipher_workspace_1' });
    expectSharedDecodeOk(wire);

    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [wire] })).resolves.toEqual({ accepted: 1, headSeq: 1 });

    const read = await readShadowEvents({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', scopeId: 'account:acct-a', hostDeviceId: 'host-a', epoch: 1, afterSeq: 0 });
    expect(read).toEqual([wire]);
    expectSharedDecodeOk(read[0]);

    const connected = await connectShadowController({
      accountId: 'acct-a',
      controllerDeviceId: 'ctrl-a',
      hello: { family: 'connect-hello', protocolVersion: 1, accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', hostDeviceId: 'host-a', epoch: 1, lastSeq: 0, collectionDigests: {}, supportedTransports: ['relay'] },
    });
    expect(connected.events).toEqual([wire]);
    expectSharedDecodeOk(connected.events?.[0]);
  });

  it('uses the shared state-event protocol for family, collection, and encrypted payload validation', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1, { family: undefined })] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1, { family: 'command-state' })] })).rejects.toMatchObject({ statusCode: 400 });

    const validCollections: ShadowCollection[] = ['workspace', 'project', 'session', 'job', 'approval', 'schedule', 'asset', 'event', 'settings', 'question', 'diff-summary', 'blob-manifest', 'command', 'audit', 'host-status'];
    for (const [index, collection] of validCollections.entries()) {
      const seq = index + 1;
      await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, seq, { collection, eventId: `event_${collection.replace(/[^A-Za-z0-9]/g, '_')}`, entityId: `entity_${seq}`, payloadCiphertext: `cipher_${seq}` })] })).resolves.toEqual({ accepted: 1, headSeq: seq });
    }
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, validCollections.length + 1, { collection: 'diff' })] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enforces the shared encrypted payload cap exactly for relay state events', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const atCap = 'x'.repeat(SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES);
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1, { payloadCiphertext: atCap })] })).resolves.toEqual({ accepted: 1, headSeq: 1 });
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 2, { payloadCiphertext: `${atCap}x` })] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('treats legacy null canonical event digests as conflicts, not idempotent replays', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1)] })).resolves.toEqual({ accepted: 1, headSeq: 1 });
    await sql`alter table shadow_event alter column canonical_digest drop not null`.execute(getDb());
    await getDb().updateTable('shadow_event').set({ canonical_digest: null }).where('account_id', '=', 'acct-a').where('scope_id', '=', 'account:acct-a').where('event_id', '=', 'event_1').execute();
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1)] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects duplicate event ids when any canonical immutable field changes', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const base = event(fence, 1, { commandId: 'cmd_1' });
    await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [base] });
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['account', { fence: { ...fence, accountId: 'acct_b' } }],
      ['scope', { fence: { ...fence, scopeId: 'account:acct_b' } }],
      ['host', { fence: { ...fence, hostDeviceId: 'host_b' } }],
      ['epoch', { fence: { ...fence, epoch: 2 } }],
      ['lease', { fence: { ...fence, leaseId: 'lease_other' } }],
      ['seq', { seq: 2 }],
      ['prevSeq', { prevSeq: 99 }],
      ['collection', { collection: 'session' }],
      ['op', { op: 'patch' }],
      ['entityId', { entityId: 'job_other' }],
      ['revision', { revision: 2 }],
      ['commandId', { commandId: 'cmd_2' }],
      ['payloadCiphertext', { payloadCiphertext: 'cipher_other' }],
      ['payloadDigest', { payloadDigest: digest('x') }],
      ['keyId', { keyId: 'key_scope_2' }],
      ['createdAt', { createdAt: now + 99 }],
      ['signature', { signature: 'sig_other' }],
    ];
    for (const [, mutation] of mutations) {
      await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [{ ...base, ...mutation }] })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    }
    expect(await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [base] })).toEqual({ accepted: 0, headSeq: 1 });
  });

  it('connects controllers with delta decisions, cursor proof, and revocation fail-closed', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(fence, 1)] });

    const connected = await connectShadowController({
      accountId: 'acct-a',
      controllerDeviceId: 'ctrl-a',
      hello: { protocolVersion: 1, accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', hostDeviceId: 'host-a', epoch: 1, lastSeq: 0, collectionDigests: {}, supportedTransports: ['relay'] },
    });
    expect(connected.decision).toMatchObject({ decision: 'delta', fromSeq: 0, toSeq: 1 });
    expect(connected.events).toHaveLength(1);

    await expect(updateShadowCursor({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, lastSeq: 1, lastEventId: 'event_1', lastDigest: digest('bad') })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateShadowCursor({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, lastSeq: 1, lastEventId: 'event_1', lastDigest: digest('1') })).resolves.toEqual({ ok: true });

    await revokeShadowController({ accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', keyRotationEffectiveSeq: 2 });
    await expect(connectShadowController({
      accountId: 'acct-a',
      controllerDeviceId: 'ctrl-a',
      hello: { protocolVersion: 1, accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', hostDeviceId: 'host-a', epoch: 1, lastSeq: 1, collectionDigests: {}, supportedTransports: ['relay'] },
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('queues encrypted commands with idempotency and host ACK conflict detection', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });

    const queued = await enqueueShadowCommand({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, commandId: 'cmd_1', idempotencyKey: 'idem_1', envelopeCiphertext: 'cipher_command', payloadDigest: digest('c') });
    expect(queued).toEqual({ commandId: 'cmd_1', status: 'queued', duplicate: false });
    expect(await enqueueShadowCommand({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, commandId: 'cmd_1', idempotencyKey: 'idem_1', envelopeCiphertext: 'cipher_command', payloadDigest: digest('c') })).toMatchObject({ duplicate: true });
    await expect(enqueueShadowCommand({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, commandId: 'cmd_2', idempotencyKey: 'idem_1', envelopeCiphertext: 'cipher_command', payloadDigest: digest('d') })).rejects.toMatchObject({ statusCode: 409 });

    const pulled = await pullShadowCommands({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a' });
    expect(pulled).toHaveLength(1);
    await expect(ackShadowCommand({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', commandId: 'cmd_1', ackCiphertext: 'cipher_ack', ackDigest: digest('a') })).resolves.toEqual({ ok: true });
    await expect(ackShadowCommand({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', commandId: 'cmd_1', ackCiphertext: 'cipher_ack_2', ackDigest: digest('b') })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('requires host-registered exact blob capabilities and slices binary ranges', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const cap = capability(fence);
    await putShadowBlob({ accountId: 'acct-a', hostDeviceId: 'host-a', fence, contentId: 'cid_screen', variant: 'screen', ciphertext: b64(bytes), byteLength: bytes.length, plaintextDigest: digest('p'), ciphertextDigest: sha256(bytes), keyId: 'key_scope_1', capabilities: [cap], capabilityExpiresAt: Date.now() + 60_000 });
    const range = await readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: cap, contentId: 'cid_screen', variant: 'screen', start: 0, endExclusive: 256 });
    expect(Buffer.from(range.ciphertext, 'base64')).toEqual(bytes);
    expect(range.fullCiphertextDigest).toBe(sha256(bytes));
    expect(range.rangeCiphertextDigest).toBe(sha256(bytes));
    await expect(readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: { ...cap, permissions: ['read'] }, contentId: 'cid_screen', variant: 'screen', start: 2, endExclusive: 6 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: { ...cap, signature: 'sig_modified' }, contentId: 'cid_screen', variant: 'screen' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: capability(fence, { capabilityId: 'cap_fabricated' }), contentId: 'cid_screen', variant: 'screen' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: cap, contentId: 'cid_screen', variant: 'screen', start: 10, endExclusive: 9 })).rejects.toMatchObject({ statusCode: 416 });

    await putShadowBlob({ accountId: 'acct-a', hostDeviceId: 'host-a', fence, contentId: 'cid_expired', variant: 'screen', ciphertext: b64(bytes), byteLength: bytes.length, plaintextDigest: digest('p'), ciphertextDigest: sha256(bytes), keyId: 'key_scope_1', capabilityExpiresAt: Date.now() - 1 });
    await expect(readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: capability(fence, { contentId: 'cid_expired', capabilityId: 'cap_expired' }), contentId: 'cid_expired', variant: 'screen' })).rejects.toMatchObject({ statusCode: 403 });

    expect((await pruneShadowRelay(now)).blobs).toBeGreaterThanOrEqual(1);
  });

  it('serializes absent lease races and expired takeovers', async () => {
    await upsertDevice({ id: 'host-c', userId: 'acct-a', role: 'host', name: 'Mac C', platform: 'macos' });
    const attempts = await Promise.allSettled([
      acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'race_a', ttlMs: 60_000 }),
      acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-c', scopeId: 'account:acct-a', requestedLeaseId: 'race_c', ttlMs: 60_000 }),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = attempts.find((r): r is PromiseFulfilledResult<{ fence: Fence; expiresAt: number }> => r.status === 'fulfilled')!.value;
    const row = await getDb().selectFrom('shadow_lease').selectAll().where('account_id', '=', 'acct-a').where('scope_id', '=', 'account:acct-a').executeTakeFirstOrThrow();
    expect(row.lease_id).toBe(winner.fence.leaseId);

    await getDb().updateTable('shadow_lease').set({ expires_at: new Date(Date.now() - 1) }).where('account_id', '=', 'acct-a').where('scope_id', '=', 'account:acct-a').execute();
    const takeover = await Promise.allSettled([
      acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'takeover_a', ttlMs: 60_000 }),
      acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-c', scopeId: 'account:acct-a', requestedLeaseId: 'takeover_c', ttlMs: 60_000 }),
    ]);
    expect(takeover.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const takeoverWinner = takeover.find((r): r is PromiseFulfilledResult<{ fence: Fence; expiresAt: number }> => r.status === 'fulfilled')!.value;
    expect(takeoverWinner.fence.epoch).toBe(2);
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: winner.fence.hostDeviceId, events: [event(winner.fence, 1)] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('requires exact same-host renewal proof and treats same-host expiry as takeover', async () => {
    const first = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await expect(acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', currentFence: { ...first.fence, epoch: 99 }, ttlMs: 60_000 })).rejects.toMatchObject({ statusCode: 409 });
    const renewed = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', currentFence: first.fence, ttlMs: 60_000 });
    expect(renewed.fence).toEqual(first.fence);

    await getDb().updateTable('shadow_lease').set({ expires_at: new Date(Date.now() - 1) }).where('account_id', '=', 'acct-a').where('scope_id', '=', 'account:acct-a').execute();
    await expect(acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', currentFence: first.fence, ttlMs: 60_000 })).rejects.toMatchObject({ statusCode: 409 });
    const takeover = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', ttlMs: 60_000 });
    expect(takeover.fence.epoch).toBe(first.fence.epoch + 1);
    expect(takeover.fence.leaseId).not.toBe(first.fence.leaseId);
    await expect(uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(first.fence, 1)] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows exactly one expired lease race winner across same and other host', async () => {
    await upsertDevice({ id: 'host-c', userId: 'acct-a', role: 'host', name: 'Mac C', platform: 'macos' });
    await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_old', ttlMs: 60_000 });
    await getDb().updateTable('shadow_lease').set({ expires_at: new Date(Date.now() - 1) }).where('account_id', '=', 'acct-a').where('scope_id', '=', 'account:acct-a').execute();
    const attempts = await Promise.allSettled([
      acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_new_a', ttlMs: 60_000 }),
      acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-c', scopeId: 'account:acct-a', requestedLeaseId: 'lease_new_c', ttlMs: 60_000 }),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const row = await getDb().selectFrom('shadow_lease').selectAll().where('account_id', '=', 'acct-a').where('scope_id', '=', 'account:acct-a').executeTakeFirstOrThrow();
    expect(row.epoch).toBe(2);
    expect(row.lease_id).not.toBe('lease_old');
  });

  it('requires exact controller identity and current fence for transport updates', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    await expect(updateShadowTransport({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, transport: 'relay', state: 'connected' })).resolves.toEqual({ ok: true });
    await expect(updateShadowTransport({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence: { ...fence, leaseId: 'lease_old' }, transport: 'relay', state: 'connected' })).rejects.toMatchObject({ statusCode: 409 });
    await revokeShadowController({ accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', keyRotationEffectiveSeq: 0 });
    await expect(updateShadowTransport({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, transport: 'relay', state: 'connected' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects malformed base64 and ciphertext digest mismatches before blob insert', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const bytes = Buffer.from('binary');
    await expect(putShadowBlob({ accountId: 'acct-a', hostDeviceId: 'host-a', fence, contentId: 'bad_base64', variant: 'screen', ciphertext: 'YmluYXI', byteLength: bytes.length, plaintextDigest: digest('p'), ciphertextDigest: sha256(bytes), keyId: 'key_scope_1' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(putShadowBlob({ accountId: 'acct-a', hostDeviceId: 'host-a', fence, contentId: 'bad_digest', variant: 'screen', ciphertext: b64(bytes), byteLength: bytes.length, plaintextDigest: digest('p'), ciphertextDigest: digest('wrong'), keyId: 'key_scope_1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('proves migration up is non-destructive and idempotent over sentinel relay data', async () => {
    for (const table of [...SHADOW_TABLES].reverse()) {
      await getDb().schema.dropTable(table.name).ifExists().execute();
    }

    await withCapturedMigrationDb(async (db, capturedSql) => {
      await shadowRelayMigration.up(db);
      assertMigrationExecutedOnlySchemaSafeSql(capturedSql);
    });
    await seedAllShadowRelayTables();
    const before = await readCanonicalShadowRows();
    for (const table of SHADOW_TABLES) {
      expect(before.rowCounts[table.name]).toBe(1);
    }

    await withCapturedMigrationDb(async (db, capturedSql) => {
      await shadowRelayMigration.up(db);
      assertMigrationExecutedOnlySchemaSafeSql(capturedSql);
    });
    const after = await readCanonicalShadowRows();
    expect(after.rowCounts).toEqual(before.rowCounts);
    expect(after.pkSets).toEqual(before.pkSets);
    expect(after.tableHashes).toEqual(before.tableHashes);
    expect(after.combinedHash).toBe(before.combinedHash);
    expect(after.tables).toEqual(before.tables);
  });

  it('serves blob ranges over HTTP only with the registered capability', async () => {
    await migrateAuth();
    const app = buildAccountServer();
    await app.ready();
    try {
      const signed = await auth.api.signUpEmail({ body: { email: `shadow${Date.now()}@x.dev`, password: 'pw-12345678', name: 'Shadow' } });
      const token = signed.token as string;
      const accountId = signed.user.id;
      await upsertDevice({ id: 'http-host', userId: accountId, role: 'host', name: 'Mac HTTP', platform: 'macos' });
      await upsertDevice({ id: 'http-ctrl', userId: accountId, role: 'remote', name: 'Phone HTTP', platform: 'ios' });
      // Register the host identity + a controller signing key so the enrolled
      // data routes accept real signed request proofs (Phase 3A1).
      const hostId = await generateShadowIdentity(nodeShadowCrypto, 'http-host');
      await registerHostIdentity({ accountId, hostDeviceId: 'http-host', signingPublicKey: base64urlEncode(hostId.signingPublicKey), agreementPublicKey: base64urlEncode(hostId.agreementPublicKey), registrationSignature: await signHostRegistration(nodeShadowCrypto, hostId.keys.signing.privateKey, accountId, 'http-host', hostId.signingPublicKey, hostId.agreementPublicKey), nowMs: Date.now() });
      const ctrlId = await generateShadowIdentity(nodeShadowCrypto, 'http-ctrl');
      await getDb().insertInto('shadow_registered_key').values({ account_id: accountId, key_id: ctrlId.signingKeyId, device_id: 'http-ctrl', role: 'controller', purpose: 'sign', public_key: base64urlEncode(ctrlId.signingPublicKey), status: 'active', created_at: new Date(), revoked_at: null }).execute();

      const leaseBody = JSON.stringify({ scopeId: `account:${accountId}`, leaseId: 'lease_http', ttlMs: 60_000 });
      const leaseRes = await app.inject({ method: 'POST', url: '/api/shadow/lease', headers: { authorization: `Bearer ${token}`, ...(await signedShadowHeaders(hostId, accountId, 'POST', '/api/shadow/lease', leaseBody)) }, payload: leaseBody });
      const fence = (leaseRes.json() as { fence: Fence }).fence;
      const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
      const cap = capability(fence, { controllerDeviceId: 'http-ctrl', contentId: 'http_cid', capabilityId: 'cap_http' });
      const putBody = JSON.stringify({ fence, contentId: 'http_cid', variant: 'screen', ciphertext: b64(bytes), byteLength: bytes.length, plaintextDigest: digest('h'), ciphertextDigest: sha256(bytes), keyId: 'key_scope_1', capabilities: [cap] });
      const putRes = await app.inject({ method: 'POST', url: '/api/shadow/blobs', headers: { authorization: `Bearer ${token}`, ...(await signedShadowHeaders(hostId, accountId, 'POST', '/api/shadow/blobs', putBody)) }, payload: putBody });
      expect(putRes.statusCode).toBe(200);
      const goodUrl = `/api/shadow/blobs/http_cid/screen?start=1&endExclusive=5&capability=${encodeURIComponent(JSON.stringify(cap))}`;
      const good = await app.inject({ method: 'GET', url: goodUrl, headers: { authorization: `Bearer ${token}`, ...(await signedShadowHeaders(ctrlId, accountId, 'GET', goodUrl, '')) } });
      expect(good.statusCode).toBe(200);
      expect(Buffer.from(good.json().ciphertext, 'base64')).toEqual(bytes.subarray(1, 5));
      const badUrl = `/api/shadow/blobs/http_cid/screen?capability=${encodeURIComponent(JSON.stringify({ ...cap, capabilityId: 'cap_fake' }))}`;
      const bad = await app.inject({ method: 'GET', url: badUrl, headers: { authorization: `Bearer ${token}`, ...(await signedShadowHeaders(ctrlId, accountId, 'GET', badUrl, '')) } });
      expect(bad.statusCode).toBe(403);
      // Missing the signed proof entirely → 401 (raw device id is not sufficient).
      const noProof = await app.inject({ method: 'GET', url: goodUrl, headers: { authorization: `Bearer ${token}`, 'x-maestro-device-id': 'http-ctrl' } });
      expect(noProof.statusCode).toBe(401);
      const cases = [
        ['/api/shadow/blobs/http_cid/screen', 400],
        ['/api/shadow/blobs/http_cid/screen?capability=%7Bbad', 400],
        [`/api/shadow/blobs/http_cid/screen?capability=${encodeURIComponent(JSON.stringify('scalar'))}`, 400],
        [`/api/shadow/blobs/http_cid/screen?capability=${encodeURIComponent(JSON.stringify([cap]))}`, 400],
        [`/api/shadow/blobs/http_cid/screen?capability=${encodeURIComponent(JSON.stringify(null))}`, 400],
        [`/api/shadow/blobs/http_cid/screen?capability=${encodeURIComponent(JSON.stringify({ ...cap, capabilityId: 'cap_missing' }))}`, 403],
        [`/api/shadow/blobs/http_cid/screen?capability=${encodeURIComponent('{"x":"' + 'a'.repeat(17 * 1024) + '"}')}`, 413],
        ['/api/shadow/blobs/http_cid/screen?capability=%E0%A4%A', 400],
      ] as const;
      for (const [url, expected] of cases) {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...(await signedShadowHeaders(ctrlId, accountId, 'GET', url, '')) } });
        expect(res.statusCode).toBe(expected);
        expect(res.body).not.toMatch(/cipher|stack|SyntaxError|JSON\.parse/i);
      }
    } finally {
      await app.close();
    }
  });

  it('isolates tenant composite ids and preserves accepted event operations', async () => {
    await upsertDevice({ id: 'ctrl-b', userId: 'acct-b', role: 'remote', name: 'Phone B', platform: 'ios' });
    const a = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const b = await acquireShadowLease({ accountId: 'acct-b', hostDeviceId: 'host-b', scopeId: 'account:acct-b', requestedLeaseId: 'lease_b', ttlMs: 60_000 });
    const aBytes = Buffer.from('abcdefghijklmnop');
    const bBytes = Buffer.from('qrstuvwxyz123456');
    const aCap = capability(a.fence, { contentId: 'same_cid', capabilityId: 'cap_same_a' });
    await putShadowBlob({ accountId: 'acct-a', hostDeviceId: 'host-a', fence: a.fence, contentId: 'same_cid', variant: 'screen', ciphertext: b64(aBytes), byteLength: aBytes.length, plaintextDigest: digest('p'), ciphertextDigest: sha256(aBytes), keyId: 'key_scope_1', capabilities: [aCap] });
    await putShadowBlob({ accountId: 'acct-b', hostDeviceId: 'host-b', fence: b.fence, contentId: 'same_cid', variant: 'screen', ciphertext: b64(bBytes), byteLength: bBytes.length, plaintextDigest: digest('r'), ciphertextDigest: sha256(bBytes), keyId: 'key_scope_2', capabilities: [capability(b.fence, { controllerDeviceId: 'ctrl-b', contentId: 'same_cid', capabilityId: 'cap_same_b' })] });
    await expect(putShadowBlob({ accountId: 'acct-a', hostDeviceId: 'host-a', fence: a.fence, contentId: 'same_cid', variant: 'screen', ciphertext: b64(aBytes), byteLength: aBytes.length, plaintextDigest: digest('x'), ciphertextDigest: sha256(aBytes), keyId: 'key_scope_1' })).rejects.toMatchObject({ statusCode: 409 });

    await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: [event(a.fence, 1, { op: 'delete' })] });
    const replayed = await readShadowBlobRange({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', capability: aCap, contentId: 'same_cid', variant: 'screen', start: 0, endExclusive: 4 });
    expect(Buffer.from(replayed.ciphertext, 'base64').toString('utf8')).toBe('abcd');
    const events = await connectShadowController({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', hello: { protocolVersion: 1, accountId: 'acct-a', scopeId: 'account:acct-a', controllerDeviceId: 'ctrl-a', hostDeviceId: 'host-a', epoch: 1, lastSeq: 0, collectionDigests: {} } });
    expect(events.events?.[0]).toMatchObject({ op: 'delete' });
  });

  it('prunes old events only behind snapshot and cursor repair floors', async () => {
    const { fence } = await acquireShadowLease({ accountId: 'acct-a', hostDeviceId: 'host-a', scopeId: 'account:acct-a', requestedLeaseId: 'lease_a', ttlMs: 60_000 });
    const batch = Array.from({ length: 120 }, (_, index) => event(fence, index + 1));
    await uploadShadowEvents({ accountId: 'acct-a', hostDeviceId: 'host-a', events: batch });
    await getDb().updateTable('shadow_event').set({ stored_at: new Date(now - 8 * 24 * 60 * 60_000) }).where('account_id', '=', 'acct-a').execute();

    expect((await pruneShadowRelay(now)).events).toBe(0);
    await publishShadowSnapshot({ accountId: 'acct-a', hostDeviceId: 'host-a', fence, snapshotId: 'snapshot_120', baseSeq: 120, manifestCiphertext: 'manifest_cipher', manifestDigest: digest('m'), keyId: 'key_scope_1' });
    await updateShadowCursor({ accountId: 'acct-a', controllerDeviceId: 'ctrl-a', fence, lastSeq: 110, lastEventId: 'event_110', lastDigest: digest('110') });
    expect((await pruneShadowRelay(now)).events).toBe(19);
    const remaining = await getDb().selectFrom('shadow_event').select(({ fn }) => [fn.min<number>('seq').as('min_seq'), fn.max<number>('seq').as('max_seq')]).where('account_id', '=', 'acct-a').executeTakeFirstOrThrow();
    expect(Number(remaining.min_seq)).toBe(20);
    expect(Number(remaining.max_seq)).toBe(120);
  });
});
