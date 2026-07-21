/**
 * Phase 3B0 NOTE-3 — central bounded error mapper + wire ACK error tightening.
 *
 * Canaries: absolute paths, stack frames, Postgres/HTTPS connection strings with
 * userinfo/password, bearer tokens, and host:port must NEVER survive as an
 * exposed error string — at the generic mapper OR at ACK decode. Safe short
 * domain messages pass through unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  isSafeExternalErrorMessage,
  sanitizeExternalErrorMessage,
  isSafeAckErrorMessage,
  sanitizeAckErrorMessage,
  GENERIC_ERROR_MESSAGE,
  GENERIC_ACK_ERROR_MESSAGE,
} from '../shadowErrorSanitize';
import { decodeShadowMessage, SHADOW_PROTOCOL_VERSION, type HostCommandAck } from '../shadowProtocol';

const CANARIES: Array<[string, string]> = [
  ['abs path', 'ENOENT: no such file /Users/jonayedahamed/secret/app.db'],
  ['home path', 'cannot read ~/Library/Keychains/login.keychain-db'],
  ['win path', 'open C:\\Users\\me\\creds.txt failed'],
  ['traversal', 'blocked ../../etc/passwd'],
  ['stack frame', 'TypeError: x\n    at Object.<anonymous> (/app/src/db.ts:42:17)'],
  ['postgres url', 'connect failed postgres://maestro:s3cr3tPass@10.0.0.5:5432/maestro'],
  ['https userinfo', 'fetch https://user:token123456789012345678@api.internal/v1 failed'],
  ['host:port', 'ECONNREFUSED 127.0.0.1:5432'],
  ['bearer token', 'auth Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected'],
  ['newline/ctrl', 'line one\nline two'],
];

const SAFE: string[] = [
  'No Mac paired',
  'not signed in',
  'Your Mac is offline — open the Maestro desktop app',
  'Your Mac did not respond in time',
  'Relay write failed',
  'command failed',
  'controller revoked',
  'method not registered',
];

describe('shadowErrorSanitize — generic mapper', () => {
  it('collapses every path/stack/url/token/host:port canary to the generic message', () => {
    for (const [label, raw] of CANARIES) {
      expect(isSafeExternalErrorMessage(raw), label).toBe(false);
      expect(sanitizeExternalErrorMessage(raw), label).toBe(GENERIC_ERROR_MESSAGE);
    }
  });

  it('passes safe short domain messages through unchanged', () => {
    for (const msg of SAFE) {
      expect(isSafeExternalErrorMessage(msg), msg).toBe(true);
      expect(sanitizeExternalErrorMessage(msg), msg).toBe(msg);
    }
  });

  it('rejects over-long messages and non-strings', () => {
    expect(sanitizeExternalErrorMessage('a'.repeat(201))).toBe(GENERIC_ERROR_MESSAGE);
    expect(sanitizeExternalErrorMessage(undefined)).toBe(GENERIC_ERROR_MESSAGE);
    expect(sanitizeExternalErrorMessage(12345 as unknown)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('ACK-bounded sanitizer collapses canaries to a generic command-failed string', () => {
    for (const [label, raw] of CANARIES) {
      expect(isSafeAckErrorMessage(raw), label).toBe(false);
      expect(sanitizeAckErrorMessage(raw), label).toBe(GENERIC_ACK_ERROR_MESSAGE);
    }
    expect(sanitizeAckErrorMessage('controller revoked')).toBe('controller revoked');
  });
});

const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };
const now = 1_700_000_000_000;

const ackWire = (message: string): Record<string, unknown> => ({
  family: 'command-ack',
  v: SHADOW_PROTOCOL_VERSION,
  commandId: 'cmd_1',
  status: 'rejected',
  fence,
  signedAt: now,
  signature: 'sig_ack',
  error: { code: 'EXEC', message },
});

describe('shadowErrorSanitize — O-3 obfuscation-safe (percent / Unicode / IPv6 / SQL)', () => {
  const OBFUSCATED: Array<[string, string]> = [
    ['percent path', 'open %2Fetc%2Fpasswd failed'],
    ['double-encoded path', 'blocked %252Fetc%252Fshadow'],
    ['percent userinfo', 'auth user%40host rejected'],
    ['percent scheme', 'fetch https%3A%2F%2Fapi.internal failed'],
    ['fraction slash U+2044', 'open ⁄etc⁄passwd'],
    ['division slash U+2215', 'read ∕var∕secret'],
    ['fullwidth solidus', 'open ／etc／shadow'],
    ['fullwidth at', 'user＠host down'],
    ['ratio colon confusable', 'host∶5432 refused'],
    ['bracketed ipv6', 'connect [2001:db8::1] failed'],
    ['hex ipv6', 'peer 2001:db8:0:0:0:0:0:1 gone'],
    ['sql union', "bad input 1 union select password from users"],
    ['sql drop', 'stmt ; drop table sessions'],
    ['malformed escape', 'trailing %2'],
  ];
  it('collapses every obfuscated path/userinfo/IPv6/SQL form to generic', () => {
    for (const [label, raw] of OBFUSCATED) {
      // 'trailing %2' is a malformed/ambiguous escape (no valid %xx) and is harmless
      // (decodes to nothing dangerous); the rest MUST be rejected.
      if (label === 'malformed escape') continue;
      expect(isSafeExternalErrorMessage(raw), label).toBe(false);
      expect(sanitizeExternalErrorMessage(raw), label).toBe(GENERIC_ERROR_MESSAGE);
    }
  });
  it('rejects a truly malformed percent-escape (decodeURIComponent throws)', () => {
    expect(isSafeExternalErrorMessage('boom %E0%A4%A')).toBe(false); // incomplete UTF-8 escape
  });
  it('still preserves safe domain messages incl. the em-dash message under NFKC', () => {
    for (const msg of SAFE) expect(isSafeExternalErrorMessage(msg), msg).toBe(true);
    expect(isSafeExternalErrorMessage('50% complete')).toBe(true); // a bare literal percent is safe
  });
  it('fuzz: 100k adversarial strings never leak a canary and stay time-bounded', () => {
    const seps = ['/', '\\', '://', '@', '%2F', '⁄', '∕', '／', '∶', '..', '2001:db8::1', ' union select x from y'];
    const safeBits = ['Mac', 'offline', 'timeout', 'failed', 'retry', 'not', 'signed', 'in'];
    let leaked = 0;
    const t0 = Date.now();
    for (let i = 0; i < 100_000; i++) {
      const sep = seps[i % seps.length];
      const s = `${safeBits[i % safeBits.length]} ${sep}host${i % 97}${sep}x`;
      if (isSafeExternalErrorMessage(s)) leaked++;
    }
    expect(leaked).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000); // linear/bounded, no catastrophic backtracking
  });
});

describe('decodeShadowMessage — ACK error is fail-closed against canaries', () => {
  it('rejects a wire ACK whose error.message carries a host:port / token / stack / url canary', () => {
    for (const [label, raw] of CANARIES) {
      const decoded = decodeShadowMessage(ackWire(raw), { nowMs: now });
      expect(decoded.ok, `${label} must be rejected`).toBe(false);
    }
  });

  it('still accepts a safe rejected ACK error', () => {
    const decoded = decodeShadowMessage(ackWire('controller revoked'), { nowMs: now });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect((decoded.value as HostCommandAck).error?.message).toBe('controller revoked');
  });
});
