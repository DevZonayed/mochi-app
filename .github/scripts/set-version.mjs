// Rewrite apps/desktop/package.json's "version" to $VERSION (value-only replace,
// so formatting is preserved). Used by the release workflow to sync the bumped
// version back to master after publishing.
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'apps/desktop/package.json';
const v = process.env.VERSION;
if (!v) { console.error('set-version: VERSION env not set'); process.exit(1); }

const s = readFileSync(f, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${v}$2`);
writeFileSync(f, s);
console.error(`set-version: ${f} -> ${v}`);
