import { describe, test, expect } from 'vitest';
import { pickPrFields } from './git-service.js';
import type { PrStatus, SessionGitStatus } from './pr-state.js';

/* pickPrFields is the await-free guard that closes the cache-clobber race the
   async conversion of fullStatus opened: a cheap (withPr:false) recompute must
   never overwrite a fresher PR that a concurrent withPr:true recompute landed in
   the cache while the cheap pass was awaiting local git. */

const openPr: PrStatus = { number: 7, url: 'u', title: 't', state: 'open', mergeable: true, mergeableState: 'clean', checks: [] };
const mergedPr: PrStatus = { ...openPr, state: 'merged' };

function cached(pr: PrStatus | null, prChecked: boolean): SessionGitStatus {
  return {
    sessionId: 's', branch: 'b', base: 'main',
    local: { isRepo: true, ahead: 1, behind: 0, dirty: false, pushed: true },
    pr, state: 'pr-mergeable', lastCheckedAt: 1, prChecked,
  };
}

describe('pickPrFields', () => {
  test('withPr pass is authoritative — adopts the freshly-fetched PR + prChecked=true', () => {
    expect(pickPrFields(true, mergedPr, cached(openPr, true))).toEqual({ pr: mergedPr, prChecked: true });
  });

  test('withPr pass with no PR found still marks prChecked=true (we did ask GitHub)', () => {
    expect(pickPrFields(true, null, undefined)).toEqual({ pr: null, prChecked: true });
  });

  test('cheap pass with empty cache → no PR, not checked', () => {
    expect(pickPrFields(false, null, undefined)).toEqual({ pr: null, prChecked: false });
  });

  test('cheap pass keeps whatever PR is newest in the cache (sticky prChecked)', () => {
    expect(pickPrFields(false, null, cached(openPr, true))).toEqual({ pr: openPr, prChecked: true });
  });

  test('THE RACE: cheap pass must NOT clobber a merged PR a concurrent reconcile just landed', () => {
    // Entry-time the session had no PR; while we awaited local git, a withPr:true
    // reconcile wrote the merged PR into the cache. The cheap pass re-reads that
    // latest value and preserves it instead of writing back its stale null.
    const afterReconcile = cached(mergedPr, true);
    expect(pickPrFields(false, null, afterReconcile)).toEqual({ pr: mergedPr, prChecked: true });
  });
});
