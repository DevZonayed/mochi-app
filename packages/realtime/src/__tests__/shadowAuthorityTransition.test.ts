import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto as node } from '../shadowCryptoNode.js';
import type { Fence } from '../shadowProtocol.js';
import { signAuthorityTransition, verifyAuthorityTransitionSignature, type AuthorityTransitionGrantFields } from '../shadowAuthorityTransition.js';

const fence: Fence = { accountId: 'acct', scopeId: 'account:acct', hostDeviceId: 'host', epoch: 1, leaseId: 'lease' };

async function hostKeys() {
  const id = await node.generateSigningKeyPair();
  return { priv: id.privateKey, pub: id.publicKey };
}

const base = (over: Partial<AuthorityTransitionGrantFields> = {}): Omit<AuthorityTransitionGrantFields, 'signature'> => ({
  family: 'authority-transition-grant', v: 1, transitionId: 'tr_1', kind: 'lease-renewal',
  controllerDeviceId: 'ctrl', previousFence: fence, nextFence: fence, issuedAt: 100, expiresAt: 200, nonce: 'n_1', keyId: 'hk_1',
  ...over,
});

describe('shadowAuthorityTransition — host-signed grant', () => {
  it('signs and verifies a lease-renewal grant against the host trust root', async () => {
    const { priv, pub } = await hostKeys();
    const grant = await signAuthorityTransition(node, priv, base());
    expect(await verifyAuthorityTransitionSignature(node, { hostSigningPublicKey: pub, hostSigningKeyId: 'hk_1' }, grant)).toBe(true);
  });

  it('rejects a tampered field (expiry / fence / controller / kind)', async () => {
    const { priv, pub } = await hostKeys();
    const trust = { hostSigningPublicKey: pub, hostSigningKeyId: 'hk_1' };
    const grant = await signAuthorityTransition(node, priv, base());
    expect(await verifyAuthorityTransitionSignature(node, trust, { ...grant, expiresAt: 999 })).toBe(false);
    expect(await verifyAuthorityTransitionSignature(node, trust, { ...grant, controllerDeviceId: 'evil' })).toBe(false);
    expect(await verifyAuthorityTransitionSignature(node, trust, { ...grant, nextFence: { ...fence, epoch: 9 } })).toBe(false);
    expect(await verifyAuthorityTransitionSignature(node, trust, { ...grant, kind: 'lease-rotation' })).toBe(false);
  });

  it('rejects a foreign signing key and a mismatched trusted keyId', async () => {
    const host = await hostKeys();
    const foreign = await hostKeys();
    const grant = await signAuthorityTransition(node, foreign.priv, base()); // signed by the wrong key
    expect(await verifyAuthorityTransitionSignature(node, { hostSigningPublicKey: host.pub, hostSigningKeyId: 'hk_1' }, grant)).toBe(false);
    // Right signature but the grant's keyId is not the trusted enrollment keyId.
    const real = await signAuthorityTransition(node, host.priv, base({ keyId: 'hk_other' }));
    expect(await verifyAuthorityTransitionSignature(node, { hostSigningPublicKey: host.pub, hostSigningKeyId: 'hk_1' }, real)).toBe(false);
  });

  it('a corrupt base64url signature fails closed', async () => {
    const { priv, pub } = await hostKeys();
    const grant = await signAuthorityTransition(node, priv, base());
    expect(await verifyAuthorityTransitionSignature(node, { hostSigningPublicKey: pub, hostSigningKeyId: 'hk_1' }, { ...grant, signature: '!!!not-base64!!!' })).toBe(false);
  });
});
