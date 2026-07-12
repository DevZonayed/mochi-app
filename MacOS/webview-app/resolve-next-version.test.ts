// Regression tests for resolve-next-version.sh — the CI "next release" resolver.
//
// It gathers semver candidates from resolve-version.sh (repo), the installed
// /Applications/Mochlet[.| Preview].app bundles, and explicitly-supplied candidate
// app paths / versions, ignores anything that isn't a strict X.Y.Z, and returns
// the next PATCH after the HIGHEST NUMERIC semver (never lower/equal). Test knobs
// (all non-secret): MAESTRO_VERSION (repo candidate via resolve-version.sh),
// MAESTRO_APPLICATIONS_DIR (override /Applications), MAESTRO_EXTRA_VERSIONS
// (comma/space list), and extra .app paths as positional args.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./resolve-next-version.sh', import.meta.url));

function fakeApp(appsDir: string, appName: string, version: string): string {
  const contents = path.join(appsDir, `${appName}.app`, 'Contents');
  mkdirSync(contents, { recursive: true });
  writeFileSync(path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`);
  return path.join(appsDir, `${appName}.app`);
}

function run(env: Record<string, string>, args: string[] = []): { code: number; out: string; err: string } {
  const res = spawnSync(SCRIPT, args, { encoding: 'utf8', env: { ...process.env, MAESTRO_VERSION: '', MAESTRO_EXTRA_VERSIONS: '', ...env } });
  return { code: res.status ?? -1, out: (res.stdout || '').trim(), err: res.stderr || '' };
}

describe('resolve-next-version.sh', () => {
  let apps = '';
  beforeEach(() => { apps = mkdtempSync(path.join(os.tmpdir(), 'mochi-apps-')); });
  afterEach(() => { if (apps) rmSync(apps, { recursive: true, force: true }); apps = ''; });

  it('installed prod 0.1.51 + repo 0.1.51 + no preview → next 0.1.52', () => {
    fakeApp(apps, 'Mochlet', '0.1.51');
    const { code, out } = run({ MAESTRO_VERSION: '0.1.51', MAESTRO_APPLICATIONS_DIR: apps });
    expect(code).toBe(0);
    expect(out).toBe('0.1.52');
  });

  it('numeric semver ordering (0.10.9 > 0.9.99) → 0.10.10', () => {
    const { out } = run({ MAESTRO_VERSION: '0.1.0', MAESTRO_APPLICATIONS_DIR: apps, MAESTRO_EXTRA_VERSIONS: '0.9.99,0.10.9' });
    expect(out).toBe('0.10.10');
  });

  it('ignores malformed / non-X.Y.Z candidates safely', () => {
    const { code, out } = run({
      MAESTRO_VERSION: '0.1.51',
      MAESTRO_APPLICATIONS_DIR: apps,
      MAESTRO_EXTRA_VERSIONS: '1.2, abc, 0.09.1, v2.0.0, 1.2.3.4, 9.9', // all invalid
    });
    expect(code).toBe(0);
    expect(out).toBe('0.1.52');
  });

  it('missing apps → still resolves from the repo candidate', () => {
    const { out } = run({ MAESTRO_VERSION: '0.1.51', MAESTRO_APPLICATIONS_DIR: apps }); // empty apps dir
    expect(out).toBe('0.1.52');
  });

  it('a higher installed Preview wins the max', () => {
    fakeApp(apps, 'Mochlet', '0.1.51');
    fakeApp(apps, 'Mochlet Preview', '0.2.0');
    const { out } = run({ MAESTRO_VERSION: '0.1.51', MAESTRO_APPLICATIONS_DIR: apps });
    expect(out).toBe('0.2.1');
  });

  it('an explicit candidate .app path arg is considered', () => {
    const extra = fakeApp(apps, 'Somewhere', '0.3.0');
    const { out } = run({ MAESTRO_VERSION: '0.1.51', MAESTRO_APPLICATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), 'mochi-empty-')) }, [extra]);
    expect(out).toBe('0.3.1');
  });

  it('never returns lower/equal than the highest candidate', () => {
    fakeApp(apps, 'Mochlet', '0.1.51');
    const { out } = run({ MAESTRO_VERSION: '0.1.51', MAESTRO_APPLICATIONS_DIR: apps, MAESTRO_EXTRA_VERSIONS: '0.1.40,0.0.1' });
    expect(out).toBe('0.1.52');
  });
});
