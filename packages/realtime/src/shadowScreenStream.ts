/**
 * shadowScreenStream — Phase 3D1 ephemeral, view-only, end-to-end-encrypted live
 * screen-stream protocol (Section B). This is a SEPARATE protocol from the durable
 * command / state-delta transcript (`shadowProtocol.ts`): it is intentionally NOT
 * part of `ShadowWireMessage`, never persisted, and carries NO remote input of any
 * kind. There is no `screen.input`/pointer/keyboard/clipboard family here — the wire
 * vocabulary below is the complete surface, and a controller can only ever RECEIVE
 * frames, never send an input event.
 *
 * Security model (mirrors the enrolled-authority + HKDF + AES-GCM pattern already
 * used by `shadowEnrollment.wrapKeyFor` and `shadowDataCodec`):
 *   - A per-stream 256-bit key is derived from the ENROLLED host/controller X25519
 *     agreement authority (no new long-term secret, no secret cloning) mixed with
 *     FRESH per-stream host + controller nonces, so every stream (even between the
 *     same enrolled pair) gets an independent key.
 *   - The key derivation `info` and every frame's AEAD `aad` bind accountId,
 *     hostDeviceId, controllerDeviceId, grantId, scopeId, fence epoch, streamId,
 *     source-policy id, codec and dimensions. Any mismatch (wrong stream / fence /
 *     epoch / source / key epoch) makes the AEAD open fail closed.
 *   - Each frame carries a strictly-monotonic uint64 sequence and a key epoch; the
 *     receiver rejects replay / duplicate / reorder / old-key / oversize / expired.
 *   - Frame bytes are opaque ciphertext on the wire; the relay cannot decrypt.
 *
 * This module is PURE (no ambient time / RNG / IO): all randomness (nonces) and
 * clocks are passed in by the host/controller coordinators, so it is fully
 * deterministic and Node-testable.
 */

import {
  SHADOW_AES_KEY_BYTES,
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  structuredEncode,
  type ShadowCryptoBackend,
  type StructuredPart,
} from './shadowCrypto.js';
import { screenViewPermittedBy, type ShadowCapability } from './shadowCapabilities.js';
import type { Fence } from './shadowProtocol.js';

export const SHADOW_SCREEN_STREAM_VERSION = 1 as const;
export type ShadowScreenStreamVersion = typeof SHADOW_SCREEN_STREAM_VERSION;

/** Foreground stream lifetime cap; a stream is torn down at/after this. */
export const SHADOW_SCREEN_STREAM_MAX_TTL_MS = 15 * 60_000;
/** Hard upper bound on a single encrypted frame (ciphertext incl. tag). */
export const SHADOW_SCREEN_FRAME_MAX_BYTES = 900_000;
/** Max encoded binary envelope (header + ciphertext). */
export const SHADOW_SCREEN_ENVELOPE_MAX_BYTES = SHADOW_SCREEN_FRAME_MAX_BYTES + 64;
/** Aspect-fit maximum dimension for a captured frame. */
export const SHADOW_SCREEN_MAX_DIMENSION = 1280;
export const SHADOW_SCREEN_MIN_DIMENSION = 16;
/** Adaptive frame-rate band. */
export const SHADOW_SCREEN_MIN_FPS = 2;
export const SHADOW_SCREEN_MAX_FPS = 10;
export const SHADOW_SCREEN_TARGET_FPS = 8;
/** Reject a capture timestamp implausibly far in the future (clock-skew guard). */
export const SHADOW_SCREEN_MAX_CLOCK_SKEW_MS = 60_000;

export const SHADOW_SCREEN_CODECS = ['jpeg', 'webp'] as const;
export type ShadowScreenCodec = (typeof SHADOW_SCREEN_CODECS)[number];
const CODEC_TO_BYTE: Record<ShadowScreenCodec, number> = { jpeg: 0, webp: 1 };
const BYTE_TO_CODEC: Record<number, ShadowScreenCodec> = { 0: 'jpeg', 1: 'webp' };

const SHADOW_SCREEN_ENVELOPE_MAGIC = 0x53435231; // 'SCR1'
const SHADOW_SCREEN_HEADER_BYTES = 4 /*magic*/ + 1 /*version*/ + 1 /*codec*/ + 4 /*keyEpoch*/ + 8 /*seq*/ + 8 /*captureTs*/ + 2 /*w*/ + 2 /*h*/ + 4 /*ctLen*/;
const NONCE_BYTES = 12;

// Key-schedule v2 (Phase 3D1 correction, closes L1): the leaseId + lease expiry are
// now bound into the HKDF `info` and every frame AAD, so a key/frame is cryptographically
// tied to the exact lease it was authorised under. Fail-closed vs any v1 vector — the
// screen protocol has no deployed clients, so this is a clean break.
const KEY_SALT_DOMAIN = 'maestro.shadow.screen-stream.v2.key-salt';
const KEY_INFO_DOMAIN = 'maestro.shadow.screen-stream.v2.key-info';
const FRAME_AAD_DOMAIN = 'maestro.shadow.screen-stream.v2.frame-aad';
const CONTROL_DOMAIN = 'maestro.shadow.screen-control.v1'; // domain-separate from durable commands
/** Signed control clock-skew tolerance (issuedAt must be within ± this of now). */
export const SHADOW_SCREEN_CONTROL_CLOCK_SKEW_MS = 60_000;
/** The relay's placeholder stream id for a transport-local teardown (see notes on
 * `verifyScreenControl`) — unsigned, may ONLY cause a conservative STOP. */
