/* BrowserManager — owns one persistent Playwright context PER PROJECT, driving
   the user's INSTALLED Chrome (channel:'chrome', no bundled Chromium). Shared by
   the agent's browser_* tools (via engine.setBrowserManager) and the Swift app
   (via the browser* RPCs), so both drive a single instance per project.

   Lifecycle only lives here; the agent-tool command bus (`call`) and the
   comment/steer overlay are layered on in later tasks. */
import { browserProfileDir } from './paths.js';
import { snapshotPage, resolveRef } from './snapshot.js';
import { OVERLAY_JS, SNAPSHOT_BINDING, SEND_BINDING } from './overlay.js';
import { applySeedIfFresh, importSeed as doImportSeed, seedInfo as readSeedInfo, clearSeed as doClearSeed, type SeedInfo } from './seed.js';
import { listChromeProfiles as readChromeProfiles, type ChromeProfile } from './profiles.js';
import { chromeStatus as readChromeStatus, quitChrome as quitChromeApp, reopenChrome, openChromeDownload as openDownload, type ChromeStatus } from './chrome.js';
import type {
  BrowserManagerDeps, BrowserStatus, OpenOpts, Launcher, PwContextLike, PwPageLike,
} from './types.js';

interface NetEntry { kind: 'request' | 'response'; method?: string; status?: number; url?: string }
interface ConsoleEntry { type?: string; text?: string }
/** `page` is the ACTIVE tab; tabs come from `ctx.pages()`. net/cons are ring
    buffers (cleared on navigation) backing browser_network_requests / _console_messages. */
interface Live { ctx: PwContextLike; page: PwPageLike; lastShot: number | null; net: NetEntry[]; cons: ConsoleEntry[] }

async function defaultLauncher(): Promise<Launcher> {
  const { chromium } = await import('playwright-core');
  return chromium as unknown as Launcher;
}

export class BrowserManager {
  private live = new Map<string, Live>();
  private opening = new Map<string, Promise<BrowserStatus>>();
  constructor(private deps: BrowserManagerDeps) {}

  /** Live page for a project, or throw a clear error the agent/app can show. */
  protected requireLive(projectId: string): Live {
    const l = this.live.get(projectId);
    if (!l) throw new Error('browser not open for this project');
    return l;
  }

  private mkStatus(projectId: string, err?: string): BrowserStatus {
    const l = this.live.get(projectId);
    return {
      projectId,
      open: !!l,
      url: l ? l.page.url() : null,
      title: null,
      tabCount: l ? l.ctx.pages().length : 0,
      lastScreenshotAt: l?.lastShot ?? null,
      chromeVersion: l ? (l.ctx.browser()?.version() ?? null) : null,
      ...(err ? { error: err } : {}),
    };
  }

  private push(projectId: string, err?: string): BrowserStatus {
    const s = this.mkStatus(projectId, err);
    try { this.deps.emit(s); } catch { /* emit must never throw the caller */ }
    return s;
  }

