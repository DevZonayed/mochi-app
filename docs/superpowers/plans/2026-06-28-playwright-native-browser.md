# Playwright-native Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native macOS app a Playwright-driven browser that uses the user's installed Chrome (no bundled Chromium), with per-project persistent profiles, comment/steer powers, a dedicated Swift surface, and Settings — replacing the extension as the browser backend for the native path.

**Architecture:** A new in-process `BrowserManager` in `apps/desktop/electron/browser/` owns one Playwright `launchPersistentContext({channel:'chrome'})` per project. The existing ~50 `browser_*` agent tools keep their vocabulary; their backend swaps from `ExtensionBridge.request` to `BrowserManager.call` via a new `engine.setBrowserManager()`. The Swift app drives the same manager over new `browser*` RPCs and renders a Browser genre + Settings pane.

**Tech Stack:** TypeScript (Node/Electron + sidecar), `playwright-core`, vitest; SwiftUI (`MacOS/app`).

## Global Constraints

- **No bundled Chromium.** Depend on **`playwright-core`** only; launch with `channel: "chrome"`. Verify install adds no `~/.cache/ms-playwright` download.
- **Profiles dir:** `<userData>/browser-profiles/<projectId>/` via a single exported helper `browserProfileDir(projectId)`. `userData = ~/Library/Application Support/@maestro/desktop`.
- **Dedicated per-project profiles**, never the user's default Chrome profile. One context per project.
- **Tests live in `apps/desktop/electron/**` `*.test.ts`** (vitest) so they run in the standing `pnpm --filter @maestro/desktop test` suite. Renderer/`src/**` tests are NOT in that suite.
- **Merge/commit policy:** never merge/push master; **commit only when the operator asks** — build and leave staged. (Plan includes commit steps per TDD convention; defer the actual `git commit` to operator approval at phase boundaries.)
- **No AI-attribution** in any commit/PR.
- New TS code in `apps/desktop/electron` is consumed by BOTH `main.ts` (Electron) and `MacOS/sidecar` (imports `../../../apps/desktop/electron/*.js`). No Electron-only imports in `browser/` modules.

---

### Task 0.1: Add `playwright-core`, prove no browser download

**Files:**
- Modify: `apps/desktop/package.json` (dependencies)

**Interfaces:**
- Produces: `playwright-core` resolvable from `apps/desktop/electron` and the sidecar.

- [ ] **Step 1:** Add the dep:

```bash
cd apps/desktop
pnpm add playwright-core@^1.49.0
```

- [ ] **Step 2:** Verify NO browser binaries were downloaded (the `-core` package must not populate the ms-playwright cache):

```bash
ls -la ~/.cache/ms-playwright 2>/dev/null || ls -la "$HOME/Library/Caches/ms-playwright" 2>/dev/null || echo "NO ms-playwright cache — good"
```
Expected: "NO ms-playwright cache — good" (or a pre-existing cache unchanged in size).

- [ ] **Step 3:** Sanity import + detect installed Chrome via the channel (no launch):

```bash
node -e "const {chromium}=require('playwright-core'); console.log('playwright-core OK', typeof chromium.launchPersistentContext)"
```
Expected: `playwright-core OK function`

- [ ] **Step 4 (commit — defer to operator):** `git add apps/desktop/package.json pnpm-lock.yaml && git commit -m "build(desktop): add playwright-core (no bundled chromium)"`

---

### Task 0.2: `browserProfileDir()` path helper

**Files:**
- Create: `apps/desktop/electron/browser/paths.ts`
- Test: `apps/desktop/electron/browser/paths.test.ts`

**Interfaces:**
- Produces: `export function browserProfilesRoot(userDataDir: string): string` and `export function browserProfileDir(userDataDir: string, projectId: string): string`. Project id is sanitized to a safe dir segment.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { browserProfilesRoot, browserProfileDir } from './paths.js';

