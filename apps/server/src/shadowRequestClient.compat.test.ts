/**
 * Known-answer compatibility test: the portable client proof builder
 * (`@maestro/realtime/shadowRequestClient`) must produce byte-identical proof
 * bytes to the server's own `shadowRequestProofBytes` for the same inputs, so a
 * host/mobile client signature always verifies server-side. No DB required.
 */
import { describe, it, expect } from 'vitest';
import { shadowRequestProofBytes as serverProofBytes, normalizePathQuery as serverNormalize } from './shadowRequestAuth.js';
import { shadowRequestProofBytes as clientProofBytes, normalizePathQuery as clientNormalize } from '@maestro/realtime/shadowRequestClient';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';

const cases = [
  { method: 'POST', rawUrl: '/api/shadow/events', rawBody: '{"events":[]}' },
  { method: 'get', rawUrl: '/api/shadow/enroll/sessions?b=2&a=1', rawBody: '' },
  { method: 'POST', rawUrl: '/api/shadow/commands/cmd_1/ack?scopeId=account%3Aacct', rawBody: '{"scopeId":"account:acct"}' },
  { method: 'DELETE', rawUrl: '/api/shadow/x?z=9&z=1&m=q', rawBody: 'raw-body-∆-unicode' },
];

describe('portable shadowRequestClient ↔ server proof parity', () => {
  it('normalizePathQuery matches the server for every case', () => {
    for (const c of cases) {
      expect(clientNormalize(c.rawUrl)).toBe(serverNormalize(c.rawUrl));
    }
  });

  it('proof bytes are byte-identical to the server derivation', async () => {
    for (const c of cases) {
      const common = {
        method: c.method,
        rawUrl: c.rawUrl,
        rawBody: c.rawBody,
        accountId: 'acct_1',
        deviceId: 'device_1',
        keyId: 'sk_1',
        timestampMs: 1_700_000_000_123,
        nonce: 'nonce-xyz',
      };
      const server = serverProofBytes(common);
      const client = await clientProofBytes(nodeShadowCrypto, common);
      expect(Buffer.from(client).equals(Buffer.from(server))).toBe(true);
    }
  });
});
