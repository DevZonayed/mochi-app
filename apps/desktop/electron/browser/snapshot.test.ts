import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright-core';
import { snapshotPage, injectedSnapshot, resolveRef } from './snapshot.js';

/* Gated real-Chrome test. If Chrome (channel:'chrome') isn't installable in the
   environment it returns early = green-skip, so CI without a browser stays green.
   Locally (Chrome present) it proves the full ref round-trip end to end. */
const HTML = 'data:text/html,<h1>Hi</h1><button>Click me</button><a href="/x">Link</a>';

async function ctxOrSkip() {
  try {
    return await chromium.launchPersistentContext('/tmp/mochi-snap-' + Date.now(), { channel: 'chrome', headless: true, viewport: null });
  } catch { return null; }
}

describe('snapshotPage (real Chrome, gated)', () => {
  it('produces AI refs that resolve + click via aria-ref', async () => {
    const ctx = await ctxOrSkip();
    if (!ctx) { expect(true).toBe(true); return; }
    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await page.goto(HTML, { waitUntil: 'domcontentloaded' });
      const snap = await snapshotPage(page as any);
      expect(snap.tree).toMatch(/button/i);
      expect(snap.refs.length).toBeGreaterThan(0);
      expect(snap.tree).toMatch(/\[ref=e\d+\]/); // AI snapshot path on this version
      const loc: any = resolveRef(page as any, snap.refs[0]);
      expect(await loc.count()).toBeGreaterThan(0);
      // a button ref should be clickable
      const btnRef = (snap.tree.match(/button[^\n]*\[ref=(e\d+)\]/) || [])[1];
      if (btnRef) await (resolveRef(page as any, btnRef) as any).click({ timeout: 2000 });
    } finally { await ctx.close(); }
  });

  it('injected fallback tags elements with data-mochi-ref and resolves them', async () => {
    const ctx = await ctxOrSkip();
    if (!ctx) { expect(true).toBe(true); return; }
    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await page.goto(HTML, { waitUntil: 'domcontentloaded' });
      const snap = await injectedSnapshot(page as any);
      expect(snap.refs[0]).toBe('m1');
      const loc: any = resolveRef(page as any, 'm1');
      expect(await loc.count()).toBe(1);
    } finally { await ctx.close(); }
  });
});
