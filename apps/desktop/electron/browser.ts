/* Native browser automation — engine-agnostic, owned by the Mac (the brain).
   ONE real Google Chrome per PROJECT (a persistent profile under our app data, so
   every chat in a project shares cookies / history / logins), driven by the full
   Playwright API via playwright-core's launchPersistentContext over the user's
   system Chrome (no bundled Chromium — 12 MB dep, no browser download).

   This is the single browser owner. Both engines reach it through ONE surface:
   Claude calls in-process MCP tools (engine.ts) whose handlers call these methods
   directly; Codex calls a thin stdio MCP shim (browser-mcp-shim) that forwards to
   this same controller over a local socket. Screenshots become real Assets (via
   PublishingEngine) so they display inline in chat and land in the asset bin.

   Headed by default: the window is visible so the operator can WATCH the agent and
   step in for a CAPTCHA / login (the whole point of a real, trusted browser). */

import { app } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page, ConsoleMessage } from 'playwright-core';
import type { Store } from './store.js';
import type { PublishingEngine } from './publishing.js';
import { chromeUserDataDir, importChromeCookies } from './chrome-profiles.js';

/* ── Public result shapes (what the tools return to the model) ─────────── */
export interface BrowserState { open: boolean; url: string; title: string; tabs: number; activeTab: number }
export interface BrowserNav { url: string; title: string }
export interface BrowserSnapshot { url: string; title: string; aria: string; truncated: boolean }
export interface BrowserShot { path: string; assetId: string; width?: number; height?: number; url: string; title: string }
export interface ClickTarget { selector?: string; text?: string; nth?: number }

const ARIA_CAP = 8000;      // chars of accessibility snapshot handed to the model
const EVAL_CAP = 4000;      // chars of an evaluate() result
const CONSOLE_CAP = 120;    // console messages retained per session
const ACTION_TIMEOUT = 20_000;

/** macOS Chrome-family binaries we can drive. First hit wins. Chromium/Edge/Brave
    are Chromium-based, so launchPersistentContext drives them the same way. */
