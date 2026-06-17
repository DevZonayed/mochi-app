import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from './git.js';

const SAMPLE = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,5 +1,7 @@
 import { store } from '../db';
+import { verifyJwt } from './jwt';

 export async function getSession(req) {
-  const sid = req.cookies['sid'];
-  return store.get(sid);
+  const bearer = req.headers.authorization?.slice(7);
+  if (bearer) return store.get(verifyJwt(bearer).sid);
 }
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Maestro
+Updated.
`;

describe('parseUnifiedDiff', () => {
  it('parses files, hunks, and add/del/ctx lines with new-file line numbers', () => {
    const d = parseUnifiedDiff(SAMPLE);
    expect(d.fileCount).toBe(2);
    expect(d.files[0].path).toBe('src/auth/session.ts');
    expect(d.files[0].lang).toBe('TS');
    expect(d.files[1].path).toBe('README.md');
    expect(d.files[1].lang).toBe('MD');

    // 3 additions in file 1 (verifyJwt import, bearer line, if-bearer line) + 1 in README.
    expect(d.additions).toBe(4);
    // 2 deletions in file 1.
    expect(d.deletions).toBe(2);

    const adds = d.files[0].lines.filter((l) => l.t === 'add');
    expect(adds.map((l) => l.c)).toContain(`import { verifyJwt } from './jwt';`);
    // new-file line numbers are assigned to add/ctx lines, blank for deletions.
    expect(adds[0].n).toBe('2');
    const dels = d.files[0].lines.filter((l) => l.t === 'del');
    expect(dels.every((l) => l.n === '')).toBe(true);
    // hunk header is preserved as its own row.
    expect(d.files[0].lines.some((l) => l.t === 'hunk')).toBe(true);
  });

  it('returns an empty result for an empty diff', () => {
    const d = parseUnifiedDiff('');
    expect(d.fileCount).toBe(0);
    expect(d.additions).toBe(0);
    expect(d.deletions).toBe(0);
    expect(d.truncated).toBe(false);
  });
});
