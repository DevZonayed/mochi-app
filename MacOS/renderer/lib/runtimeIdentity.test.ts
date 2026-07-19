// Pure formatter for the runtime identity footer (channel → app name, version →
// label). No React, no network — just the display contract, so the Settings
// footer can render honestly for production / preview / development, an unknown
// channel, and a missing version.
import { describe, it, expect } from 'vitest';
import { formatRuntimeIdentity } from './runtimeIdentity';

describe('formatRuntimeIdentity', () => {
  it('names each known channel', () => {
    expect(formatRuntimeIdentity({ channel: 'production', version: '0.1.56' }).name).toBe('Mochlet');
    expect(formatRuntimeIdentity({ channel: 'preview', version: '0.1.56' }).name).toBe('Mochlet Preview');
    expect(formatRuntimeIdentity({ channel: 'development', version: '0.1.56' }).name).toBe('Mochlet Development');
  });

  it('formats the version label as "Version X.Y.Z"', () => {
    expect(formatRuntimeIdentity({ channel: 'preview', version: '0.1.56' }).versionLabel).toBe('Version 0.1.56');
  });

  it('falls back to the production identity for an unknown/missing channel', () => {
    expect(formatRuntimeIdentity({ channel: 'staging', version: '1.0.0' }).name).toBe('Mochlet');
    expect(formatRuntimeIdentity({ channel: undefined, version: '1.0.0' }).name).toBe('Mochlet');
    expect(formatRuntimeIdentity({ version: '1.0.0' }).channel).toBe('production');
  });

  it('is fail-soft on a missing/blank version — it never invents a number', () => {
    const missing = formatRuntimeIdentity({ channel: 'preview', version: undefined });
    expect(missing.versionLabel).toBe('Version unavailable');
    expect(missing.versionLabel).not.toMatch(/\d/);
    expect(formatRuntimeIdentity({ channel: 'preview', version: '   ' }).versionLabel).toBe('Version unavailable');
    expect(formatRuntimeIdentity({ channel: 'preview', version: null }).versionLabel).toBe('Version unavailable');
  });

  it('provides an aria label describing name + version', () => {
    expect(formatRuntimeIdentity({ channel: 'preview', version: '0.1.56' }).ariaLabel)
      .toBe('Running Mochlet Preview, version 0.1.56');
    expect(formatRuntimeIdentity({ channel: 'production', version: undefined }).ariaLabel)
      .toContain('version unavailable');
  });
});