export const SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID = 'relay';

/** M-A / B2-R1: the ONLY `sourcePolicyId` a controller may request. It is a deferral,
 * not a selection — "capture whatever display the HOST has confirmed." The controller
 * never names a concrete display (it cannot enumerate them), so a remote can never
 * choose the source; the host substitutes its operator-confirmed display and echoes the
 * real id in the signed accept (which both sides then bind into the key + frame AAD).
 * A request naming any OTHER concrete id is rejected (`source-lost`). */
export const SHADOW_SCREEN_HOST_CONFIGURED_SOURCE = 'host-configured-display';

// ---------------------------------------------------------------------------
// Source policy: the host binds exactly ONE allowed capture source to the grant.
// The controller can never select an arbitrary display or enumerate window titles;
// it only ever references the opaque `sourcePolicyId`. `label` is the human name
// the host chose to show ("Built-in Retina Display · 1512×982") — never a window
// title or app name.
// ---------------------------------------------------------------------------
export interface ScreenSourcePolicy {
  readonly sourcePolicyId: string;
  readonly kind: 'display';
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/** The immutable per-stream binding, agreed at start/accept and bound into the key
 * and every frame's AAD. width/height are the negotiated output dimensions. */
export interface ScreenStreamBinding {
  readonly streamId: string;
  readonly accountId: string;
  readonly hostDeviceId: string;
  readonly controllerDeviceId: string;
  readonly grantId: string;
  readonly scopeId: string;
  readonly epoch: number;
  /** The lease this stream is authorised under (L1: bound into key + frame AAD). */
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly sourcePolicyId: string;
  readonly codec: ShadowScreenCodec;
  readonly width: number;
  readonly height: number;
}

/** The authority context both peers hold, bound into every signed control transcript. */
export interface ScreenControlBinding {
  readonly accountId: string;
  readonly hostDeviceId: string;
  readonly controllerDeviceId: string;
  readonly grantId: string;
  readonly scopeId: string;
  readonly epoch: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly streamId: string;
}

// ---------------------------------------------------------------------------
// Control messages (separate ephemeral vocabulary; discriminated on `kind`).
// These are relayed as JSON; frames are relayed as the binary envelope below.
// ---------------------------------------------------------------------------

export type ScreenStreamStatus =
  | 'starting'
  | 'live'
  | 'permission-required'
  | 'permission-denied'
  | 'busy'
  | 'source-lost'
  | 'source-required'
  | 'error'
  | 'stopped'
  | 'revoked'
  | 'expired';

export type ScreenSignerRole = 'controller' | 'host';

/** The Ed25519 signature envelope every AUTHORITATIVE control message carries
 * (Phase 3D1 correction, H1). `controlNonce` is a fresh 16-byte b64url replay nonce;
 * `signerKeyId` names the enrolled signing key; `signature` is over the canonical
 * transcript (see `signScreenControl`). Optional in the type only because the relay's
 * transport-local teardown (see `isRelayTeardownControl`) is unsigned and may cause a
 * conservative STOP only. */
export interface ScreenControlSignatureEnvelope {
  readonly signerRole?: ScreenSignerRole;
  readonly signerKeyId?: string;
  readonly controlNonce?: string; // base64url, 16 bytes
  readonly signature?: string;    // base64url Ed25519
}

/** controller → host: request to begin a view-only stream. */
export interface ScreenStartRequest {
  readonly kind: 'screen-start';
  readonly v: ShadowScreenStreamVersion;
  readonly streamId: string;
  readonly accountId: string;
  readonly hostDeviceId: string;
  readonly controllerDeviceId: string;
  readonly grantId: string;
  readonly scopeId: string;
  readonly epoch: number;
  readonly leaseId: string;
  readonly sourcePolicyId: string;
  readonly requestedCodec: ShadowScreenCodec;
  readonly requestedMaxDimension: number;
  readonly requestedFps: number;
  readonly controllerNonce: string; // base64url, 16 bytes
  readonly requestedAt: number;
  readonly expiresAt: number;
}

/** host → controller: stream accepted; carries the host nonce + negotiated params. */
export interface ScreenAcceptMessage {
  readonly kind: 'screen-accept';
  readonly v: ShadowScreenStreamVersion;
  readonly streamId: string;
  readonly hostNonce: string; // base64url, 16 bytes
  readonly codec: ShadowScreenCodec;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly keyEpoch: number;
  readonly sourcePolicyId: string;
  readonly sourceLabel: string;
  readonly acceptedAt: number;
  readonly expiresAt: number;
}

/** host → controller: a truthful status transition (no live-before-first-frame). */
export interface ScreenStatusMessage {
  readonly kind: 'screen-status';
  readonly v: ShadowScreenStreamVersion;
  readonly streamId: string;
  readonly status: ScreenStreamStatus;
  readonly fps?: number;
  readonly reason?: string; // bounded, generic — NEVER a title/path/key
  readonly at: number;
}

/** either → peer: stop the stream. */
export interface ScreenStopMessage {
  readonly kind: 'screen-stop';
  readonly v: ShadowScreenStreamVersion;
  readonly streamId: string;
  readonly reason: string; // bounded, generic
  readonly at: number;
}

export type ScreenControlMessage =
  | ScreenStartRequest
  | ScreenAcceptMessage
  | ScreenStatusMessage
  | ScreenStopMessage;

// ---------------------------------------------------------------------------
// Small, strict validators (mirror the shadowProtocol decode idiom).
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const B64URL_16_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes → 22 base64url chars, no padding

function isSafeId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}
function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function isBoundedReason(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 120;
}
function isCodec(v: unknown): v is ShadowScreenCodec {
  return v === 'jpeg' || v === 'webp';
}
function isNonce16(v: unknown): v is string {
  return typeof v === 'string' && B64URL_16_RE.test(v);
}

