/**
 * shadowDataCodec — Phase 3A2a shared, portable codec that binds the enrolled
 * account scope key to the durable data/command plane. Both the desktop host
 * (Node backend) and the Expo controller (noble backend) use it, so the exact
 * same AES-256-GCM framing is produced and consumed on each side.
 *
 * KEY SEPARATION (3A2a re-review finding 3): the raw account scope key is NEVER
 * used directly for AES-GCM / HMAC. Instead `deriveScopeKeyring` runs HKDF-SHA256
 * over the scope key with a versioned salt and a per-purpose `info` label to
 * derive FIVE independent 256-bit subkeys — one each for event-payload AEAD,
 * event-nonce PRF, command-envelope AEAD, command-ack MAC, and command-ack AEAD.
 * The derivation context binds account/scope/keyId/version, so a subkey from one
 * scope/keyId/version can never open another's ciphertext, and a compromise of one
 * purpose's subkey never yields the others. The raw scope key only ever enters
 * HKDF extract/expand; the derived ring is zeroizable (`dispose`).
 *
 * Three surfaces:
 *  1. Event payloads (host → controller). `ShadowHostCore.appendEvent` stores the
 *     GCM nonce+tag in a local column and puts ONLY the ciphertext on the wire,
 *     so the wire event is not self-decryptable. The host relay port therefore
 *     RE-SEALS the plaintext (obtained via `host.decryptEventPayload`) into a
 *     self-contained wire envelope — deterministic nonce = HMAC(event-nonce-prf
 *     subkey, keyId+full fence+eventId+seq+payloadDigest) so re-publish is
 *     idempotent, AAD binds the ciphertext to the exact event — which the
 *     controller opens with the same derived ring. `ShadowHostCore` is not
 *     modified.
 *  2. Command envelopes (controller → host): random-nonce envelope under the
 *     command-envelope AEAD subkey.
 *  3. Command ACKs (host → controller): command-ack AEAD envelope + a command-ack
 *     MAC subkey HMAC over the canonical ACK so the controller's control-message
 *     verifier can independently authenticate host authorship.
 *
 * The relay only ever sees ciphertext + digests.
 */
import {
  base64urlEncode,
  base64urlDecode,
  utf8Encode,
  utf8Decode,
  structuredEncode,
  concatBytes,
  constantTimeEqual,
  SHADOW_AES_GCM_NONCE_BYTES,
  type ShadowCryptoBackend,
} from './shadowCrypto.js';
import type { Fence, ShadowStateEvent, HostCommandAck } from './shadowProtocol.js';

/**
 * Codec family/version. Bound into the HKDF derivation context AND the AAD/binding
 * domains, so a version bump yields entirely independent subkeys + framing. No
 * released data exists at v1; unsupported/legacy framing fails closed (there is no
 * ambiguous fallback path — mismatched derivation simply fails the GCM/MAC open).
 */
export const SHADOW_DATA_CODEC_VERSION = 2;

const EVENT_NONCE_DOMAIN = 'maestro.shadow.event-nonce.v2';
const EVENT_PAYLOAD_DOMAIN = 'maestro.shadow.event-payload.v2';
const SCOPE_ENVELOPE_DOMAIN = 'maestro.shadow.scope-envelope.v2';
const COMMAND_ACK_DOMAIN = 'maestro.shadow.command-ack.v2';

/** Versioned HKDF salt (extract phase). */
const HKDF_SALT = utf8Encode('maestro.shadow.data-codec.hkdf-salt.v2');
/** Domain for the per-purpose HKDF `info` (expand phase). */
const SUBKEY_INFO_DOMAIN = 'maestro.shadow.data-codec.subkey.v2';

/** The distinct cryptographic purposes; each gets an independent HKDF subkey. */
export type ScopeSubkeyPurpose =
  | 'event-payload-aead'
  | 'event-nonce-prf'
  | 'command-envelope-aead'
  | 'command-ack-mac'
  | 'command-ack-aead';

const SUBKEY_PURPOSES: readonly ScopeSubkeyPurpose[] = [
  'event-payload-aead', 'event-nonce-prf', 'command-envelope-aead', 'command-ack-mac', 'command-ack-aead',
];

