/* Pure gh release-asset resolution + checksum parsing (no network, no Electron). */
import { describe, it, expect } from 'vitest';
import { ghPlatform, ghAssetName, ghBinInArchive, parseChecksum, ghAssetUrl, ghChecksumsUrl, GH_VERSION } from './gh-cli.js';

describe('ghPlatform / ghAssetName', () => {
  it('maps each supported platform/arch to GitHub release naming', () => {
    expect(ghAssetName('2.63.2', 'darwin', 'arm64')).toBe('gh_2.63.2_macOS_arm64.zip');
    expect(ghAssetName('2.63.2', 'darwin', 'x64')).toBe('gh_2.63.2_macOS_amd64.zip');
    expect(ghAssetName('2.63.2', 'linux', 'x64')).toBe('gh_2.63.2_linux_amd64.tar.gz');
    expect(ghAssetName('2.63.2', 'linux', 'arm64')).toBe('gh_2.63.2_linux_arm64.tar.gz');
    expect(ghAssetName('2.63.2', 'win32', 'x64')).toBe('gh_2.63.2_windows_amd64.zip');
  });
  it('uses zip for macOS/Windows and tar.gz for Linux', () => {
    expect(ghPlatform('darwin', 'arm64')?.ext).toBe('zip');
    expect(ghPlatform('win32', 'x64')?.ext).toBe('zip');
    expect(ghPlatform('linux', 'x64')?.ext).toBe('tar.gz');
  });
  it('returns null for unsupported arch', () => {
    expect(ghPlatform('linux', 'ia32')).toBeNull();
    expect(ghAssetName('2.63.2', 'linux', 'ia32')).toBeNull();
  });
});

describe('ghBinInArchive', () => {
  it('points at bin/gh inside the versioned dir', () => {
    expect(ghBinInArchive('2.63.2', 'darwin', 'arm64')).toBe('gh_2.63.2_macOS_arm64/bin/gh');
    expect(ghBinInArchive('2.63.2', 'win32', 'x64')).toBe('gh_2.63.2_windows_amd64/bin/gh.exe');
  });
});

describe('parseChecksum', () => {
  const body = [
    'abc123  gh_2.63.2_linux_amd64.tar.gz',
    'deadbeef00000000000000000000000000000000000000000000000000000000  gh_2.63.2_macOS_arm64.zip',
    '1111111111111111111111111111111111111111111111111111111111111111  gh_2.63.2_windows_amd64.zip',
  ].join('\n');
  it('finds the sha256 for the exact asset', () => {
    expect(parseChecksum(body, 'gh_2.63.2_macOS_arm64.zip')).toBe('deadbeef00000000000000000000000000000000000000000000000000000000');
  });
  it('returns null when the asset is absent or the hash is malformed', () => {
    expect(parseChecksum(body, 'gh_2.63.2_linux_amd64.tar.gz')).toBeNull(); // hash too short → not 64 hex
    expect(parseChecksum(body, 'gh_2.63.2_darwin_amd64.zip')).toBeNull();
  });
});

describe('release URLs', () => {
  it('point at the pinned cli/cli release', () => {
    expect(ghAssetUrl('2.63.2', 'darwin', 'arm64')).toBe('https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_macOS_arm64.zip');
    expect(ghChecksumsUrl('2.63.2')).toBe('https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_checksums.txt');
  });
  it('exposes a pinned version', () => {
    expect(GH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
