import { sql, type Kysely, type Transaction } from 'kysely';
import { createHash } from 'node:crypto';
import {
  SHADOW_PROTOCOL_VERSION,
  decodeShadowMessage,
  type ShadowStateEvent,
} from '@maestro/realtime/shadowProtocol';
import { assertDeviceInAccount, assertHostInAccount } from './accountDevices.js';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import { base64urlDecode } from '@maestro/realtime/shadowCrypto';
import { verifyAuthorityTransitionSignature } from '@maestro/realtime/shadowAuthorityTransition';
import { getDb, type DB, type ShadowLeaseTable } from './db.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_COMMAND_TTL_MS = 10 * 60_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_EVENT_BATCH = 500;
const RETENTION_TTL_MS = 7 * 24 * 60 * 60_000;

type DbOrTrx = Kysely<DB> | Transaction<DB>;
type ShadowStateWireEvent = ShadowStateEvent & { family: 'state-event' };

interface Fence {
  accountId: string;
  scopeId: string;
  hostDeviceId: string;
  epoch: number;
  leaseId: string;
}

interface ShadowConnectHello {
  protocolVersion: 1;
  accountId?: string;
  scopeId?: string;
  controllerDeviceId?: string;
  hostDeviceId: string;
  epoch: number;
  lastSeq: number;
  snapshotId?: string;
  collectionDigests: Record<string, string>;
  supportedTransports?: string[];
}

interface BlobCapability {
  family?: 'asset-capability';
  v: 1;
  capabilityId: string;
  fence: Fence;
  controllerDeviceId: string;
  assetId?: string;
  contentId: string;
  variant: string;
  permissions: Array<'read' | 'range-read' | 'pin-offline'>;
  expiresAt: number;
  signature: string;
}

type ReconnectDecision =
  | { decision: 'delta'; fromSeq: number; toSeq: number }
  | { decision: 'manifest-repair'; snapshotId: string; baseSeqHint?: number; replayFromSeq: number }
  | { decision: 'fenced'; reason: 'wrong-host' | 'stale-epoch' | 'future-epoch' }
  | { decision: 'incompatible'; supportedProtocolVersions: readonly number[] };

function status(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function opaque(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4 * 1024 * 1024) throw status(`bad ${name}`, 400);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function strictBase64ToBuffer(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw status(`bad ${name} base64`, 400);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) throw status(`bad ${name} base64`, 400);
  return decoded;
}

function bufferToCanonicalBase64(value: Buffer): string {
  return Buffer.from(value).toString('base64');
}

function clampTtlMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!positiveInt(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) throw status('bad ttl', 400);
  return value;
}

function requireFence(value: unknown): Fence {
  if (!isRecord(value)) throw status('bad fence', 400);
  const fence = value as Partial<Fence>;
  if (!safeId(fence.accountId) || !safeId(fence.scopeId) || !safeId(fence.hostDeviceId) || !safeId(fence.leaseId) || !positiveInt(fence.epoch)) {
    throw status('bad fence', 400);
  }
  return {
    accountId: fence.accountId,
    scopeId: fence.scopeId,
    hostDeviceId: fence.hostDeviceId,
    leaseId: fence.leaseId,
    epoch: fence.epoch,
  };
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_=-]{8,256}$/.test(value);
}

function sameFence(a: Fence, b: Fence): boolean {
  return a.accountId === b.accountId && a.scopeId === b.scopeId && a.hostDeviceId === b.hostDeviceId && a.epoch === b.epoch && a.leaseId === b.leaseId;
}

function decodeBlobCapability(value: unknown, expected: { controllerDeviceId: string; fence: Fence; contentId: string; variant: string; now: number }): { ok: true; value: BlobCapability } | { ok: false } {
  if (!isRecord(value) || value.v !== SHADOW_PROTOCOL_VERSION) return { ok: false };
  const allowed = new Set(['family', 'v', 'capabilityId', 'fence', 'controllerDeviceId', 'assetId', 'contentId', 'variant', 'permissions', 'expiresAt', 'signature']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false };
  if (value.family !== undefined && value.family !== 'asset-capability') return { ok: false };
  const fence = requireFence(value.fence);
  if (!sameFence(fence, expected.fence)) return { ok: false };
  if (!safeId(value.capabilityId) || !safeId(value.controllerDeviceId) || !safeId(value.contentId) || !safeId(value.variant) || !safeId(value.signature)) return { ok: false };
  if (value.controllerDeviceId !== expected.controllerDeviceId || value.contentId !== expected.contentId || value.variant !== expected.variant) return { ok: false };
  if (!Array.isArray(value.permissions) || value.permissions.some((p) => p !== 'read' && p !== 'range-read' && p !== 'pin-offline')) return { ok: false };
  if (!nonNegativeInt(value.expiresAt) || expected.now >= value.expiresAt) return { ok: false };
  return { ok: true, value: { ...value, fence } as BlobCapability };
}

function decodeShadowConnectHello(value: unknown): ShadowConnectHello {
  if (!isRecord(value)) throw status('invalid connect hello', 400);
  if (value.protocolVersion !== SHADOW_PROTOCOL_VERSION) throw status('unsupported protocol version', 400);
  if (!safeId(value.hostDeviceId) || !positiveInt(value.epoch) || !nonNegativeInt(value.lastSeq) || !isRecord(value.collectionDigests)) throw status('bad connect hello', 400);
  if (value.accountId !== undefined && !safeId(value.accountId)) throw status('bad account hello', 400);
  if (value.scopeId !== undefined && !safeId(value.scopeId)) throw status('bad scope hello', 400);
  if (value.controllerDeviceId !== undefined && !safeId(value.controllerDeviceId)) throw status('bad controller hello', 400);
  if (value.snapshotId !== undefined && !safeId(value.snapshotId)) throw status('bad snapshot hello', 400);
  if (value.supportedTransports !== undefined && (!Array.isArray(value.supportedTransports) || value.supportedTransports.some((t) => !['relay', 'lan', 'webrtc-data'].includes(String(t))))) {
    throw status('bad transports hello', 400);
  }
  return {
    protocolVersion: SHADOW_PROTOCOL_VERSION,
    accountId: value.accountId as string | undefined,
    scopeId: value.scopeId as string | undefined,
    controllerDeviceId: value.controllerDeviceId as string | undefined,
    hostDeviceId: value.hostDeviceId,
    epoch: value.epoch,
    lastSeq: value.lastSeq,
    snapshotId: value.snapshotId as string | undefined,
    collectionDigests: value.collectionDigests as Record<string, string>,
    supportedTransports: value.supportedTransports as string[] | undefined,
  };
}

function coerceStateEvent(value: unknown): ShadowStateWireEvent {
  const decoded = decodeShadowMessage(value);
  if (!decoded.ok || decoded.value.family !== 'state-event') throw status('invalid state event', 400);
  return decoded.value;
}

function reconstructStateEvent(row: DB['shadow_event']): ShadowStateWireEvent {
  const event = {
    family: 'state-event' as const,
    v: SHADOW_PROTOCOL_VERSION,
    eventId: row.event_id,
    seq: row.seq,
    prevSeq: row.prev_seq,
    fence: { accountId: row.account_id, scopeId: row.scope_id, hostDeviceId: row.host_device_id, epoch: row.epoch, leaseId: row.lease_id },
    collection: row.collection,
    op: row.op,
    entityId: row.entity_id,
    revision: row.revision,
    ...(row.command_id === null ? {} : { commandId: row.command_id }),
    durable: true as const,
    payloadCiphertext: row.payload_ciphertext,
    payloadDigest: row.payload_digest,
    keyId: row.key_id,
    createdAt: Number(row.created_at_ms),
    signature: row.signature,
  };
  const decoded = decodeShadowMessage(event);
  if (!decoded.ok || decoded.value.family !== 'state-event') throw status('corrupt stored state event', 500);
  return decoded.value;
}