/** Reject if a status is not one of the enumerated truthful states. */
const STATUS_SET: ReadonlySet<string> = new Set<ScreenStreamStatus>([
  'starting', 'live', 'permission-required', 'permission-denied', 'busy',
  'source-lost', 'source-required', 'error', 'stopped', 'revoked', 'expired',
]);

export type DecodeScreenControlResult =
  | { ok: true; message: ScreenControlMessage }
  | { ok: false; reason: string };

/**
 * Strict, fail-closed decoder for a relayed control message. Rejects unknown
 * kinds, malformed ids/nonces, out-of-band dimensions/fps, and TTLs beyond the
 * foreground cap. `nowMs` (optional) enforces expiry / clock-skew.
 */
export function decodeScreenControl(value: unknown, opts?: { nowMs?: number }): DecodeScreenControlResult {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not-object' };
  const m = value as Record<string, unknown>;
  if (m.v !== SHADOW_SCREEN_STREAM_VERSION) return { ok: false, reason: 'bad-version' };
  const nowMs = opts?.nowMs;
  switch (m.kind) {
    case 'screen-start': {
      if (!isSafeId(m.streamId) || !isSafeId(m.accountId) || !isSafeId(m.hostDeviceId) || !isSafeId(m.controllerDeviceId)
        || !isSafeId(m.grantId) || !isSafeId(m.scopeId) || !isSafeId(m.leaseId) || !isSafeId(m.sourcePolicyId)) return { ok: false, reason: 'bad-id' };
      if (!isSafeInt(m.epoch) || m.epoch <= 0) return { ok: false, reason: 'bad-epoch' };
      if (!isCodec(m.requestedCodec)) return { ok: false, reason: 'bad-codec' };
      if (!isSafeInt(m.requestedMaxDimension) || m.requestedMaxDimension < SHADOW_SCREEN_MIN_DIMENSION || m.requestedMaxDimension > SHADOW_SCREEN_MAX_DIMENSION) return { ok: false, reason: 'bad-dimension' };
      if (!isSafeInt(m.requestedFps) || m.requestedFps < SHADOW_SCREEN_MIN_FPS || m.requestedFps > SHADOW_SCREEN_MAX_FPS) return { ok: false, reason: 'bad-fps' };
      if (!isNonce16(m.controllerNonce)) return { ok: false, reason: 'bad-nonce' };
      if (!isSafeInt(m.requestedAt) || !isSafeInt(m.expiresAt)) return { ok: false, reason: 'bad-time' };
      if (m.expiresAt <= m.requestedAt || m.expiresAt - m.requestedAt > SHADOW_SCREEN_STREAM_MAX_TTL_MS) return { ok: false, reason: 'bad-ttl' };
      if (nowMs !== undefined && m.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
      return { ok: true, message: m as unknown as ScreenStartRequest };
    }
    case 'screen-accept': {
      if (!isSafeId(m.streamId) || !isSafeId(m.sourcePolicyId)) return { ok: false, reason: 'bad-id' };
      if (!isNonce16(m.hostNonce)) return { ok: false, reason: 'bad-nonce' };
      if (!isCodec(m.codec)) return { ok: false, reason: 'bad-codec' };
      if (!isSafeInt(m.width) || m.width < SHADOW_SCREEN_MIN_DIMENSION || m.width > SHADOW_SCREEN_MAX_DIMENSION) return { ok: false, reason: 'bad-width' };
      if (!isSafeInt(m.height) || m.height < SHADOW_SCREEN_MIN_DIMENSION || m.height > SHADOW_SCREEN_MAX_DIMENSION) return { ok: false, reason: 'bad-height' };
      if (!isSafeInt(m.fps) || m.fps < SHADOW_SCREEN_MIN_FPS || m.fps > SHADOW_SCREEN_MAX_FPS) return { ok: false, reason: 'bad-fps' };
      if (!isSafeInt(m.keyEpoch)) return { ok: false, reason: 'bad-key-epoch' };
      if (typeof m.sourceLabel !== 'string' || m.sourceLabel.length > 120) return { ok: false, reason: 'bad-label' };
      if (!isSafeInt(m.acceptedAt) || !isSafeInt(m.expiresAt)) return { ok: false, reason: 'bad-time' };
      if (nowMs !== undefined && m.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
      return { ok: true, message: m as unknown as ScreenAcceptMessage };
    }
    case 'screen-status': {
      if (!isSafeId(m.streamId)) return { ok: false, reason: 'bad-id' };
      if (typeof m.status !== 'string' || !STATUS_SET.has(m.status)) return { ok: false, reason: 'bad-status' };
      if (m.reason !== undefined && !isBoundedReason(m.reason)) return { ok: false, reason: 'bad-reason' };
      if (m.fps !== undefined && (!isSafeInt(m.fps) || m.fps < SHADOW_SCREEN_MIN_FPS || m.fps > SHADOW_SCREEN_MAX_FPS)) return { ok: false, reason: 'bad-fps' };
      if (!isSafeInt(m.at)) return { ok: false, reason: 'bad-time' };
      return { ok: true, message: m as unknown as ScreenStatusMessage };
    }
    case 'screen-stop': {
      if (!isSafeId(m.streamId)) return { ok: false, reason: 'bad-id' };
      if (!isBoundedReason(m.reason)) return { ok: false, reason: 'bad-reason' };
      if (!isSafeInt(m.at)) return { ok: false, reason: 'bad-time' };
      return { ok: true, message: m as unknown as ScreenStopMessage };
    }
    default:
      return { ok: false, reason: 'unknown-kind' };
  }
}

// ---------------------------------------------------------------------------
// Signed control plane (Phase 3D1 correction, H1). Every AUTHORITATIVE control
// message is Ed25519-signed by the enrolled signer of the originating role and
// verified by the peer against the enrolled signing PUBLIC key + the current
// authority binding, BEFORE it changes any live/authoritative state. The relay is
// untrusted: it can neither forge a `screen-start` (→ unsolicited host capture) nor
// spoof an `accept`/`status` (→ fake viewer UI). Domain-separated from durable
// commands. Message-specific canonical body per kind; the binding (account/host/
// controller/grant/scope/epoch/lease/leaseExpiry/streamId) is bound into every
// transcript so a signature is valid ONLY for the exact stream + authority.
// ---------------------------------------------------------------------------

function controlIssuedAt(msg: ScreenControlMessage): number {
  switch (msg.kind) {
    case 'screen-start': return msg.requestedAt;
    case 'screen-accept': return msg.acceptedAt;
    case 'screen-status': return msg.at;
    case 'screen-stop': return msg.at;
  }
}

function controlBody(msg: ScreenControlMessage): StructuredPart[] {
  switch (msg.kind) {
    case 'screen-start':
      return ['start', msg.sourcePolicyId, msg.requestedCodec, msg.requestedMaxDimension, msg.requestedFps, msg.controllerNonce, msg.requestedAt, msg.expiresAt];
    case 'screen-accept':
      return ['accept', msg.hostNonce, msg.codec, msg.width, msg.height, msg.fps, msg.keyEpoch, msg.sourcePolicyId, msg.sourceLabel, msg.acceptedAt, msg.expiresAt];
    case 'screen-status':
      return ['status', msg.status, msg.fps ?? 0, msg.reason ?? '', msg.at];
    case 'screen-stop':
      return ['stop', msg.reason, msg.at];
  }
}

function controlTranscript(msg: ScreenControlMessage, role: ScreenSignerRole, signerKeyId: string, controlNonce: string, binding: ScreenControlBinding): Uint8Array {
  return structuredEncode(CONTROL_DOMAIN, [
    SHADOW_SCREEN_STREAM_VERSION,
    msg.kind,
    role,
    signerKeyId,
    controlNonce,
    binding.accountId,
    binding.hostDeviceId,
    binding.controllerDeviceId,
    binding.grantId,
    binding.scopeId,
    binding.epoch,
    binding.leaseId, // stable lease identity is signed; leaseExpiresAt is a local
    // freshness gate only (see verifyScreenControl) so a lease RENEWAL never
    // invalidates an in-flight signature.
    binding.streamId,
    ...controlBody(msg),
  ]);
}

/**
 * Sign a control message. Returns the message with the signature envelope filled in
 * (`signerRole`, `signerKeyId`, `controlNonce`, `signature`). `controlNonce` is a
 * fresh 16-byte b64url value the caller supplies.
 */
export async function signScreenControl<M extends ScreenControlMessage>(
  backend: ShadowCryptoBackend,
  signingPrivateKey: Uint8Array,
  input: { role: ScreenSignerRole; signerKeyId: string; controlNonce: string; message: M; binding: ScreenControlBinding },
): Promise<M & ScreenControlSignatureEnvelope> {
  const sig = await backend.sign(signingPrivateKey, controlTranscript(input.message, input.role, input.signerKeyId, input.controlNonce, input.binding));
  return { ...input.message, signerRole: input.role, signerKeyId: input.signerKeyId, controlNonce: input.controlNonce, signature: base64urlEncode(sig) };
}

export interface VerifyScreenControlEnv {
  readonly nowMs: number;
  /** Per-stream replay cache; verify ADDS a nonce on success and rejects reuse. */
  readonly seenControlNonces: Set<string>;
}
export type VerifyScreenControlResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a signed control message against the peer's enrolled signing PUBLIC key +
 * the current authority binding. Fail-closed on: wrong signer role (reflection), bad
 * key id / nonce / signature shape, clock-skew (issuedAt beyond ± tolerance), expired
 * lease, replayed control nonce, or a bad signature (forgery / tamper / cross-stream /
 * cross-account/host/grant/epoch/lease — all bound in the transcript).
 */
export async function verifyScreenControl(
  backend: ShadowCryptoBackend,
  signingPublicKey: Uint8Array,
  expectedRole: ScreenSignerRole,
  msg: ScreenControlMessage & ScreenControlSignatureEnvelope,
  binding: ScreenControlBinding,
  env: VerifyScreenControlEnv,
): Promise<VerifyScreenControlResult> {
  if (msg.signerRole !== expectedRole) return { ok: false, reason: 'wrong-role' };
  if (typeof msg.signerKeyId !== 'string' || !isSafeId(msg.signerKeyId)) return { ok: false, reason: 'bad-key-id' };
  if (!isNonce16(msg.controlNonce)) return { ok: false, reason: 'bad-control-nonce' };
  if (typeof msg.signature !== 'string' || msg.signature.length === 0 || msg.signature.length > 200 || !/^[A-Za-z0-9_-]+$/.test(msg.signature)) return { ok: false, reason: 'bad-signature' };
  const issuedAt = controlIssuedAt(msg);
  if (!Number.isSafeInteger(issuedAt) || Math.abs(env.nowMs - issuedAt) > SHADOW_SCREEN_CONTROL_CLOCK_SKEW_MS) return { ok: false, reason: 'clock-skew' };
  if (!Number.isSafeInteger(binding.leaseExpiresAt) || binding.leaseExpiresAt <= env.nowMs) return { ok: false, reason: 'lease-expired' };
  const nonceKey = `${expectedRole}:${msg.controlNonce}`;
  if (env.seenControlNonces.has(nonceKey)) return { ok: false, reason: 'replay' };
  let sig: Uint8Array;
  try { sig = base64urlDecode(msg.signature); } catch { return { ok: false, reason: 'bad-signature' }; }
  const transcript = controlTranscript(msg, expectedRole, msg.signerKeyId, msg.controlNonce, binding);
  const ok = await backend.verify(signingPublicKey, transcript, sig);
  if (!ok) return { ok: false, reason: 'bad-signature' };
  env.seenControlNonces.add(nonceKey);
  return { ok: true };
}

/**
 * TRUE only for the relay's transport-local teardown control (unsigned): a
 * `screen-stop` or `screen-status:stopped` with the reserved relay stream id. These
 * may cause a conservative STOP ONLY — never start/live/permission/accept — so a
 * disconnected/malicious relay can at worst end a stream, never begin or spoof one.
 */
export function isRelayTeardownControl(msg: ScreenControlMessage): boolean {
  if (msg.streamId !== SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID) return false;
  return msg.kind === 'screen-stop' || (msg.kind === 'screen-status' && msg.status === 'stopped');
}

// ---------------------------------------------------------------------------
// Per-stream key derivation (enrolled X25519 authority + fresh nonces → HKDF).
// ---------------------------------------------------------------------------

export interface DeriveScreenStreamKeyInput {
  readonly backend: ShadowCryptoBackend;
  /** THIS side's enrolled X25519 agreement private key. */
  readonly selfAgreementPrivate: Uint8Array;
  /** The PEER's enrolled X25519 agreement public key. */
  readonly peerAgreementPublic: Uint8Array;
  readonly hostNonce: Uint8Array;
  readonly controllerNonce: Uint8Array;
  readonly binding: ScreenStreamBinding;
  readonly keyEpoch: number;
}

/**
 * Derive the 256-bit per-stream AES-GCM key. Because X25519 is symmetric, the host
 * (selfPriv=hostAgreementPriv, peerPub=controllerAgreementPub) and the controller
 * (selfPriv=controllerAgreementPriv, peerPub=hostAgreementPub) derive the SAME key.
 * Fresh host+controller nonces are folded into the HKDF salt so every stream (and
 * every rotation epoch) has an independent key even between the same enrolled pair.
 */
export async function deriveScreenStreamKey(input: DeriveScreenStreamKeyInput): Promise<Uint8Array> {
  const { backend, binding } = input;
  if (input.hostNonce.length !== 16 || input.controllerNonce.length !== 16) throw new Error('bad-nonce-length');
  const shared = await backend.deriveSharedSecret(input.selfAgreementPrivate, input.peerAgreementPublic);
  const salt = structuredEncode(KEY_SALT_DOMAIN, [input.hostNonce, input.controllerNonce, binding.streamId, input.keyEpoch]);
  const info = structuredEncode(KEY_INFO_DOMAIN, [
    SHADOW_SCREEN_STREAM_VERSION,
    input.keyEpoch,
    binding.accountId,
    binding.hostDeviceId,
    binding.controllerDeviceId,
    binding.grantId,
    binding.scopeId,
    binding.epoch,
    binding.leaseId,        // L1: the STABLE lease identity is bound into the key
    // schedule. leaseExpiresAt is intentionally NOT bound (it is a renewable timestamp
    // both peers derive independently and can't agree on to the ms — it is enforced
    // procedurally at start/verify instead).
    binding.streamId,
    binding.sourcePolicyId,
    binding.codec,
    binding.width,
    binding.height,
  ]);
  return backend.hkdfSha256(shared, salt, info, SHADOW_AES_KEY_BYTES);
}

// ---------------------------------------------------------------------------
// Frame nonce + AAD + binary envelope.
// ---------------------------------------------------------------------------

function writeU32BE(view: DataView, offset: number, n: number): void {
  view.setUint32(offset, n >>> 0, false);
}
function writeU64BE(view: DataView, offset: number, n: number): void {
  // n is a non-negative safe integer; split into hi/lo 32-bit halves.
  const hi = Math.floor(n / 0x100000000);
  const lo = n % 0x100000000;
  view.setUint32(offset, hi, false);
  view.setUint32(offset + 4, lo, false);
}
function readU64BE(view: DataView, offset: number): number {
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  return hi * 0x100000000 + lo;
}

/** 12-byte deterministic nonce: 4-byte keyEpoch ‖ 8-byte seq (big-endian). Unique
 * per (keyEpoch, seq); combined with strict monotonic seq this guarantees GCM
 * nonce uniqueness without transmitting the nonce. */
function frameNonce(keyEpoch: number, seq: number): Uint8Array {
  const n = new Uint8Array(NONCE_BYTES);
  const view = new DataView(n.buffer);
  writeU32BE(view, 0, keyEpoch);
  writeU64BE(view, 4, seq);
  return n;
}

function frameAad(binding: ScreenStreamBinding, keyEpoch: number, seq: number, captureTsMs: number, width: number, height: number, codec: ShadowScreenCodec): Uint8Array {
  return structuredEncode(FRAME_AAD_DOMAIN, [
    SHADOW_SCREEN_STREAM_VERSION,
    binding.streamId,
    binding.accountId,
    binding.hostDeviceId,
    binding.controllerDeviceId,
    binding.grantId,
    binding.scopeId,
    binding.epoch,
    binding.leaseId,        // L1: stable lease identity bound into every frame AAD
    binding.sourcePolicyId,
    keyEpoch,
    seq,
    captureTsMs,
    width,
    height,
    codec,
  ]);
}

export interface ScreenFrameMeta {
  readonly keyEpoch: number;
  readonly seq: number;
  readonly captureTsMs: number;
  readonly width: number;
  readonly height: number;
  readonly codec: ShadowScreenCodec;
}

/**
 * Seal a raw (JPEG/WebP) frame into an opaque binary envelope. The header fields
 * (keyEpoch/seq/captureTs/w/h/codec) are authenticated via the AAD, so any tamper
 * flips the GCM tag and the receiver rejects it.
 */
export async function sealScreenFrame(
  backend: ShadowCryptoBackend,
  key: Uint8Array,
  binding: ScreenStreamBinding,
  meta: ScreenFrameMeta,
  frameBytes: Uint8Array,
): Promise<Uint8Array> {
  if (meta.codec !== binding.codec) throw new Error('codec-mismatch');
  if (meta.width !== binding.width || meta.height !== binding.height) throw new Error('dimension-mismatch');
  if (frameBytes.length === 0 || frameBytes.length > SHADOW_SCREEN_FRAME_MAX_BYTES) throw new Error('frame-size');
  const nonce = frameNonce(meta.keyEpoch, meta.seq);
  const aad = frameAad(binding, meta.keyEpoch, meta.seq, meta.captureTsMs, meta.width, meta.height, meta.codec);
  const ct = await backend.aesGcmSeal(key, nonce, frameBytes, aad);
  const header = new Uint8Array(SHADOW_SCREEN_HEADER_BYTES);
  const view = new DataView(header.buffer);
  writeU32BE(view, 0, SHADOW_SCREEN_ENVELOPE_MAGIC);
  header[4] = SHADOW_SCREEN_STREAM_VERSION;
  header[5] = CODEC_TO_BYTE[meta.codec];
  writeU32BE(view, 6, meta.keyEpoch);
  writeU64BE(view, 10, meta.seq);
  writeU64BE(view, 18, meta.captureTsMs);
  view.setUint16(26, meta.width, false);
  view.setUint16(28, meta.height, false);
  writeU32BE(view, 30, ct.length);
  return concatBytes(header, ct);
}

export interface ParsedScreenFrameHeader {
  readonly keyEpoch: number;
  readonly seq: number;
  readonly captureTsMs: number;
  readonly width: number;
  readonly height: number;
  readonly codec: ShadowScreenCodec;
  readonly ciphertextLength: number;
}

export type ParseScreenHeaderResult =
  | { ok: true; header: ParsedScreenFrameHeader }
  | { ok: false; reason: string };

/** Parse + bound-check the envelope header WITHOUT decrypting (cheap pre-filter). */
export function parseScreenFrameHeader(envelope: Uint8Array): ParseScreenHeaderResult {
  if (envelope.length < SHADOW_SCREEN_HEADER_BYTES) return { ok: false, reason: 'truncated' };
  if (envelope.length > SHADOW_SCREEN_ENVELOPE_MAX_BYTES) return { ok: false, reason: 'oversize' };
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  if (view.getUint32(0, false) !== SHADOW_SCREEN_ENVELOPE_MAGIC) return { ok: false, reason: 'bad-magic' };
  if (envelope[4] !== SHADOW_SCREEN_STREAM_VERSION) return { ok: false, reason: 'bad-version' };
  const codec = BYTE_TO_CODEC[envelope[5]!];
  if (!codec) return { ok: false, reason: 'bad-codec' };
  const keyEpoch = view.getUint32(6, false);
  const seq = readU64BE(view, 10);
  const captureTsMs = readU64BE(view, 18);
  const width = view.getUint16(26, false);
  const height = view.getUint16(28, false);
  const ciphertextLength = view.getUint32(30, false);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(captureTsMs)) return { ok: false, reason: 'bad-int' };
  if (width < SHADOW_SCREEN_MIN_DIMENSION || width > SHADOW_SCREEN_MAX_DIMENSION) return { ok: false, reason: 'bad-width' };
  if (height < SHADOW_SCREEN_MIN_DIMENSION || height > SHADOW_SCREEN_MAX_DIMENSION) return { ok: false, reason: 'bad-height' };
  if (ciphertextLength <= 0 || ciphertextLength > SHADOW_SCREEN_FRAME_MAX_BYTES) return { ok: false, reason: 'bad-ct-len' };
  if (SHADOW_SCREEN_HEADER_BYTES + ciphertextLength !== envelope.length) return { ok: false, reason: 'length-mismatch' };
  return { ok: true, header: { keyEpoch, seq, captureTsMs, width, height, codec, ciphertextLength } };
}

// ---------------------------------------------------------------------------
// ScreenFrameSender (host side) — monotonic seq, rotation awareness.
// ---------------------------------------------------------------------------

export class ScreenFrameSender {
  private seq = 0;
  private disposed = false;
  constructor(
    private readonly backend: ShadowCryptoBackend,
    private key: Uint8Array,
    private readonly binding: ScreenStreamBinding,
    private keyEpoch: number,
  ) {}

  /** Seal the next frame; seq auto-increments and is never reused. */
  async seal(frameBytes: Uint8Array, captureTsMs: number): Promise<Uint8Array> {
    if (this.disposed) throw new Error('sender-disposed');
    this.seq += 1;
    return sealScreenFrame(this.backend, this.key, this.binding, {
      keyEpoch: this.keyEpoch,
      seq: this.seq,
      captureTsMs,
      width: this.binding.width,
      height: this.binding.height,
      codec: this.binding.codec,
    }, frameBytes);
  }

  // NOTE (Phase 3D1 correction, M3): there is NO in-stream key rotation. Streams
  // hard-expire at SHADOW_SCREEN_STREAM_MAX_TTL_MS (15 min) — a ≤ ~9,000-frame ceiling
  // at 10 fps, far below the uint64 seq / nonce limit — and every reconnect derives a
  // fresh stream + key. The dead rotate/needsRotation API was removed.
  currentKeyEpoch(): number {
    return this.keyEpoch;
  }
  currentSeq(): number {
    return this.seq;
  }

  private zeroKey(): void {
    this.key.fill(0);
  }
  dispose(): void {
    this.disposed = true;
    this.zeroKey();
  }
}

// ---------------------------------------------------------------------------
// ScreenFrameReceiver (controller side) — replay / reorder / old-key / expiry.
// ---------------------------------------------------------------------------

export type ScreenFrameAcceptResult =
  | { ok: true; frameBytes: Uint8Array; meta: ScreenFrameMeta }
  | { ok: false; reason: string };

export interface ScreenFrameReceiverOptions {
  readonly expiresAtMs: number;
}

export class ScreenFrameReceiver {
  private lastSeq = 0;
  private disposed = false;
  constructor(
    private readonly backend: ShadowCryptoBackend,
    private key: Uint8Array,
    private readonly binding: ScreenStreamBinding,
    private keyEpoch: number,
    private readonly options: ScreenFrameReceiverOptions,
  ) {}

  /**
   * Verify + decrypt a frame envelope. Rejects (fail-closed, generic reason):
   * truncated / oversize / bad-magic / wrong version / wrong codec / dimension
   * mismatch / wrong key epoch / replay / duplicate / reorder / expired / clock-skew
   * / auth-failed (tamper / wrong stream / fence / source — all bound in the AAD).
   */
  async accept(envelope: Uint8Array, nowMs: number): Promise<ScreenFrameAcceptResult> {
    if (this.disposed) return { ok: false, reason: 'receiver-disposed' };
    if (nowMs >= this.options.expiresAtMs) return { ok: false, reason: 'expired' };
    const parsed = parseScreenFrameHeader(envelope);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const h = parsed.header;
    if (h.codec !== this.binding.codec) return { ok: false, reason: 'codec-mismatch' };
    if (h.width !== this.binding.width || h.height !== this.binding.height) return { ok: false, reason: 'dimension-mismatch' };
    if (h.keyEpoch !== this.keyEpoch) return { ok: false, reason: h.keyEpoch < this.keyEpoch ? 'old-key' : 'future-key' };
    if (h.seq <= this.lastSeq) return { ok: false, reason: 'replay-or-reorder' };
    if (h.captureTsMs > nowMs + SHADOW_SCREEN_MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'clock-skew' };
    const ct = envelope.subarray(SHADOW_SCREEN_HEADER_BYTES);
    const nonce = frameNonce(h.keyEpoch, h.seq);
    const aad = frameAad(this.binding, h.keyEpoch, h.seq, h.captureTsMs, h.width, h.height, h.codec);
    const plain = await this.backend.aesGcmOpen(this.key, nonce, ct, aad);
    if (plain === null) return { ok: false, reason: 'auth-failed' };
    // Commit the sequence ONLY after a successful authenticated decrypt.
    this.lastSeq = h.seq;
    return {
      ok: true,
      frameBytes: plain,
      meta: { keyEpoch: h.keyEpoch, seq: h.seq, captureTsMs: h.captureTsMs, width: h.width, height: h.height, codec: h.codec },
    };
  }

  // No in-stream key rotation (M3): a fresh stream + key is derived on every
  // reconnect; the receiver rejects any frame whose keyEpoch differs from its own.
  currentKeyEpoch(): number {
    return this.keyEpoch;
  }
  lastAcceptedSeq(): number {
    return this.lastSeq;
  }

  private zeroKey(): void {
    this.key.fill(0);
  }
  dispose(): void {
    this.disposed = true;
    this.zeroKey();
  }
}

// ---------------------------------------------------------------------------
// Consent gate — the single authority the host coordinator consults at stream
// start time. Grant is necessary but NOT sufficient: EVERY field must line up.
// ---------------------------------------------------------------------------

export interface ScreenAuthoritySnapshot {
  readonly fence: Fence;
  readonly leaseExpiresAtMs: number;
  readonly grantedCapabilities: readonly ShadowCapability[];
  readonly revokedControllerDeviceIds: readonly string[];
  readonly hostOnline: boolean;
  readonly configuredSourcePolicyId: string | null;
  readonly foreground: boolean;
}

export type ScreenStartDenyStatus = Extract<
  ScreenStreamStatus,
  'permission-required' | 'permission-denied' | 'busy' | 'error' | 'revoked' | 'expired' | 'source-lost' | 'source-required'
>;
export type ScreenStartDecision =
  | { ok: true }
  | { ok: false; status: ScreenStartDenyStatus; reason: string };

/**
 * Fail-closed decision for whether a `screen-start` may proceed, evaluated against
 * the host's LIVE authority (never a cached/static/requested list). Returns a
 * structured deny with a bounded generic reason. `sourceAvailable` and
 * `permissionGranted` are supplied by the native bridge preflight.
 */
export function decideScreenStart(
  req: ScreenStartRequest,
  authority: ScreenAuthoritySnapshot,
  env: { nowMs: number; activeViewerDeviceId: string | null; permission: 'granted' | 'denied' | 'undetermined'; sourceAvailable: boolean },
): ScreenStartDecision {
  // Authority fence must match exactly.
  const f = authority.fence;
  if (req.accountId !== f.accountId || req.hostDeviceId !== f.hostDeviceId || req.scopeId !== f.scopeId || req.epoch !== f.epoch || req.leaseId !== f.leaseId) {
    return { ok: false, status: 'error', reason: 'authority mismatch' };
  }
  if (!authority.hostOnline) return { ok: false, status: 'error', reason: 'host offline' };
  if (authority.revokedControllerDeviceIds.includes(req.controllerDeviceId)) return { ok: false, status: 'revoked', reason: 'access revoked' };
  if (authority.leaseExpiresAtMs <= env.nowMs || req.expiresAt <= env.nowMs) return { ok: false, status: 'expired', reason: 'session expired' };
  if (!screenViewPermittedBy(authority.grantedCapabilities)) return { ok: false, status: 'permission-denied', reason: 'screen viewing not granted' };
  // M-A / B2-R1: the host must have EXPLICITLY confirmed a display before any capture.
  // No configured source is a distinct, truthful state (host shows a "configure" CTA),
  // not a transient loss. The controller may ONLY request the deferral sentinel (or,
  // defensively, the exact configured id); any OTHER concrete id is a remote attempting
  // to select a source it can't name → rejected source-lost. The remote never chooses.
  if (authority.configuredSourcePolicyId === null) {
    return { ok: false, status: 'source-required', reason: 'no display configured for viewing' };
  }
  const defersToHostSource =
    req.sourcePolicyId === SHADOW_SCREEN_HOST_CONFIGURED_SOURCE ||
    req.sourcePolicyId === authority.configuredSourcePolicyId;
  if (!defersToHostSource) {
    return { ok: false, status: 'source-lost', reason: 'requested source is not the configured display' };
  }
  if (!authority.foreground) return { ok: false, status: 'error', reason: 'controller not in foreground' };
  if (env.permission === 'denied') return { ok: false, status: 'permission-denied', reason: 'screen recording permission denied' };
  if (env.permission !== 'granted') return { ok: false, status: 'permission-required', reason: 'screen recording permission required' };
  if (!env.sourceAvailable) return { ok: false, status: 'source-lost', reason: 'capture source unavailable' };
  // One active viewer max: a second controller gets Busy, never steals.
  if (env.activeViewerDeviceId !== null && env.activeViewerDeviceId !== req.controllerDeviceId) {
    return { ok: false, status: 'busy', reason: 'another device is viewing' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Nonce helpers (host/controller coordinators call these with the crypto backend).
// ---------------------------------------------------------------------------

export function freshStreamNonce(backend: ShadowCryptoBackend): { bytes: Uint8Array; b64: string } {
  const bytes = backend.randomBytes(16);
  return { bytes, b64: base64urlEncode(bytes) };
}
export function decodeStreamNonce(b64: string): Uint8Array {
  const bytes = base64urlDecode(b64);
  if (bytes.length !== 16) throw new Error('bad-nonce-length');
  return bytes;
}
