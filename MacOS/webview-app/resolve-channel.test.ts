// Regression tests for the packaging channel resolver (resolve-channel.sh).
//
// package-app.sh must select the release channel from a VALIDATED MAESTRO_CHANNEL
// (production is the default; unknown channels are rejected) and emit the
// channel-specific app name / bundle id / userData dir / MCP port so production,
// preview, and development bundles stay fully isolated.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./resolve-channel.sh', import.meta.url));

function resolve(channel?: string): { code: number; fields: Record<string, string>; stderr: string } {
  const env = { ...process.env, MAESTRO_CHANNEL: channel ?? '' };
  const res = spawnSync(SCRIPT, [], { encoding: 'utf8', env });
  const fields: Record<string, string> = {};
  for (const line of (res.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  return { code: res.status ?? -1, fields, stderr: res.stderr || '' };
}

describe('resolve-channel.sh', () => {
  it('defaults to the production channel when MAESTRO_CHANNEL is unset', () => {
    const { code, fields } = resolve('');
    expect(code).toBe(0);
    expect(fields).toMatchObject({
      CHANNEL: 'production',
      APP_NAME: 'Mochlet',
      BUNDLE_ID: 'cloud.nexalance.maestro.webkit',
      USER_DATA_DIR: 'desktop',
      MCP_PORT: '9235',
    });
  });
  it('resolves the preview channel with an isolated bundle id / userData / port', () => {
    const { code, fields } = resolve('preview');
    expect(code).toBe(0);
    expect(fields).toMatchObject({
      CHANNEL: 'preview',
      APP_NAME: 'Mochlet Preview',
      BUNDLE_ID: 'cloud.nexalance.maestro.webkit.preview',
      USER_DATA_DIR: 'desktop-preview',
      MCP_PORT: '9236',
    });
  });
  it('resolves the development channel', () => {
    const { code, fields } = resolve('development');
    expect(code).toBe(0);
    expect(fields).toMatchObject({
      CHANNEL: 'development',
      APP_NAME: 'Mochlet Development',
      BUNDLE_ID: 'cloud.nexalance.maestro.webkit.development',
      USER_DATA_DIR: 'desktop-development',
      MCP_PORT: '9237',
    });
  });
  it('REJECTS an unknown channel (nonzero exit, no fields)', () => {
    const { code, stderr } = resolve('staging');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown.*channel/i);
  });
});
