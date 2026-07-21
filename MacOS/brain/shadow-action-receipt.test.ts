/**
 * LOW-fix reviewer reproduction: `ShadowActionReceiptStore.commit` must SURFACE a
 * cross-process conflicting commit (same key, different account/method/payload) as an
 * explicit `conflict` — never return the caller's own completion as success.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowActionReceiptStore, type ActionReceiptBinding, type ActionReceiptCompletion } from './shadow-action-receipt.js';

const completion = (entityId: string): ActionReceiptCompletion => ({ collection: 'job', op: 'upsert', entityId, revision: 1, payload: { id: entityId } });
const binding = (over: Partial<ActionReceiptBinding> = {}): ActionReceiptBinding => ({
  accountId: 'acct_1', scopeId: 'account:acct_1', controllerDeviceId: 'ctrl_1', idempotencyKey: 'idem_1',
  method: 'controller.job.start', canonicalPayloadDigest: 'pd1', ...over,
});

describe('ShadowActionReceiptStore.commit — conflict surfacing', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rcpt-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('same binding → ok with the winner completion; identical replay → ok (no re-apply)', () => {
    const r = new ShadowActionReceiptStore(dir);
    const c1 = r.commit(binding(), completion('job_A'), 1);
    expect(c1.status).toBe('ok');
    if (c1.status === 'ok') expect(c1.completion.entityId).toBe('job_A');
    const c2 = r.commit(binding(), completion('job_A'), 2); // same key+payload
    expect(c2.status).toBe('ok');
    if (c2.status === 'ok') expect(c2.completion.entityId).toBe('job_A'); // winner's, not a second
    r.close();
  });

  it('CROSS-PROCESS conflicting commit (same key, different payload) → explicit conflict, not masked success', () => {
    const a = new ShadowActionReceiptStore(dir);
    const b = new ShadowActionReceiptStore(dir); // second process on the SAME db file
    // A commits first.
    expect(a.commit(binding({ canonicalPayloadDigest: 'pd-A' }), completion('job_A'), 1).status).toBe('ok');
    // B commits a CONFLICTING binding under the same key → must be surfaced as conflict.
    const cb = b.commit(binding({ canonicalPayloadDigest: 'pd-B' }), completion('job_B'), 2);
    expect(cb.status).toBe('conflict');
    if (cb.status === 'conflict') expect(cb.reason).toContain('receipt-conflict');
    // The store still holds ONLY A's completion.
    const look = b.lookup(binding({ canonicalPayloadDigest: 'pd-A' }));
    expect(look.status).toBe('hit');
    if (look.status === 'hit') expect(look.completion.entityId).toBe('job_A');
    a.close(); b.close();
  });

  it('conflict by method / account is also surfaced', () => {
    const r = new ShadowActionReceiptStore(dir);
    r.commit(binding(), completion('job_A'), 1);
    expect(r.commit(binding({ method: 'controller.job.cancel' }), completion('job_A'), 2).status).toBe('conflict');
    expect(r.commit(binding({ accountId: 'acct_evil' }), completion('job_A'), 3).status).toBe('conflict');
    r.close();
  });
});