/** Context that scopes a keyring to one (account, scope, keyId, codec version). */
export interface ScopeKeyringContext {
  accountId: string;
  scopeId: string;
  keyId: string;
}

/**
 * A ring of HKDF-derived, purpose-separated subkeys for one scope key + context.
 * The raw scope key is not retained. `dispose()` zeroizes every subkey.
 */
export interface ScopeKeyring {
  readonly accountId: string;
  readonly scopeId: string;
  readonly keyId: string;
  readonly version: number;
  readonly eventPayloadAead: Uint8Array;
  readonly eventNoncePrf: Uint8Array;
  readonly commandEnvelopeAead: Uint8Array;
  readonly commandAckMac: Uint8Array;
  readonly commandAckAead: Uint8Array;
  dispose(): void;
}

function subkeyInfo(ctx: ScopeKeyringContext, purpose: ScopeSubkeyPurpose): Uint8Array {
  return structuredEncode(SUBKEY_INFO_DOMAIN, [purpose, SHADOW_DATA_CODEC_VERSION, ctx.accountId, ctx.scopeId, ctx.keyId]);
}

/**
 * Derive the purpose-separated subkey ring from a raw scope key via HKDF-SHA256.
 * The raw key only enters HKDF here; callers hold the returned ring and dispose it
 * on stop/rotation.
 */
export async function deriveScopeKeyring(
  backend: ShadowCryptoBackend,
  scopeKey: Uint8Array,
  ctx: ScopeKeyringContext,
): Promise<ScopeKeyring> {
  const [eventPayloadAead, eventNoncePrf, commandEnvelopeAead, commandAckMac, commandAckAead] = await Promise.all(
    SUBKEY_PURPOSES.map((purpose) => backend.hkdfSha256(scopeKey, HKDF_SALT, subkeyInfo(ctx, purpose), 32)),
  );
  let disposed = false;
  return {
    accountId: ctx.accountId, scopeId: ctx.scopeId, keyId: ctx.keyId, version: SHADOW_DATA_CODEC_VERSION,
    eventPayloadAead, eventNoncePrf, commandEnvelopeAead, commandAckMac, commandAckAead,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const k of [eventPayloadAead, eventNoncePrf, commandEnvelopeAead, commandAckMac, commandAckAead]) k.fill(0);
    },
  };
}

/** The full, immutable, authoritative binding for an event. */
type EventBinding = Pick<ShadowStateEvent, 'fence' | 'eventId' | 'seq' | 'keyId' | 'payloadDigest'>;

/**
 * Canonical binding parts, load-bearing for both the deterministic nonce and the
 * GCM AAD. Includes the full fence, eventId, seq, keyId AND payloadDigest. Because
 * `payloadDigest = sha256(plaintext)` and `eventId` is HMAC-bound to the digest in
 * `ShadowHostCore`, a given (keyId, fence, eventId, seq, payloadDigest) tuple can
 * only ever correspond to ONE plaintext — so a deterministic nonce derived from
 * these parts can never repeat with a differing plaintext under a given nonce
 * subkey (the only AES-GCM misuse that matters).
 */
function bindingParts(event: EventBinding): (string | number)[] {
  return [
    event.keyId,
    event.fence.accountId, event.fence.scopeId, event.fence.hostDeviceId, event.fence.epoch, event.fence.leaseId,
    event.eventId, event.seq, event.payloadDigest,
  ];
}

function eventAad(event: EventBinding): Uint8Array {
  return structuredEncode(EVENT_PAYLOAD_DOMAIN, bindingParts(event));
}

/** The keyring must be the one derived for this event's keyId + scope. */
function keyringBindsEvent(keyring: ScopeKeyring, event: EventBinding): boolean {
  return keyring.keyId === event.keyId
    && keyring.accountId === event.fence.accountId
    && keyring.scopeId === event.fence.scopeId;
}

/**
 * Deterministic 12-byte nonce = the first 96 bits of a keyed HMAC-SHA256 (keyed by
 * the event-nonce-prf subkey) over the full immutable binding. Keyed PRF (not
 * raw/truncated metadata); unique per distinct plaintext under a given scope key;
 * identical on re-seal (idempotent re-publish).
 */