function decideReconnect(input: {
  hello: ShadowConnectHello;
  retainedMinSeq: number;
  headSeq: number;
  latestSnapshotId: string;
  hostDeviceId: string;
  epoch: number;
  latestSnapshotBaseSeq?: number;
}): ReconnectDecision {
  if (input.hello.protocolVersion !== SHADOW_PROTOCOL_VERSION) return { decision: 'incompatible', supportedProtocolVersions: [SHADOW_PROTOCOL_VERSION] };
  if (input.hello.hostDeviceId !== input.hostDeviceId) return { decision: 'fenced', reason: 'wrong-host' };
  if (input.hello.epoch < input.epoch) return { decision: 'fenced', reason: 'stale-epoch' };
  if (input.hello.epoch > input.epoch) return { decision: 'fenced', reason: 'future-epoch' };
  if (input.hello.lastSeq >= input.retainedMinSeq - 1) return { decision: 'delta', fromSeq: input.hello.lastSeq, toSeq: input.headSeq };
  return { decision: 'manifest-repair', snapshotId: input.latestSnapshotId, baseSeqHint: input.latestSnapshotBaseSeq, replayFromSeq: input.latestSnapshotBaseSeq ?? 0 };
}

function assertValidRange(input: { contentId: string; totalBytes: number; start: number; endExclusive: number }): void {
  if (!safeId(input.contentId) || !positiveInt(input.totalBytes) || !nonNegativeInt(input.start) || !positiveInt(input.endExclusive) || input.start >= input.endExclusive || input.endExclusive > input.totalBytes) {
    throw status('bad range', 416);
  }
}

function fenceFromLease(lease: ShadowLeaseTable): Fence {
  return {
    accountId: lease.account_id,
    scopeId: lease.scope_id,
    hostDeviceId: lease.host_device_id,
    epoch: lease.epoch,
    leaseId: lease.lease_id,
  };
}

async function activeLease(db: DbOrTrx, accountId: string, scopeId: string): Promise<ShadowLeaseTable> {
  const lease = await db.selectFrom('shadow_lease').selectAll().where('account_id', '=', accountId).where('scope_id', '=', scopeId).executeTakeFirst();
  if (!lease) throw status('host lease not found', 404);
  if (lease.expires_at.getTime() <= Date.now()) throw status('host lease expired', 409);
  return lease;
}

async function assertScopeAuthorized(db: DbOrTrx, input: { accountId: string; scopeId: string; deviceId: string; role: 'host' | 'controller' }): Promise<void> {
  if (!safeId(input.scopeId)) throw status('bad scope', 400);
  if (input.scopeId !== `account:${input.accountId}`) throw status('scope is not account-owned', 403);
  const row = await db
    .selectFrom('device')
    .selectAll()
    .where('user_id', '=', input.accountId)
    .where('id', '=', input.deviceId)
    .executeTakeFirst();
  if (!row) throw status('device not found', 404);
  if (input.role === 'host' && row.role !== 'host') throw status('host not found', 404);
  if (input.role === 'controller' && row.role !== 'remote') throw status('controller not enrolled', 403);
}

async function assertControllerAllowed(db: DbOrTrx, accountId: string, scopeId: string, controllerDeviceId: string): Promise<void> {
  await assertScopeAuthorized(db, { accountId, scopeId, deviceId: controllerDeviceId, role: 'controller' });
  const revoked = await db
    .selectFrom('shadow_revoked_controller')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('scope_id', '=', scopeId)
    .where('controller_device_id', '=', controllerDeviceId)
    .executeTakeFirst();
  if (revoked) throw status('controller revoked', 403);
}

async function assertFence(db: DbOrTrx, accountId: string, fence: Fence, controllerDeviceId?: string): Promise<ShadowLeaseTable> {
  if (fence.accountId !== accountId) throw status('wrong account fence', 403);
  await assertScopeAuthorized(db, { accountId, scopeId: fence.scopeId, deviceId: controllerDeviceId ?? fence.hostDeviceId, role: controllerDeviceId ? 'controller' : 'host' });
  const lease = await activeLease(db, accountId, fence.scopeId);
  const revoked = controllerDeviceId
    ? await db
      .selectFrom('shadow_revoked_controller')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('scope_id', '=', fence.scopeId)
      .where('controller_device_id', '=', controllerDeviceId)
      .execute()
    : [];
  const expected = fenceFromLease(lease);
  if (fence.scopeId !== expected.scopeId || fence.hostDeviceId !== expected.hostDeviceId || fence.leaseId !== expected.leaseId) throw status('invalid fence', 409);
  if (fence.epoch !== expected.epoch) throw status('invalid fence epoch', 409);
  if (lease.expires_at.getTime() <= Date.now()) throw status('host lease expired', 409);
  if (controllerDeviceId && revoked.some((r) => r.controller_device_id === controllerDeviceId)) throw status('controller revoked', 403);
  return lease;
}

export async function acquireShadowLease(input: {
  accountId: string;
  hostDeviceId: string;
  scopeId?: string;
  requestedLeaseId?: string;
  currentFence?: unknown;
  ttlMs?: number;
}): Promise<{ fence: Fence; expiresAt: number }> {
  const scopeId = input.scopeId ?? `account:${input.accountId}`;
  const ttlMs = clampTtlMs(input.ttlMs, DEFAULT_LEASE_TTL_MS);
  return getDb().transaction().execute(async (trx) => {
    await assertScopeAuthorized(trx, { accountId: input.accountId, scopeId, deviceId: input.hostDeviceId, role: 'host' });
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${input.accountId}:${scopeId}`}, 0))`.execute(trx);
    const now = new Date();
    const existing = await trx
      .selectFrom('shadow_lease')
      .selectAll()
      .where('account_id', '=', input.accountId)
      .where('scope_id', '=', scopeId)
      .forUpdate()
      .executeTakeFirst();
    const unexpired = !!existing && existing.expires_at.getTime() > now.getTime();
    if (unexpired && existing.host_device_id !== input.hostDeviceId) throw status('scope already leased by another host', 409);
    if (unexpired && existing.host_device_id === input.hostDeviceId) {
      const proof = requireFence(input.currentFence);
      const current = fenceFromLease(existing);
      if (proof.accountId !== current.accountId || proof.scopeId !== current.scopeId || proof.hostDeviceId !== current.hostDeviceId || proof.epoch !== current.epoch || proof.leaseId !== current.leaseId) throw status('same host renewal requires current fence proof', 409);
      if (input.requestedLeaseId && input.requestedLeaseId !== existing.lease_id) throw status('same host renewal must use current lease', 409);
    }
    const expired = !!existing && existing.expires_at.getTime() <= now.getTime();
    if (expired && input.requestedLeaseId === existing.lease_id) throw status('expired lease id cannot be reused', 409);
    const epoch = unexpired && existing?.host_device_id === input.hostDeviceId ? existing.epoch : (existing?.epoch ?? 0) + 1;
    const leaseId = input.requestedLeaseId && safeId(input.requestedLeaseId)
      ? input.requestedLeaseId
      : `lease-${input.hostDeviceId}-${epoch}-${now.getTime()}`;
    // Same-host renewal is EXTEND-ONLY — it must never SHORTEN an already-longer lease
    // (e.g. one just extended by an atomic renew-and-store-transitions commit), which
    // would otherwise create a split between the lease and a committed renewal receipt.
    const sameHostRenewal = unexpired && existing?.host_device_id === input.hostDeviceId;
    const expiresAt = sameHostRenewal && existing ? new Date(Math.max(now.getTime() + ttlMs, existing.expires_at.getTime())) : new Date(now.getTime() + ttlMs);
    if (existing) {
      await trx
        .updateTable('shadow_lease')
        .set({ host_device_id: input.hostDeviceId, epoch, lease_id: leaseId, expires_at: expiresAt, updated_at: now })
        .where('account_id', '=', input.accountId)
        .where('scope_id', '=', scopeId)
        .execute();
    } else {
      await trx
        .insertInto('shadow_lease')
        .values({ account_id: input.accountId, scope_id: scopeId, host_device_id: input.hostDeviceId, epoch, lease_id: leaseId, expires_at: expiresAt, created_at: now, updated_at: now })
        .execute();
    }
    return { fence: { accountId: input.accountId, scopeId, hostDeviceId: input.hostDeviceId, epoch, leaseId }, expiresAt: expiresAt.getTime() };
  });
}

