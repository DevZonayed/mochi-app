/**
 * shadowEnrollmentService — Phase 3A1 account-scoped, PostgreSQL-backed
 * enrollment state machine, controller grant storage, and atomic revocation.
 *
 * Built purely on the shared `@maestro/realtime/shadowEnrollment` primitives and
 * the Node crypto backend; the relay verifies signatures and secret proofs but
 * never holds a private key, one-time secret plaintext, or plaintext scope key.
 *
 * Secret-verifier note: the one-time enrollment secret is a 256-bit CSPRNG value
 * carried only in the host QR bootstrap. The HOST computes the peppered verifier
 * (using the shared, public verifier pepper below) and the API receives only the
 * verifier + salt — never the plaintext secret. The pepper is public by design:
 * with a full-entropy 256-bit secret a stored HMAC verifier is not brute-forcible,
 * so no server-only secret is required for the verifier to be safe at rest, and
 * both tiers can compute/verify it without sharing a private key.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS,
  SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME,
  SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
  verifyEnrollmentRequest,
  verifyEnrollmentSecret,
  verifyEnrollmentGrantSignature,
  verifyDeviceRevocation,
  makeEnrollmentSecretVerifier,
  type EnrollmentBootstrap,
  type EnrollmentRequest,
  type EnrollmentGrantMessage,
  type EnrollmentKeyMaterial,
  type DeviceRevocationMessage,
  type EnrollmentSecretVerifier,
} from '@maestro/realtime/shadowEnrollment';
import {
  base64urlDecode,
  base64urlEncode,
  structuredEncode,
  keyFingerprint,
  type ShadowCryptoBackend,
} from '@maestro/realtime/shadowCrypto';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import { canonicalizeCapabilities, type ShadowCapability } from '@maestro/realtime/shadowCapabilities';
/** Canonicalise a stored capability value, failing closed to the read floor. */
function safeCaps(value: unknown): ShadowCapability[] {
  const c = canonicalizeCapabilities(value);
  return c.ok ? c.capabilities : ['account.read'];
}
import { createHash } from 'node:crypto';
import { getDb, type DB } from './db.js';

type DbOrTrx = Kysely<DB> | Transaction<DB>;
const backend = nodeShadowCrypto;

/** Public verifier pepper (see module header): shared, not secret. */
export const ENROLLMENT_VERIFIER_PEPPER = new TextEncoder().encode('maestro.shadow.enroll.verifier.pepper.v1');
const HOST_REGISTER_DOMAIN = 'maestro.shadow.host-register.v1';
const HOST_ROTATE_DOMAIN = 'maestro.shadow.host-rotate.v1';
const CONTROLLER_POLL_DOMAIN = 'maestro.shadow.enroll.poll.v1';

function status(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function isPgUniqueViolation(e: unknown, constraintOrIndex: string): boolean {
  const err = e as { code?: unknown; constraint?: unknown } | undefined;
  return err?.code === '23505' && err.constraint === constraintOrIndex;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{1,4096}$/;

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw status(`bad ${name}`, 400);
  return value;
}
function requireB64(value: unknown, name: string): string {
  if (typeof value !== 'string' || !B64URL_RE.test(value)) throw status(`bad ${name}`, 400);
  return value;
}
function requireInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw status(`bad ${name}`, 400);
  return value;
}
function decode32(value: string, name: string): Uint8Array {
  let bytes: Uint8Array;
  try { bytes = base64urlDecode(value); } catch { throw status(`bad ${name}`, 400); }
  if (bytes.length !== 32) throw status(`bad ${name} length`, 400);
  return bytes;
}

/** Allowed relay origins for enrollment bootstraps (comma-separated env or default). */
export function allowedRelayOrigins(): string[] {
  const raw = process.env.SHADOW_RELAY_ORIGINS;
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['https://api.nexalance.cloud'];
}

function accountScope(accountId: string): string {
  return `account:${accountId}`;
}

// ── Host identity (TOFU registration + rotation) ──────────────────────────

export interface RegisterHostIdentityInput {
  accountId: string;
  hostDeviceId: string;
  signingPublicKey: string; // base64url raw 32
  agreementPublicKey: string; // base64url raw 32
  registrationSignature: string; // self-signature by the new signing key
  rotationSignature?: string; // signature by the CURRENT active signing key (rotation only)
  nowMs: number;
}

export interface HostIdentityView {
  hostDeviceId: string;
  signingKeyId: string;
  agreementKeyId: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  rotated: boolean;
}

function hostRegisterBytes(accountId: string, hostDeviceId: string, signingPub: Uint8Array, agreementPub: Uint8Array): Uint8Array {
  return structuredEncode(HOST_REGISTER_DOMAIN, [accountId, hostDeviceId, signingPub, agreementPub]);
}
function hostRotateBytes(accountId: string, hostDeviceId: string, newSigningPub: Uint8Array, newAgreementPub: Uint8Array): Uint8Array {
  return structuredEncode(HOST_ROTATE_DOMAIN, [accountId, hostDeviceId, newSigningPub, newAgreementPub]);
}

// ── Host/controller-side signers + verifier (used by the host/mobile runtime
//    and tests; the relay only ever VERIFIES these). ────────────────────────

/** Host proves possession of the signing key it is registering (TOFU). */
export async function signHostRegistration(backend: ShadowCryptoBackend, signingPrivateKey: Uint8Array, accountId: string, hostDeviceId: string, signingPub: Uint8Array, agreementPub: Uint8Array): Promise<string> {
  return base64urlEncode(await backend.sign(signingPrivateKey, hostRegisterBytes(accountId, hostDeviceId, signingPub, agreementPub)));
}

/** Current host key authorizes replacing itself with new keys (rotation). */
export async function signHostRotation(backend: ShadowCryptoBackend, currentSigningPrivateKey: Uint8Array, accountId: string, hostDeviceId: string, newSigningPub: Uint8Array, newAgreementPub: Uint8Array): Promise<string> {
  return base64urlEncode(await backend.sign(currentSigningPrivateKey, hostRotateBytes(accountId, hostDeviceId, newSigningPub, newAgreementPub)));
}

/** Controller signs a poll of its own enrollment status. */
export async function signControllerPoll(backend: ShadowCryptoBackend, controllerSigningPrivateKey: Uint8Array, accountId: string, sessionId: string, controllerDeviceId: string, nonce: string, timestampMs: number): Promise<string> {
  return base64urlEncode(await backend.sign(controllerSigningPrivateKey, structuredEncode(CONTROLLER_POLL_DOMAIN, [accountId, sessionId, controllerDeviceId, nonce, timestampMs])));
}

/** Host computes the peppered one-time-secret verifier the relay stores (never the secret). */
export async function computeEnrollmentVerifier(backend: ShadowCryptoBackend, input: { sessionId: string; accountId: string; secret: Uint8Array; salt: Uint8Array }): Promise<EnrollmentSecretVerifier> {
  return makeEnrollmentSecretVerifier(backend, { ...input, pepper: ENROLLMENT_VERIFIER_PEPPER });
}