  async open(projectId: string, opts?: OpenOpts): Promise<BrowserStatus> {
    if (this.live.has(projectId)) return this.push(projectId);
    const inflight = this.opening.get(projectId);
    if (inflight) return inflight;
    const p = (async (): Promise<BrowserStatus> => {
      const s = this.deps.settings();
      const launcher = this.deps.launcher ?? await defaultLauncher();
      const dir = browserProfileDir(this.deps.userDataDir, projectId);
      let ctx: PwContextLike;
      // Launch the user's Chrome so it looks like a NORMAL browser, not an automated
      // one — otherwise reCAPTCHA / Cloudflare flag it instantly. The key signals:
      //  • `--enable-automation` (Playwright default) sets navigator.webdriver=true — the
      //    #1 thing reCAPTCHA checks. We drop it via ignoreDefaultArgs AND blunt it with
      //    `--disable-blink-features=AutomationControlled` (makes webdriver report false).
      //  • `--no-sandbox` (Playwright default `chromiumSandbox:false`) shows the warning
      //    banner + is a bot tell. We run WITH the sandbox (fine on macOS).
      //  • `--use-mock-keychain` (Playwright default) makes Chrome use an EMPTY mock
      //    keychain — which means real v10 cookies (seeded from the user's profile)
      //    can't decrypt. We drop it so Chrome uses the real macOS Keychain.
      const args = [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
      ];
      if (s.windowWidth && s.windowHeight) args.push(`--window-size=${s.windowWidth},${s.windowHeight}`);
      // First-ever open of this project: if a seed profile is set and this project has
      // no profile yet, copy the seed in so it starts signed in (each project then
      // diverges with its OWN copy). The user's real Chrome is never touched.
      try { applySeedIfFresh(this.deps.userDataDir, projectId); } catch { /* seed is best-effort */ }
      try {
        ctx = await launcher.launchPersistentContext(dir, {
          channel: 'chrome',
          headless: s.headless ?? false,
          viewport: null,
          chromiumSandbox: true,
          ignoreDefaultArgs: ['--enable-automation', '--use-mock-keychain'],
          ...(s.chromePath ? { executablePath: s.chromePath } : {}),
          args,
        });
      } catch (e) {
        return this.push(projectId, `chrome-launch-failed: ${(e as Error).message}`);
      }
      const page = ctx.pages()[0] ?? await ctx.newPage();
      ctx.on('close', () => { this.live.delete(projectId); this.push(projectId); });
      const live: Live = { ctx, page, lastShot: null, net: [], cons: [] };
      this.live.set(projectId, live);
      this.observe(live);
      await this.onContextReady(projectId, ctx, page);
      const url = opts?.startUrl ?? s.defaultStartUrl;
      if (url && url !== 'about:blank') {
        try { await page.goto(url, { waitUntil: 'domcontentloaded' }); } catch { /* surfaced via status */ }
      }
      return this.push(projectId);
    })();
    this.opening.set(projectId, p);
    try { return await p; } finally { this.opening.delete(projectId); }
  }

  /** Register the Send-hint bindings + inject the overlay into every page.
      Best-effort: a failure here must never block opening the browser. */
  protected async onContextReady(projectId: string, ctx: PwContextLike, page: PwPageLike): Promise<void> {
    try {
      // Session picker data: this project's (non-archived) sessions.
      await ctx.exposeBinding(SNAPSHOT_BINDING, async () => {
        let sessions: Array<{ id: string; title?: string; codename?: string; archived?: number }> = [];
        try { sessions = await this.deps.dispatch('listSessions', { projectId }) as typeof sessions; } catch { sessions = []; }
        let name = 'Project';
        try {
          const projs = await this.deps.dispatch('listProjects', {}) as Array<{ id: string; name?: string }>;
          const p = (projs ?? []).find((x) => x?.id === projectId);
          if (p?.name) name = p.name;
        } catch { /* */ }
        const list = (Array.isArray(sessions) ? sessions : [])
          .filter((s) => !s?.archived)
          .map((s) => ({ id: s.id, title: s.title || s.codename || 'Chat', running: false }));
        return { paired: true, projects: [{ id: projectId, name, sessions: list }] };
      });
      // Compose + deliver the hint into the CHOSEN session (steer if it's busy).
      await ctx.exposeBinding(SEND_BINDING, async (_src, payload) => this.sendHint(projectId, payload));
      await ctx.addInitScript(OVERLAY_JS);
      // Also inject into the already-open page (addInitScript only affects future docs).
      try { await (page as unknown as { evaluate(s: string): Promise<unknown> }).evaluate(OVERLAY_JS); } catch { /* blank/restricted page */ }
    } catch { /* overlay is best-effort — never block opening the browser */ }
  }

