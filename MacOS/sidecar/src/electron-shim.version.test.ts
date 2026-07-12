// Regression tests for the sidecar's app-version resolution.
//
// The installed /Applications/Mochlet.app reported version 0.1.28 (a stale
// hardcoded default in the electron shim) while its Info.plist said 0.1.51 —
// health/feedback lied about the version. The shim now resolves the REAL
// version: MAESTRO_VERSION (injected by the Swift launcher from Bundle.main),
// else the enclosing packaged app's Info.plist, else a dev fallback. These
// tests pin all three legs.

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { parseBundleVersion, readBundleVersion, resolveAppVersion } from './electron-shim.ts';

const plist = (v: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Mochlet</string>
  <key>CFBundleShortVersionString</key><string>${v}</string>
  <key>CFBundleVersion</key><string>${v}</string>
</dict>
</plist>`;

describe('parseBundleVersion', () => {
  it('extracts CFBundleShortVersionString', () => {
    expect(parseBundleVersion(plist('0.1.51'))).toBe('0.1.51');
  });
  it('tolerates whitespace variance', () => {
    expect(parseBundleVersion('<key>CFBundleShortVersionString</key>\n  <string> 9.9.9 </string>')).toBe('9.9.9');
  });
  it('returns null when the key is absent', () => {
    expect(parseBundleVersion('<plist><dict><key>Other</key><string>x</string></dict></plist>')).toBeNull();
  });
});

describe('readBundleVersion', () => {
  let tmp = '';
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

  it('walks up from the sidecar node to the enclosing .app Info.plist', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'mochi-ver-'));
    const contents = path.join(tmp, 'Mochlet.app', 'Contents');
    const binDir = path.join(contents, 'Resources', 'sidecar', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(contents, 'Info.plist'), plist('0.1.51'));
    const fakeNode = path.join(binDir, 'node');
    writeFileSync(fakeNode, '');
    expect(readBundleVersion(fakeNode)).toBe('0.1.51');
  });

  it('returns null when there is no enclosing bundle', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'mochi-nover-'));
    expect(readBundleVersion(path.join(tmp, 'node'))).toBeNull();
  });
});

describe('resolveAppVersion (memoised, env-first)', () => {
  afterEach(() => { vi.resetModules(); delete process.env.MAESTRO_VERSION; });

  it('prefers MAESTRO_VERSION when set', async () => {
    vi.resetModules();
    process.env.MAESTRO_VERSION = '0.1.51';
    const mod = await import('./electron-shim.ts');
    expect(mod.resolveAppVersion()).toBe('0.1.51');
    expect(mod.app.getVersion()).toBe('0.1.51');
  });

  it('never returns the old stale 0.1.28 constant', () => {
    // Whatever it resolves to in this process, it must not be the removed default.
    expect(resolveAppVersion()).not.toBe('0.1.28');
    expect(resolveAppVersion().length).toBeGreaterThan(0);
  });
});