async function assertDeviceRole(db: DbOrTrx, accountId: string, deviceId: string, role: 'host' | 'remote', notFound: string): Promise<void> {
  const row = await db.selectFrom('device').select(['id', 'role']).where('user_id', '=', accountId).where('id', '=', deviceId).executeTakeFirst();
  if (!row || row.role !== role) throw status(notFound, 404);
}

/**
 * TOFU host identity registration. First registration for (account, host device)
 * is accepted after proving possession of the new signing key. Re-registration
 * with the same keys is idempotent; with different keys it REQUIRES a valid
 * rotation signature by the current active signing key — never a silent overwrite.
 */
export async function registerHostIdentity(input: RegisterHostIdentityInput): Promise<HostIdentityView> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  const signingPub = decode32(requireB64(input.signingPublicKey, 'signingPublicKey'), 'signingPublicKey');
  const agreementPub = decode32(requireB64(input.agreementPublicKey, 'agreementPublicKey'), 'agreementPublicKey');
  const registrationSignature = base64urlDecode(requireB64(input.registrationSignature, 'registrationSignature'));

  // Possession proof of the new signing key (mandatory for TOFU + rotation).
  const selfOk = await backend.verify(signingPub, hostRegisterBytes(accountId, hostDeviceId, signingPub, agreementPub), registrationSignature);
  if (!selfOk) throw status('host registration signature invalid', 401);

  const signingKeyId = await keyFingerprint(backend, 'sign', signingPub);
  const agreementKeyId = await keyFingerprint(backend, 'agree', agreementPub);
  const fingerprint = signingKeyId;

  return getDb().transaction().execute(async (trx) => {
    await assertDeviceRole(trx, accountId, hostDeviceId, 'host', 'host not found');
    await sql`select pg_advisory_xact_lock(hashtextextended(${`hostid:${accountId}:${hostDeviceId}`}, 0))`.execute(trx);
    const existing = await trx.selectFrom('shadow_host_identity').selectAll().where('account_id', '=', accountId).where('host_device_id', '=', hostDeviceId).executeTakeFirst();
    let rotated = false;
    if (existing && existing.status === 'active') {
      if (existing.signing_key_id === signingKeyId && existing.agreement_key_id === agreementKeyId) {
        return { hostDeviceId, signingKeyId, agreementKeyId, fingerprint, status: 'active' as const, rotated: false };
      }
      // Different keys → require a rotation signature from the CURRENT key.
      if (!input.rotationSignature) throw status('host identity exists; rotation signature required', 409);
      let rotationSig: Uint8Array;
      try { rotationSig = base64urlDecode(requireB64(input.rotationSignature, 'rotationSignature')); } catch { throw status('bad rotationSignature', 400); }
      const currentSigningPub = base64urlDecode(existing.signing_public_key);
      const rotOk = await backend.verify(currentSigningPub, hostRotateBytes(accountId, hostDeviceId, signingPub, agreementPub), rotationSig);
      if (!rotOk) throw status('host rotation signature invalid', 401);
      rotated = true;
      // Retire the old registered signing key.
      await trx.updateTable('shadow_registered_key').set({ status: 'revoked', revoked_at: new Date() }).where('account_id', '=', accountId).where('key_id', '=', existing.signing_key_id).execute();
      await trx.updateTable('shadow_registered_key').set({ status: 'revoked', revoked_at: new Date() }).where('account_id', '=', accountId).where('key_id', '=', existing.agreement_key_id).execute();
    }
    const now = new Date();
    await trx.insertInto('shadow_host_identity').values({
      account_id: accountId, host_device_id: hostDeviceId, signing_key_id: signingKeyId, signing_public_key: input.signingPublicKey,
      agreement_key_id: agreementKeyId, agreement_public_key: input.agreementPublicKey, fingerprint, status: 'active',
      rotated_from_key_id: rotated && existing ? existing.signing_key_id : null, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.columns(['account_id', 'host_device_id']).doUpdateSet({
      signing_key_id: signingKeyId, signing_public_key: input.signingPublicKey, agreement_key_id: agreementKeyId,
      agreement_public_key: input.agreementPublicKey, fingerprint, status: 'active',
      rotated_from_key_id: rotated && existing ? existing.signing_key_id : null, updated_at: now,
    })).execute();
    await upsertRegisteredKey(trx, { accountId, keyId: signingKeyId, deviceId: hostDeviceId, role: 'host', purpose: 'sign', publicKey: input.signingPublicKey });
    await upsertRegisteredKey(trx, { accountId, keyId: agreementKeyId, deviceId: hostDeviceId, role: 'host', purpose: 'agree', publicKey: input.agreementPublicKey });
    return { hostDeviceId, signingKeyId, agreementKeyId, fingerprint, status: 'active' as const, rotated };
  });
}

async function upsertRegisteredKey(db: DbOrTrx, k: { accountId: string; keyId: string; deviceId: string; role: 'host' | 'controller'; purpose: 'sign' | 'agree'; publicKey: string }): Promise<void> {
  await db.insertInto('shadow_registered_key').values({
    account_id: k.accountId, key_id: k.keyId, device_id: k.deviceId, role: k.role, purpose: k.purpose, public_key: k.publicKey, status: 'active', created_at: new Date(), revoked_at: null,
  }).onConflict((oc) => oc.columns(['account_id', 'key_id']).doUpdateSet({ device_id: k.deviceId, role: k.role, purpose: k.purpose, public_key: k.publicKey, status: 'active', revoked_at: null })).execute();
}

async function activeHostIdentity(db: DbOrTrx, accountId: string, hostDeviceId: string): Promise<DB['shadow_host_identity']> {
  const row = await db.selectFrom('shadow_host_identity').selectAll().where('account_id', '=', accountId).where('host_device_id', '=', hostDeviceId).executeTakeFirst();
  if (!row || row.status !== 'active') throw status('host identity not registered', 404);
  return row;
}

async function expirePendingEnrollmentRequestsForController(db: DbOrTrx, accountId: string, controllerDeviceId: string, nowMs: number): Promise<void> {
  await sql`
    WITH expired AS (
      SELECT r.account_id, r.session_id
      FROM shadow_enrollment_request r
      JOIN shadow_enrollment_session s
        ON s.account_id = r.account_id
       AND s.session_id = r.session_id
      WHERE r.account_id = ${accountId}
        AND r.controller_device_id = ${controllerDeviceId}
        AND r.status = 'pending'
        AND s.expires_at_ms <= ${nowMs}
    ),
    denied AS (
      UPDATE shadow_enrollment_request r
      SET status = 'denied', updated_at = now()
      FROM expired e
      WHERE r.account_id = e.account_id
        AND r.session_id = e.session_id
        AND r.status = 'pending'
      RETURNING r.account_id, r.session_id
    )
    UPDATE shadow_enrollment_session s
    SET status = 'cancelled', updated_at = now()
    FROM denied d
    WHERE s.account_id = d.account_id
      AND s.session_id = d.session_id
      AND s.status IN ('pending', 'consumed')
  `.execute(db);
}

