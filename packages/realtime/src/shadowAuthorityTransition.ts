/**
 * shadowAuthorityTransition — Phase 3A2a canonical Ed25519 signer + verifier for
 * host-signed authority-transition grants. The TRUST BOUNDARY for a lease
 * extension is the HOST signature (bound to the enrollment host signing key), NOT
 * the relay — the relay only stores/forwards the signed grant. Both the desktop
 * host (to mint) and the Expo controller (to verify) use these helpers so the exact
 * same canonical bytes are signed and checked.
 *
 * `lease-renewal` grants keep the SAME fence and strictly increase the lease expiry;
 * `handoff`/`lease-rotation` change epoch/leaseId. The structural fence/expiry rules
 * are enforced by the durable client (ShadowMobileClient); THIS module only owns the
 * cryptographic authorship proof.
 */
import { structuredEncode, base64urlEncode, base64urlDecode, type ShadowCryptoBackend } from './shadowCrypto.js';
import type { Fence } from './shadowProtocol.js';

const TRANSITION_SIG_DOMAIN = 'maestro.shadow.transition.grant-sig.v1';

export type ShadowAuthorityTransitionKind = 'handoff' | 'lease-rotation' | 'lease-renewal';

/** Structural mirror of `ShadowAuthorityTransitionGrant` (kept dep-free of the mobile package). */
export interface AuthorityTransitionGrantFields {
  family: 'authority-transition-grant';
  v: 1;
  transitionId: string;
  kind: ShadowAuthorityTransitionKind;
  controllerDeviceId: string;
  previousFence: Fence;
  nextFence: Fence;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  keyId: string;
  signature: string;
}

function fenceParts(f: Fence): (string | number)[] {
  return [f.accountId, f.scopeId, f.hostDeviceId, f.epoch, f.leaseId];
}

/** Canonical signing bytes over the FULL previous/next fence + expiries + identity + kind. */
function transitionSigningInput(g: Omit<AuthorityTransitionGrantFields, 'signature'>): Uint8Array {
  return structuredEncode(TRANSITION_SIG_DOMAIN, [
    g.v, g.transitionId, g.kind, g.controllerDeviceId,
    ...fenceParts(g.previousFence),
    ...fenceParts(g.nextFence),
    g.issuedAt, g.expiresAt, g.nonce, g.keyId,
  ]);
}

/** Host: Ed25519-sign an authority-transition grant with the host signing private key. */
export async function signAuthorityTransition(
  backend: ShadowCryptoBackend,
  hostSigningPrivateKey: Uint8Array,
  unsigned: Omit<AuthorityTransitionGrantFields, 'signature'>,
): Promise<AuthorityTransitionGrantFields> {
  const signature = await backend.sign(hostSigningPrivateKey, transitionSigningInput(unsigned));
  return { ...unsigned, signature: base64urlEncode(signature) };
}

/**
 * Controller: verify a transition grant's host Ed25519 signature. Also binds the
 * grant's `keyId` to the trusted enrollment host signing keyId when one is supplied,
 * so a grant signed under a different (or forged) key is rejected before it can
 * advance authority.
 */
export async function verifyAuthorityTransitionSignature(
  backend: ShadowCryptoBackend,
  trust: { hostSigningPublicKey: Uint8Array; hostSigningKeyId?: string },
  grant: AuthorityTransitionGrantFields,
): Promise<boolean> {
  if (grant.family !== 'authority-transition-grant' || grant.v !== 1) return false;
  if (trust.hostSigningKeyId !== undefined && grant.keyId !== trust.hostSigningKeyId) return false;
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(grant.signature);
  } catch {
    return false;
  }
  const { signature: _s, ...rest } = grant;
  try {
    return await backend.verify(trust.hostSigningPublicKey, transitionSigningInput(rest), sig);
  } catch {
    return false;
  }
}
