/**
 * shadowRequestAuth — Phase 3A1 signed-request authentication for the enrolled
 * `/api/shadow/*` surface.
 *
 * After enrollment, a raw `x-maestro-device-id` + account session is NOT enough
 * to act as a host/controller: every enrolled request must carry an Ed25519
 * signature over a canonical request proof, verified against the device's
 * active registered signing key.
 *
 * Canonical proof (domain-separated, length-prefixed via the shared
 * `structuredEncode`) binds:
 *   method · normalized path+query · SHA-256(body) · accountId · deviceId ·
 *   keyId · timestampMs · nonce
 *
 * Verification enforces: active registered key ↔ device ↔ required role,
 * bounded clock skew, exact body/path binding, and a single-use nonce persisted
 * in PostgreSQL (replay — even across process/repository restart — is rejected).
 */
import { createHash } from 'node:crypto';
import {
  base64urlDecode,
  constantTimeEqual,
  structuredEncode,
  utf8Encode,
} from '@maestro/realtime/shadowCrypto';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import { getDb, type DB } from './db.js';
import type { Kysely, Transaction } from 'kysely';

export const SHADOW_REQUEST_PROOF_DOMAIN = 'maestro.shadow.request-proof.v1';
export const SHADOW_REQUEST_SKEW_MS = 5 * 60_000;
export const SHADOW_REQUEST_NONCE_TTL_MS = 10 * 60_000;

/** The four declared auth classes; every shadow route pins exactly one. */
export type ShadowAuthClass = 'bootstrap-host' | 'bootstrap-controller' | 'enrolled-host' | 'enrolled-controller';

type DbOrTrx = Kysely<DB> | Transaction<DB>;

export interface ShadowRequestProof {
  deviceId: string;
  keyId: string;
  timestampMs: number;
  nonce: string;
  signature: string; // base64url Ed25519
}

export interface ShadowRequestContext {
  accountId: string;
  method: string;
  /** Raw request path including query string, exactly as received. */
  rawUrl: string;
  /** Raw request body bytes (the serialized string the client signed), '' if none. */
  rawBody: string;
  nowMs: number;
}

