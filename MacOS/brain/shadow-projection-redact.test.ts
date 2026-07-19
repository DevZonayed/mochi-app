import { describe, expect, it } from 'vitest';
import { redactProjectionPayload, canonicalStringify, DEFAULT_REDACT_BOUNDS } from './shadow-projection-redact.js';

const CANARY = 'CANARY_ZZ_9f83aa11deadbeefcafe';

describe('shadow-projection-redact — secret scrub', () => {
  it('redacts secret-bearing keys (value never echoed)', () => {
    const r = redactProjectionPayload({ title: 'ok', authToken: `tok_${CANARY}`, password: 'hunter2', nested: { apiKey: `sk-${CANARY}` } });
    const s = JSON.stringify(r.value);
    expect(s).not.toContain(CANARY);
    expect(s).not.toContain('hunter2');
    expect(r.redactions).toBeGreaterThanOrEqual(2);
    expect((r.value as Record<string, unknown>).title).toBe('ok'); // legitimate field preserved
  });

  it('redacts secret VALUE patterns embedded in legitimate free text', () => {
    // Realistic secret shapes (no underscores in token bodies, realistic lengths).
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFghiJKLmnopQRstuv';
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0123456789abcdef\n-----END RSA PRIVATE KEY-----';
    const secrets = [
      'Bearer abcdefghijkl0123456789ABCDEF',
      jwt,
      'sk-ant-api03abcdefghijklmnopqrstuvwx',
      'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      pem,
      '0123456789abcdef0123456789abcdef0123456789abcdef', // 48 hex
    ];
    for (const secret of secrets) {
      const r = redactProjectionPayload({ field: `job failed near: ${secret} — see logs` });
      const s = JSON.stringify(r.value);
      expect(s).not.toContain(secret);
      expect(s).not.toContain('PRIVATE KEY');
      expect(r.redactions).toBeGreaterThanOrEqual(1);
      expect(s).toContain('job failed near'); // surrounding legit text preserved
    }
    // path patterns
    for (const p of ['/Users/bob/project/.env.production', '/Users/bob/Library/Keychains/login.keychain-db']) {
      const r = redactProjectionPayload({ field: `path ${p}` });
      expect(JSON.stringify(r.value)).not.toContain('keychain-db');
      expect(r.redactions).toBeGreaterThanOrEqual(p.includes('.env') ? 1 : 1);
    }
  });

  it('scrubs canaries nested deeply and inside arrays', () => {
    const deep = { a: { b: { c: { d: { secretValue: `sk-${CANARY}` } } } }, list: [`Bearer ${CANARY}xxxxxxxxxxxx`, 'clean'] };
    const r = redactProjectionPayload(deep);
    expect(JSON.stringify(r.value)).not.toContain(CANARY);
  });

  it('bounds depth, keys, array length, and string bytes deterministically', () => {
    let node: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 20; i++) node = { nested: node };
    const rDepth = redactProjectionPayload(node);
    expect(JSON.stringify(rDepth.value)).toContain('[max-depth]');

    const bigObj: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) bigObj[`k${String(i).padStart(3, '0')}`] = i;
    const rKeys = redactProjectionPayload(bigObj);
    expect((rKeys.value as Record<string, unknown>).__truncated__).toBe(true);

    const bigArr = Array.from({ length: 1000 }, (_, i) => i);
    const rArr = redactProjectionPayload({ arr: bigArr });
    const arr = (rArr.value as { arr: unknown[] }).arr;
    expect(arr.length).toBeLessThanOrEqual(DEFAULT_REDACT_BOUNDS.maxArray + 1);
    expect(String(arr[arr.length - 1])).toContain('more');

    // Many short words (spaces break the long-token pattern) → truncation, not redaction.
    const longStr = 'lorem ipsum dolor sit amet '.repeat(1000);
    const rStr = redactProjectionPayload({ s: longStr }, { ...DEFAULT_REDACT_BOUNDS, maxStringBytes: 100 });
    expect(String((rStr.value as { s: string }).s)).toContain('…[truncated]');
  });

  it('drops prototype-pollution keys and cannot pollute Object.prototype', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":"y"}');
    const r = redactProjectionPayload(evil);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const out = r.value as Record<string, unknown>;
    expect('__proto__' in out ? Object.getOwnPropertyNames(out).includes('__proto__') : false).toBe(false);
    expect(out.ok).toBe('y');
  });

  it('handles cycles, binary, undefined, and functions safely', () => {
    const cyc: Record<string, unknown> = { name: 'root' };
    cyc.self = cyc;
    const r = redactProjectionPayload(cyc);
    expect(JSON.stringify(r.value)).toContain('[cycle]');
    const r2 = redactProjectionPayload({ bin: new Uint8Array([1, 2, 3]), fn: () => 1, u: undefined, ok: 'keep' });
    const out = r2.value as Record<string, unknown>;
    expect(String(out.bin)).toContain('[binary:3]');
    expect('fn' in out).toBe(false);
    expect('u' in out).toBe(false);
    expect(out.ok).toBe('keep');
  });

  it('fails closed to an inert marker when the payload is too large', () => {
    // Legit, non-secret fields whose canonical JSON exceeds a tiny total budget.
    const payload = { title: 'hello world report', name: 'alpha project', color: 'blue sky' };
    const r = redactProjectionPayload(payload, { ...DEFAULT_REDACT_BOUNDS, maxTotalBytes: 20 });
    expect(r.overflow).toBe(true);
    expect(r.value).toBe('[payload-too-large]');
  });

  it('canonical output is deterministic regardless of key order', () => {
    const a = canonicalStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    const r1 = redactProjectionPayload({ x: 1, y: 2 });
    const r2 = redactProjectionPayload({ y: 2, x: 1 });
    expect(canonicalStringify(r1.value)).toBe(canonicalStringify(r2.value));
  });
});
