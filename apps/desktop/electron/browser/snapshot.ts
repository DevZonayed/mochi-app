/* Ref-tagged page snapshot — the parity linchpin for browser_snapshot/click.
   The agent reads `tree` (a role-based outline with inline [ref=eN] tags) and
   passes a ref to browser_click/type; `resolveRef` turns that ref back into a
   Playwright Locator.

   Primary path: Playwright's AI aria snapshot. `ariaSnapshot({ mode:'ai' })`
   emits the same [ref=eN] tags Microsoft's @playwright/mcp uses, and the
   built-in `aria-ref=` selector engine resolves them. Verified against Chrome
   149 + playwright-core 1.61. Fallback: if a build ever stops emitting AI refs,
   we inject our own `data-mochi-ref="mN"` outline (version-independent). The
   two ref namespaces never collide — AI refs are `eN`, injected refs are `mN`. */
import type { PwPageLike } from './types.js';

export interface PageSnapshot { tree: string; refs: string[] }

const AI_REF = /\[ref=(e\d+)\]/g;

export async function snapshotPage(page: PwPageLike): Promise<PageSnapshot> {
  const p = page as unknown as { ariaSnapshot(o?: unknown): Promise<string> };
  let tree = '';
  try { tree = await p.ariaSnapshot({ mode: 'ai' }); } catch { tree = ''; }
  const aiRefs = [...tree.matchAll(AI_REF)].map((m) => m[1]);
  if (aiRefs.length) return { tree, refs: aiRefs };
  return injectedSnapshot(page);
}

/** Fallback: walk the DOM for interactive/visible elements, tag each with a
    stable `data-mochi-ref`, and build the outline ourselves. */
export async function injectedSnapshot(page: PwPageLike): Promise<PageSnapshot> {
  const p = page as unknown as { evaluate(fn: () => string[]): Promise<string[]> };
  const rows = await p.evaluate(() => {
    const sel = 'a,button,input,select,textarea,[role],[onclick],summary,[contenteditable="true"]';
    let n = 0; const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const ref = 'm' + (++n);
      he.setAttribute('data-mochi-ref', ref);
      const name = (he.innerText || (he as HTMLInputElement).value || he.getAttribute('aria-label') || he.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const role = he.getAttribute('role') || he.tagName.toLowerCase();
      out.push(`- ${role} "${name}" [ref=${ref}]`);
    }
    return out;
  });
  return { tree: rows.join('\n'), refs: rows.length ? rows.map((_, i) => 'm' + (i + 1)) : [] };
}

/** Turn a ref (eN from the AI snapshot, mN from the injected fallback, with or
    without an `aria-ref=` prefix) into a Locator. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveRef(page: PwPageLike, ref: string): any {
  const id = String(ref).replace(/^aria-ref=/, '').trim();
  const p = page as unknown as { locator(sel: string): unknown };
  if (/^m\d+$/.test(id)) return p.locator(`[data-mochi-ref="${id}"]`);
  return p.locator(`aria-ref=${id}`);
}
