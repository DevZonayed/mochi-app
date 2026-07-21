// Source-contract test: a stored-but-unreadable provider credential
// (listProviders → status:'reconnect') must render TRUTHFULLY — not green
// "Connected", not silently absent — in both Settings and Onboarding. These
// screens are too large to mount headless, so we lock the exact seams.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(HERE, rel), 'utf8');

describe('Settings — reconnect-required is a distinct, non-connected state', () => {
  const src = read('Settings.tsx');
  it('derives needsReconnect from status === reconnect', () => {
    expect(src).toMatch(/needsReconnect\s*=\s*c\?\.status\s*===\s*'reconnect'/);
  });
  it('excludes reconnect from the connected (green) state', () => {
    expect(src).toMatch(/connected\s*=\s*!!c\s*&&\s*!needsReconnect/);
  });
  it('renders reconnect in amber with its secret-free detail (not "Connected")', () => {
    expect(src).toMatch(/needsReconnect\s*\?\s*'var\(--orange\)'/);
    expect(src).toMatch(/needsReconnect\s*\?\s*\(c\?\.detail/);
  });
});

describe('Onboarding — a reconnect row is NOT treated as connected', () => {
  const src = read('Onboarding.tsx');
  it('skips any conn whose status is not connected before marking connected', () => {
    expect(src).toMatch(/if\s*\(c\.status\s*!==\s*'connected'\)\s*continue;/);
  });
});