  /** Compose a hint (text + element refs + optional URL / console errors /
      screenshot) and deliver it into a chosen EXISTING session (or a new chat
      when sessionId is null). Steers a busy session by cancelling its running
      job first — mirroring the old extension's deliver(). */
  protected async sendHint(projectId: string, payload: unknown): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    try {
      const pl = (payload ?? {}) as {
        sessionId?: string | null; text?: string;
        elements?: Array<{ selector?: string; tagName?: string; text?: string }>;
        includeUrl?: boolean; includeConsole?: boolean; includeScreenshot?: boolean;
      };
      const live = this.liveFor(projectId);
      // The VISIBLE bubble is the user's hint ONLY — keep it clean, never dump our
      // context format into the chat. Selectors / URL / console ride to the agent as
      // ONE attachment it reads (a tidy chip, not raw text); the screenshot rides as
      // an image (renders as a thumbnail, never a raw @path).
      const hint = String(pl.text ?? '').trim();
      const els = Array.isArray(pl.elements) ? pl.elements : [];

      const ctx: string[] = [];
      if (els.length) {
        ctx.push('Referenced elements:');
        els.forEach((e, i) => ctx.push(`[#${i + 1}] ${e.selector ?? ''}${e.tagName ? `  <${e.tagName}>` : ''}${e.text ? `  — "${String(e.text).slice(0, 120)}"` : ''}`));
      }
      if (pl.includeUrl && live) { try { ctx.push(`${ctx.length ? '\n' : ''}URL: ${live.page.url()}`); } catch { /* */ } }
      if (pl.includeConsole && live) {
        const errs = live.cons.filter((c) => /error|warning|exception|assert/i.test(c.type ?? '')).slice(-5);
        if (errs.length) { ctx.push('\nRecent console errors:'); errs.forEach((c) => ctx.push(`- [${c.type ?? 'log'}] ${String(c.text ?? '').slice(0, 200)}`)); }
      }

      const images: Array<{ id: string; dataB64: string; mime: string; name: string }> = [];
      if (pl.includeScreenshot) {
        try { const shot = await this.screenshot(projectId); images.push({ id: 'shot-1', dataB64: shot.dataUrl.split(',')[1] ?? '', mime: 'image/png', name: 'screenshot.png' }); } catch { /* */ }
      }
      // Page context → HIDDEN per-turn context: the model gets it, but it's never
      // rendered in the chat (no openable attachment). Only the screenshot stays visible.
      const agentContext = ctx.length ? `Page context (from the browser the user is viewing):\n${ctx.join('\n')}` : undefined;

      if (!hint && !images.length && !agentContext) return { ok: false, error: 'nothing to send' };
      const sessionId = pl.sessionId ? String(pl.sessionId) : undefined;
      if (sessionId) {
        try {
          const jobs = await this.deps.dispatch('listJobs', { projectId, sessionId }) as Array<{ id: string; status?: string }>;
          const running = (jobs ?? []).find((j) => j?.status === 'running' || j?.status === 'pending');
          if (running) await this.deps.dispatch('cancelJob', { id: running.id });
        } catch { /* best-effort steer */ }
      }
      const res = await this.deps.dispatch('sendChat', {
        projectId, sessionId, text: hint,
        images: images.length ? images : undefined,
        agentContext,
      }) as { session?: { id?: string } };
      return { ok: true, sessionId: res?.session?.id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async close(projectId: string): Promise<void> {
    const l = this.live.get(projectId);
    if (!l) return;
    this.live.delete(projectId);
    try { await l.ctx.close(); } catch { /* already gone */ }
    this.push(projectId);
  }

  status(projectId: string): BrowserStatus { return this.mkStatus(projectId); }
  statusAll(): BrowserStatus[] { return [...this.live.keys()].map((id) => this.mkStatus(id)); }
  protected liveFor(projectId: string): Live | undefined { return this.live.get(projectId); }

  async navigate(projectId: string, url: string): Promise<BrowserStatus> {
    if (!this.live.has(projectId)) await this.open(projectId);
    const live = this.live.get(projectId);
    if (!live) return this.status(projectId);
    live.net.length = 0; live.cons.length = 0; // network/console are "since navigation"
    await live.page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.push(projectId);
  }

  /** Wire network + console ring buffers + new-tab tracking. Best-effort; the
      `as any` casts reflect that PwContextLike is a deliberate subset of the real
      Playwright BrowserContext (which emits these events). */
  private observe(l: Live): void {
    const ctx = l.ctx as any;
    const pushNet = (e: NetEntry) => { l.net.push(e); if (l.net.length > 200) l.net.shift(); };
    try {
      ctx.on('request', (r: any) => pushNet({ kind: 'request', method: r.method?.(), url: r.url?.() }));
      ctx.on('response', (r: any) => pushNet({ kind: 'response', status: r.status?.(), url: r.url?.() }));
    } catch { /* events optional */ }
    const attachConsole = (p: any) => { try { p.on('console', (m: any) => { l.cons.push({ type: m.type?.(), text: m.text?.() }); if (l.cons.length > 200) l.cons.shift(); }); } catch { /* */ } };
    try { for (const p of ctx.pages()) attachConsole(p); } catch { /* */ }
    try { ctx.on('page', (p: any) => { l.page = p; attachConsole(p); }); } catch { /* */ }
  }

  async screenshot(projectId: string, opts?: { fullPage?: boolean }): Promise<{ dataUrl: string }> {
    const l = this.requireLive(projectId);
    const buf = await l.page.screenshot({ fullPage: !!opts?.fullPage, type: 'png' });
    l.lastShot = Date.now();
    return { dataUrl: `data:image/png;base64,${Buffer.from(buf).toString('base64')}` };
  }

  async clearData(projectId: string): Promise<void> {
    await this.close(projectId);
    const { rm } = await import('node:fs/promises');
    await rm(browserProfileDir(this.deps.userDataDir, projectId), { recursive: true, force: true });
  }

  /** The command bus the agent's browser_* tools call. `type` is the same verb
      string the tools used to send to ExtensionBridge.request, so engine.ts call
      sites are unchanged. Returns the shape each tool surfaces to the agent. */
  async call(projectId: string, type: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    if (type === 'status') return this.status(projectId);
    if (type === 'navigate') { const s = await this.navigate(projectId, String(params.url)); return { url: s.url }; }
    const l = this.requireLive(projectId);
    const page = l.page as any;
    switch (type) {
      // ── read ───────────────────────────────────────────────────
      case 'snapshot': { const snap = await snapshotPage(l.page); return { tree: snap.tree, refs: snap.refs }; }
      case 'screenshot': return this.screenshot(projectId, { fullPage: !!params.fullPage });
      case 'title': return { title: await page.title() };
      case 'tab_url': return { url: page.url() };
      case 'read':
      case 'text': return { text: await page.evaluate('document.body ? document.body.innerText : ""') };
      case 'links': return { links: await page.evaluate('Array.from(document.querySelectorAll("a[href]")).slice(0,200).map(a=>({text:(a.innerText||"").trim().slice(0,80),href:a.href}))') };
      case 'match_count': return { count: await page.locator(String(params.selector ?? '*')).count() };
      case 'find_by_role_name': { const loc = page.getByRole(String(params.role), params.name != null ? { name: String(params.name) } : undefined); return { count: await loc.count() }; }
      case 'resolve_box': return { box: await resolveRef(l.page, String(params.ref)).boundingBox() };
      case 'network_requests': return { requests: l.net.slice(-Number(params.limit ?? 50)) };
      case 'console_messages': return { messages: l.cons.slice(-Number(params.limit ?? 50)) };
      case 'evaluate': return { result: await page.evaluate(String(params.expression)) };
      case 'assert': { const v = await page.evaluate(String(params.expression ?? params.condition ?? 'true')); return { ok: !!v, value: v }; }
      // ── interact ───────────────────────────────────────────────
      case 'click': await resolveRef(l.page, String(params.ref)).click({ timeout: timeoutMs }); return { ok: true };
      case 'click_at': await page.mouse.click(Number(params.x), Number(params.y)); return { ok: true };
      case 'hover': await resolveRef(l.page, String(params.ref)).hover({ timeout: timeoutMs }); return { ok: true };
      case 'type': await resolveRef(l.page, String(params.ref)).fill(String(params.text ?? '')); return { ok: true };
      case 'press_key': await page.keyboard.press(String(params.key)); return { ok: true };
      case 'scroll': await page.evaluate(`window.scrollBy(${Number(params.dx ?? 0)}, ${Number(params.dy ?? 600)})`); return { ok: true };
      case 'drag': await resolveRef(l.page, String(params.from)).dragTo(resolveRef(l.page, String(params.to))); return { ok: true };
      case 'upload_file': await resolveRef(l.page, String(params.ref)).setInputFiles(String(params.path)); return { ok: true };
      // ── navigation / tabs ──────────────────────────────────────
      case 'go_back': await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); return { url: page.url() };
      case 'go_forward': await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); return { url: page.url() };
      case 'list_tabs': return { tabs: l.ctx.pages().map((p, i) => ({ index: i, url: (p as { url(): string }).url(), active: p === l.page })) };
      case 'open_tab': { const np = await l.ctx.newPage() as any; if (params.url) await np.goto(String(params.url), { waitUntil: 'domcontentloaded' }); l.page = np; return { url: np.url(), index: l.ctx.pages().indexOf(np) }; }
      case 'close_tab': { const pages = l.ctx.pages(); const idx = params.index != null ? Number(params.index) : pages.indexOf(l.page); const tgt = pages[idx] as any; if (tgt) await tgt.close(); l.page = l.ctx.pages()[0] ?? l.page; return { ok: true }; }
      // ── cookies ────────────────────────────────────────────────
      case 'cookies_get': return { cookies: await (l.ctx as any).cookies() };
      case 'cookies_set': await (l.ctx as any).addCookies(params.cookies ?? []); return { ok: true };
      case 'cookies_clear': await (l.ctx as any).clearCookies(); return { ok: true };
      // ── emulation / window ─────────────────────────────────────
      case 'emulate_viewport': await page.setViewportSize({ width: Number(params.width ?? 1280), height: Number(params.height ?? 800) }); return { ok: true };
      case 'clear_emulation': await page.setViewportSize({ width: 1280, height: 800 }); return { ok: true };
      case 'window_resize': {
        const w = Number(params.width ?? 1280), h = Number(params.height ?? 800);
        try { const sess = await (l.ctx as any).newCDPSession(page); const { windowId } = await sess.send('Browser.getWindowForTarget'); await sess.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } }); }
        catch { await page.setViewportSize({ width: w, height: h }); }
        return { ok: true };
      }
      // ── lifecycle / raw ────────────────────────────────────────
      case 'session_start': return { ok: true, ...this.status(projectId) };
      case 'session_end': return { ok: true }; // per-project browser stays open
      case 'cdp': { const sess = await (l.ctx as any).newCDPSession(page); return { result: await sess.send(String(params.method), (params.params ?? {}) as object) }; }
      case 'download_url': return { dataUrl: await page.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(String(params.url))});const b=await r.blob();return await new Promise(rs=>{const f=new FileReader();f.onload=()=>rs(f.result);f.readAsDataURL(b);});})()`) };
      case 'wait': {
        if (params.selector) await page.waitForSelector(String(params.selector), { timeout: timeoutMs });
        else await page.waitForTimeout(Number(params.ms ?? 500));
        return { ok: true };
      }
      default: throw new Error('unsupported browser action: ' + type);
    }
  }

  profileDir(projectId: string): string { return browserProfileDir(this.deps.userDataDir, projectId); }

  // ── Seed profile (a chosen real Chrome profile → every project's first launch) ──
  /** The installed Chrome's profiles, for the Settings seed picker. */
  listChromeProfiles(): ChromeProfile[] { return readChromeProfiles(); }
  /** Import login state from a chosen real Chrome profile into the global seed.
      With `quitChromeFirst`, gracefully quits Chrome for a clean/complete copy and
      reopens it after (the Swift side warns + confirms before setting this). */
  async importSeed(profileDir: string, sourceName?: string, quitChromeFirst = false): Promise<SeedInfo> {
    if (quitChromeFirst) {
      const closed = await quitChromeApp();
      if (!closed) throw Object.assign(new Error('Could not close Google Chrome — please quit it manually, then import.'), { statusCode: 409 });
    }
    const info = doImportSeed(this.deps.userDataDir, profileDir, sourceName);
    if (quitChromeFirst) reopenChrome();
    return info;
  }
  /** The current seed (source profile + when imported + cookie count), or null. */
  seedInfo(): SeedInfo | null { return readSeedInfo(this.deps.userDataDir); }
  clearSeed(): void { doClearSeed(this.deps.userDataDir); }
  /** Is Google Chrome installed / running? (drives the import warning + install path.) */
  chromeStatus(): ChromeStatus { return readChromeStatus(); }
  /** Open Google's official Chrome download page (when Chrome isn't installed). */
  openChromeDownload(): void { openDownload(); }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map((id) => this.close(id)));
  }
}