export async function revokeShadowController(input: {
  accountId: string;
  scopeId: string;
  controllerDeviceId: string;
  keyRotationEffectiveSeq: number;
}): Promise<{ ok: true }> {
  if (!safeId(input.scopeId) || !nonNegativeInt(input.keyRotationEffectiveSeq)) throw status('bad revocation', 400);
  await assertControllerAllowed(getDb(), input.accountId, input.scopeId, input.controllerDeviceId);
  await getDb()
    .insertInto('shadow_revoked_controller')
    .values({
      account_id: input.accountId,
      scope_id: input.scopeId,
      controller_device_id: input.controllerDeviceId,
      revoked_at: new Date(),
      key_rotation_effective_seq: input.keyRotationEffectiveSeq,
    })
    .onConflict((oc) => oc.columns(['account_id', 'scope_id', 'controller_device_id']).doUpdateSet({
      revoked_at: new Date(),
      key_rotation_effective_seq: input.keyRotationEffectiveSeq,
    }))
    .execute();
  return { ok: true };
}

export async function uploadShadowEvents(input: { accountId: string; hostDeviceId: string; events: unknown[] }): Promise<{ accepted: number; headSeq: number }> {
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > MAX_EVENT_BATCH) throw status('bad event batch', 400);
  const events = input.events.map(coerceStateEvent);
  return getDb().transaction().execute(async (trx) => {
    let headSeq = 0;
    let accepted = 0;
    for (const event of events) {
      if (event.fence.accountId !== input.accountId || event.fence.hostDeviceId !== input.hostDeviceId) throw status('wrong event fence', 403);
      await assertFence(trx, input.accountId, event.fence);
      const byId = await trx.selectFrom('shadow_event').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', event.fence.scopeId).where('epoch', '=', event.fence.epoch).where('event_id', '=', event.eventId).executeTakeFirst();
      const canonical = canonicalDigest(event);
      if (byId) {
        if (byId.canonical_digest !== null && byId.canonical_digest === canonical) {
          headSeq = Math.max(headSeq, byId.seq);
          continue;
        }
        throw status('conflicting duplicate event', 409);
      }
      const prior = event.seq === 1
        ? null
        : await trx
          .selectFrom('shadow_event')
          .selectAll()
          .where('account_id', '=', input.accountId)
          .where('scope_id', '=', event.fence.scopeId)
          .where('epoch', '=', event.fence.epoch)
          .where('seq', '=', event.seq - 1)
          .executeTakeFirst();
      if (event.seq === 1) {
        if (event.prevSeq !== 0) throw status('event gap', 409);
      } else if (!prior || prior.seq !== event.prevSeq) {
        throw status('event gap', 409);
      }
      await trx
        .insertInto('shadow_event')
        .values({
          account_id: input.accountId,
          scope_id: event.fence.scopeId,
          host_device_id: input.hostDeviceId,
          epoch: event.fence.epoch,
          lease_id: event.fence.leaseId,
          seq: event.seq,
          prev_seq: event.prevSeq,
          event_id: event.eventId,
          collection: event.collection,
          op: event.op,
          entity_id: event.entityId,
          revision: event.revision,
          command_id: event.commandId ?? null,
          payload_ciphertext: event.payloadCiphertext,
          payload_digest: event.payloadDigest,
          key_id: event.keyId,
          signature: event.signature,
          canonical_digest: canonical,
          created_at_ms: event.createdAt,
          stored_at: new Date(),
        })
        .execute();
      accepted += 1;
      headSeq = event.seq;
    }
    return { accepted, headSeq };
  });
}

export async function connectShadowController(input: {
  accountId: string;
  controllerDeviceId: string;
  hello: unknown;
}): Promise<{ decision: ReconnectDecision; events?: unknown[]; latestSnapshot?: unknown }> {
  const hello = decodeShadowConnectHello(input.hello);
  if (!hello.controllerDeviceId || hello.controllerDeviceId !== input.controllerDeviceId) throw status('controller hello mismatch', 403);
  if (hello.accountId && hello.accountId !== input.accountId) throw status('wrong account hello', 403);
  const scopeId = hello.scopeId ?? `account:${input.accountId}`;
  await assertControllerAllowed(getDb(), input.accountId, scopeId, input.controllerDeviceId);
  await assertHostInAccount(input.accountId, hello.hostDeviceId);
  const lease = await activeLease(getDb(), input.accountId, scopeId);
  const head = await getDb()
    .selectFrom('shadow_event')
    .select(({ fn }) => [fn.max<number>('seq').as('head_seq'), fn.min<number>('seq').as('min_seq')])
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', scopeId)
    .where('epoch', '=', lease.epoch)
    .executeTakeFirst();
  const latestSnapshot = await getDb()
    .selectFrom('shadow_snapshot')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', scopeId)
    .where('epoch', '=', lease.epoch)
    .orderBy('base_seq', 'desc')
    .executeTakeFirst();
  const headSeq = Number(head?.head_seq ?? 0);
  const retainedMinSeq = Number(head?.min_seq ?? 1);
  const decision = decideReconnect({
    hello,
    retainedMinSeq,
    headSeq,
    latestSnapshotId: latestSnapshot?.snapshot_id ?? 'none',
    latestSnapshotBaseSeq: latestSnapshot?.base_seq,
    hostDeviceId: lease.host_device_id,
    epoch: lease.epoch,
  });
  const events = decision.decision === 'delta'
    ? await readShadowEvents({ accountId: input.accountId, controllerDeviceId: input.controllerDeviceId, scopeId, hostDeviceId: lease.host_device_id, epoch: lease.epoch, afterSeq: decision.fromSeq })
    : undefined;
  return { decision, events, latestSnapshot: latestSnapshot ? { snapshotId: latestSnapshot.snapshot_id, baseSeq: latestSnapshot.base_seq, manifestCiphertext: latestSnapshot.manifest_ciphertext, manifestDigest: latestSnapshot.manifest_digest, keyId: latestSnapshot.key_id } : undefined };
}

export async function readShadowEvents(input: { accountId: string; controllerDeviceId: string; scopeId: string; hostDeviceId: string; epoch: number; afterSeq: number; limit?: number }): Promise<unknown[]> {
  await assertControllerAllowed(getDb(), input.accountId, input.scopeId, input.controllerDeviceId);
  const lease = await activeLease(getDb(), input.accountId, input.scopeId);
  if (lease.host_device_id !== input.hostDeviceId || lease.epoch !== input.epoch) throw status('invalid fence', 409);
  const rows = await getDb()
    .selectFrom('shadow_event')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', input.scopeId)
    .where('host_device_id', '=', input.hostDeviceId)
    .where('epoch', '=', input.epoch)
    .where('seq', '>', input.afterSeq)
    .orderBy('seq', 'asc')
    .limit(Math.min(input.limit ?? MAX_EVENT_BATCH, MAX_EVENT_BATCH))
    .execute();
  return rows.map(reconstructStateEvent);
}

