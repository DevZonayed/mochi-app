// Compute a strictly increasing native macOS artifact version.
//
// This workflow uploads artifacts instead of publishing GitHub Releases, so the
// release-based desktop version helper would repeat when no release tag changes.
// Use apps/desktop/package.json as the version floor and GitHub's per-workflow
// run number as the automatic patch increment.
import { appendFileSync, readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')).version;
const runNumber = Number(process.env.GITHUB_RUN_NUMBER || '0');

if (!Number.isInteger(runNumber) || runNumber < 1) {
  console.error(`next-native-version: invalid GITHUB_RUN_NUMBER=${process.env.GITHUB_RUN_NUMBER ?? ''}`);
  process.exit(1);
}

const parts = base.split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
  console.error(`next-native-version: invalid base version ${base}`);
  process.exit(1);
}

const [major, minor, patch] = parts;
const version = `${major}.${minor}.${patch + runNumber}`;

console.error(`next-native-version: base=${base} run=${runNumber} -> ${version}`);
console.log(version);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