// ── Enrollment session (host) ─────────────────────────────────────────────

export interface CreateEnrollmentSessionInput {
  accountId: string;
  hostDeviceId: string;
  sessionId: string;
  hostSigningKeyId: string;
  secretSalt: string; // base64url
  secretVerifier: string; // base64url peppered HMAC computed by the host
  relayOrigin: string;
  ttlMs?: number;
  expectedFingerprint?: string;
  nowMs: number;
}

export interface EnrollmentSessionView {
  sessionId: string;
  status: string;
  expiresAt: number;
  relayOrigin: string;
}

export async function createEnrollmentSession(input: CreateEnrollmentSessionInput): Promise<EnrollmentSessionView> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  const sessionId = requireId(input.sessionId, 'sessionId');
  const hostSigningKeyId = requireId(input.hostSigningKeyId, 'hostSigningKeyId');
  const secretSalt = requireB64(input.secretSalt, 'secretSalt');
  const secretVerifier = requireB64(input.secretVerifier, 'secretVerifier');
  const relayOrigin = String(input.relayOrigin ?? '');
  if (!allowedRelayOrigins().includes(relayOrigin)) throw status('relay origin not allowed', 403);
  const ttl = Math.min(input.ttlMs ?? SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS, SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS);
  if (ttl <= 0) throw status('bad ttl', 400);
  const expiresAt = input.nowMs + ttl;

  return getDb().transaction().execute(async (trx) => {
    await assertDeviceRole(trx, accountId, hostDeviceId, 'host', 'host not found');
    const identity = await activeHostIdentity(trx, accountId, hostDeviceId);
    if (identity.signing_key_id !== hostSigningKeyId) throw status('host signing key mismatch', 409);
    const now = new Date();
    await trx.insertInto('shadow_enrollment_session').values({
      account_id: accountId, session_id: sessionId, host_device_id: hostDeviceId, host_signing_key_id: hostSigningKeyId, relay_origin: relayOrigin,
      secret_salt: secretSalt, secret_verifier: secretVerifier, expected_fingerprint: input.expectedFingerprint ?? null, status: 'pending',
      created_at_ms: input.nowMs, expires_at_ms: expiresAt, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.columns(['account_id', 'session_id']).doNothing()).execute();
    const stored = await trx.selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
    if (!stored) throw status('session create failed', 500);
    if (stored.host_device_id !== hostDeviceId || stored.secret_verifier !== secretVerifier) throw status('session id already used', 409);
    return { sessionId, status: stored.status, expiresAt: Number(stored.expires_at_ms), relayOrigin };
  });
}

function bootstrapFromSession(session: DB['shadow_enrollment_session'], identity: DB['shadow_host_identity']): EnrollmentBootstrap {
  return {
    scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME,
    v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
    sessionId: session.session_id,
    accountId: session.account_id,
    hostDeviceId: session.host_device_id,
    hostSigningKeyId: session.host_signing_key_id,
    hostSigningPublicKey: identity.signing_public_key,
    hostAgreementPublicKey: identity.agreement_public_key,
    relayOrigin: session.relay_origin,
    secret: '', // never persisted; unused by verifyEnrollmentRequest
    expiresAt: Number(session.expires_at_ms),
  };
}

// ── Controller enrollment request (bootstrap-controller) ──────────────────

export interface SubmitEnrollmentRequestInput {
  accountId: string;
  sessionId: string;
  request: EnrollmentRequest;
  presentedSecret: string; // base64url one-time secret from the QR
  idempotencyKey?: string;
  nowMs: number;
}

export interface SubmitEnrollmentRequestView {
  sessionId: string;
  controllerDeviceId: string;
  status: 'pending';
  coalesced?: boolean;
}

/**
 * Controller submits its signed enrollment request + the one-time secret proof.
 * The controller signature (over the transcript) and the secret proof are both
 * verified BEFORE anything is persisted; the first valid request atomically
 * consumes the single-use session.
 */