export async function updateShadowCursor(input: {
  accountId: string;
  controllerDeviceId: string;
  fence: unknown;
  lastSeq: number;
  lastEventId?: string;
  lastDigest?: string;
}): Promise<{ ok: true }> {
  const fence = requireFence(input.fence);
  if (!nonNegativeInt(input.lastSeq)) throw status('bad cursor', 400);
  await getDb().transaction().execute(async (trx) => {
    await assertFence(trx, input.accountId, fence, input.controllerDeviceId);
    const existing = await trx
      .selectFrom('shadow_cursor')
      .selectAll()
      .where('account_id', '=', input.accountId)
      .where('scope_id', '=', fence.scopeId)
      .where('controller_device_id', '=', input.controllerDeviceId)
      .forUpdate()
      .executeTakeFirst();
    if (existing) {
      if (existing.epoch > fence.epoch || (existing.epoch === fence.epoch && existing.lease_id !== fence.leaseId)) throw status('stale cursor fence', 409);
      if (existing.epoch === fence.epoch && existing.lease_id === fence.leaseId && input.lastSeq < existing.last_seq) throw status('cursor cannot move backwards', 409);
    }
    const event = input.lastSeq === 0 ? null : await trx
      .selectFrom('shadow_event')
      .selectAll()
      .where('account_id', '=', input.accountId)
      .where('scope_id', '=', fence.scopeId)
      .where('epoch', '=', fence.epoch)
      .where('seq', '=', input.lastSeq)
      .executeTakeFirst();
    if (input.lastSeq > 0 && (!event || event.event_id !== input.lastEventId || event.payload_digest !== input.lastDigest)) throw status('cursor proof mismatch', 409);
    await trx
      .insertInto('shadow_cursor')
      .values({ account_id: input.accountId, scope_id: fence.scopeId, controller_device_id: input.controllerDeviceId, host_device_id: fence.hostDeviceId, epoch: fence.epoch, lease_id: fence.leaseId, last_seq: input.lastSeq, last_event_id: input.lastEventId ?? null, last_digest: input.lastDigest ?? null, updated_at: new Date() })
      .onConflict((oc) => oc.columns(['account_id', 'scope_id', 'controller_device_id']).doUpdateSet({ host_device_id: fence.hostDeviceId, epoch: fence.epoch, lease_id: fence.leaseId, last_seq: input.lastSeq, last_event_id: input.lastEventId ?? null, last_digest: input.lastDigest ?? null, updated_at: new Date() }))
      .execute();
  });
  return { ok: true };
}

export async function publishShadowSnapshot(input: {
  accountId: string;
  hostDeviceId: string;
  fence: unknown;
  snapshotId: string;
  baseSeq: number;
  manifestCiphertext: string;
  manifestDigest: string;
  keyId: string;
  expiresAt?: number;
}): Promise<{ ok: true }> {
  const fence = requireFence(input.fence);
  await assertFence(getDb(), input.accountId, fence);
  if (input.hostDeviceId !== fence.hostDeviceId) throw status('wrong host', 403);
  if (!safeId(input.snapshotId) || !nonNegativeInt(input.baseSeq) || !safeId(input.keyId)) throw status('bad snapshot', 400);
  const values = { account_id: input.accountId, scope_id: fence.scopeId, host_device_id: input.hostDeviceId, epoch: fence.epoch, lease_id: fence.leaseId, snapshot_id: input.snapshotId, base_seq: input.baseSeq, manifest_ciphertext: opaque(input.manifestCiphertext, 'manifest'), manifest_digest: opaque(input.manifestDigest, 'manifest digest'), key_id: input.keyId, published_at: new Date(), expires_at: input.expiresAt ? new Date(input.expiresAt) : null };
  const existing = await getDb().selectFrom('shadow_snapshot').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', fence.scopeId).where('snapshot_id', '=', input.snapshotId).executeTakeFirst();
  if (existing) {
    if (existing.host_device_id !== values.host_device_id || existing.epoch !== values.epoch || existing.lease_id !== values.lease_id || existing.base_seq !== values.base_seq || existing.manifest_digest !== values.manifest_digest || existing.key_id !== values.key_id) throw status('conflicting snapshot', 409);
    return { ok: true };
  }
  await getDb().insertInto('shadow_snapshot').values(values).execute();
  return { ok: true };
}

export async function putShadowChunk(input: {
  accountId: string;
  hostDeviceId: string;
  fence: unknown;
  contentId: string;
  ciphertext: string;
  byteLength: number;
  plaintextDigest: string;
  ciphertextDigest: string;
  keyId: string;
  snapshotId?: string;
  collection?: string;
  pageKey?: string;
  expiresAt?: number;
}): Promise<{ ok: true }> {
  const fence = requireFence(input.fence);
  await assertFence(getDb(), input.accountId, fence);
  if (input.hostDeviceId !== fence.hostDeviceId) throw status('wrong host', 403);
  if (!safeId(input.contentId) || !positiveInt(input.byteLength) || !safeId(input.keyId)) throw status('bad chunk', 400);
  const ciphertext = strictBase64ToBuffer(input.ciphertext, 'chunk');
  if (ciphertext.length !== input.byteLength) throw status('bad chunk byte length', 400);
  if (sha256(ciphertext) !== input.ciphertextDigest) throw status('chunk digest mismatch', 400);
  const values = { account_id: input.accountId, scope_id: fence.scopeId, host_device_id: input.hostDeviceId, epoch: fence.epoch, lease_id: fence.leaseId, content_id: input.contentId, snapshot_id: input.snapshotId ?? null, collection: input.collection ?? null, page_key: input.pageKey ?? null, byte_length: input.byteLength, ciphertext, plaintext_digest: opaque(input.plaintextDigest, 'plaintext digest'), ciphertext_digest: opaque(input.ciphertextDigest, 'ciphertext digest'), key_id: input.keyId, created_at: new Date(), expires_at: input.expiresAt ? new Date(input.expiresAt) : null };
  const existing = await getDb().selectFrom('shadow_chunk').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', fence.scopeId).where('content_id', '=', input.contentId).executeTakeFirst();
  if (existing) {
    if (existing.byte_length !== values.byte_length || existing.plaintext_digest !== values.plaintext_digest || existing.ciphertext_digest !== values.ciphertext_digest || existing.key_id !== values.key_id || existing.host_device_id !== values.host_device_id || existing.epoch !== values.epoch || existing.lease_id !== values.lease_id) throw status('conflicting chunk', 409);
    return { ok: true };
  }
  await getDb().insertInto('shadow_chunk').values(values).execute();
  return { ok: true };
}

