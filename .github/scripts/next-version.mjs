// Compute the next desktop release version and write it to GITHUB_OUTPUT.
//
// Rule: take the highest already-published release and bump its PATCH (0.1.4 →
// 0.1.5). apps/desktop/package.json is the floor — if you bump its major/minor
// there (e.g. 0.2.0), that wins and starts a new series. So every build gets a
// fresh, strictly-increasing version with no manual edits.
import { execSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')).version;
const repo = process.env.GITHUB_REPOSITORY || 'DevZonayed/mochi-app';

const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

let published = [];
try {
  const out = execSync(`gh release list --repo ${repo} --json tagName --limit 200`, { encoding: 'utf8' });
  published = JSON.parse(out)
    .map((r) => String(r.tagName).replace(/^v/, ''))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v));
} catch (e) {
  console.error('next-version: no releases yet / gh failed:', e.message);
}

const latest = published.sort(cmp).pop();
let next;
if (!latest || cmp(base, latest) > 0) next = base;            // package.json starts a new series
else { const p = latest.split('.').map(Number); p[2] += 1; next = p.join('.'); } // bump patch

console.error(`next-version: base=${base} latest=${latest ?? '(none)'} -> ${next}`);
console.log(next);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${next}\n`);