export async function submitEnrollmentRequest(input: SubmitEnrollmentRequestInput): Promise<SubmitEnrollmentRequestView> {
  const accountId = requireId(input.accountId, 'accountId');
  const sessionId = requireId(input.sessionId, 'sessionId');
  const presentedSecret = decode32(requireB64(input.presentedSecret, 'presentedSecret'), 'presentedSecret');
  if (input.idempotencyKey !== undefined) requireId(input.idempotencyKey, 'idempotencyKey');
  const req = input.request;
  if (!req || typeof req !== 'object') throw status('bad request', 400);
  if (req.sessionId !== sessionId || req.accountId !== accountId) throw status('enrollment denied', 403);

  const session = await getDb().selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
  if (!session) throw status('enrollment denied', 403);
  if (session.status !== 'pending') {
    if (input.idempotencyKey) {
      const existing = await getDb().selectFrom('shadow_enrollment_request')
        .select(['controller_device_id', 'nonce'])
        .where('account_id', '=', accountId)
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      if (existing?.controller_device_id === req.controllerDeviceId && existing.nonce === req.nonce) {
        return { sessionId, controllerDeviceId: existing.controller_device_id, status: 'pending' as const, coalesced: true };
      }
    }
    throw status('enrollment already claimed', 409);
  }
  if (input.nowMs >= Number(session.expires_at_ms)) throw status('enrollment denied', 403);
  const identity = await activeHostIdentity(getDb(), accountId, session.host_device_id);
  const bootstrap = bootstrapFromSession(session, identity);

  const verified = await verifyEnrollmentRequest(backend, { request: req, bootstrap, expectedAccountId: accountId, nowMs: input.nowMs });
  if (!verified.ok) throw status('enrollment denied', 403);

  const secretOk = await verifyEnrollmentSecret(backend, {
    sessionId, accountId, presentedSecret,
    stored: { salt: session.secret_salt, verifier: session.secret_verifier }, pepper: ENROLLMENT_VERIFIER_PEPPER,
  });
  if (!secretOk) throw status('enrollment denied', 403);

  const controllerDeviceId = requireId(req.controllerDeviceId, 'controllerDeviceId');
  await expirePendingEnrollmentRequestsForController(getDb(), accountId, controllerDeviceId, input.nowMs);

  const activeGrant = await getDb().selectFrom('shadow_enrollment_grant')
    .select(['grant_id'])
    .where('account_id', '=', accountId)
    .where('controller_device_id', '=', controllerDeviceId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (activeGrant) throw status('controller already enrolled', 409);

  const pendingForController = await getDb().selectFrom('shadow_enrollment_request')
    .select(['session_id'])
    .where('account_id', '=', accountId)
    .where('controller_device_id', '=', controllerDeviceId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (pendingForController && pendingForController.session_id !== sessionId) {
    throw status('controller already enrolled', 409);
  }

  try {
    return await getDb().transaction().execute(async (trx) => {
      // Single-use consume: flip pending→consumed guarded on status, and insert the
      // one-per-session request row. Whichever wins the row insert wins the session.
      const consume = await trx.updateTable('shadow_enrollment_session').set({ status: 'consumed', updated_at: new Date() })
        .where('account_id', '=', accountId).where('session_id', '=', sessionId).where('status', '=', 'pending').executeTakeFirst();
      if (Number(consume.numUpdatedRows ?? 0) === 0) throw status('enrollment already claimed', 409);
      const now = new Date();
      const inserted = await trx.insertInto('shadow_enrollment_request').values({
        account_id: accountId, session_id: sessionId, controller_device_id: controllerDeviceId,
        controller_signing_key_id: req.controllerSigningKeyId, controller_agreement_key_id: req.controllerAgreementKeyId,
        signing_public_key: req.signingPublicKey, agreement_public_key: req.agreementPublicKey, nonce: req.nonce,
        requested_at_ms: req.requestedAt, transcript_hash: req.transcriptHash, signature: req.signature, status: 'pending',
        // Persist the CRYPTOGRAPHICALLY-VERIFIED requested set (bound in the controller
        // signature; `verifyEnrollmentRequest` returned it). Never a detached plain field.
        requested_capabilities: JSON.stringify(verified.requestedCapabilities),
        created_at: now, updated_at: now,
      }).onConflict((oc) => oc.columns(['account_id', 'session_id']).doNothing()).executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) throw status('enrollment already claimed', 409);
      return { sessionId, controllerDeviceId, status: 'pending' as const };
    });
  } catch (e) {
    if (isPgUniqueViolation(e, 'shadow_enrollment_one_pending_controller_idx')) {
      throw status('controller already enrolled', 409);
    }
    throw e;
  }
}

// ── Account-wise enrollment discovery + challenge ─────────────────────────

export interface AccountEnrollmentMacView {
  hostDeviceId: string;
  name: string;
  platform: string;
  fingerprint: string;
  online: boolean;
  lastSeen: number;
  leaseExpiresAt: number | null;
}

export async function listAccountEnrollmentMacs(input: { accountId: string; nowMs: number }): Promise<AccountEnrollmentMacView[]> {
  const accountId = requireId(input.accountId, 'accountId');
  const rows = await getDb().selectFrom('device as d')
    .innerJoin('shadow_host_identity as h', (j) => j.onRef('h.account_id', '=', 'd.user_id').onRef('h.host_device_id', '=', 'd.id'))
    .leftJoin('shadow_lease as l', (j) => j.onRef('l.account_id', '=', 'd.user_id').onRef('l.host_device_id', '=', 'd.id').on('l.scope_id', '=', accountScope(accountId)))
    .select([
      'd.id as host_device_id', 'd.name as name', 'd.platform as platform', 'd.last_seen_at as last_seen_at',
      'h.fingerprint as fingerprint', 'l.expires_at as lease_expires_at',
    ])
    .where('d.user_id', '=', accountId)
    .where('d.role', '=', 'host')
    .where('h.status', '=', 'active')
    .orderBy('d.last_seen_at', 'desc')
    .execute();
  return rows.map((r) => {
    const leaseExpiresAt = r.lease_expires_at ? new Date(r.lease_expires_at).getTime() : null;
    return {
      hostDeviceId: r.host_device_id,
      name: r.name,
      platform: r.platform,
      fingerprint: r.fingerprint,
      online: leaseExpiresAt !== null && leaseExpiresAt > input.nowMs,
      lastSeen: new Date(r.last_seen_at).getTime(),
      leaseExpiresAt,
    };
  });
}

export async function createAccountEnrollmentChallenge(input: {
  accountId: string;
  hostDeviceId: string;
  controllerDeviceId: string;
  requestedCapabilities: unknown;
  relayOrigin: string;
  ttlMs?: number;
  nowMs: number;
}): Promise<{ bootstrap: EnrollmentBootstrap; requestedCapabilities: ShadowCapability[] }> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  requireId(input.controllerDeviceId, 'controllerDeviceId');
  const relayOrigin = String(input.relayOrigin ?? '');
  if (!allowedRelayOrigins().includes(relayOrigin)) throw status('relay origin not allowed', 403);
  const requested = canonicalizeCapabilities(input.requestedCapabilities);
  if (!requested.ok) throw status('bad requested capabilities', 400);
  const ttl = Math.min(input.ttlMs ?? SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS, SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS);
  if (ttl <= 0) throw status('bad ttl', 400);

  return getDb().transaction().execute(async (trx) => {
    await assertDeviceRole(trx, accountId, hostDeviceId, 'host', 'host not found');
    const identity = await activeHostIdentity(trx, accountId, hostDeviceId);
    const lease = await trx.selectFrom('shadow_lease').selectAll()
      .where('account_id', '=', accountId)
      .where('scope_id', '=', accountScope(accountId))
      .where('host_device_id', '=', hostDeviceId)
      .executeTakeFirst();
    if (!lease || new Date(lease.expires_at).getTime() <= input.nowMs) throw status('host offline', 409);

    const sessionId = 'aes_' + base64urlEncode(backend.randomBytes(18));
    const challenge = backend.randomBytes(32);
    const salt = backend.randomBytes(16);
    const verifier = await makeEnrollmentSecretVerifier(backend, { sessionId, accountId, secret: challenge, salt, pepper: ENROLLMENT_VERIFIER_PEPPER });
    const expiresAt = input.nowMs + ttl;
    const now = new Date();
    await trx.insertInto('shadow_enrollment_session').values({
      account_id: accountId, session_id: sessionId, host_device_id: hostDeviceId, host_signing_key_id: identity.signing_key_id,
      relay_origin: relayOrigin, secret_salt: verifier.salt, secret_verifier: verifier.verifier,
      expected_fingerprint: `account:${input.controllerDeviceId}:${requested.capabilities.join(',')}`,
      status: 'pending', created_at_ms: input.nowMs, expires_at_ms: expiresAt, created_at: now, updated_at: now,
    }).execute();
    return {
      bootstrap: {
        scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME,
        v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
        sessionId,
        accountId,
        hostDeviceId,
        hostSigningKeyId: identity.signing_key_id,
        hostSigningPublicKey: identity.signing_public_key,
        hostAgreementPublicKey: identity.agreement_public_key,
        relayOrigin,
        secret: base64urlEncode(challenge),
        expiresAt,
      },
      requestedCapabilities: requested.capabilities,
    };
  });
}

// ── Host approve / deny / cancel ──────────────────────────────────────────

export interface ApproveEnrollmentInput {
  accountId: string;
  hostDeviceId: string; // the verified enrolled-host device
  sessionId: string;
  grant: EnrollmentGrantMessage;
  keyMaterial: EnrollmentKeyMaterial;
  controllerName?: string;
  controllerPlatform?: string;
  nowMs: number;
}

export interface ApproveEnrollmentView {
  grantId: string;
  controllerDeviceId: string;
  status: 'active';
  keyId: string;
  expiresAt: number;
}