function status(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const HEADER = {
  device: 'x-maestro-device-id',
  keyId: 'x-maestro-shadow-key-id',
  timestamp: 'x-maestro-shadow-timestamp',
  nonce: 'x-maestro-shadow-nonce',
  signature: 'x-maestro-shadow-signature',
} as const;

function header(headers: Record<string, unknown>, name: string): string | null {
  const v = headers[name];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{1,4096}$/;

/** Extract + shape-validate the proof headers. Throws 401 on any missing/invalid field. */
export function readShadowRequestProof(headers: Record<string, unknown>): ShadowRequestProof {
  const deviceId = header(headers, HEADER.device);
  const keyId = header(headers, HEADER.keyId);
  const timestampRaw = header(headers, HEADER.timestamp);
  const nonce = header(headers, HEADER.nonce);
  const signature = header(headers, HEADER.signature);
  if (!deviceId || !keyId || !timestampRaw || !nonce || !signature) throw status('shadow request proof required', 401);
  if (!ID_RE.test(deviceId) || !ID_RE.test(keyId) || !ID_RE.test(nonce)) throw status('bad shadow proof id', 401);
  if (!B64URL_RE.test(signature)) throw status('bad shadow proof signature', 401);
  const timestampMs = Number(timestampRaw);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) throw status('bad shadow proof timestamp', 401);
  return { deviceId, keyId, timestampMs, nonce, signature };
}

function sha256Bytes(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

/**
 * Deterministic path+query normalization: keep the pathname verbatim, sort the
 * query params by (key, value) and re-encode. Reordering query params cannot
 * change the signed bytes, but altering any key/value does.
 */
export function normalizePathQuery(rawUrl: string): string {
  const u = new URL(rawUrl, 'http://shadow.invalid');
  const params = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return u.pathname + (qs ? `?${qs}` : '');
}

/** The exact bytes an enrolled client signs (and the server re-derives). */
export function shadowRequestProofBytes(input: {
  method: string;
  rawUrl: string;
  rawBody: string;
  accountId: string;
  deviceId: string;
  keyId: string;
  timestampMs: number;
  nonce: string;
}): Uint8Array {
  return structuredEncode(SHADOW_REQUEST_PROOF_DOMAIN, [
    input.method.toUpperCase(),
    normalizePathQuery(input.rawUrl),
    sha256Bytes(input.rawBody),
    input.accountId,
    input.deviceId,
    input.keyId,
    input.timestampMs,
    input.nonce,
  ]);
}

export interface VerifiedShadowRequest {
  accountId: string;
  deviceId: string;
  keyId: string;
  role: 'host' | 'controller';
}

/**
 * Full enrolled-request verification. Order matters: cheap shape/skew checks,
 * then the active-key lookup, then the Ed25519 signature, then the single-use
 * nonce consume (last, so a bad signature never burns a nonce). Any failure
 * throws a bounded generic error and never leaks secret material.
 */
export async function verifyShadowRequestProof(
  ctx: ShadowRequestContext,
  proof: ShadowRequestProof,
  requiredClass: 'enrolled-host' | 'enrolled-controller',
  headerDeviceId: string,
): Promise<VerifiedShadowRequest> {
  if (proof.deviceId !== headerDeviceId) throw status('shadow proof device mismatch', 401);
  if (Math.abs(ctx.nowMs - proof.timestampMs) > SHADOW_REQUEST_SKEW_MS) throw status('shadow proof stale', 401);

  const requiredRole = requiredClass === 'enrolled-host' ? 'host' : 'controller';
  const key = await getDb()
    .selectFrom('shadow_registered_key')
    .selectAll()
    .where('account_id', '=', ctx.accountId)
    .where('key_id', '=', proof.keyId)
    .where('purpose', '=', 'sign')
    .executeTakeFirst();
  if (!key || key.status !== 'active' || key.device_id !== proof.deviceId || key.role !== requiredRole) {
    throw status('shadow proof key not authorized', 401);
  }

  // The device must still exist in the account registry with the matching role.
  const device = await getDb()
    .selectFrom('device')
    .select(['id', 'role'])
    .where('user_id', '=', ctx.accountId)
    .where('id', '=', proof.deviceId)
    .executeTakeFirst();
  if (!device) throw status('shadow proof device not found', 401);
  if (requiredRole === 'host' && device.role !== 'host') throw status('shadow proof not a host', 401);
  if (requiredRole === 'controller' && device.role !== 'remote') throw status('shadow proof not a controller', 401);

  let signingPublicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    signingPublicKey = base64urlDecode(key.public_key);
    signature = base64urlDecode(proof.signature);
  } catch {
    throw status('bad shadow proof encoding', 401);
  }
  if (signingPublicKey.length !== 32) throw status('bad shadow key length', 401);

  const message = shadowRequestProofBytes({
    method: ctx.method,
    rawUrl: ctx.rawUrl,
    rawBody: ctx.rawBody,
    accountId: ctx.accountId,
    deviceId: proof.deviceId,
    keyId: proof.keyId,
    timestampMs: proof.timestampMs,
    nonce: proof.nonce,
  });
  const good = await nodeShadowCrypto.verify(signingPublicKey, message, signature);
  if (!good) throw status('shadow proof signature invalid', 401);

  // Consume the nonce last. A duplicate (replay) fails the PK insert.
  await consumeRequestNonce(getDb(), ctx.accountId, proof.deviceId, proof.nonce, ctx.nowMs);

  return { accountId: ctx.accountId, deviceId: proof.deviceId, keyId: proof.keyId, role: requiredRole };
}

/** Insert a single-use nonce; PK conflict → replay → 401. */
export async function consumeRequestNonce(db: DbOrTrx, accountId: string, deviceId: string, nonce: string, nowMs: number): Promise<void> {
  try {
    const res = await db
      .insertInto('shadow_request_nonce')
      .values({ account_id: accountId, device_id: deviceId, nonce, expires_at_ms: nowMs + SHADOW_REQUEST_NONCE_TTL_MS, created_at: new Date() })
      .onConflict((oc) => oc.columns(['account_id', 'device_id', 'nonce']).doNothing())
      .executeTakeFirst();
    if (!res || Number(res.numInsertedOrUpdatedRows ?? 0) === 0) throw status('shadow proof nonce replay', 401);
  } catch (e) {
    if (e && typeof e === 'object' && 'statusCode' in e) throw e;
    throw status('shadow proof nonce replay', 401);
  }
}

/** Bounded cleanup of expired nonces (called by the relay prune path). */
export async function pruneShadowRequestNonces(now = Date.now()): Promise<number> {
  const res = await getDb().deleteFrom('shadow_request_nonce').where('expires_at_ms', '<', now).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

/** Constant-time compare exported for callers that verify opaque digests. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  return constantTimeEqual(utf8Encode(a), utf8Encode(b));
}