export async function putShadowBlob(input: {
  accountId: string;
  hostDeviceId: string;
  fence: unknown;
  contentId: string;
  variant: string;
  ciphertext: string;
  byteLength: number;
  plaintextDigest: string;
  ciphertextDigest: string;
  keyId: string;
  capabilities?: unknown[];
  capabilityExpiresAt?: number;
}): Promise<{ ok: true }> {
  const fence = requireFence(input.fence);
  const lease = await assertFence(getDb(), input.accountId, fence);
  if (input.hostDeviceId !== fence.hostDeviceId || lease.host_device_id !== input.hostDeviceId) throw status('wrong host', 403);
  if (!safeId(input.contentId) || !safeId(input.variant) || !positiveInt(input.byteLength) || !safeId(input.keyId)) throw status('bad blob', 400);
  const ciphertext = strictBase64ToBuffer(input.ciphertext, 'blob');
  if (ciphertext.length !== input.byteLength) throw status('bad blob byte length', 400);
  if (sha256(ciphertext) !== input.ciphertextDigest) throw status('blob digest mismatch', 400);
  await getDb().transaction().execute(async (trx) => {
    const values = { account_id: input.accountId, scope_id: fence.scopeId, host_device_id: input.hostDeviceId, epoch: fence.epoch, lease_id: fence.leaseId, content_id: input.contentId, variant: input.variant, byte_length: input.byteLength, ciphertext, plaintext_digest: opaque(input.plaintextDigest, 'plaintext digest'), ciphertext_digest: opaque(input.ciphertextDigest, 'ciphertext digest'), key_id: input.keyId, capability_expires_at: input.capabilityExpiresAt ? new Date(input.capabilityExpiresAt) : null, created_at: new Date() };
    const existing = await trx.selectFrom('shadow_blob').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', fence.scopeId).where('content_id', '=', input.contentId).where('variant', '=', input.variant).executeTakeFirst();
    if (existing) {
      if (existing.byte_length !== values.byte_length || existing.plaintext_digest !== values.plaintext_digest || existing.ciphertext_digest !== values.ciphertext_digest || existing.key_id !== values.key_id || existing.host_device_id !== values.host_device_id || existing.epoch !== values.epoch || existing.lease_id !== values.lease_id || !Buffer.from(existing.ciphertext).equals(ciphertext)) throw status('conflicting blob', 409);
    } else {
      await trx.insertInto('shadow_blob').values(values).execute();
    }
    for (const rawCapability of input.capabilities ?? []) {
      const decoded = decodeBlobCapability(rawCapability, { controllerDeviceId: (rawCapability as BlobCapability)?.controllerDeviceId, fence, contentId: input.contentId, variant: input.variant, now: Date.now() });
      if (!decoded.ok) throw status('bad blob capability', 400);
      const capability = decoded.value;
      await assertControllerAllowed(trx, input.accountId, fence.scopeId, capability.controllerDeviceId);
      const capabilityDigest = canonicalDigest(capability);
      const capValues = {
        account_id: input.accountId,
        scope_id: fence.scopeId,
        controller_device_id: capability.controllerDeviceId,
        host_device_id: input.hostDeviceId,
        epoch: fence.epoch,
        lease_id: fence.leaseId,
        content_id: input.contentId,
        variant: input.variant,
        capability_id: capability.capabilityId,
        permissions: capability.permissions,
        expires_at: new Date(capability.expiresAt),
        revoked_at: null,
        signature: capability.signature,
        canonical_digest: capabilityDigest,
        capability_json: capability as unknown as Record<string, unknown>,
        created_at: new Date(),
      };
      await trx.insertInto('shadow_blob_capability').values(capValues).onConflict((oc) => oc.columns(['account_id', 'scope_id', 'capability_id']).doUpdateSet(capValues)).execute();
    }
  });
  return { ok: true };
}

export async function readShadowBlobRange(input: { accountId: string; controllerDeviceId: string; capability: unknown; contentId: string; variant: string; start?: number; endExclusive?: number }): Promise<{ contentId: string; variant: string; byteLength: number; ciphertext: string; rangeCiphertext: string; fullCiphertextDigest: string; rangeCiphertextDigest: string; range: { start: number; endExclusive: number; totalBytes: number } }> {
  const expectedFence = isRecord(input.capability) ? requireFence((input.capability as Record<string, unknown>).fence) : undefined;
  const decoded = expectedFence ? decodeBlobCapability(input.capability, { controllerDeviceId: input.controllerDeviceId, fence: expectedFence, contentId: input.contentId, variant: input.variant, now: Date.now() }) : { ok: false as const };
  if (!decoded.ok) throw status('bad blob capability', 403);
  const capability = decoded.value;
  const fence = capability.fence;
  await assertFence(getDb(), input.accountId, fence, input.controllerDeviceId);
  const row = await getDb()
    .selectFrom('shadow_blob')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', fence.scopeId)
    .where('epoch', '=', fence.epoch)
    .where('lease_id', '=', fence.leaseId)
    .where('content_id', '=', input.contentId)
    .where('variant', '=', input.variant)
    .executeTakeFirst();
  if (!row) throw status('blob not found', 404);
  const capabilityRow = await getDb()
    .selectFrom('shadow_blob_capability')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', fence.scopeId)
    .where('capability_id', '=', capability.capabilityId)
    .where('controller_device_id', '=', input.controllerDeviceId)
    .where('content_id', '=', input.contentId)
    .where('variant', '=', input.variant)
    .executeTakeFirst();
  const requiredPermission = input.start !== undefined || input.endExclusive !== undefined ? 'range-read' : 'read';
  if (!capabilityRow || capabilityRow.revoked_at || capabilityRow.expires_at.getTime() <= Date.now() || capabilityRow.canonical_digest !== canonicalDigest(capability) || capabilityRow.signature !== capability.signature || capabilityRow.epoch !== fence.epoch || capabilityRow.lease_id !== fence.leaseId || !capability.permissions.includes(requiredPermission)) {
    throw status('blob capability denied', 403);
  }
  if (row.capability_expires_at && row.capability_expires_at.getTime() <= Date.now()) throw status('blob expired', 410);
  const requestedRange = input.start !== undefined || input.endExclusive !== undefined
    ? { start: input.start ?? 0, endExclusive: input.endExclusive ?? row.byte_length }
    : undefined;
  const range = requestedRange ?? { start: 0, endExclusive: row.byte_length };
  assertValidRange({ contentId: input.contentId, totalBytes: row.byte_length, start: range.start, endExclusive: range.endExclusive });
  const ciphertext = Buffer.from(row.ciphertext);
  const rangeBytes = ciphertext.subarray(range.start, range.endExclusive);
  return { contentId: row.content_id, variant: row.variant, byteLength: row.byte_length, ciphertext: bufferToCanonicalBase64(rangeBytes), rangeCiphertext: bufferToCanonicalBase64(rangeBytes), fullCiphertextDigest: row.ciphertext_digest, rangeCiphertextDigest: sha256(rangeBytes), range: { ...range, totalBytes: row.byte_length } };
}

export async function enqueueShadowCommand(input: {
  accountId: string;
  controllerDeviceId: string;
  fence: unknown;
  commandId: string;
  idempotencyKey: string;
  envelopeCiphertext: string;
  payloadDigest: string;
  ttlMs?: number;
}): Promise<{ commandId: string; status: string; duplicate: boolean }> {
  const fence = requireFence(input.fence);
  if (!safeId(input.commandId) || !safeId(input.idempotencyKey)) throw status('bad command', 400);
  await assertFence(getDb(), input.accountId, fence, input.controllerDeviceId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + clampTtlMs(input.ttlMs, DEFAULT_COMMAND_TTL_MS));
  const existing = await getDb()
    .selectFrom('shadow_command')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', fence.scopeId)
    .where('controller_device_id', '=', input.controllerDeviceId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    if (existing.command_id !== input.commandId || existing.payload_digest !== input.payloadDigest) throw status('conflicting idempotency key', 409);
    return { commandId: existing.command_id, status: existing.status, duplicate: true };
  }
  await getDb()
    .insertInto('shadow_command')
    .values({ account_id: input.accountId, scope_id: fence.scopeId, host_device_id: fence.hostDeviceId, controller_device_id: input.controllerDeviceId, command_id: input.commandId, idempotency_key: input.idempotencyKey, fence: { ...fence }, envelope_ciphertext: opaque(input.envelopeCiphertext, 'command'), payload_digest: opaque(input.payloadDigest, 'payload digest'), status: 'queued', ack_ciphertext: null, ack_digest: null, created_at: now, updated_at: now, expires_at: expiresAt })
    .execute();
  return { commandId: input.commandId, status: 'queued', duplicate: false };
}