describe('browser profile paths', () => {
  it('nests profiles under <userData>/browser-profiles', () => {
    expect(browserProfilesRoot('/u')).toBe('/u/browser-profiles');
  });
  it('puts each project in its own dir', () => {
    expect(browserProfileDir('/u', 'proj_123')).toBe('/u/browser-profiles/proj_123');
  });
  it('sanitizes unsafe project ids', () => {
    expect(browserProfileDir('/u', '../../etc')).toBe('/u/browser-profiles/______etc');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd apps/desktop && pnpm exec vitest run electron/browser/paths.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import path from 'node:path';

const SAFE = /[^a-zA-Z0-9._-]/g;

export function browserProfilesRoot(userDataDir: string): string {
  return path.join(userDataDir, 'browser-profiles');
}

export function browserProfileDir(userDataDir: string, projectId: string): string {
  const safe = projectId.replace(SAFE, '_');
  return path.join(browserProfilesRoot(userDataDir), safe);
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd apps/desktop && pnpm exec vitest run electron/browser/paths.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): add per-project profile path helper"`

---

### Task 0.3: `BrowserManager` lifecycle (open/close/status/navigate/screenshot/clearData/shutdown)

**Files:**
- Create: `apps/desktop/electron/browser/manager.ts`
- Create: `apps/desktop/electron/browser/types.ts`
- Test: `apps/desktop/electron/browser/manager.test.ts`

**Interfaces:**
- Consumes: `browserProfileDir` (0.2), `playwright-core`.
- Produces:
  ```ts
  // types.ts
  export interface BrowserSettings { enabled: boolean; headless: boolean; chromePath?: string; defaultStartUrl?: string; windowWidth?: number; windowHeight?: number }
  export interface BrowserStatus { projectId: string; open: boolean; url: string|null; title: string|null; tabCount: number; lastScreenshotAt: number|null; chromeVersion: string|null; error?: string }
  export interface OpenOpts { startUrl?: string }
  export interface BrowserManagerDeps {
    userDataDir: string;
    settings: () => BrowserSettings;
    dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    emit: (status: BrowserStatus) => void;
    launcher?: Launcher; // injectable for tests; defaults to playwright-core chromium
  }
  export interface Launcher { launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContextLike> }
  export interface PwContextLike { pages(): PwPageLike[]; newPage(): Promise<PwPageLike>; close(): Promise<void>; on(ev:'close', cb:()=>void): void; browser(): { version(): string }|null; addInitScript(s: string): Promise<void>; exposeBinding(n: string, cb: (src:unknown, payload:any)=>unknown): Promise<void> }
  export interface PwPageLike { goto(url:string, o?:any): Promise<unknown>; url(): string; title(): Promise<string>; screenshot(o?:any): Promise<Buffer>; bringToFront(): Promise<void> }
  ```
  Class `BrowserManager` with: `open(projectId, opts?) → Promise<BrowserStatus>`, `close(projectId) → Promise<void>`, `status(projectId) → BrowserStatus`, `statusAll() → BrowserStatus[]`, `navigate(projectId, url) → Promise<BrowserStatus>`, `screenshot(projectId, {fullPage?}) → Promise<{dataUrl:string}>`, `clearData(projectId) → Promise<void>`, `shutdown() → Promise<void>`. (`.call(...)` added in P1.)

- [ ] **Step 1: Write the failing test** (uses a fake launcher — no real Chrome):

```ts
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager } from './manager.js';

function fakePage(url='about:blank') {
  return { _url:url, goto: vi.fn(async(u:string)=>{ (this as any); }), url(){return (this as any)._url;}, title: async()=>'T', screenshot: async()=>Buffer.from('img'), bringToFront: async()=>{} } as any;
}
function fakeLauncher() {
  const page = { _url:'about:blank', goto: vi.fn(async function(this:any,u:string){ this._url=u; }), url(){return (this as any)._url;}, title: async()=>'Title', screenshot: async()=>Buffer.from('PNG'), bringToFront: async()=>{} };
  const ctx:any = { _closed:false, pages:()=>[page], newPage: async()=>page, close: vi.fn(async function(this:any){ this._closed=true; this._cb?.(); }), on(_e:string,cb:()=>void){ this._cb=cb; }, browser:()=>({version:()=>'126.0'}), addInitScript: vi.fn(async()=>{}), exposeBinding: vi.fn(async()=>{}) };
  return { launchPersistentContext: vi.fn(async()=>ctx), _ctx: ctx, _page: page };
}

function mk(launcher:any) {
  const emit = vi.fn();
  const m = new BrowserManager({ userDataDir:'/tmp/ud', settings:()=>({enabled:true,headless:false}), dispatch: async()=>({}), emit, launcher });
  return { m, emit };
}

describe('BrowserManager lifecycle', () => {
  it('open launches a persistent context with channel:chrome and reports open', async () => {
    const launcher = fakeLauncher(); const { m, emit } = mk(launcher);
    const st = await m.open('proj_1', { startUrl: 'https://example.com' });
    expect(launcher.launchPersistentContext).toHaveBeenCalledWith('/tmp/ud/browser-profiles/proj_1', expect.objectContaining({ channel:'chrome', headless:false }));
    expect(st.open).toBe(true); expect(st.chromeVersion).toBe('126.0');
    expect(emit).toHaveBeenCalled();
  });
  it('open is idempotent — second call reuses the context', async () => {
    const launcher = fakeLauncher(); const { m } = mk(launcher);
    await m.open('proj_1'); await m.open('proj_1');
    expect(launcher.launchPersistentContext).toHaveBeenCalledTimes(1);
  });
  it('navigate goes to the url and status reflects it', async () => {
    const launcher = fakeLauncher(); const { m } = mk(launcher);
    await m.open('proj_1');
    const st = await m.navigate('proj_1','https://a.test');
    expect(st.url).toBe('https://a.test');
  });
  it('close closes the context and status goes not-open', async () => {
    const launcher = fakeLauncher(); const { m } = mk(launcher);
    await m.open('proj_1'); await m.close('proj_1');
    expect(launcher._ctx.close).toHaveBeenCalled();
    expect(m.status('proj_1').open).toBe(false);
  });
  it('screenshot returns a data url', async () => {
    const launcher = fakeLauncher(); const { m } = mk(launcher);
    await m.open('proj_1');
    const r = await m.screenshot('proj_1');
    expect(r.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run electron/browser/manager.test.ts` → FAIL.

- [ ] **Step 3: Implement `manager.ts`**

```ts
import { browserProfileDir } from './paths.js';
import type { BrowserManagerDeps, BrowserStatus, OpenOpts, Launcher, PwContextLike, PwPageLike } from './types.js';

interface Live { ctx: PwContextLike; page: PwPageLike; lastShot: number|null }

async function defaultLauncher(): Promise<Launcher> {
  const { chromium } = await import('playwright-core');
  return chromium as unknown as Launcher;
}

export class BrowserManager {
  private live = new Map<string, Live>();
  private opening = new Map<string, Promise<BrowserStatus>>();
  constructor(private deps: BrowserManagerDeps) {}

  private mkStatus(projectId: string, err?: string): BrowserStatus {
    const l = this.live.get(projectId);
    return {
      projectId, open: !!l,
      url: l ? l.page.url() : null,
      title: null, // filled async in status()
      tabCount: l ? l.ctx.pages().length : 0,
      lastScreenshotAt: l?.lastShot ?? null,
      chromeVersion: l ? (l.ctx.browser()?.version() ?? null) : null,
      ...(err ? { error: err } : {}),
    };
  }
  private push(projectId: string, err?: string) { const s = this.mkStatus(projectId, err); this.deps.emit(s); return s; }

  async open(projectId: string, opts?: OpenOpts): Promise<BrowserStatus> {
    if (this.live.has(projectId)) return this.push(projectId);
    const inflight = this.opening.get(projectId); if (inflight) return inflight;
    const p = (async () => {
      const s = this.deps.settings();
      const launcher = this.deps.launcher ?? await defaultLauncher();
      const dir = browserProfileDir(this.deps.userDataDir, projectId);
      let ctx: PwContextLike;
      try {
        ctx = await launcher.launchPersistentContext(dir, {
          channel: 'chrome', headless: s.headless ?? false, viewport: null,
          ...(s.chromePath ? { executablePath: s.chromePath } : {}),
          args: ['--no-first-run', '--no-default-browser-check', '--restore-last-session=false'],
        });
      } catch (e) {
        return this.push(projectId, `chrome-launch-failed: ${(e as Error).message}`);
      }
      const page = ctx.pages()[0] ?? await ctx.newPage();
      ctx.on('close', () => { this.live.delete(projectId); this.push(projectId); });
      this.live.set(projectId, { ctx, page, lastShot: null });
      const url = opts?.startUrl ?? s.defaultStartUrl;
      if (url && url !== 'about:blank') { try { await page.goto(url, { waitUntil: 'domcontentloaded' }); } catch { /* surfaced via status */ } }
      return this.push(projectId);
    })();
    this.opening.set(projectId, p);
    try { return await p; } finally { this.opening.delete(projectId); }
  }

  async close(projectId: string): Promise<void> {
    const l = this.live.get(projectId); if (!l) return;
    this.live.delete(projectId);
    try { await l.ctx.close(); } catch { /* */ }
    this.push(projectId);
  }

  status(projectId: string): BrowserStatus { return this.mkStatus(projectId); }
  statusAll(): BrowserStatus[] { return [...this.live.keys()].map(id => this.mkStatus(id)); }

  async navigate(projectId: string, url: string): Promise<BrowserStatus> {
    const l = this.live.get(projectId); if (!l) await this.open(projectId, { startUrl: url });
    const live = this.live.get(projectId); if (!live) return this.status(projectId);
    await live.page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.push(projectId);
  }

  async screenshot(projectId: string, opts?: { fullPage?: boolean }): Promise<{ dataUrl: string }> {
    const l = this.live.get(projectId); if (!l) throw new Error('browser not open for this project');
    const buf = await l.page.screenshot({ fullPage: !!opts?.fullPage, type: 'png' });
    l.lastShot = Date.now();
    return { dataUrl: `data:image/png;base64,${Buffer.from(buf).toString('base64')}` };
  }

  async clearData(projectId: string): Promise<void> {
    await this.close(projectId);
    const { rm } = await import('node:fs/promises');
    await rm(browserProfileDir(this.deps.userDataDir, projectId), { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map(id => this.close(id)));
  }
}
```

(Also create `types.ts` with the interfaces from the Interfaces block.)

- [ ] **Step 4: Run, verify pass** — `pnpm exec vitest run electron/browser/manager.test.ts` → PASS (5).

- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): BrowserManager per-project lifecycle"`

---

### Task 0.4: Wire BrowserManager into `main.ts` + `headless-main.ts` + shutdown

**Files:**
- Modify: `apps/desktop/electron/engine.ts` (add `setBrowserManager` injector near :2031)
- Modify: `apps/desktop/electron/localApi.ts:150` (append `browserManager?` param — used in P3)
- Modify: `apps/desktop/electron/main.ts` (~:434 createDispatch call, + construct manager + shutdown)
- Modify: `MacOS/sidecar/src/headless-main.ts` (:134 TODO, :135 createDispatch, + shutdown)
- Create: `MacOS/sidecar/src/browser-smoke.mjs` (gated real-Chrome smoke)

**Interfaces:**
- Consumes: `BrowserManager` (0.3).
- Produces: `LocalEngine.setBrowserManager(m: BrowserManager)`; `createDispatch(..., browserManager?)`.

- [ ] **Step 1:** In `engine.ts` after the `setBrowserWatcher` injector (~:2038) add:

```ts
private browserManager?: import('./browser/manager.js').BrowserManager;
setBrowserManager(m: import('./browser/manager.js').BrowserManager) { this.browserManager = m; }
```

- [ ] **Step 2:** In `localApi.ts:150`, append `browserManager?: import('./browser/manager.js').BrowserManager` as the final param of `createDispatch`.

- [ ] **Step 3:** In `main.ts`, after `engine.setExtensionBridge(...)` (~:439) add:

```ts
const browserManager = new BrowserManager({
  userDataDir: app.getPath('userData'),
  settings: () => store.getSettings().browser ?? { enabled: true, headless: false },
  dispatch: (m, p) => dispatch(m, p as any),
  emit: (s) => emit('browser', s, { desktopOnly: true }),
});
engine.setBrowserManager(browserManager);
app.on('before-quit', () => { void browserManager.shutdown(); });
```
…and append `browserManager` to the `createDispatch(...)` call at :434. Add `import { BrowserManager } from './browser/manager.js';` up top. (Note: `dispatch` is defined at :434 — declare `browserManager` AFTER it, and pass a thunk `(m,p)=>dispatch(m,p)` so the reference resolves.)

- [ ] **Step 4:** In `headless-main.ts`, replace the `getExtensionBridge → null` note at :134 with manager construction (mirror Step 3, using `shimApp.getPath('userData')`), append `browserManager` to `createDispatch(` at :135, `engine.setBrowserManager(browserManager)`, and call `browserManager.shutdown()` in the existing shutdown path. Add the import: `import { BrowserManager } from '../../../apps/desktop/electron/browser/manager.js';`.

- [ ] **Step 5:** Typecheck both:

```bash
cd apps/desktop && pnpm exec tsc --noEmit
cd ../../MacOS/sidecar && pnpm exec tsc --noEmit -p . 2>/dev/null || node --import ./src/register.mjs --check src/headless-main.ts 2>/dev/null || echo "sidecar typecheck via build step"
```
Expected: no new type errors.

- [ ] **Step 6:** Real-Chrome smoke (gated; needs installed Chrome + display). Create `browser-smoke.mjs`:

```js
import { BrowserManager } from '../../../apps/desktop/electron/browser/manager.js';
const m = new BrowserManager({ userDataDir: '/tmp/mochi-smoke', settings: ()=>({enabled:true,headless:false}), dispatch: async()=>({}), emit: s=>console.log('status', s.open, s.url) });
const st = await m.open('smoke', { startUrl: 'https://example.com' });
console.log('opened', st.open, st.chromeVersion);
const shot = await m.screenshot('smoke'); console.log('shot bytes', shot.dataUrl.length);
await m.close('smoke'); console.log('closed');
process.exit(0);
```
Run: `cd MacOS/sidecar && node --import ./src/register.mjs src/browser-smoke.mjs`
Expected: opens a real Chrome window to example.com, prints a chrome version, screenshot length, closes.

- [ ] **Step 7 (commit — defer):** `git commit -m "feat(browser): wire BrowserManager into electron + sidecar"`

---

### Task 1.1: Snapshot / ref module (the parity linchpin)

**Files:**
- Create: `apps/desktop/electron/browser/snapshot.ts`
- Test: `apps/desktop/electron/browser/snapshot.test.ts`

**Interfaces:**
- Produces: `export async function snapshotPage(page: PwPageLike): Promise<{ tree: string; refs: Map<string,string> }>` (returns a ref-tagged textual a11y/DOM outline + a map of `ref → playwright selector`); `export function resolveRef(page, ref): Locator` via `page.locator('aria-ref=' + id)`.

Use Playwright's built-in aria snapshot. Strategy: `await page.locator('body').ariaSnapshot({ ref: true })` yields a YAML tree with `[ref=eN]` tags; pass `ref` straight into `page.locator('aria-ref=eN')`. The module wraps that into the existing tool contract (a `ref` string the agent passes to `browser_click`).

- [ ] **Step 1:** Failing test against a static HTML fixture (Playwright can load `data:` URLs):

```ts
import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright-core';
import { snapshotPage, resolveRef } from './snapshot.js';
// Gated: requires installed Chrome. Skips cleanly if unavailable.
const HTML = 'data:text/html,<button>Click me</button><a href=%22/x%22>Link</a>';
describe('snapshot refs', () => {
  it('produces refs that resolve back to elements', async () => {
    let ctx; try { ctx = await chromium.launchPersistentContext('/tmp/mochi-snap', { channel:'chrome', headless:true }); } catch { return; /* no chrome in CI */ }
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(HTML);
    const snap = await snapshotPage(page as any);
    expect(snap.tree).toMatch(/button/i);
    const refMatch = snap.tree.match(/\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const loc = resolveRef(page as any, refMatch![1]);
    expect(await loc.count()).toBeGreaterThan(0);
    await ctx.close();
  });
});
```

- [ ] **Step 2:** Run → FAIL (module missing). (If no Chrome, the test returns early = green-skip; that's acceptable per gating.)

- [ ] **Step 3:** Implement:

```ts
import type { PwPageLike } from './types.js';
export async function snapshotPage(page: PwPageLike): Promise<{ tree: string; refs: Map<string,string> }> {
  const tree = await (page as any).locator('body').ariaSnapshot({ ref: true });
  const refs = new Map<string,string>();
  for (const m of tree.matchAll(/\[ref=(e\d+)\]/g)) refs.set(m[1], `aria-ref=${m[1]}`);
  return { tree, refs };
}
export function resolveRef(page: PwPageLike, ref: string) {
  const id = ref.startsWith('aria-ref=') ? ref.slice('aria-ref='.length) : ref;
  return (page as any).locator(`aria-ref=${id}`);
}
```

- [ ] **Step 4:** Run → PASS (or green-skip without Chrome).
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): aria-ref snapshot parity"`

---

### Task 1.2: `BrowserManager.call` type-map (agent tool backend)

**Files:**
- Modify: `apps/desktop/electron/browser/manager.ts` (add `call`)
- Test: `apps/desktop/electron/browser/manager-call.test.ts`

**Interfaces:**
- Consumes: `snapshotPage`/`resolveRef` (1.1).
- Produces: `BrowserManager.call(projectId, type, params?, timeoutMs?) → Promise<unknown>` handling: `status, navigate, snapshot, click, type, press_key, scroll, screenshot, evaluate, read, links, text`. Each returns the same shape the current `browser_*` tools expect (e.g. `navigate → {url}`, `snapshot → {tree}`, `evaluate → {result}`).

- [ ] **Step 1:** Failing test with the fake launcher extended so `page` has `evaluate`, `keyboard`, `locator`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager } from './manager.js';
function launcherWith(page:any){ const ctx:any={pages:()=>[page],newPage:async()=>page,close:async()=>{},on(){},browser:()=>({version:()=>'1'}),addInitScript:async()=>{},exposeBinding:async()=>{}}; return { launchPersistentContext: async()=>ctx }; }
describe('BrowserManager.call', () => {
  it('navigate returns the url', async () => {
    const page:any = { _u:'about:blank', goto: async function(this:any,u:string){this._u=u;}, url(){return this._u;}, title:async()=>'t', screenshot:async()=>Buffer.from('p'), bringToFront:async()=>{} };
    const m = new BrowserManager({ userDataDir:'/tmp', settings:()=>({enabled:true,headless:true}), dispatch:async()=>({}), emit:()=>{}, launcher: launcherWith(page) });
    await m.open('p');
    expect(await m.call('p','navigate',{url:'https://z.test'})).toEqual({ url:'https://z.test' });
  });
  it('evaluate returns the result', async () => {
    const page:any = { goto:async()=>{}, url:()=>'about:blank', title:async()=>'t', screenshot:async()=>Buffer.from('p'), bringToFront:async()=>{}, evaluate: async(_fn:any)=>42 };
    const m = new BrowserManager({ userDataDir:'/tmp', settings:()=>({enabled:true,headless:true}), dispatch:async()=>({}), emit:()=>{}, launcher: launcherWith(page) });
    await m.open('p');
    expect(await m.call('p','evaluate',{expression:'1+41'})).toEqual({ result: 42 });
  });
  it('throws a clear error when not open', async () => {
    const m = new BrowserManager({ userDataDir:'/tmp', settings:()=>({enabled:true,headless:true}), dispatch:async()=>({}), emit:()=>{} });
    await expect(m.call('nope','navigate',{url:'x'})).rejects.toThrow(/not open/i);
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `call` on `BrowserManager` (dispatch on `type`; use `snapshotPage`/`resolveRef`; `evaluate` wraps `page.evaluate(new Function('return ('+expr+')'))` → `{result}`; `click`/`type` use `resolveRef(page, params.ref)`; `screenshot` reuses `this.screenshot`; unknown type → throw `unsupported browser action: <type>`). Guard each with `const l = this.live.get(projectId); if (!l) throw new Error('browser not open for this project');`.
- [ ] **Step 4:** Run → PASS (3).
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): BrowserManager.call agent-tool backend"`

---

### Task 1.3: Network + console buffers + raw CDP

**Files:**
- Modify: `apps/desktop/electron/browser/manager.ts`
- Test: `apps/desktop/electron/browser/manager-observe.test.ts`

**Interfaces:**
- Produces: `call` handles `network_requests → {requests:[…]}`, `console_messages → {messages:[…]}` (buffered from `page.on('request'|'response'|'console')`, captured on open, `sinceNavigation` honored), `cdp → newCDPSession(page).send(method, params)`.

- [ ] **Step 1–4:** TDD with a fake page exposing `.on(event, cb)`; assert buffered request/console entries are returned and cleared on navigation. Implement ring buffers attached in `open()`. (Console reads must respect `sinceNavigation`, mirroring `skills/browser/references/gotchas.md`.)
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): network/console buffers + cdp passthrough"`

---

### Task 1.4: Route `engine.browserCtx` to the manager

**Files:**
- Modify: `apps/desktop/electron/engine.ts:3090-3121` (browserCtx construction)
- Test: `apps/desktop/electron/browser-ctx-routing.test.ts`

**Interfaces:**
- Consumes: `setBrowserManager` (0.4), `BrowserManager.call/status` (1.2).
- Produces: when a manager is set and not in plan mode, `browserCtx` routes to it scoped by the run's `projectId`; otherwise falls back to `extBridge` (unchanged Electron path).

- [ ] **Step 1:** Failing unit test for a small extracted pure helper `buildBrowserCtx({ manager, bridge, plan, projectId, session, browserWatcher })` (extract the :3090 logic into `browser/ctx.ts` so it's testable without a full run). Assert: manager present → `.call` hits `manager.call(projectId, …)`; manager absent + bridge present → hits `bridge.request`; plan mode → `undefined`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Extract `buildBrowserCtx` into `apps/desktop/electron/browser/ctx.ts`, implement the precedence, and call it from `engine.ts:3090`.
- [ ] **Step 4:** Run → PASS; then `pnpm exec vitest run electron/` (full suite) → green.
- [ ] **Step 5:** Real-Chrome agent smoke (gated): from a sidecar dev run, issue `browser_navigate` + `browser_snapshot` + `browser_click({ref})`; confirm the real window obeys.
- [ ] **Step 6 (commit — defer):** `git commit -m "feat(browser): route agent browser tools to Playwright manager"`

---

### Task 2.1: Comment-mode + steer overlay injection

**Files:**
- Create: `apps/desktop/electron/browser/overlay.ts` (the `OVERLAY_JS` string + binding names)
- Modify: `apps/desktop/electron/browser/manager.ts` (`open()` injects + binds)
- Test: `apps/desktop/electron/browser/overlay.test.ts`

**Interfaces:**
- Produces: `export const OVERLAY_JS: string` (closed-shadow-DOM FAB + numbered pins + popover; calls `window.__mochiComment({selector,label,note,severity})` and `window.__mochiSteer({text})`). `BrowserManager.open` calls `ctx.addInitScript(OVERLAY_JS)` and `ctx.exposeBinding('__mochiComment', …)` / `exposeBinding('__mochiSteer', …)`, wired to `this.deps.dispatch`.

- [ ] **Step 1:** Failing test: a fake ctx records `addInitScript`/`exposeBinding` calls; assert `open()` registered both bindings and the init script; simulate the `__mochiComment` callback and assert `dispatch('addDesignComment', {id, selector, label, note})` was called; simulate `__mochiSteer` → `dispatch('sendChat', …)`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Port a compact comment overlay (FAB + pins + popover in a closed shadow root, z-index 2147483600) into `OVERLAY_JS`; in `open()` register bindings BEFORE the first `goto`. Bindings forward to `dispatch` with `projectId` captured in the closure.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Real-Chrome smoke (gated): open a page, click the FAB, drop a comment, assert it appears via `dispatch('listDesignComments')`.
- [ ] **Step 6 (commit — defer):** `git commit -m "feat(browser): native comment-mode + steer overlay"`

---

### Task 3.1: `browser*` RPCs in `localApi.ts`

**Files:**
- Modify: `apps/desktop/electron/localApi.ts` (switch cases)
- Test: `apps/desktop/electron/browser-rpc.test.ts`

**Interfaces:**
- Consumes: `browserManager` param (0.4 Step 2).
- Produces RPC cases: `browserOpen{projectId,startUrl?}→BrowserStatus`, `browserClose{projectId}`, `browserNavigate{projectId,url}→BrowserStatus`, `browserStatus{projectId?}→BrowserStatus|BrowserStatus[]`, `browserScreenshot{projectId,fullPage?}→{dataUrl}`, `browserListComments{projectId}` (delegates to existing `listDesignComments`), `browserClearData{projectId}`, `browserRevealProfile{projectId}` (returns `{path}` for the Swift side to reveal).

- [ ] **Step 1:** Failing test calling the dispatch with a fake `browserManager` (assert each case invokes the right manager method + returns its result; `browserStatus` with no projectId → `statusAll()`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the cases (guard `if (!browserManager) bad('browser unavailable', 503)`).
- [ ] **Step 4:** Run → PASS; full `pnpm exec vitest run electron/` green.
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): browser* RPCs"`

---

### Task 3.2: Swift models + Route + RootView

**Files:**
- Modify: `MacOS/app/Sources/Maestro/Core/Models.swift` (add `BrowserStatus`, `BrowserSettings`)
- Modify: `MacOS/app/Sources/Maestro/App/AppEnv.swift` (Route `.browser`)
- Modify: `MacOS/app/Sources/Maestro/App/RootView.swift` (route case)

**Interfaces:**
- Produces: `struct BrowserStatus: Codable { let projectId:String; let open:Bool; let url:String?; let title:String?; let tabCount:Int; let lastScreenshotAt:Double?; let chromeVersion:String?; let error:String? }`; `struct BrowserSettings: Codable { var enabled:Bool; var headless:Bool; var chromePath:String?; var defaultStartUrl:String?; var windowWidth:Double?; var windowHeight:Double? }`; `Route.browser` (label "Browser", icon "globe") added to `navBar`.

- [ ] **Step 1:** Add the structs + Route case + RootView mapping `.browser → BrowserView()`. (No unit test — covered by `swift build` + selftest.)
- [ ] **Step 2:** `cd MacOS/app && swift build` → compiles (BrowserView referenced; create a stub in 3.3 first if needed, or build after 3.3).
- [ ] **Step 3 (commit — defer):** fold into 3.3 commit.

---

### Task 3.3: Swift `BrowserStore` + `BrowserView`

**Files:**
- Create: `MacOS/app/Sources/Maestro/Features/Browser/BrowserStore.swift`
- Create: `MacOS/app/Sources/Maestro/Features/Browser/BrowserView.swift`

**Interfaces:**
- Consumes: `MaestroClient.call/onEvent`, `BrowserStatus`, the `browser*` RPCs (3.1), the active project from `WorkspaceStore`.
- Produces: a Browser genre view: project header, Open/Close, URL bar + Go (`browserNavigate`), live status line, a screenshot mirror (poll `browserScreenshot` every ~2s while open), comment list (`browserListComments` + resolve via existing `setDesignCommentStatus`).

- [ ] **Step 1:** Implement `BrowserStore` (`@Observable @MainActor`): `status: BrowserStatus?`, `shot: NSImage?`, `comments: [DesignComment]`; `open()/close()/navigate(_:)/refreshShot()`; subscribe to `"browser"` events → decode `BrowserStatus` → update. On disappear remove the handler.
- [ ] **Step 2:** Implement `BrowserView` per the Interfaces; follow the Design workspace layout idiom (`PaneHead`, grouped controls).
- [ ] **Step 3:** `cd MacOS/app && swift build` → success.
- [ ] **Step 4:** `swift run Maestro --selftest` (or the existing selftest flag) → boots, Browser route renders without crash.
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(macos): Browser genre (open/control/observe)"`

---

### Task 4.1: `AppSettings.browser` in the store

**Files:**
- Modify: `apps/desktop/electron/store.ts` (AppSettings + DEFAULT_SETTINGS)
- Test: `apps/desktop/electron/browser-settings.test.ts`

**Interfaces:**
- Produces: `AppSettings.browser?: BrowserSettings`; `DEFAULT_SETTINGS.browser = { enabled: true, headless: false }`; `getSettings()/setSettings({browser})` round-trips it.

- [ ] **Step 1:** Failing test: `setSettings({ browser:{ enabled:false, headless:true } })` then `getSettings().browser.headless === true`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add the field + default + ensure `setSettings` merges nested `browser` (shallow-merge the `browser` object so a partial patch doesn't drop keys).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(browser): persist BrowserSettings"`

---

### Task 4.2: Swift **Browser** Settings pane

**Files:**
- Modify: `MacOS/app/Sources/Maestro/Features/Settings/SettingsView.swift` (Section enum + pane switch)
- Create: `MacOS/app/Sources/Maestro/Features/Settings/BrowserPane.swift`

**Interfaces:**
- Consumes: `getSettings`/`setSettings` (4.1), `browserStatus`/`browserClearData`/`browserRevealProfile` (3.1).
- Produces: a `.browser` Settings section: enable toggle, detected Chrome path/version (override `TextField`), headless toggle, default start URL, window size, and a per-project profile list with **Clear data** + **Reveal in Finder**.

- [ ] **Step 1:** Add `.browser` to `SettingsView.Section` (icon "globe", tint) + the `@ViewBuilder` case → `BrowserPane()`.
- [ ] **Step 2:** Implement `BrowserPane` using `PaneHead`/`GroupedList`/`GLRow`, reading `getSettings().browser`, writing via `setSettings(["browser": …])`.
- [ ] **Step 3:** `cd MacOS/app && swift build` → success.
- [ ] **Step 4:** `swift run Maestro --selftest` → Settings → Browser renders, toggles round-trip.
- [ ] **Step 5 (commit — defer):** `git commit -m "feat(macos): Browser settings pane"`

---

## Self-Review

**Spec coverage:** §3 engine → P0/P1; §4.2 snapshot → 1.1; §4.3 overlay → 2.1; §4.4 engine integration → 0.4+1.4; §4.5 RPCs → 3.1; §4.6 settings store → 4.1; §4.7 wiring → 0.4; §4.8 Swift genre → 3.2/3.3; §4.9 Swift settings → 4.2. §6 error handling covered in 0.3 (chrome-launch-failed, idempotent, context-close) + 1.2 (not-open). §7 testing folded into each task. All spec sections map to a task. ✓

**Placeholder scan:** Tasks 1.3, 3.2 reference "mirror"/"per the Interfaces" but each gives exact interface signatures + concrete assertions; no bare TODOs. Real code shown for the non-obvious modules (manager, snapshot, overlay, ctx). ✓

**Type consistency:** `BrowserStatus`/`BrowserSettings`/`OpenOpts` defined once in `types.ts` (0.3) and reused verbatim in 1.x/3.x/4.x and the Swift mirror (3.2). `browserProfileDir(userDataDir, projectId)` signature consistent across 0.2/0.3/manager. RPC names match between 3.1 and the Swift store (3.3)/pane (4.2). ✓

**Execution order note:** 3.2 references `BrowserView` created in 3.3 — build 3.2+3.3 together (one `swift build`).