function resolveChrome(): string | null {
  const home = app.getPath('home');
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

interface Session {
  projectId: string;
  ctx: BrowserContext;
  pages: Page[];        // open tabs (index 0 = first)
  active: number;       // active tab index
  console: string[];    // ring buffer of console/page-error lines
  userDataDir: string;
  /** true = Maestro-owned isolated profile (we may clear its lock); false = the
      user's REAL Chrome profile (never touch its lock files). */
  managed: boolean;
  /** serialize operations on this session — one Page can't run two actions at once. */
  queue: Promise<unknown>;
  lastUrl: string;
  lastTitle: string;
}

/** How a project's browser should be launched, resolved from Settings.
    managed = Maestro-owned dir (its OWN browser); seedFrom = copy a profile's
    logins into it on first run; profileDir = drive the REAL Chrome profile live. */
interface ProfilePlan { key: string; userDataDir: string; managed: boolean; seedFrom?: string; profileDir?: string }

/** What a screenshot needs from publishing — registers bytes as a displayable Asset. */
type ShotSink = Pick<PublishingEngine, 'importAssetBytes'>;

export class BrowserController {
  private sessions = new Map<string, Session>();
  /** In-flight launches, keyed by project — coalesces concurrent first-touch. */
  private launching = new Map<string, Promise<Session>>();
  private chromePath: string | null | undefined;

  constructor(
    private store: Store,
    private publishing: ShotSink,
    private emit: (name: string, data: unknown) => void,
  ) {}

  /** Is a real Chrome present to drive? (Settings / status surfaces use this.) */
  available(): { ok: boolean; reason?: string } {
    if (this.chromePath === undefined) this.chromePath = resolveChrome();
    return this.chromePath ? { ok: true } : { ok: false, reason: 'Google Chrome not found — install it from google.com/chrome' };
  }

  private key(projectId: string | null | undefined): string {
    return (projectId && String(projectId)) || '__noproject__';
  }

  /** Decide which Chrome profile a project's browser uses, from Settings:
      - No profile → an isolated, Maestro-owned profile PER PROJECT (the default;
        the app's own fresh browser, cookies shared across that project's chats).
      - Profile + 'copy' (default for a chosen profile) → still the app's OWN
        browser, but warm-started from a one-time COPY of that profile's logins.
        Never opens, locks, or modifies the user's real Chrome.
      - Profile + 'live' → drive the REAL Chrome profile (live sessions/passwords);
        requires the user's Chrome to be quit (a profile can't open twice). */
  private resolveProfile(projectId: string | null | undefined): ProfilePlan {
    const settings = this.store.getSettings();
    const profile = settings.chromeProfile ? settings.chromeProfile.replace(/[^a-zA-Z0-9 _-]/g, '').trim() : '';
    if (profile) {
      if (settings.chromeProfileMode === 'live') {
        return { key: `live:${profile}`, userDataDir: chromeUserDataDir(), managed: false, profileDir: profile };
      }
      const dirSafe = profile.replace(/[^a-zA-Z0-9_-]/g, '') || 'profile';
      return { key: `profile:${profile}`, userDataDir: path.join(app.getPath('userData'), 'browser-profiles', `seeded-${dirSafe}`), managed: true, seedFrom: profile };
    }
    const k = this.key(projectId);
    const safe = k.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
    return { key: k, userDataDir: path.join(app.getPath('userData'), 'browser-profiles', safe), managed: true };
  }

  /** Lazily launch (or reuse) the persistent Chrome for a project. Concurrent
      first-touch (e.g. Claude's in-process tools racing codex's bridge on the same
      project) is COALESCED onto one launch — two launchPersistentContext calls
      against one --user-data-dir would collide on Chrome's ProcessSingleton. */
  private async session(projectId: string | null | undefined): Promise<Session> {
    const plan = this.resolveProfile(projectId);
    const live = this.sessions.get(plan.key);
    if (live && live.ctx.browser()?.isConnected() !== false && live.pages.length) return live;
    const inflight = this.launching.get(plan.key);
    if (inflight) return inflight;
    const p = this.buildSession(plan).finally(() => { this.launching.delete(plan.key); });
    this.launching.set(plan.key, p);
    return p;
  }

  private async buildSession(plan: ProfilePlan): Promise<Session> {
    const { key, userDataDir, managed } = plan;
    // Another caller may have finished launching while we were queued.
    const live = this.sessions.get(key);
    if (live && live.ctx.browser()?.isConnected() !== false && live.pages.length) return live;
    const stale = this.sessions.get(key);
    if (stale) { try { await stale.ctx.close(); } catch { /* already gone */ } this.sessions.delete(key); }

    if (this.chromePath === undefined) this.chromePath = resolveChrome();
    if (!this.chromePath) throw Object.assign(new Error('Google Chrome not found — install it from google.com/chrome'), { statusCode: 503 });

    mkdirSync(userDataDir, { recursive: true });

    const { chromium } = await import('playwright-core');
    const opts = {
      executablePath: this.chromePath,
      headless: false,                                   // visible — the operator can watch / solve CAPTCHAs
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      // Let Chrome use its own sandbox (don't pass --no-sandbox) so there's no
      // "unsupported command-line flag" banner, and drop the "controlled by
      // automated software" infobar — the browser should feel native to the user.
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--enable-automation'],
      // This Playwright runs IN the Electron main process — let Electron own the
      // app's signals (otherwise Playwright force-exits on SIGINT/TERM, skipping
      // our before-quit cleanup). The unconditional process.on('exit') killer
      // still SIGKILLs Chrome on real exit, so orphan protection is unchanged.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter',
        ...(plan.profileDir ? [`--profile-directory=${plan.profileDir}`] : [])],
    };
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const singleton = /ProcessSingleton|SingletonLock|already/i.test(msg);
      // For a Maestro-OWNED isolated profile, a stale SingletonLock (from a hard
      // crash) can wedge it forever — clear the lock + retry once so it self-heals.
      // NEVER do this for the user's REAL Chrome profile: the lock may be held by a
      // running Chrome, and deleting it risks profile corruption — tell them to quit.
      if (singleton && managed) {
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          try { rmSync(path.join(userDataDir, f), { force: true }); } catch { /* not present */ }
        }
        try { ctx = await chromium.launchPersistentContext(userDataDir, opts); }
        catch (e2) { throw Object.assign(new Error(`Couldn't start the browser: ${e2 instanceof Error ? e2.message : String(e2)}`), { statusCode: 500 }); }
      } else if (singleton) {
        throw Object.assign(new Error('Google Chrome is open on this profile — Live mode needs it closed. Quit Chrome and retry, or switch this profile to “Copy” in Settings → Browser (uses Maestro’s own browser, no need to quit Chrome).'), { statusCode: 409 });
      } else {
        throw Object.assign(new Error(`Couldn't start the browser: ${msg}`), { statusCode: 500 });
      }
    }

    // Copy mode: warm-start this (isolated, app-owned) browser by decrypting the
    // chosen Chrome profile's cookies and injecting them — so it's signed in
    // without ever opening the user's real Chrome. Done on every launch so logins
    // stay roughly in sync. Read-only + best-effort; failure → just no cookies.
    if (plan.seedFrom) {
      try {
        const cookies = importChromeCookies(plan.seedFrom);
        if (cookies.length) {
          // One malformed cookie would reject the whole batch — fall back to
          // adding them individually so the rest still land.
          try { await ctx.addCookies(cookies); }
          catch { for (const c of cookies) { try { await ctx.addCookies([c]); } catch { /* skip this one */ } } }
        }
      } catch { /* keychain denied / parse issue — proceed signed-out */ }
    }

    const session: Session = {
      projectId: key, ctx, pages: [], active: 0, console: [], managed,
      userDataDir, queue: Promise.resolve(), lastUrl: '', lastTitle: '',
    };
    // Track tabs the user/agent/site opens; wire console capture on each.
    const adopt = (page: Page) => {
      if (!session.pages.includes(page)) session.pages.push(page);
      page.on('console', (m: ConsoleMessage) => this.pushConsole(session, `[${m.type()}] ${m.text()}`.slice(0, 500)));
      page.on('pageerror', (err: Error) => this.pushConsole(session, `[pageerror] ${err.message}`.slice(0, 500)));
      page.on('close', () => {
        // Keep `active` pointing at the SAME page across a splice — a lower-indexed
        // tab closing would otherwise silently shift the agent onto a different tab.
        const wasActive = session.pages[session.active];
        const i = session.pages.indexOf(page);
        if (i >= 0) session.pages.splice(i, 1);
        session.active = (page === wasActive || !wasActive)
          ? Math.max(0, Math.min(session.active, session.pages.length - 1)) // the active tab itself closed
          : Math.max(0, session.pages.indexOf(wasActive));                  // a different tab closed
      });
    };
    ctx.on('page', adopt);
    for (const p of ctx.pages()) adopt(p);
    if (!session.pages.length) adopt(await ctx.newPage());

    this.sessions.set(key, session);
    return session;
  }

  private pushConsole(s: Session, line: string) {
    s.console.push(line);
    if (s.console.length > CONSOLE_CAP) s.console.shift();
  }

  /** The page the agent is acting on. Falls back to a fresh tab if the active one closed. */
  private async page(s: Session): Promise<Page> {
    let p = s.pages[s.active];
    if (!p || p.isClosed()) {
      p = s.pages.find(pg => !pg.isClosed()) ?? await s.ctx.newPage();
      s.active = Math.max(0, s.pages.indexOf(p));
    }
    return p;
  }

  /** Run an operation with this session's lock held (so two tool calls can't race
      on one Page). Refreshes lastUrl/lastTitle + emits state afterward. */
  private async exclusive<T>(projectId: string | null | undefined, fn: (s: Session, p: Page) => Promise<T>): Promise<T> {
    const s = await this.session(projectId);
    const run = s.queue.then(async () => {
      const p = await this.page(s);
      const out = await fn(s, p);
      try { s.lastUrl = p.url(); s.lastTitle = await p.title(); } catch { /* navigating */ }
      this.emitState(s);
      return out;
    });
    // keep the chain alive even if this op throws, so the next op still runs
    s.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private emitState(s: Session) {
    // A shared real-profile session isn't tied to one project — report null rather
    // than the internal `real:<profile>` key.
    const projectId = (s.projectId === '__noproject__' || s.projectId.startsWith('real:')) ? null : s.projectId;
    this.emit('browser', { projectId, url: s.lastUrl, title: s.lastTitle, tabs: s.pages.length, activeTab: s.active, open: true });
  }

  /* ── Navigation ─────────────────────────────────────────────────────── */
  async navigate(projectId: string | null | undefined, url: string): Promise<BrowserNav> {
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    return this.exclusive(projectId, async (_s, p) => {
      await p.goto(target, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT });
      return { url: p.url(), title: await p.title() };
    });
  }
  async back(projectId: string | null | undefined): Promise<BrowserNav> {
    return this.exclusive(projectId, async (_s, p) => { await p.goBack({ timeout: ACTION_TIMEOUT }).catch(() => {}); return { url: p.url(), title: await p.title() }; });
  }
  async forward(projectId: string | null | undefined): Promise<BrowserNav> {
    return this.exclusive(projectId, async (_s, p) => { await p.goForward({ timeout: ACTION_TIMEOUT }).catch(() => {}); return { url: p.url(), title: await p.title() }; });
  }
  async reload(projectId: string | null | undefined): Promise<BrowserNav> {
    return this.exclusive(projectId, async (_s, p) => { await p.reload({ timeout: ACTION_TIMEOUT }); return { url: p.url(), title: await p.title() }; });
  }

  /* ── Reading the page ───────────────────────────────────────────────── */
  /** Ref-addressable accessibility tree — the model's primary view for deciding
      what to click/type. Compact + structured (roles, names, levels). */
  async snapshot(projectId: string | null | undefined): Promise<BrowserSnapshot> {
    return this.exclusive(projectId, async (_s, p) => {
      let aria = '';
      try { aria = await p.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT }); }
      catch { try { aria = (await p.locator('body').innerText()).slice(0, ARIA_CAP); } catch { aria = ''; } }
      const truncated = aria.length > ARIA_CAP;
      return { url: p.url(), title: await p.title(), aria: truncated ? aria.slice(0, ARIA_CAP) + '\n… (truncated)' : aria, truncated };
    });
  }

  /** PNG screenshot → a real Asset (displayed inline + in the bin). */
  async screenshot(projectId: string | null | undefined, opts: { fullPage?: boolean } = {}): Promise<BrowserShot> {
    return this.exclusive(projectId, async (_s, p) => {
      const buf = await p.screenshot({ fullPage: !!opts.fullPage, type: 'png', timeout: ACTION_TIMEOUT });
      let host = 'page';
      try { host = new URL(p.url()).hostname.replace(/[^a-zA-Z0-9.-]/g, '') || 'page'; } catch { /* about:blank etc. */ }
      const asset = this.publishing.importAssetBytes(Buffer.from(buf), `screenshot-${host}.png`, (projectId && String(projectId)) || null);
      return { path: asset.localPath ?? '', assetId: asset.id, width: asset.width, height: asset.height, url: p.url(), title: await p.title() };
    });
  }

  /** A live preview frame for the in-app Browser tab: a PNG data URL of the
      current page WITHOUT registering an Asset (so polling doesn't spam the bin).
      Returns open:false (no bytes) when no session is running. */
  async view(projectId: string | null | undefined): Promise<{ open: boolean; dataUrl?: string; url: string; title: string }> {
    if (!this.sessions.get(this.resolveProfile(projectId).key)) return { open: false, url: '', title: '' };
    return this.exclusive(projectId, async (_s, p) => {
      const buf = await p.screenshot({ type: 'png', timeout: ACTION_TIMEOUT });
      return { open: true, dataUrl: `data:image/png;base64,${Buffer.from(buf).toString('base64')}`, url: p.url(), title: await p.title() };
    });
  }

  async evaluate(projectId: string | null | undefined, expression: string): Promise<{ result: string }> {
    return this.exclusive(projectId, async (_s, p) => {
      // Run the agent's JS in page context. Wrap so a bare expression returns its value.
      const raw = await p.evaluate(`(()=>{ try { return (${expression}); } catch(e){ return String(e); } })()`);
      let result: string;
      try { result = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { result = String(raw); }
      result = result ?? 'undefined';
      return { result: result.length > EVAL_CAP ? result.slice(0, EVAL_CAP) + '… (truncated)' : result };
    });
  }

  async console(projectId: string | null | undefined): Promise<{ messages: string[] }> {
    const s = await this.session(projectId);
    return { messages: [...s.console] };
  }

  /* ── Acting on the page ─────────────────────────────────────────────── */
  private locator(p: Page, t: ClickTarget) {
    const base = t.selector ? p.locator(t.selector) : t.text ? p.getByText(t.text, { exact: false }) : null;
    if (!base) throw Object.assign(new Error('click/type needs a `selector` or `text`'), { statusCode: 400 });
    return typeof t.nth === 'number' ? base.nth(t.nth) : base.first();
  }

  async click(projectId: string | null | undefined, t: ClickTarget): Promise<BrowserNav> {
    return this.exclusive(projectId, async (_s, p) => {
      await this.locator(p, t).click({ timeout: ACTION_TIMEOUT });
      await p.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT }).catch(() => {});
      return { url: p.url(), title: await p.title() };
    });
  }

  async type(projectId: string | null | undefined, opts: { selector?: string; text: string; submit?: boolean; clear?: boolean }): Promise<{ ok: true; url: string }> {
    return this.exclusive(projectId, async (_s, p) => {
      const loc = this.locator(p, { selector: opts.selector ?? 'input,textarea,[contenteditable]' });
      if (opts.clear) await loc.fill('');
      await loc.fill(opts.text, { timeout: ACTION_TIMEOUT });
      if (opts.submit) { await loc.press('Enter'); await p.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT }).catch(() => {}); }
      return { ok: true as const, url: p.url() };
    });
  }

  async press(projectId: string | null | undefined, keys: string): Promise<{ ok: true }> {
    return this.exclusive(projectId, async (_s, p) => { await p.keyboard.press(keys); return { ok: true as const }; });
  }

  async scroll(projectId: string | null | undefined, opts: { dy?: number; dx?: number } = {}): Promise<{ ok: true }> {
    return this.exclusive(projectId, async (_s, p) => { await p.mouse.wheel(opts.dx ?? 0, opts.dy ?? 600); return { ok: true as const }; });
  }

  /** Wait for a selector / text / fixed delay before the next step. */
  async waitFor(projectId: string | null | undefined, opts: { selector?: string; text?: string; ms?: number }): Promise<{ ok: true }> {
    return this.exclusive(projectId, async (_s, p) => {
      if (opts.selector) await p.locator(opts.selector).first().waitFor({ timeout: ACTION_TIMEOUT });
      else if (opts.text) await p.getByText(opts.text, { exact: false }).first().waitFor({ timeout: ACTION_TIMEOUT });
      else if (opts.ms) await p.waitForTimeout(Math.min(opts.ms, ACTION_TIMEOUT));
      return { ok: true as const };
    });
  }

  /* ── Tabs ───────────────────────────────────────────────────────────── */
  async newTab(projectId: string | null | undefined, url?: string): Promise<BrowserNav> {
    return this.exclusive(projectId, async (s, _p) => {
      const page = await s.ctx.newPage();
      s.active = s.pages.indexOf(page);
      if (url) { const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`; await page.goto(target, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT }); }
      return { url: page.url(), title: await page.title() };
    });
  }
  async listTabs(projectId: string | null | undefined): Promise<{ tabs: { index: number; url: string; title: string; active: boolean }[] }> {
    const s = await this.session(projectId);
    const tabs = await Promise.all(s.pages.map(async (pg, i) => ({ index: i, url: pg.url(), title: await pg.title().catch(() => ''), active: i === s.active })));
    return { tabs };
  }
  async selectTab(projectId: string | null | undefined, index: number): Promise<BrowserNav> {
    return this.exclusive(projectId, async (s, _p) => {
      if (index < 0 || index >= s.pages.length) throw Object.assign(new Error('no such tab'), { statusCode: 400 });
      s.active = index;
      const page = s.pages[index];
      await page.bringToFront().catch(() => {});
      return { url: page.url(), title: await page.title() };
    });
  }
  async closeTab(projectId: string | null | undefined, index: number): Promise<{ ok: true }> {
    return this.exclusive(projectId, async (s, _p) => {
      const page = s.pages[index];
      if (page) await page.close().catch(() => {});
      return { ok: true as const };
    });
  }

  /* ── Window / lifecycle ─────────────────────────────────────────────── */
  /** Bring the project's Chrome window to the front (manual CAPTCHA / login). */
  async focus(projectId: string | null | undefined): Promise<{ ok: true }> {
    return this.exclusive(projectId, async (_s, p) => { await p.bringToFront().catch(() => {}); return { ok: true as const }; });
  }

  state(projectId: string | null | undefined): BrowserState {
    const s = this.sessions.get(this.resolveProfile(projectId).key);
    if (!s) return { open: false, url: '', title: '', tabs: 0, activeTab: 0 };
    return { open: true, url: s.lastUrl, title: s.lastTitle, tabs: s.pages.length, activeTab: s.active };
  }

  /** Close a project's browser (frees the profile + the window). */
  async close(projectId: string | null | undefined): Promise<{ ok: true }> {
    const key = this.resolveProfile(projectId).key;
    const s = this.sessions.get(key);
    if (s) { this.sessions.delete(key); try { await s.ctx.close(); } catch { /* gone */ } this.emit('browser', { projectId: (projectId && String(projectId)) || null, open: false, url: '', title: '', tabs: 0, activeTab: 0 }); }
    return { ok: true as const };
  }

  /** Tear every session down on app quit. */
  async dispose(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map(s => s.ctx.close().catch(() => {})));
  }
}