export async function pullShadowCommands(input: { accountId: string; hostDeviceId: string; scopeId: string; limit?: number }): Promise<unknown[]> {
  await assertScopeAuthorized(getDb(), { accountId: input.accountId, scopeId: input.scopeId, deviceId: input.hostDeviceId, role: 'host' });
  const lease = await activeLease(getDb(), input.accountId, input.scopeId);
  if (lease.host_device_id !== input.hostDeviceId) throw status('invalid fence', 409);
  const rows = await getDb()
    .selectFrom('shadow_command')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', input.scopeId)
    .where('host_device_id', '=', input.hostDeviceId)
    .where('status', '=', 'queued')
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'asc')
    .limit(Math.min(input.limit ?? 100, 100))
    .execute();
  if (rows.length) {
    await getDb().updateTable('shadow_command').set({ status: 'delivered', updated_at: new Date() }).where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('host_device_id', '=', input.hostDeviceId).where('command_id', 'in', rows.map((r) => r.command_id)).execute();
  }
  return rows.map((r) => ({ commandId: r.command_id, controllerDeviceId: r.controller_device_id, fence: r.fence, envelopeCiphertext: r.envelope_ciphertext, payloadDigest: r.payload_digest }));
}

export async function ackShadowCommand(input: { accountId: string; hostDeviceId: string; scopeId: string; commandId: string; ackCiphertext: string; ackDigest: string }): Promise<{ ok: true }> {
  await assertScopeAuthorized(getDb(), { accountId: input.accountId, scopeId: input.scopeId, deviceId: input.hostDeviceId, role: 'host' });
  const lease = await activeLease(getDb(), input.accountId, input.scopeId);
  if (lease.host_device_id !== input.hostDeviceId) throw status('invalid fence', 409);
  const row = await getDb().selectFrom('shadow_command').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('host_device_id', '=', input.hostDeviceId).where('command_id', '=', input.commandId).executeTakeFirst();
  if (!row) throw status('command not found', 404);
  if (row.expires_at.getTime() <= Date.now()) throw status('command expired', 410);
  if (row.ack_digest && row.ack_digest !== input.ackDigest) throw status('conflicting command ack', 409);
  await getDb().updateTable('shadow_command').set({ status: 'acked', ack_ciphertext: opaque(input.ackCiphertext, 'ack'), ack_digest: opaque(input.ackDigest, 'ack digest'), updated_at: new Date() }).where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('command_id', '=', input.commandId).execute();
  return { ok: true };
}

/**
 * Controller-facing ACK poll (Phase 3A2a additive). The controller has no other
 * way to observe the host's ACK/completion outcome (the ack is stored on the
 * host-owned command row). Returns ONLY this controller's own acked commands'
 * ciphertext + digest — scoped to (account, scope, controllerDeviceId), so there
 * is no cross-controller leakage. `assertFence(..., controllerDeviceId)` rejects a
 * revoked controller (403) and a stale/invalid fence (409) before any read. The
 * relay never sees the ack plaintext.
 */
export async function listControllerCommandAcks(input: { accountId: string; controllerDeviceId: string; fence: unknown; limit?: number }): Promise<Array<{ commandId: string; status: string; ackCiphertext: string; ackDigest: string }>> {
  const fence = requireFence(input.fence);
  await assertFence(getDb(), input.accountId, fence, input.controllerDeviceId);
  const rows = await getDb()
    .selectFrom('shadow_command')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', fence.scopeId)
    .where('controller_device_id', '=', input.controllerDeviceId)
    .where('status', '=', 'acked')
    .orderBy('updated_at', 'asc')
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 100))
    .execute();
  return rows
    .filter((r) => r.ack_ciphertext !== null && r.ack_digest !== null)
    .map((r) => ({ commandId: r.command_id, status: r.status, ackCiphertext: r.ack_ciphertext as string, ackDigest: r.ack_digest as string }));
}

/**
 * Enrolled-controller lease reconciliation (Phase 3A2a re-review finding 2). Returns
 * the server-authoritative fence + lease expiry for the controller's scope so the
 * mobile runtime can track real renewal instead of a fixed optimistic window. The
 * controller must be enrolled + not revoked (403 revoked) and a live lease must
 * exist (404 none / 409 expired). The relay is authoritative for the LEASE window
 * it already enforces on every route; an epoch/leaseId CHANGE is still delivered to
 * the client only via a host-signed transition, so the client fail-closes on a
 * changed fence rather than trusting this read.
 */
export async function getScopeAuthority(input: { accountId: string; controllerDeviceId: string; scopeId: string }): Promise<{ fence: Fence; expiresAt: number }> {
  if (!safeId(input.scopeId)) throw status('bad scope', 400);
  await assertControllerAllowed(getDb(), input.accountId, input.scopeId, input.controllerDeviceId);
  const lease = await activeLease(getDb(), input.accountId, input.scopeId);
  if (lease.host_device_id === input.controllerDeviceId) throw status('invalid role', 403);
  return { fence: fenceFromLease(lease), expiresAt: lease.expires_at.getTime() };
}

interface RelayTransitionGrant {
  family: 'authority-transition-grant';
  v: 1;
  transitionId: string;
  kind: string;
  controllerDeviceId: string;
  previousFence: Fence;
  nextFence: Fence;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  keyId: string;
  signature: string;
}

/** Minimal RELAY-side shape validation (the HOST signature is the trust boundary; the mobile verifies it). */
function decodeRelayTransitionGrant(value: unknown): RelayTransitionGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;
  if (g.family !== 'authority-transition-grant' || g.v !== 1) return null;
  if (!['handoff', 'lease-rotation', 'lease-renewal'].includes(g.kind as string)) return null;
  if (!safeId(g.transitionId as string) || !safeId(g.controllerDeviceId as string) || !safeId(g.nonce as string) || !safeId(g.keyId as string) || !safeId(g.signature as string)) return null;
  if (typeof g.issuedAt !== 'number' || typeof g.expiresAt !== 'number' || g.issuedAt >= g.expiresAt) return null;
  let previousFence: Fence, nextFence: Fence;
  try { previousFence = requireFence(g.previousFence); nextFence = requireFence(g.nextFence); } catch { return null; }
  return { ...(g as unknown as RelayTransitionGrant), previousFence, nextFence };
}

const transitionVerifyBackend = nodeShadowCrypto;
function sameFenceExact(a: Fence, b: Fence): boolean {
  return a.accountId === b.accountId && a.scopeId === b.scopeId && a.hostDeviceId === b.hostDeviceId && a.epoch === b.epoch && a.leaseId === b.leaseId;
}

/**
 * ATOMIC lease renewal + per-controller transition store (Phase 3A2a re-review HIGH).
 * In ONE PostgreSQL transaction (with the lease row + an advisory scope lock) the
 * server: authenticates the exact registered active host, rejects a successor/stale
 * fence, validates the strictly-increasing bounded requested expiry, loads the exact
 * ACTIVE enrolled controllers, requires the host-signed `lease-renewal` grants to
 * cover each active controller EXACTLY once (Ed25519-verified against the registered
 * host signing key), then atomically UPDATEs the lease expiry AND INSERTs the
 * transition rows AND a durable renewal receipt keyed by `(account, scope, renewalId)`.
 * Idempotent replay of the identical body returns the committed fence/expiry; a
 * mismatched body under the same renewalId is 409. There is no partial (lease-only)
 * commit path, so a host crash after this returns cannot lose the transitions.
 */