async function eventNonce(backend: ShadowCryptoBackend, keyring: ScopeKeyring, event: EventBinding): Promise<Uint8Array> {
  const mac = await backend.hmacSha256(keyring.eventNoncePrf, structuredEncode(EVENT_NONCE_DOMAIN, bindingParts(event)));
  return mac.slice(0, SHADOW_AES_GCM_NONCE_BYTES);
}

/**
 * Host side: re-seal an event payload into a self-contained wire envelope
 * (base64url(nonce ‖ ciphertext ‖ tag)). Deterministic + fully AAD-bound.
 */
export async function sealEventPayload(
  backend: ShadowCryptoBackend,
  keyring: ScopeKeyring,
  event: EventBinding,
  plaintext: Uint8Array,
): Promise<string> {
  if (!keyringBindsEvent(keyring, event)) throw new Error('scope-keyring-event-mismatch');
  const nonce = await eventNonce(backend, keyring, event);
  const sealed = await backend.aesGcmSeal(keyring.eventPayloadAead, nonce, plaintext, eventAad(event));
  return base64urlEncode(concatBytes(nonce, sealed));
}

/** Controller side: open a self-contained wire event payload. Returns null (fail closed) on any failure. */
export async function openEventPayload(
  backend: ShadowCryptoBackend,
  keyring: ScopeKeyring,
  event: EventBinding & Pick<ShadowStateEvent, 'payloadCiphertext'>,
): Promise<unknown | null> {
  // Wrong keyId/scope keyring → fail closed before touching GCM.
  if (!keyringBindsEvent(keyring, event)) return null;
  let blob: Uint8Array;
  try {
    blob = base64urlDecode(event.payloadCiphertext);
  } catch {
    return null;
  }
  if (blob.length <= SHADOW_AES_GCM_NONCE_BYTES + 16) return null;
  const nonce = blob.slice(0, SHADOW_AES_GCM_NONCE_BYTES);
  const sealed = blob.slice(SHADOW_AES_GCM_NONCE_BYTES);
  // Defense-in-depth: the wire nonce MUST equal the deterministic nonce derived
  // from the (authenticated) binding — a relay that swaps in a different nonce
  // for the same binding is rejected before the GCM open.
  const expectedNonce = await eventNonce(backend, keyring, event);
  if (!constantTimeEqual(nonce, expectedNonce)) return null;
  const plain = await backend.aesGcmOpen(keyring.eventPayloadAead, nonce, sealed, eventAad(event));
  if (!plain) return null;
  try {
    return JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
}

/** Seal arbitrary bytes under a purpose subkey with a fresh random nonce + AAD binding. */
async function sealSubkeyEnvelope(
  backend: ShadowCryptoBackend,
  subkey: Uint8Array,
  plaintext: Uint8Array,
  bindingParts: readonly (string | number)[],
): Promise<string> {
  const nonce = backend.randomBytes(SHADOW_AES_GCM_NONCE_BYTES);
  const aad = structuredEncode(SCOPE_ENVELOPE_DOMAIN, [...bindingParts]);
  const sealed = await backend.aesGcmSeal(subkey, nonce, plaintext, aad);
  return base64urlEncode(concatBytes(nonce, sealed));
}

/** Open a purpose-subkey envelope. Returns null (fail closed) on any failure. */
async function openSubkeyEnvelope(
  backend: ShadowCryptoBackend,
  subkey: Uint8Array,
  envelope: string,
  bindingParts: readonly (string | number)[],
): Promise<Uint8Array | null> {
  let blob: Uint8Array;
  try {
    blob = base64urlDecode(envelope);
  } catch {
    return null;
  }
  if (blob.length <= SHADOW_AES_GCM_NONCE_BYTES + 16) return null;
  const nonce = blob.slice(0, SHADOW_AES_GCM_NONCE_BYTES);
  const sealed = blob.slice(SHADOW_AES_GCM_NONCE_BYTES);
  const aad = structuredEncode(SCOPE_ENVELOPE_DOMAIN, [...bindingParts]);
  return backend.aesGcmOpen(subkey, nonce, sealed, aad);
}

function commandEnvelopeBinding(fence: Fence, commandId: string): (string | number)[] {
  return ['command', commandId, fence.accountId, fence.scopeId, fence.hostDeviceId, fence.epoch, fence.leaseId];
}

/** JSON-seal a value as a command envelope bound to (commandId, fence). */
export async function sealCommandEnvelope(
  backend: ShadowCryptoBackend,
  keyring: ScopeKeyring,
  fence: Fence,
  commandId: string,
  value: unknown,
): Promise<string> {
  return sealSubkeyEnvelope(backend, keyring.commandEnvelopeAead, utf8Encode(JSON.stringify(value)), commandEnvelopeBinding(fence, commandId));
}

/** Open a command envelope → parsed JSON, or null. */
export async function openCommandEnvelope(
  backend: ShadowCryptoBackend,
  keyring: ScopeKeyring,
  fence: Fence,
  commandId: string,
  envelope: string,
): Promise<unknown | null> {
  const plain = await openSubkeyEnvelope(backend, keyring.commandEnvelopeAead, envelope, commandEnvelopeBinding(fence, commandId));
  if (!plain) return null;
  try {
    return JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
}

function ackSigningInput(ack: Omit<HostCommandAck, 'signature'>): Uint8Array {
  return structuredEncode(COMMAND_ACK_DOMAIN, [
    ack.commandId, ack.status,
    ack.fence.accountId, ack.fence.scopeId, ack.fence.hostDeviceId, ack.fence.epoch, ack.fence.leaseId,
    ack.acceptedSeq ?? 0, ack.resultSeq ?? 0, ack.duplicateOf ?? '', ack.signedAt,
  ]);
}

/**
 * Fixed alphanumeric prefix on the ACK signature string. base64url can begin with
 * `-`/`_`, but the durable controller store validates the stored signature with a
 * SAFE-ID rule whose first character must be alphanumeric — so an un-prefixed
 * base64url MAC is rejected on reload ~3% of the time. The prefix guarantees a
 * valid, stable signature string; it is stripped before the constant-time compare.
 */
const ACK_SIGNATURE_PREFIX = 'h';

/** Host: HMAC-sign a command ACK under the command-ack-mac subkey (authenticates host authorship). */
export async function signCommandAck(backend: ShadowCryptoBackend, keyring: ScopeKeyring, ack: Omit<HostCommandAck, 'signature'>): Promise<string> {
  return ACK_SIGNATURE_PREFIX + base64urlEncode(await backend.hmacSha256(keyring.commandAckMac, ackSigningInput(ack)));
}

/** Controller: verify a command ACK's command-ack-mac HMAC (constant-time). */
export async function verifyCommandAck(backend: ShadowCryptoBackend, keyring: ScopeKeyring, ack: HostCommandAck): Promise<boolean> {
  if (typeof ack.signature !== 'string' || ack.signature[0] !== ACK_SIGNATURE_PREFIX) return false;
  let provided: Uint8Array;
  try {
    provided = base64urlDecode(ack.signature.slice(ACK_SIGNATURE_PREFIX.length));
  } catch {
    return false;
  }
  const { signature: _sig, ...rest } = ack;
  const expected = await backend.hmacSha256(keyring.commandAckMac, ackSigningInput(rest));
  return constantTimeEqual(provided, expected);
}

function commandAckBinding(fence: Fence, commandId: string): (string | number)[] {
  return ['command-ack', commandId, fence.accountId, fence.scopeId, fence.hostDeviceId, fence.epoch, fence.leaseId];
}

/** Seal a fully-signed ACK for the relay (ciphertext the controller decrypts). */
export async function sealCommandAck(backend: ShadowCryptoBackend, keyring: ScopeKeyring, ack: HostCommandAck): Promise<string> {
  return sealSubkeyEnvelope(backend, keyring.commandAckAead, utf8Encode(JSON.stringify(ack)), commandAckBinding(ack.fence, ack.commandId));
}

/** Open + parse a sealed ACK; returns null on failure. */
export async function openCommandAck(
  backend: ShadowCryptoBackend,
  keyring: ScopeKeyring,
  fence: Fence,
  commandId: string,
  envelope: string,
): Promise<HostCommandAck | null> {
  const plain = await openSubkeyEnvelope(backend, keyring.commandAckAead, envelope, commandAckBinding(fence, commandId));
  if (!plain) return null;
  try {
    return JSON.parse(utf8Decode(plain)) as HostCommandAck;
  } catch {
    return null;
  }
}
