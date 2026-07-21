/**
 * shadowActionIdempotency — Phase 3C3 CORRECTED (F1). The opaque, cryptographically-random
 * idempotency key that binds a logical user action attempt to its EXACTLY-ONCE product effect
 * on the host. The key is generated ONCE per attempt and is:
 *   - never payload-derived (pure CSPRNG bytes, no method/params mixed in);
 *   - never rendered / logged / sent to analytics (see `shadowActionSourceScan.test.ts`);
 *   - never sent to the relay in PLAINTEXT — `ShadowControllerService.sendCommand` seals it
 *     INSIDE the encrypted command envelope, while the relay's own transport-dedup
 *     `idempotencyKey` field stays a distinct per-command random value.
 *
 * The host reads this sealed key from the DECRYPTED envelope and keys its durable action
 * receipt on it, so two commands carrying the SAME sealed key converge on ONE product effect
 * (receipt HIT → recorded completion, no re-apply).
 */
import { base64urlEncode } from '@maestro/realtime/shadowCrypto';

/** `idem_` + base64url(18 random bytes) → 24 base64url chars; strict, opaque, bounded. */
export const IDEMPOTENCY_KEY_RE = /^idem_[A-Za-z0-9_-]{16,64}$/;

export function isValidIdempotencyKey(k: unknown): k is string {
  return typeof k === 'string' && IDEMPOTENCY_KEY_RE.test(k);
}

/**
 * Mint a fresh opaque idempotency key from a secure random source (18 bytes → 144 bits).
 * `rand` MUST be a CSPRNG (expo-crypto in production, injected in tests). The key carries NO
 * payload material.
 */
export function newIdempotencyKey(rand: (n: number) => Uint8Array): string {
  const bytes = rand(18);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 18) throw new Error('idempotency CSPRNG unavailable');
  const key = `idem_${base64urlEncode(bytes)}`;
  // Defence-in-depth: never emit a key that would fail the strict wire validator.
  if (!isValidIdempotencyKey(key)) throw new Error('idempotency key format');
  return key;
}
