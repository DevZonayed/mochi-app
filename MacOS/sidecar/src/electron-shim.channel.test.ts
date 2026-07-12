// Channel isolation for the sidecar's userData directory.
//
// Each release channel MUST use a distinct userData dir so production, preview,
// and development never read or mutate each other's store/token/runtime:
//   production   → ~/Library/Application Support/@maestro/desktop
//   preview      → ~/Library/Application Support/@maestro/desktop-preview
//   development  → ~/Library/Application Support/@maestro/desktop-development
// An explicit MAESTRO_USER_DATA_DIR (the Swift launcher injects it) always wins.
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { channelSubdir, resolveUserDataPath } from './electron-shim.ts';

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');

describe('channelSubdir', () => {
  it('maps each channel to its isolated @maestro subdir', () => {
    expect(channelSubdir('production')).toBe('desktop');
    expect(channelSubdir('preview')).toBe('desktop-preview');
    expect(channelSubdir('development')).toBe('desktop-development');
  });
  it('absent/unknown channel defaults to production (safe)', () => {
    expect(channelSubdir(undefined)).toBe('desktop');
    expect(channelSubdir('')).toBe('desktop');
    expect(channelSubdir('bogus')).toBe('desktop');
  });
});

describe('resolveUserDataPath (pure, no mkdir)', () => {
  it('production / absent channel → @maestro/desktop', () => {
    expect(resolveUserDataPath({})).toBe(path.join(APP_SUPPORT, '@maestro', 'desktop'));
    expect(resolveUserDataPath({ MAESTRO_CHANNEL: 'production' })).toBe(path.join(APP_SUPPORT, '@maestro', 'desktop'));
  });
  it('preview → @maestro/desktop-preview (isolated from production)', () => {
    expect(resolveUserDataPath({ MAESTRO_CHANNEL: 'preview' })).toBe(path.join(APP_SUPPORT, '@maestro', 'desktop-preview'));
  });
  it('development → @maestro/desktop-development (isolated)', () => {
    expect(resolveUserDataPath({ MAESTRO_CHANNEL: 'development' })).toBe(path.join(APP_SUPPORT, '@maestro', 'desktop-development'));
  });
  it('an explicit MAESTRO_USER_DATA_DIR wins over the channel', () => {
    expect(resolveUserDataPath({ MAESTRO_USER_DATA_DIR: '/tmp/mochi-x', MAESTRO_CHANNEL: 'preview' })).toBe('/tmp/mochi-x');
  });
  it('a ~-prefixed override is expanded', () => {
    expect(resolveUserDataPath({ MAESTRO_USER_DATA_DIR: '~/foo' })).toBe(path.join(os.homedir(), 'foo'));
  });
});