export async function approveEnrollment(input: ApproveEnrollmentInput): Promise<ApproveEnrollmentView> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  const sessionId = requireId(input.sessionId, 'sessionId');
  const grant = input.grant;
  const km = input.keyMaterial;
  if (!grant || grant.family !== 'enrollment-grant' || grant.v !== 1) throw status('bad grant', 400);
  if (!km || typeof km !== 'object') throw status('bad key material', 400);
  const fence = grant.fence;
  if (!fence || fence.accountId !== accountId) throw status('grant account mismatch', 403);
  if (fence.hostDeviceId !== hostDeviceId) throw status('grant host mismatch', 403);
  if (fence.scopeId !== accountScope(accountId)) throw status('grant scope not account-owned', 403);
  const grantId = requireId(grant.grantId, 'grantId');
  const keyId = requireId(grant.keyId, 'keyId');
  if (km.keyId !== keyId || km.grantId !== grantId) throw status('key material mismatch', 400);
  const controllerDeviceId = requireId(grant.controllerDeviceId, 'controllerDeviceId');
  if (km.controllerDeviceId !== controllerDeviceId) throw status('key material controller mismatch', 400);
  requireB64(km.wrapNonce, 'wrapNonce');
  requireB64(km.wrappedScopeKey, 'wrappedScopeKey');
  requireB64(km.transcriptHash, 'transcriptHash');

  const identity = await activeHostIdentity(getDb(), accountId, hostDeviceId);
  const session = await getDb().selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
  if (!session) throw status('session not found', 404);
  if (session.host_device_id !== hostDeviceId) throw status('session host mismatch', 403);
  const request = await getDb().selectFrom('shadow_enrollment_request').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
  if (!request) throw status('no pending request', 404);
  if (request.controller_device_id !== controllerDeviceId) throw status('controller mismatch', 403);
  if (km.transcriptHash !== request.transcript_hash) throw status('transcript mismatch', 403);

  // The grant must be signed by the registered host key over the bound transcript.
  const hostSigningPub = base64urlDecode(identity.signing_public_key);
  const transcriptHash = base64urlDecode(request.transcript_hash);
  const grantOk = await verifyEnrollmentGrantSignature(backend, hostSigningPub, grant, transcriptHash);
  if (!grantOk) throw status('grant signature invalid', 401);

  return getDb().transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`enroll:${accountId}:${sessionId}`}, 0))`.execute(trx);
    // Re-read the session UNDER LOCK inside the transaction so approval binds the
    // authoritative status + expiry (no TOCTOU against a concurrent expiry, or a
    // race with approve/deny/cancel). A session consumed just before expiry must
    // NOT be approvable once nowMs has reached expires_at_ms.
    const locked = await trx.selectFrom('shadow_enrollment_session').selectAll()
      .where('account_id', '=', accountId).where('session_id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!locked) throw status('session not found', 404);
    if (locked.host_device_id !== hostDeviceId) throw status('session host mismatch', 403);
    if (locked.status !== 'consumed') throw status('session not awaiting approval', 409);
    // Boundary: nowMs == expires_at_ms is EXPIRED (half-open [created, expires)).
    if (input.nowMs >= Number(locked.expires_at_ms)) throw status('enrollment session expired', 403);
    // Guarded update predicated on account/session/host/status='consumed' AND
    // non-expired relative to the authoritative nowMs; assert exactly one row.
    const approve = await trx.updateTable('shadow_enrollment_session').set({ status: 'approved', updated_at: new Date() })
      .where('account_id', '=', accountId).where('session_id', '=', sessionId).where('host_device_id', '=', hostDeviceId)
      .where('status', '=', 'consumed').where('expires_at_ms', '>', input.nowMs).executeTakeFirst();
    if (Number(approve.numUpdatedRows ?? 0) !== 1) throw status('session not awaiting approval', 409);

    // CAPABILITY GATE (transactional): reload + LOCK the exact request row under the
    // advisory lock, and enforce the host-APPROVED set (bound in the signed grant) ⊆
    // the persisted controller-VERIFIED requested set (+ the account.read read floor).
    // The server rejects an approval beyond the request even from an authenticated host.
    const lockedReq = await trx.selectFrom('shadow_enrollment_request').selectAll()
      .where('account_id', '=', accountId).where('session_id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!lockedReq) throw status('no pending request', 404);
    const requestedCanon = canonicalizeCapabilities(lockedReq.requested_capabilities);
    if (!requestedCanon.ok) throw status('stored requested capabilities corrupt', 409);
    const approvedCanon = canonicalizeCapabilities(grant.capabilities);
    if (!approvedCanon.ok) throw status('bad approved capabilities', 400);
    const requestedSet = new Set<ShadowCapability>(requestedCanon.capabilities);
    for (const c of approvedCanon.capabilities) {
      if (c !== 'account.read' && !requestedSet.has(c)) throw status(`approved capability ${c} exceeds the verified requested set`, 403);
    }
    // Persist NULL when the grant carried NO capability field (legacy, signed without
    // it) so `pollEnrollment` reconstructs the byte-identical grant; else the bound set.
    const approvedCapabilities = grant.capabilities !== undefined ? JSON.stringify(approvedCanon.capabilities) : null;

    await trx.updateTable('shadow_enrollment_request').set({ status: 'approved', updated_at: new Date() }).where('account_id', '=', accountId).where('session_id', '=', sessionId).execute();

    const now = new Date();
    // Register the controller device (remote) + its keys so it can pass
    // enrolled-controller signed-request auth.
    await trx.insertInto('device').values({
      id: controllerDeviceId, user_id: accountId, role: 'remote', name: input.controllerName ?? 'Shadow Controller', platform: input.controllerPlatform ?? 'controller', deck_id: null, last_seen_at: now, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.column('id').doUpdateSet({ user_id: accountId, role: 'remote', last_seen_at: now, updated_at: now })).execute();
    await upsertRegisteredKey(trx, { accountId, keyId: request.controller_signing_key_id, deviceId: controllerDeviceId, role: 'controller', purpose: 'sign', publicKey: request.signing_public_key });
    await upsertRegisteredKey(trx, { accountId, keyId: request.controller_agreement_key_id, deviceId: controllerDeviceId, role: 'controller', purpose: 'agree', publicKey: request.agreement_public_key });
    // A previously-revoked controller re-enrolling becomes allowed again.
    await trx.deleteFrom('shadow_revoked_controller').where('account_id', '=', accountId).where('scope_id', '=', fence.scopeId).where('controller_device_id', '=', controllerDeviceId).execute();

    try {
      await trx.insertInto('shadow_enrollment_grant').values({
        account_id: accountId, grant_id: grantId, scope_id: fence.scopeId, session_id: sessionId, controller_device_id: controllerDeviceId, host_device_id: hostDeviceId,
        epoch: fence.epoch, lease_id: fence.leaseId, key_id: keyId, expires_at_ms: grant.expiresAt, signed_at_ms: grant.signedAt, grant_signature: grant.signature,
        wrap_nonce: km.wrapNonce, wrapped_scope_key: km.wrappedScopeKey, transcript_hash: km.transcriptHash, status: 'active', key_rotation_id: null, revoked_at_ms: null,
        approved_capabilities: approvedCapabilities, created_at: now, updated_at: now,
      }).execute();
    } catch (e) {
      // unique (account, scope, controller) or PK (account, grant_id) conflict
      throw status('controller already enrolled', 409);
    }
    return { grantId, controllerDeviceId, status: 'active' as const, keyId, expiresAt: grant.expiresAt };
  });
}

export async function denyEnrollment(input: { accountId: string; hostDeviceId: string; sessionId: string }): Promise<{ ok: true; status: 'denied' }> {
  const accountId = requireId(input.accountId, 'accountId');
  const sessionId = requireId(input.sessionId, 'sessionId');
  return getDb().transaction().execute(async (trx) => {
    const session = await trx.selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
    if (!session) throw status('session not found', 404);
    if (session.host_device_id !== input.hostDeviceId) throw status('session host mismatch', 403);
    if (session.status === 'approved') throw status('session already approved', 409);
    await trx.updateTable('shadow_enrollment_session').set({ status: 'denied', updated_at: new Date() }).where('account_id', '=', accountId).where('session_id', '=', sessionId).execute();
    await trx.updateTable('shadow_enrollment_request').set({ status: 'denied', updated_at: new Date() }).where('account_id', '=', accountId).where('session_id', '=', sessionId).execute();
    return { ok: true as const, status: 'denied' as const };
  });
}

export async function cancelEnrollment(input: { accountId: string; hostDeviceId: string; sessionId: string }): Promise<{ ok: true; status: 'cancelled' }> {
  const accountId = requireId(input.accountId, 'accountId');
  const sessionId = requireId(input.sessionId, 'sessionId');
  return getDb().transaction().execute(async (trx) => {
    const session = await trx.selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
    if (!session) throw status('session not found', 404);
    if (session.host_device_id !== input.hostDeviceId) throw status('session host mismatch', 403);
    if (session.status === 'approved') throw status('session already approved', 409);
    await trx.updateTable('shadow_enrollment_session').set({ status: 'cancelled', updated_at: new Date() }).where('account_id', '=', accountId).where('session_id', '=', sessionId).execute();
    return { ok: true as const, status: 'cancelled' as const };
  });
}

export async function listEnrollmentSessions(input: { accountId: string; hostDeviceId: string }): Promise<Array<{ sessionId: string; status: string; controllerDeviceId: string | null; expiresAt: number; requestedAt: number | null }>> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  const rows = await getDb().selectFrom('shadow_enrollment_session as s')
    .leftJoin('shadow_enrollment_request as r', (j) => j.onRef('r.account_id', '=', 's.account_id').onRef('r.session_id', '=', 's.session_id'))
    .select(['s.session_id as session_id', 's.status as status', 's.expires_at_ms as expires_at_ms', 'r.controller_device_id as controller_device_id', 'r.requested_at_ms as requested_at_ms'])
    .where('s.account_id', '=', accountId).where('s.host_device_id', '=', hostDeviceId).orderBy('s.created_at', 'desc').execute();
  return rows.map((r) => ({ sessionId: r.session_id, status: r.status, controllerDeviceId: r.controller_device_id ?? null, expiresAt: Number(r.expires_at_ms), requestedAt: r.requested_at_ms === null || r.requested_at_ms === undefined ? null : Number(r.requested_at_ms) }));
}

/**
 * Enrolled-host: read the PUBLIC material of pending enrollment requests so the
 * host can (a) render a short authentication string / verification phrase over
 * the signed transcript and (b) build the grant + wrap the scope key to the
 * controller's X25519 agreement key before calling `approveEnrollment`.
 *
 * Phase 3A2a addition (additive, read-only): every field returned here is
 * already stored and is PUBLIC — controller device id, key ids, raw signing /
 * agreement public keys, the request nonce, the requested-at time, and the
 * signed transcript hash. The one-time secret plaintext, the peppered
 * verifier/salt, private keys, and the wrapped scope key are NEVER returned.
 * Only requests whose session is still awaiting approval (`consumed`) and whose
 * request is `pending` are listed.
 */
export async function listPendingEnrollmentRequests(input: { accountId: string; hostDeviceId: string }): Promise<Array<{
  sessionId: string;
  controllerDeviceId: string;
  controllerSigningKeyId: string;
  controllerAgreementKeyId: string;
  signingPublicKey: string;
  agreementPublicKey: string;
  nonce: string;
  requestedAt: number;
  transcriptHash: string;
  relayOrigin: string;
  sessionExpiresAt: number;
  /** Controller-signed requested capability set (canonical, verified at submit). */
  requestedCapabilities: string[];
}>> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  const rows = await getDb().selectFrom('shadow_enrollment_request as r')
    .innerJoin('shadow_enrollment_session as s', (j) => j.onRef('s.account_id', '=', 'r.account_id').onRef('s.session_id', '=', 'r.session_id'))
    .select([
      'r.session_id as session_id', 'r.controller_device_id as controller_device_id',
      'r.controller_signing_key_id as controller_signing_key_id', 'r.controller_agreement_key_id as controller_agreement_key_id',
      'r.signing_public_key as signing_public_key', 'r.agreement_public_key as agreement_public_key',
      'r.nonce as nonce', 'r.requested_at_ms as requested_at_ms', 'r.transcript_hash as transcript_hash',
      'r.requested_capabilities as requested_capabilities',
      's.relay_origin as relay_origin', 's.expires_at_ms as expires_at_ms',
    ])
    .where('r.account_id', '=', accountId)
    .where('s.host_device_id', '=', hostDeviceId)
    .where('r.status', '=', 'pending')
    .where('s.status', '=', 'consumed')
    .orderBy('s.created_at', 'desc')
    .execute();
  return rows.map((r) => ({
    sessionId: r.session_id,
    controllerDeviceId: r.controller_device_id,
    controllerSigningKeyId: r.controller_signing_key_id,
    controllerAgreementKeyId: r.controller_agreement_key_id,
    signingPublicKey: r.signing_public_key,
    agreementPublicKey: r.agreement_public_key,
    nonce: r.nonce,
    requestedAt: Number(r.requested_at_ms),
    transcriptHash: r.transcript_hash,
    relayOrigin: r.relay_origin,
    sessionExpiresAt: Number(r.expires_at_ms),
    // Canonicalise on read too (fail-closed to account.read on a corrupt legacy row).
    requestedCapabilities: safeCaps(r.requested_capabilities),
  }));
}

export async function listEnrolledControllers(input: { accountId: string }): Promise<Array<{ controllerDeviceId: string; grantId: string; keyId: string; status: string; expiresAt: number; approvedCapabilities: string[] }>> {
  const accountId = requireId(input.accountId, 'accountId');
  const rows = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).orderBy('created_at', 'desc').execute();
  return rows.map((r) => ({ controllerDeviceId: r.controller_device_id, grantId: r.grant_id, keyId: r.key_id, status: r.status, expiresAt: Number(r.expires_at_ms), approvedCapabilities: safeCaps(r.approved_capabilities) }));
}

// ── Controller poll (bootstrap-controller) ────────────────────────────────

export interface PollEnrollmentInput {
  accountId: string;
  sessionId: string;
  controllerDeviceId: string;
  nonce: string;
  timestampMs: number;
  signature: string; // base64url over CONTROLLER_POLL_DOMAIN
  nowMs: number;
}

function pollBytes(accountId: string, sessionId: string, controllerDeviceId: string, nonce: string, timestampMs: number): Uint8Array {
  return structuredEncode(CONTROLLER_POLL_DOMAIN, [accountId, sessionId, controllerDeviceId, nonce, timestampMs]);
}

/**
 * Controller polls the status of its own enrollment. Gated by a signature made
 * with the exact signing key it registered in the request, so only that
 * controller can read the grant + wrapped key (relay privacy). The relay only
 * ever returns ciphertext + public metadata; it cannot decrypt the scope key.
 */
export async function pollEnrollment(input: PollEnrollmentInput): Promise<{ status: string; grant?: Record<string, unknown> }> {
  const accountId = requireId(input.accountId, 'accountId');
  const sessionId = requireId(input.sessionId, 'sessionId');
  const controllerDeviceId = requireId(input.controllerDeviceId, 'controllerDeviceId');
  const nonce = requireId(input.nonce, 'nonce');
  const timestampMs = requireInt(input.timestampMs, 'timestampMs');
  const signature = base64urlDecode(requireB64(input.signature, 'signature'));
  if (Math.abs(input.nowMs - timestampMs) > SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS) throw status('poll stale', 401);

  const request = await getDb().selectFrom('shadow_enrollment_request').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
  if (!request || request.controller_device_id !== controllerDeviceId) throw status('poll denied', 403);
  const controllerSigningPub = base64urlDecode(request.signing_public_key);
  const ok = await backend.verify(controllerSigningPub, pollBytes(accountId, sessionId, controllerDeviceId, nonce, timestampMs), signature);
  if (!ok) throw status('poll denied', 403);

  const session = await getDb().selectFrom('shadow_enrollment_session').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).executeTakeFirst();
  const sessionStatus = session?.status ?? 'unknown';
  if (sessionStatus !== 'approved') return { status: sessionStatus };
  const grant = await getDb().selectFrom('shadow_enrollment_grant').selectAll().where('account_id', '=', accountId).where('session_id', '=', sessionId).where('controller_device_id', '=', controllerDeviceId).executeTakeFirst();
  if (!grant || grant.status !== 'active') return { status: grant ? 'revoked' : sessionStatus };
  return {
    status: 'approved',
    grant: {
      grant: {
        family: 'enrollment-grant', v: 1,
        fence: { accountId, scopeId: grant.scope_id, hostDeviceId: grant.host_device_id, epoch: grant.epoch, leaseId: grant.lease_id },
        controllerDeviceId, grantId: grant.grant_id, expiresAt: Number(grant.expires_at_ms), keyId: grant.key_id, signedAt: Number(grant.signed_at_ms),
        // Include the bound capability set ONLY when the grant was signed WITH it (non-null),
        // so the reconstructed grant is byte-identical to what the host signed.
        ...(grant.approved_capabilities ? { capabilities: grant.approved_capabilities } : {}),
        signature: grant.grant_signature,
      },
      keyMaterial: {
        sessionId, grantId: grant.grant_id, keyId: grant.key_id, controllerDeviceId,
        wrapNonce: grant.wrap_nonce, wrappedScopeKey: grant.wrapped_scope_key, transcriptHash: grant.transcript_hash, createdAt: Number(grant.signed_at_ms),
      },
    },
  };
}

// ── Atomic revocation / rotation ──────────────────────────────────────────

export interface RevokeControllerInput {
  accountId: string;
  hostDeviceId: string; // verified enrolled-host device
  scopeId: string;
  controllerDeviceId: string;
  revocation: DeviceRevocationMessage;
  effectiveSeq: number;
  remainingRotations?: Array<{ controllerDeviceId: string; grantId: string; keyId: string; wrapNonce: string; wrappedScopeKey: string }>;
  nowMs: number;
}

/**
 * Canonical SHA-256 of a revocation request: identity + payload + signature +
 * the NORMALIZED (sorted, shape-fixed) remaining rotations. Two revocations are
 * an exact replay iff their digests match; any differing field/rotation yields a
 * different digest and is treated as a conflict.
 */
function revocationRequestDigest(input: {
  accountId: string; scopeId: string; controllerDeviceId: string; hostDeviceId: string;
  keyRotationId: string; revokedAt: number; effectiveSeq: number; signature: string;
  rotations: ReadonlyArray<{ controllerDeviceId: string; grantId: string; keyId: string; wrapNonce: string; wrappedScopeKey: string }>;
}): string {
  // Total composite order over ALL rotation fields, so caller ordering is
  // semantically irrelevant (a reordered but identical set yields the same digest).
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const rotations = [...input.rotations]
    .map((r) => ({ c: r.controllerDeviceId, g: r.grantId, k: r.keyId, n: r.wrapNonce, w: r.wrappedScopeKey }))
    .sort((a, b) => cmp(a.c, b.c) || cmp(a.g, b.g) || cmp(a.k, b.k) || cmp(a.n, b.n) || cmp(a.w, b.w));
  const canonical = JSON.stringify([
    'maestro.shadow.revocation-request.v2',
    input.accountId, input.scopeId, input.controllerDeviceId, input.hostDeviceId,
    input.keyRotationId, input.revokedAt, input.effectiveSeq, input.signature, rotations,
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Atomic controller revocation. In one transaction: verifies the host-signed
 * revocation, marks the grant + registered keys + revoked-controller enforcement
 * row, wipes the controller's cursors/commands/capabilities/transport, records
 * the signed revocation, and stores any host-provided rewrapped rotations for the
 * remaining controllers (ciphertext only — no plaintext scope key ever reaches
 * the server). An EXACT replay of the same signed revocation (identical identity,
 * payload, signature, and rotations) is idempotent; any CONFLICTING second
 * revocation for the same (account, scope, controller) is rejected with 409 and
 * the original record is left byte-identical (no collateral row mutation).
 */
export async function revokeEnrolledController(input: RevokeControllerInput): Promise<{ ok: true; keyRotationId: string; alreadyRevoked: boolean }> {
  const accountId = requireId(input.accountId, 'accountId');
  const hostDeviceId = requireId(input.hostDeviceId, 'hostDeviceId');
  const scopeId = requireId(input.scopeId, 'scopeId');
  const controllerDeviceId = requireId(input.controllerDeviceId, 'controllerDeviceId');
  const effectiveSeq = requireInt(input.effectiveSeq, 'effectiveSeq');
  const m = input.revocation;
  if (!m || m.family !== 'device-revocation' || m.v !== 1) throw status('bad revocation', 400);
  if (scopeId !== accountScope(accountId)) throw status('scope not account-owned', 403);
  if (m.fence.accountId !== accountId || m.fence.scopeId !== scopeId || m.fence.hostDeviceId !== hostDeviceId) throw status('revocation fence mismatch', 403);
  if (m.controllerDeviceId !== controllerDeviceId) throw status('revocation controller mismatch', 403);
  const keyRotationId = requireId(m.keyRotationId, 'keyRotationId');

  // Normalize + validate the remaining-controller rotations BEFORE any mutation:
  // shape, no rotation to the revoked controller, and no duplicate target. Each
  // rotation binds an explicit grantId (checked against the active grant in-tx).
  const seenTargets = new Set<string>();
  const rotations = (input.remainingRotations ?? []).map((r) => {
    const rc = requireId(r.controllerDeviceId, 'rotation controller');
    if (rc === controllerDeviceId) throw status('cannot rotate to revoked controller', 400);
    if (seenTargets.has(rc)) throw status('duplicate rotation target', 400);
    seenTargets.add(rc);
    return {
      controllerDeviceId: rc,
      grantId: requireId(r.grantId, 'rotation grantId'),
      keyId: requireId(r.keyId, 'rotation keyId'),
      wrapNonce: requireB64(r.wrapNonce, 'rotation wrapNonce'),
      wrappedScopeKey: requireB64(r.wrappedScopeKey, 'rotation wrappedScopeKey'),
    };
  });
  const requestDigest = revocationRequestDigest({ accountId, scopeId, controllerDeviceId, hostDeviceId, keyRotationId, revokedAt: m.revokedAt, effectiveSeq, signature: m.signature, rotations });

  const identity = await activeHostIdentity(getDb(), accountId, hostDeviceId);
  const hostSigningPub = base64urlDecode(identity.signing_public_key);
  const good = await verifyDeviceRevocation(backend, hostSigningPub, m);
  if (!good) throw status('revocation signature invalid', 401);

  return getDb().transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`revoke:${accountId}:${scopeId}:${controllerDeviceId}`}, 0))`.execute(trx);
    // Read the existing record UNDER LOCK before any mutation. History is
    // immutable: ONLY a non-null digest that exactly matches the recomputed
    // full-payload digest (and the core fields) is idempotent. A legacy row with
    // a NULL digest is UNVERIFIABLE (we cannot prove identical wrapped rotations)
    // and FAILS CLOSED with 409 — never idempotent, never mutated, never
    // backfilled. Any other difference is likewise a 409 conflict, leaving the
    // record + all collateral rows untouched.
    const existing = await trx.selectFrom('shadow_revocation_record').selectAll()
      .where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', controllerDeviceId)
      .forUpdate().executeTakeFirst();
    if (existing) {
      if (existing.request_digest == null) throw status('unverifiable legacy revocation', 409);
      const coreMatch = existing.key_rotation_id === keyRotationId
        && Number(existing.revoked_at_ms) === m.revokedAt
        && existing.effective_seq === effectiveSeq
        && existing.revocation_signature === m.signature
        && existing.host_device_id === hostDeviceId;
      if (existing.request_digest === requestDigest && coreMatch) return { ok: true as const, keyRotationId, alreadyRevoked: true };
      throw status('conflicting revocation', 409);
    }

    // First revocation for this (account, scope, controller): the record is
    // immutable — a plain insert (no doUpdateSet). Concurrent first inserts are
    // serialized by the advisory lock above, so exactly one reaches this insert
    // and any concurrent replay/conflict is resolved by the re-read on the branch
    // above.
    await trx.insertInto('shadow_revocation_record').values({
      account_id: accountId, scope_id: scopeId, controller_device_id: controllerDeviceId, key_rotation_id: keyRotationId, revoked_at_ms: m.revokedAt, effective_seq: effectiveSeq, revocation_signature: m.signature, host_device_id: hostDeviceId, request_digest: requestDigest, created_at: new Date(),
    }).execute();

    // Enforcement row read by the relay's assertControllerAllowed.
    await trx.insertInto('shadow_revoked_controller').values({ account_id: accountId, scope_id: scopeId, controller_device_id: controllerDeviceId, revoked_at: new Date(), key_rotation_effective_seq: effectiveSeq })
      .onConflict((oc) => oc.columns(['account_id', 'scope_id', 'controller_device_id']).doUpdateSet({ revoked_at: new Date(), key_rotation_effective_seq: effectiveSeq })).execute();

    // Immediate signed-request auth denial.
    await trx.updateTable('shadow_registered_key').set({ status: 'revoked', revoked_at: new Date() }).where('account_id', '=', accountId).where('device_id', '=', controllerDeviceId).execute();
    await trx.updateTable('shadow_enrollment_grant').set({ status: 'revoked', revoked_at_ms: m.revokedAt, key_rotation_id: keyRotationId, updated_at: new Date() }).where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', controllerDeviceId).execute();

    // A revoked controller must not retain any pending/consumed enrollment path.
    // This is part of the same transaction as the grant revoke + scope rotation,
    // so retries observe a single server truth: revoked controller, pending0.
    await sql`
      WITH cancelled AS (
        UPDATE shadow_enrollment_request
        SET status = 'denied', updated_at = now()
        WHERE account_id = ${accountId}
          AND controller_device_id = ${controllerDeviceId}
          AND status = 'pending'
        RETURNING account_id, session_id
      )
      UPDATE shadow_enrollment_session s
      SET status = 'cancelled', updated_at = now()
      FROM cancelled c
      WHERE s.account_id = c.account_id
        AND s.session_id = c.session_id
        AND s.status IN ('pending', 'consumed')
    `.execute(trx);

    // Invalidate outstanding controller state/capabilities/transport.
    await trx.deleteFrom('shadow_cursor').where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', controllerDeviceId).execute();
    await trx.deleteFrom('shadow_command').where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', controllerDeviceId).execute();
    await trx.deleteFrom('shadow_blob_capability').where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', controllerDeviceId).execute();
    await trx.deleteFrom('shadow_transport').where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', controllerDeviceId).execute();

    // Store host-provided rewrapped rotations for the remaining controllers
    // (ciphertext + public metadata only). Each rotation is bound to the EXACT
    // active target grant (account/scope/controller/grantId/status='active'); a
    // wrong grantId → no matching row → 409 and the whole revoke rolls back (no
    // collateral mutation). Shape/duplicate/self-target were already rejected.
    for (const rot of rotations) {
      const upd = await trx.updateTable('shadow_enrollment_grant').set({ key_id: rot.keyId, wrap_nonce: rot.wrapNonce, wrapped_scope_key: rot.wrappedScopeKey, key_rotation_id: keyRotationId, updated_at: new Date() })
        .where('account_id', '=', accountId).where('scope_id', '=', scopeId).where('controller_device_id', '=', rot.controllerDeviceId).where('grant_id', '=', rot.grantId).where('status', '=', 'active').executeTakeFirst();
      if (Number(upd.numUpdatedRows ?? 0) !== 1) throw status('rotation target not enrolled', 409);
    }
    return { ok: true as const, keyRotationId, alreadyRevoked: false };
  });
}