export async function renewLeaseWithTransitions(input: {
  accountId: string;
  hostDeviceId: string;
  scopeId: string;
  renewalId: string;
  currentFence: unknown;
  expectedCurrentExpiresAt?: number;
  requestedExpiresAt: number;
  grants: unknown[];
}): Promise<{ fence: Fence; expiresAt: number; transitions: unknown[]; replayed: boolean }> {
  if (!safeId(input.scopeId) || !safeId(input.renewalId)) throw status('bad renewal request', 400);
  const currentFence = requireFence(input.currentFence);
  if (currentFence.accountId !== input.accountId || currentFence.scopeId !== input.scopeId || currentFence.hostDeviceId !== input.hostDeviceId) throw status('fence mismatch', 409);
  if (!Number.isSafeInteger(input.requestedExpiresAt)) throw status('bad requested expiry', 400);
  if (!Array.isArray(input.grants) || input.grants.length > 64) throw status('bad grants', 400);
  const requestDigest = `sha256:${createHash('sha256').update(canonicalJson({ renewalId: input.renewalId, currentFence, requestedExpiresAt: input.requestedExpiresAt, grants: input.grants }), 'utf8').digest('hex')}`;

  return getDb().transaction().execute(async (trx) => {
    await assertScopeAuthorized(trx, { accountId: input.accountId, scopeId: input.scopeId, deviceId: input.hostDeviceId, role: 'host' });
    await sql`select pg_advisory_xact_lock(hashtextextended(${`renew:${input.accountId}:${input.scopeId}`}, 0))`.execute(trx);

    // Idempotent replay by renewalId.
    const receipt = await trx.selectFrom('shadow_lease_renewal_receipt').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('renewal_id', '=', input.renewalId).executeTakeFirst();
    if (receipt) {
      if (receipt.request_digest !== requestDigest) throw status('renewal replay body mismatch', 409);
      const prior = await trx.selectFrom('shadow_authority_transition').select('grant').where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('transition_id', 'in', (input.grants.map((g) => (g as { transitionId?: string }).transitionId).filter((x): x is string => typeof x === 'string')).length ? input.grants.map((g) => (g as { transitionId: string }).transitionId) : ['__none__']).execute();
      return { fence: receipt.fence as unknown as Fence, expiresAt: Number(receipt.expires_at_ms), transitions: prior.map((t) => t.grant), replayed: true };
    }

    const lease = await trx.selectFrom('shadow_lease').selectAll().where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).forUpdate().executeTakeFirst();
    if (!lease) throw status('host lease not found', 404);
    const leaseFence = fenceFromLease(lease);
    // Reject a successor / split-brain: the proven current fence must match the LIVE lease
    // exactly. (Concurrency is handled by the strict-increase check below + the advisory
    // lock — a stale intent whose requested expiry no longer exceeds the current lease is
    // rejected there; `expectedCurrentExpiresAt` is advisory only and never a hard gate, so
    // a legitimate lease extension by a restart's `acquireLease` does not spuriously fail.)
    if (!sameFenceExact(leaseFence, currentFence)) { throw status('successor fence — stale renewal rejected', 409); }

    const now = Date.now();
    if (input.requestedExpiresAt <= lease.expires_at.getTime()) throw status('requested expiry not strictly increasing', 400);
    if (input.requestedExpiresAt <= now) throw status('requested expiry in the past', 400);
    if (input.requestedExpiresAt > now + MAX_LEASE_TTL_MS) throw status('requested expiry beyond max ttl', 400);

    const hostIdentity = await trx.selectFrom('shadow_host_identity').select(['signing_key_id', 'signing_public_key', 'status']).where('account_id', '=', input.accountId).where('host_device_id', '=', input.hostDeviceId).executeTakeFirst();
    if (!hostIdentity || hostIdentity.status !== 'active') throw status('host identity not active', 403);
    const hostPub = base64urlDecode(hostIdentity.signing_public_key);

    // Exact ACTIVE enrolled controllers under lock (active grant, not revoked).
    const grantsRows = await trx.selectFrom('shadow_enrollment_grant').select('controller_device_id').where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('status', '=', 'active').execute();
    const revokedRows = await trx.selectFrom('shadow_revoked_controller').select('controller_device_id').where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).execute();
    const revokedSet = new Set(revokedRows.map((r) => r.controller_device_id));
    const activeControllers = new Set(grantsRows.map((r) => r.controller_device_id).filter((c) => !revokedSet.has(c)));

    const seenControllers = new Set<string>();
    const seenIds = new Set<string>();
    const seenNonces = new Set<string>();
    const rows: DB['shadow_authority_transition'][] = [];
    for (const raw of input.grants) {
      const g = decodeRelayTransitionGrant(raw);
      if (!g || g.kind !== 'lease-renewal') throw status('bad transition grant', 400);
      if (g.keyId !== hostIdentity.signing_key_id) throw status('grant key mismatch', 403);
      if (!sameFenceExact(g.previousFence, currentFence) || !sameFenceExact(g.nextFence, currentFence)) throw status('grant fence mismatch', 400);
      if (g.expiresAt !== input.requestedExpiresAt) throw status('grant expiry mismatch', 400);
      if (g.issuedAt >= g.expiresAt || g.issuedAt > now + 60_000) throw status('grant issuedAt out of bounds', 400);
      if (!activeControllers.has(g.controllerDeviceId)) throw status('grant for non-active controller', 400);
      if (seenControllers.has(g.controllerDeviceId)) throw status('duplicate controller grant', 400);
      if (seenIds.has(g.transitionId) || seenNonces.has(g.nonce)) throw status('duplicate transition id/nonce', 400);
      const ok = await verifyAuthorityTransitionSignature(transitionVerifyBackend, { hostSigningPublicKey: hostPub, hostSigningKeyId: hostIdentity.signing_key_id }, { ...g, kind: 'lease-renewal' });
      if (!ok) throw status('bad grant signature', 403);
      const dup = await trx.selectFrom('shadow_authority_transition').select('transition_id').where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).where('transition_id', '=', g.transitionId).executeTakeFirst();
      if (dup) throw status('transition id already used', 409);
      seenControllers.add(g.controllerDeviceId); seenIds.add(g.transitionId); seenNonces.add(g.nonce);
      rows.push({ account_id: input.accountId, scope_id: input.scopeId, host_device_id: input.hostDeviceId, controller_device_id: g.controllerDeviceId, transition_id: g.transitionId, nonce: g.nonce, kind: g.kind, grant: g as unknown as Record<string, unknown>, status: 'queued', created_at: new Date(), updated_at: new Date(), expires_at: new Date(g.expiresAt) } as unknown as DB['shadow_authority_transition']);
    }
    // Grants must cover EACH active controller exactly once — no missing, no extras.
    if (seenControllers.size !== activeControllers.size) throw status('grants must cover exactly the active controllers', 400);
    for (const c of activeControllers) if (!seenControllers.has(c)) throw status('missing controller grant', 400);

    // ATOMIC: extend lease AND store transitions AND write the receipt — all-or-nothing.
    await trx.updateTable('shadow_lease').set({ expires_at: new Date(input.requestedExpiresAt), updated_at: new Date() }).where('account_id', '=', input.accountId).where('scope_id', '=', input.scopeId).execute();
    for (const row of rows) {
      await trx.insertInto('shadow_authority_transition').values(row).onConflict((oc) => oc.columns(['account_id', 'scope_id', 'transition_id']).doNothing()).execute();
    }
    await trx.insertInto('shadow_lease_renewal_receipt').values({ account_id: input.accountId, scope_id: input.scopeId, renewal_id: input.renewalId, host_device_id: input.hostDeviceId, fence: { ...leaseFence } as unknown as Record<string, unknown>, expires_at_ms: String(input.requestedExpiresAt), request_digest: requestDigest, committed_at: new Date() }).execute();
    return { fence: leaseFence, expiresAt: input.requestedExpiresAt, transitions: input.grants, replayed: false };
  });
}

