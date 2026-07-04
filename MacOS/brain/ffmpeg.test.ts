/* Pure ffmpeg-store logic: platform pins, spec resolution and the managed
   install layout (no network, no downloads). */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FFMPEG_PLAT, ffmpegSpec, managedFfmpeg, managedFfmpegTarget } from './ffmpeg.js';

const hostSpec = ffmpegSpec(); // pins for the machine running the suite

describe('FFMPEG_PLAT pins', () => {
  it('covers the five supported platforms with @ffmpeg-installer packages', () => {
    expect(Object.keys(FFMPEG_PLAT).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64',
    ]);
    for (const { pkg, version } of Object.values(FFMPEG_PLAT)) {
      expect(pkg).toMatch(/^@ffmpeg-installer\/[a-z0-9-]+$/);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('ffmpegSpec', () => {
  it('resolves the pinned package + binary name per platform', () => {
    expect(ffmpegSpec('darwin', 'arm64')).toEqual({ pkg: '@ffmpeg-installer/darwin-arm64', version: '4.1.5', bin: 'ffmpeg' });
    expect(ffmpegSpec('linux', 'x64')).toEqual({ pkg: '@ffmpeg-installer/linux-x64', version: '4.1.0', bin: 'ffmpeg' });
    expect(ffmpegSpec('win32', 'x64')).toEqual({ pkg: '@ffmpeg-installer/win32-x64', version: '4.1.0', bin: 'ffmpeg.exe' });
  });
  it('returns null for unsupported platform/arch combos', () => {
    expect(ffmpegSpec('win32', 'arm64')).toBeNull();
    expect(ffmpegSpec('freebsd' as NodeJS.Platform, 'x64')).toBeNull();
    expect(ffmpegSpec('darwin', 'ia32')).toBeNull();
  });
});

describe('managed install layout', () => {
  let root: string;
  const mkRoot = (): string => (root = mkdtempSync(path.join(tmpdir(), 'maestro-ffmpeg-')));
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('managedFfmpegTarget points inside <root>/ffmpeg/<version>/', () => {
    if (!hostSpec) return; // unsupported CI host — nothing to assert
    const target = managedFfmpegTarget(mkRoot());
    expect(target).toBe(path.join(root, 'ffmpeg', hostSpec.version, hostSpec.bin));
  });

  it('managedFfmpeg requires BOTH the .ok marker and the binary', () => {
    if (!hostSpec) return;
    mkRoot();
    expect(managedFfmpeg(root)).toBeNull(); // empty root

    const dir = path.join(root, 'ffmpeg', hostSpec.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, hostSpec.bin), 'fake-binary');
    expect(managedFfmpeg(root)).toBeNull(); // binary but unverified (no .ok)

    writeFileSync(path.join(dir, '.ok'), '{}');
    expect(managedFfmpeg(root)).toBe(path.join(dir, hostSpec.bin)); // verified

    rmSync(path.join(dir, hostSpec.bin));
    expect(managedFfmpeg(root)).toBeNull(); // marker without binary
  });

  it('ignores other versions than the pinned one', () => {
    if (!hostSpec) return;
    mkRoot();
    const stale = path.join(root, 'ffmpeg', '0.0.1');
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, hostSpec.bin), 'old');
    writeFileSync(path.join(stale, '.ok'), '{}');
    expect(managedFfmpeg(root)).toBeNull();
  });
});