/**
 * ACTIVE-host upload of per-controller signed authority-transition grants (Phase
 * 3A2a). Idempotent by transitionId; the host must hold the current lease and the
 * grant's previous fence must match it. The relay stores/forwards only — it never
 * verifies the host signature (that is the controller's trust boundary). NOTE: the
 * PRODUCTION lease-renewal path uses the atomic `renewLeaseWithTransitions` above;
 * this standalone upload remains only for non-renewal/testing paths.
 */
export async function uploadAuthorityTransitions(input: { accountId: string; hostDeviceId: string; scopeId: string; grants: unknown[] }): Promise<{ uploaded: number }> {
  if (!safeId(input.scopeId)) throw status('bad scope', 400);
  await assertScopeAuthorized(getDb(), { accountId: input.accountId, scopeId: input.scopeId, deviceId: input.hostDeviceId, role: 'host' });
  const lease = await activeLease(getDb(), input.accountId, input.scopeId);
  if (lease.host_device_id !== input.hostDeviceId) throw status('invalid fence', 409);
  if (!Array.isArray(input.grants) || input.grants.length > 64) throw status('bad transitions', 400);
  const now = new Date();
  let uploaded = 0;
  for (const raw of input.grants) {
    const g = decodeRelayTransitionGrant(raw);
    if (!g) throw status('bad transition grant', 400);
    if (g.previousFence.accountId !== input.accountId || g.previousFence.scopeId !== input.scopeId || g.previousFence.hostDeviceId !== input.hostDeviceId) throw status('transition fence mismatch', 409);
    if (g.expiresAt <= now.getTime()) continue; // already expired — nothing to deliver
    await getDb()
      .insertInto('shadow_authority_transition')
      .values({ account_id: input.accountId, scope_id: input.scopeId, host_device_id: input.hostDeviceId, controller_device_id: g.controllerDeviceId, transition_id: g.transitionId, nonce: g.nonce, kind: g.kind, grant: g as unknown as Record<string, unknown>, status: 'queued', created_at: now, updated_at: now, expires_at: new Date(g.expiresAt) })
      .onConflict((oc) => oc.columns(['account_id', 'scope_id', 'transition_id']).doNothing())
      .execute();
    uploaded += 1;
  }
  return { uploaded };
}

/**
 * Enrolled-controller fetch of its OWN pending transitions. Denies a revoked
 * controller (403) before any data and never leaks another controller's rows. Does
 * NOT require a live lease — an expired-old-authority controller may still fetch its
 * host-signed renewal, because the host signature (not the relay) is the authority.
 */
export async function listAuthorityTransitions(input: { accountId: string; controllerDeviceId: string; scopeId: string }): Promise<{ grants: unknown[] }> {
  if (!safeId(input.scopeId)) throw status('bad scope', 400);
  await assertControllerAllowed(getDb(), input.accountId, input.scopeId, input.controllerDeviceId);
  const rows = await getDb()
    .selectFrom('shadow_authority_transition')
    .selectAll()
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', input.scopeId)
    .where('controller_device_id', '=', input.controllerDeviceId)
    .where('status', '=', 'queued')
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'asc')
    .limit(50)
    .execute();
  return { grants: rows.map((r) => r.grant) };
}

/** Enrolled-controller consume (idempotent) of its own applied transition. */
export async function markAuthorityTransitionConsumed(input: { accountId: string; controllerDeviceId: string; scopeId: string; transitionId: string }): Promise<{ ok: true }> {
  if (!safeId(input.scopeId) || !safeId(input.transitionId)) throw status('bad request', 400);
  await assertControllerAllowed(getDb(), input.accountId, input.scopeId, input.controllerDeviceId);
  await getDb()
    .updateTable('shadow_authority_transition')
    .set({ status: 'consumed', updated_at: new Date() })
    .where('account_id', '=', input.accountId)
    .where('scope_id', '=', input.scopeId)
    .where('controller_device_id', '=', input.controllerDeviceId)
    .where('transition_id', '=', input.transitionId)
    .execute();
  return { ok: true };
}

export async function updateShadowTransport(input: { accountId: string; controllerDeviceId: string; fence: unknown; transport: string; state: string }): Promise<{ ok: true }> {
  const fence = requireFence(input.fence);
  if (!['relay', 'lan', 'webrtc-data'].includes(input.transport) || !safeId(input.state)) throw status('bad transport', 400);
  await assertFence(getDb(), input.accountId, fence, input.controllerDeviceId);
  await getDb().insertInto('shadow_transport').values({ account_id: input.accountId, scope_id: fence.scopeId, controller_device_id: input.controllerDeviceId, host_device_id: fence.hostDeviceId, transport: input.transport, state: input.state, updated_at: new Date() }).onConflict((oc) => oc.columns(['account_id', 'scope_id', 'controller_device_id', 'transport']).doUpdateSet({ host_device_id: fence.hostDeviceId, state: input.state, updated_at: new Date() })).execute();
  return { ok: true };
}

export async function pruneShadowRelay(now = Date.now()): Promise<{ events: number; commands: number; blobs: number; chunks: number; snapshots: number }> {
  const cutoff = new Date(now - RETENTION_TTL_MS);
  const eventsResult = await sql<{ count: string }>`
    with floors as (
      select
        e.account_id,
        e.scope_id,
        e.epoch,
        case
          when max(s.base_seq) is null then 0
          when min(c.last_seq) is null then greatest(max(s.base_seq) - 100, 0)
          else least(greatest(max(s.base_seq) - 100, 0), min(c.last_seq))
        end as prune_before_seq
      from shadow_event e
      left join shadow_snapshot s
        on s.account_id = e.account_id
       and s.scope_id = e.scope_id
       and s.epoch = e.epoch
       and (s.expires_at is null or s.expires_at > ${new Date(now)})
      left join shadow_cursor c
        on c.account_id = e.account_id
       and c.scope_id = e.scope_id
       and c.epoch = e.epoch
      group by e.account_id, e.scope_id, e.epoch
    ),
    deleted as (
      delete from shadow_event e
      using floors f
      where e.account_id = f.account_id
        and e.scope_id = f.scope_id
        and e.epoch = f.epoch
        and e.stored_at < ${cutoff}
        and f.prune_before_seq > 0
        and e.seq < f.prune_before_seq
      returning 1
    )
    select count(*)::text as count from deleted
  `.execute(getDb());
  const commands = await getDb().deleteFrom('shadow_command').where('expires_at', '<', new Date(now)).executeTakeFirst();
  await getDb().deleteFrom('shadow_blob_capability').where('expires_at', '<', new Date(now)).executeTakeFirst();
  const blobs = await getDb().deleteFrom('shadow_blob').where((eb) => eb.and([eb('capability_expires_at', 'is not', null), eb('capability_expires_at', '<', new Date(now))])).executeTakeFirst();
  const chunks = await getDb().deleteFrom('shadow_chunk').where((eb) => eb.and([eb('expires_at', 'is not', null), eb('expires_at', '<', new Date(now))])).executeTakeFirst();
  const snapshots = await getDb().deleteFrom('shadow_snapshot').where((eb) => eb.and([eb('expires_at', 'is not', null), eb('expires_at', '<', new Date(now))])).executeTakeFirst();
  return {
    events: Number(eventsResult.rows[0]?.count ?? 0),
    commands: Number(commands.numDeletedRows ?? 0),
    blobs: Number(blobs.numDeletedRows ?? 0),
    chunks: Number(chunks.numDeletedRows ?? 0),
    snapshots: Number(snapshots.numDeletedRows ?? 0),
  };
}
