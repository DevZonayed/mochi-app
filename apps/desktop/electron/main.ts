import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron';
import path from 'node:path';
import { existsSync, realpathSync, mkdirSync, promises as fsp } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Store } from './store.js';
import { LocalEngine } from './engine.js';
import { MediaEngine } from './media.js';
import { ResearchEngine } from './research.js';
import { PublishingEngine } from './publishing.js';
import { BrowserController } from './browser.js';
import { BrowserBridge } from './browser-bridge.js';
import { TelegramBot } from './telegram.js';
import { Providers } from './providers.js';
import type { Approval, Job } from './store.js';
import { createDispatch } from './localApi.js';
import { buildModelGroups } from './models.js';
import { RelayClient } from './relay.js';
import { CronRunner } from './cron.js';
import { runSmoke } from './smoke.js';

const RENDERER_DIST = path.join(__dirname, '../dist');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RELAY_URL = process.env['MAESTRO_RELAY_URL'] || 'wss://api.nexalance.cloud/ws';

// The preload is emitted as either preload.mjs or preload.js depending on the
// build; load whichever actually exists. If this resolves wrong, window.maestro
// never loads → the renderer falls back to the relay (the "Unauthorized" bug).
const PRELOAD = ['preload.mjs', 'preload.js']
  .map((f) => path.join(__dirname, f))
  .find((p) => existsSync(p)) ?? path.join(__dirname, 'preload.mjs');

let win: BrowserWindow | null = null;

// Smoke test (MAESTRO_SMOKE=1): isolate to a throwaway userData so the run never
// touches real data; the window is skipped + the smoke sequence runs in whenReady.
if (process.env.MAESTRO_SMOKE) {
  try { app.setPath('userData', path.join(app.getPath('temp'), 'maestro-smoke-' + Date.now())); } catch { /* pre-ready getPath may vary */ }
}

/* The Design genre's live preview serves a project's folder over a private,
   standard scheme so the artifact (design/index.html) + its images/fonts resolve
   inside a sandboxed <iframe>. Must be registered BEFORE app ready. Read-only,
   path-guarded to the project root in the handler below. */
protocol.registerSchemesAsPrivileged([
  { scheme: 'maestro-design', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const DESIGN_MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const DESIGN_PLACEHOLDER = `<!doctype html><meta charset="utf8"><style>
  html,body{margin:0;height:100%;font:400 15px/1.6 -apple-system,system-ui,sans-serif;background:#0b0b0f;color:#9aa0ad;
  display:grid;place-items:center;text-align:center}.c{max-width:340px;padding:24px}
  .d{width:40px;height:40px;margin:0 auto 16px;border-radius:11px;background:linear-gradient(135deg,#6366f1,#a855f7)}
  h1{font-size:17px;color:#e8eaf0;margin:0 0 6px;font-weight:600}</style>
  <div class="c"><div class="d"></div><h1>Your design will appear here</h1>
  <p>Describe what you want in the chat — the agent builds a live, self-contained design you can refine and hand off to code.</p></div>`;

/* Comment harness injected into every served design page (Mochi-style commenting).
   Runs inside the iframe; talks to the DesignWorkspace via postMessage. When the
   parent enables "comment mode", hovering highlights the element under the cursor
   and a click captures a robust CSS selector + a human label, posted back to the
   parent. The parent persists the note and feeds the comment list to the design
   agent. The parent also pushes the existing comments so we draw numbered pins.
   Inert (no DOM interception) until comment mode is turned on. */
/* A smooth, thin default scrollbar for the design page itself. The preview's
   visible scrollbar belongs to the design document INSIDE the iframe, so the
   renderer's container .ds-scroll class can't reach it — this has to live in the
   served page. Injected at the START of <head> so a design that styles its own
   scrollbar still overrides it (later rules win the cascade). */
const DESIGN_SCROLLBAR_CSS = `
html{scroll-behavior:smooth}
*{scrollbar-width:thin;scrollbar-color:rgba(140,142,152,.45) transparent}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(140,142,152,.45);border-radius:10px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:rgba(140,142,152,.72);background-clip:padding-box}
`;

const DESIGN_COMMENT_HARNESS = `(function(){
  if (window.__maestroComments) return; window.__maestroComments = true;
  var mode=false, hover=null, markers=[];
  var box=document.createElement('div');
  box.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2f81f7;background:rgba(47,129,247,.12);border-radius:4px;display:none;box-sizing:border-box';
  var pins=document.createElement('div');
  pins.style.cssText='position:fixed;inset:0;z-index:2147483645;pointer-events:none';
  function ready(){ try{ document.body.appendChild(box); document.body.appendChild(pins); }catch(_){} }
  if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready);
  function esc(s){ try{ return CSS.escape(s); }catch(_){ return s; } }
  function cssPath(el){
    if(!(el instanceof Element)) return '';
    if(el.id) return '#'+esc(el.id);
    var parts=[];
    while(el && el.nodeType===1 && el!==document.body && parts.length<6){
      var sel=el.nodeName.toLowerCase(), p=el.parentNode;
      if(p){ var sibs=Array.prototype.filter.call(p.children,function(c){return c.nodeName===el.nodeName;});
        if(sibs.length>1) sel+=':nth-of-type('+(Array.prototype.indexOf.call(sibs,el)+1)+')'; }
      parts.unshift(sel); el=el.parentElement;
    }
    return parts.join(' > ');
  }
  function label(el){
    var tag=el.nodeName.toLowerCase();
    var t=(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,42);
    return tag+(t?' \\u00b7 \\u201c'+t+'\\u201d':'');
  }
  function frame(el){ var r=el.getBoundingClientRect(); box.style.display='block'; box.style.left=r.left+'px'; box.style.top=r.top+'px'; box.style.width=r.width+'px'; box.style.height=r.height+'px'; }
  function onMove(e){ if(!mode) return; var el=document.elementFromPoint(e.clientX,e.clientY); if(!el||el===box||el===pins) return; hover=el; frame(el); }
  function onClick(e){ if(!mode) return; e.preventDefault(); e.stopPropagation(); var el=hover||document.elementFromPoint(e.clientX,e.clientY); if(!el) return; parent.postMessage({__maestroDesign:true,type:'comment-pick',selector:cssPath(el),label:label(el)},'*'); return false; }
  document.addEventListener('mousemove',onMove,true);
  document.addEventListener('click',onClick,true);
  document.addEventListener('keydown',function(e){ if(mode&&e.key==='Escape'){ setMode(false); parent.postMessage({__maestroDesign:true,type:'comment-cancel'},'*'); } },true);
  function setMode(on){ mode=on; try{ document.documentElement.style.cursor=on?'crosshair':''; }catch(_){} if(!on) box.style.display='none'; }
  function renderPins(){
    pins.innerHTML='';
    markers.forEach(function(m){
      try{ var el=document.querySelector(m.selector); if(!el) return; var r=el.getBoundingClientRect();
        var pin=document.createElement('div');
        pin.style.cssText='position:absolute;transform:translate(-50%,-50%) rotate(45deg);width:20px;height:20px;border-radius:50% 50% 50% 0;background:'+(m.status==='resolved'?'#2da44e':'#fb8500')+';border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)';
        var s=document.createElement('span'); s.textContent=m.n; s.style.cssText='display:block;transform:rotate(-45deg);color:#fff;font:700 11px/16px system-ui;text-align:center;width:100%';
        pin.appendChild(s); pin.style.left=(r.left+9)+'px'; pin.style.top=(r.top+9)+'px'; pins.appendChild(pin);
      }catch(_){}
    });
  }
  window.addEventListener('scroll',renderPins,true);
  window.addEventListener('resize',renderPins,true);
  setInterval(renderPins,700);
  window.addEventListener('message',function(e){
    var d=e.data; if(!d||!d.__maestro) return;
    if(d.type==='comment-mode') setMode(!!d.on);
    if(d.type==='comment-markers'){ markers=Array.isArray(d.items)?d.items:[]; renderPins(); }
    if(d.type==='flash'&&d.selector){ try{ var el=document.querySelector(d.selector); if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); frame(el); setTimeout(function(){ if(!mode) box.style.display='none'; },1300); } }catch(_){} }
  });
})();`;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#e7e9f3',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

/* ── Maestro core boots WITH the app: local store + local engine + relay ──
   Everything lives and executes on this Mac. The relay connection exists only
   so the phone/web remotes can mirror state and send commands here. */

/** A page's origin (scheme+host) — the only part of a URL safe to mirror to the
    phone. The query string / fragment can carry session tokens (OAuth callbacks,
    magic-links, presigned URLs), so they must never cross the relay. */
function originOf(u: unknown): string {
  if (typeof u !== 'string' || !u) return '';
  try { return new URL(u).origin; } catch { return ''; }
}
/** Strip a browser-state event down to what's safe to mirror to the phone. */
function slimBrowserForRelay(d: Record<string, unknown>): Record<string, unknown> {
  return { projectId: d.projectId ?? null, url: originOf(d.url), title: d.title ?? '', tabs: d.tabs ?? 0, activeTab: d.activeTab ?? 0, open: d.open ?? false };
}

app.whenReady().then(() => {
  const store = new Store();
  store.settleOrphanedRuns(); // jobs from a previous app instance can't finish — settle them honestly
  const providers = new Providers(store);

  /* Serve a design project's folder for the live preview iframe:
     maestro-design://<projectId>/design/index.html → ~/Maestro/<project>/design/…
     Read-only + path-guarded to the project root (no traversal, no symlink escape). */
  // Only DESIGN projects expose a folder over this scheme, and only their own
  // root — resolved once here (no dir creation on the read path).
  const designRootFor = (projectId: string): string | null => {
    const p = store.getProject(projectId);
    if (!p || p.kind !== 'design') return null;
    const safe = (p.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
    // The engine's write-dir (workDirFor) and this serve-dir must agree. Prefer
    // whichever candidate ACTUALLY holds the artifact (recovers a project whose
    // stored path + on-disk folder diverged), else the first that exists.
    const candidates = [p.path, path.join(app.getPath('home'), 'Maestro', safe)].filter((c): c is string => !!c);
    for (const c of candidates) if (existsSync(path.join(c, 'design', 'index.html'))) return c;
    for (const c of candidates) if (existsSync(c)) return c;
    return candidates[0] ?? null;
  };
  // A restrictive CSP for served design documents (no exfiltration: connect-src
  // 'none', form-action 'none') — the design can still load its own assets/fonts.
  const DESIGN_CSP = "default-src 'self' data: blob: https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'";
  protocol.handle('maestro-design', async (req) => {
    try {
      const u = new URL(req.url);
      const root = designRootFor(u.hostname);
      if (!root) return new Response('no such design project', { status: 404 });
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'design/index.html';
      const rootReal = realpathSync(path.resolve(root));
      const target = path.resolve(rootReal, rel);
      if (!existsSync(target)) {
        // Friendly placeholder until the agent writes the artifact.
        if (rel === 'design/index.html') return new Response(DESIGN_PLACEHOLDER, { headers: { 'content-type': 'text/html', 'content-security-policy': DESIGN_CSP } });
        return new Response('not found', { status: 404 });
      }
      // Resolve symlinks and RE-VALIDATE the real path is still inside the project
      // root (a lexical `..` check alone misses a symlink that points outside).
      const real = realpathSync(target);
      const relReal = path.relative(rootReal, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) return new Response('forbidden', { status: 403 });
      const buf = await fsp.readFile(real);
      const mime = DESIGN_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
      const headers: Record<string, string> = { 'content-type': mime, 'cache-control': 'no-cache' };
      if (mime === 'text/html') {
        headers['content-security-policy'] = DESIGN_CSP;
        let html = buf.toString('utf8');
        // Smooth scrollbar default at the TOP of <head> (design styles can override).
        const styleTag = `<style id="maestro-scroll">${DESIGN_SCROLLBAR_CSS}</style>`;
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + styleTag) : styleTag + html;
        // Inject the Mochi-style comment harness so the operator can annotate
        // specific elements of the live design (selectors → notes → the agent).
        const tag = `<script>${DESIGN_COMMENT_HARNESS}</script>`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag;
        return new Response(html, { headers });
      }
      return new Response(new Uint8Array(buf), { headers });
    } catch { return new Response('error', { status: 500 }); }
  });

  // Apply the persisted "open at login" preference, and re-apply whenever it changes.
  const applyLoginItem = (openAtLogin: boolean) => { try { app.setLoginItemSettings({ openAtLogin }); } catch { /* unsupported */ } };
  applyLoginItem(store.getSettings().openAtLogin);

  let relay: RelayClient | null = null;
  let telegram: TelegramBot | null = null;
  const emit = (name: string, data: unknown, opts?: { live?: boolean }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('maestro:event', { name, data }); } catch { /* window closing */ }
    }
    // Streaming frames (50ms cadence) are local-only: the relay/phone gets the
    // ~1s checkpoint updates instead of a snapshot push per frame.
    if (opts?.live) return;
    if (name === 'settings' && data && typeof data === 'object') applyLoginItem(!!(data as { openAtLogin?: boolean }).openAtLogin);
    // A new pending approval (e.g. reviewer NEEDS WORK) → push to Telegram gates.
    if (name === 'approval' && telegram && (data as Approval)?.status === 'pending') telegram.notifyApproval(data as Approval);
    // The relay is a pure conduit to the phone — never hand it the Mac-local path,
    // the base64 thumbnail, the content hash, or the fal queue URLs an Asset carries.
    // (Desktop windows above already got the full object; only the relay is slimmed.)
    const relayData = name === 'asset' && data && typeof data === 'object' ? store.slimAssetForRelay(data as import('./store.js').Asset)
      : name === 'job' && data && typeof data === 'object' ? store.slimJobForRelay(data as Job)
      // Browser state streams continuously — give the phone the origin + title only,
      // never the full URL (which can carry session tokens in its query string).
      : name === 'browser' && data && typeof data === 'object' ? slimBrowserForRelay(data as Record<string, unknown>)
      : data;
    relay?.event(name, relayData);
    relay?.pushSnapshot();
  };

  const engine = new LocalEngine(store, emit, providers);
  const media = new MediaEngine(store, emit, () => providers.getLocalKey('fal'));
  media.resumeOnBoot();
  const research = new ResearchEngine(store, engine, emit);
  const publishing = new PublishingEngine(store, emit);
  // Give the coding agent a real image capability (it had none → it improvised SVG).
  // This is the ONLY place MediaEngine/publishing meet the coding engine; the relay
  // dispatch (createDispatch below) never receives them, so no key/bytes hit the server.
  // The generate_image tool honours Settings → Image generation: 'codex' uses the
  // FREE native image_gen skill (no fal credits); otherwise fal flux-schnell (fast,
  // ~$0.003, uses your fal balance). The Codex *engine* always uses its own skill.
  engine.setPublishing(publishing);
  // Native browser automation — one real Chrome per project, owned here on the Mac.
  // Both engines reach this SAME controller (Claude via in-process MCP tools, Codex
  // via a stdio shim → dispatch). Not handed to the relay dispatch as a controller;
  // only its slimmed state/url crosses to the phone (see emit() below).
  const browser = new BrowserController(store, publishing, emit);
  engine.setBrowser(browser);
  // Codex parity: a local stdio-MCP bridge codex connects to (the SAME controller).
  const browserBridge = new BrowserBridge(browser, store);
  browserBridge.start();
  engine.setBrowserBridge(browserBridge);
  engine.setImageGen(async (prompt, opts) => {
    if (store.routing().image === 'codex' && engine.status('codex').available) {
      return engine.imageViaCodex(prompt, opts); // free, native — no fal credits needed
    }
    const asset = await media.generateAndWait({ modelKey: 'flux-schnell', prompt, projectId: opts.projectId ?? null, aspect: opts.aspect });
    if (!asset.localPath) throw new Error('image was generated but saving it locally failed — please try again');
    return { path: asset.localPath, assetId: asset.id, alt: prompt.slice(0, 200), width: asset.width, height: asset.height };
  });
  telegram = new TelegramBot(store, engine, providers, emit);
  telegram.resumeOnBoot();
  const dispatch = createDispatch(store, engine, media, research, publishing, telegram, providers, emit, RELAY_URL, browser);

  relay = new RelayClient({
    url: RELAY_URL,
    deckId: store.deck.deckId,
    deckSecret: store.deck.deckSecret,
    accessToken: store.accessToken,
    getSnapshot: () => ({ ...store.snapshot(providers.list()), engineStatus: engine.statuses(), mediaRates: media.rates(), models: buildModelGroups(engine.statuses()) }),
    // Relay command results can be Job-shaped (sendChat → {session,job}, getJob,
    // listJobs…) — slim any Job before it crosses back to the phone so the
    // Mac-local image path never rides the response either. (Desktop IPC at
    // maestro:call calls dispatch directly and keeps the full job for reveal.)
    onCommand: async (method, params) => {
      // Desktop-only methods that expose local secrets / personal data must never
      // answer over the relay, even though dispatch is shared with the local IPC
      // surface. getPairing returns the raw access token; listChromeProfiles
      // returns the operator's Chrome profile display names (often their real name).
      // getPairing/listChromeProfiles leak local secrets/personal data; the
      // *ProjectMemory + snapshotProject methods read/write project files and run
      // git on the Mac — none may answer over the relay (phone/web are read-mostly
      // remote controls, not local-execution surfaces).
      if (method === 'getPairing' || method === 'listChromeProfiles' || method === 'getProjectMemory' || method === 'setProjectMemory' || method === 'snapshotProject'
        || method === 'listDesignComments' || method === 'addDesignComment' || method === 'setDesignCommentStatus' || method === 'deleteDesignComment'
        || method === 'copyDesignToCode') {
        throw Object.assign(new Error('not available remotely'), { statusCode: 403 });
      }
      const r = await dispatch(method, params);
      const isJob = (x: unknown): x is Job => !!x && typeof x === 'object' && 'input' in x && 'status' in x && 'phase' in x && 'projectId' in x;
      if (isJob(r)) return store.slimJobForRelay(r);
      if (Array.isArray(r)) return r.map(x => (isJob(x) ? store.slimJobForRelay(x) : x));
      if (r && typeof r === 'object' && isJob((r as { job?: unknown }).job)) return { ...r, job: store.slimJobForRelay((r as { job: Job }).job) };
      // Browser command results carry the FULL current URL (browserState/Navigate/
      // Screenshot) — slim it to origin-only on the relay path, mirroring the event
      // path, so a token-bearing URL never reaches the phone. The local IPC surface
      // (maestro:call) bypasses onCommand and keeps the full URL for the in-app pane.
      if (typeof method === 'string' && method.startsWith('browser') && r && typeof r === 'object' && typeof (r as { url?: unknown }).url === 'string') {
        return { ...(r as Record<string, unknown>), url: originOf((r as { url: string }).url) };
      }
      return r;
    },
  });
  relay.start();

  const cron = new CronRunner(store, engine, emit, (nowMs) => publishing.fireDue(nowMs));
  cron.start();
  app.on('before-quit', () => { cron.stop(); relay?.stop(); telegram?.stop(); browserBridge.stop(); void browser.dispose(); });

  ipcMain.handle('maestro:call', async (_e, method: string, params: Record<string, unknown>) => {
    try {
      const data = await dispatch(method, params ?? {});
      return { ok: true, data };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number };
      return { ok: false, error: err?.message ?? 'failed', status: err?.statusCode ?? 500 };
    }
  });

  // Native folder picker — DESKTOP-ONLY (never exposed to the relay/remotes).
  // The coding agent opens an existing local folder as a project workspace.
  ipcMain.handle('maestro:pickFolder', async () => {
    const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' });
    if (res.canceled || !res.filePaths[0]) return { ok: true, data: null };
    return { ok: true, data: await dispatch('inspectFolder', { path: res.filePaths[0] }) };
  });

  // Reveal a path in Finder — desktop-only, path-guarded. Expands a leading ~.
  ipcMain.handle('maestro:revealPath', async (_e, p: string) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'no path' };
    const abs = p.startsWith('~/') || p === '~' ? path.join(app.getPath('home'), p.slice(1)) : p;
    if (existsSync(abs)) { shell.showItemInFolder(abs); return { ok: true }; }
    return { ok: false, error: 'path not found' };
  });

  // Import a local media file as an asset — DESKTOP-ONLY (native picker).
  ipcMain.handle('maestro:importAsset', async (_e, projectId: string | null) => {
    const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const opts = { properties: ['openFile' as const], title: 'Import media', filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a'] }] };
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return { ok: true, data: null };
    try { return { ok: true, data: await dispatch('importAsset', { path: res.filePaths[0], projectId: projectId ?? null }) }; }
    catch (e) { const err = e as { message?: string }; return { ok: false, error: err?.message ?? 'import failed' }; }
  });

  // Inline image bytes for the chat — DESKTOP-ONLY, keyed by a TRUSTED Asset id
  // (the renderer never supplies a path, so there's no traversal surface). NOT in
  // the relay dispatch, so phone/web remotes can never pull Mac-local image bytes.
  const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  ipcMain.handle('maestro:assetImage', async (_e, assetId: string) => {
    try {
      const a = store.getAsset(String(assetId));
      if (!a?.localPath || !existsSync(a.localPath)) return { ok: false, error: 'no local image' };
      const st = await fsp.stat(a.localPath);
      if (st.size > 12 * 1024 * 1024) return { ok: false, error: 'image too large to preview' };
      const ext = (a.localPath.split('.').pop() ?? 'png').toLowerCase();
      const mime = IMG_MIME[ext] ?? 'application/octet-stream';
      const b64 = (await fsp.readFile(a.localPath)).toString('base64');
      return { ok: true, data: { dataUrl: `data:${mime};base64,${b64}` } };
    } catch (e) { return { ok: false, error: (e as Error)?.message ?? 'read failed' }; }
  });

  // Live browser preview frame for the in-app Browser tab — DESKTOP-ONLY (raw PNG
  // bytes, never an Asset, never relayed). The phone only ever sees slimmed state.
  ipcMain.handle('maestro:browserView', async (_e, projectId: string | null) => {
    try { return { ok: true, data: await browser.view(projectId ? String(projectId) : null) }; }
    catch (e) { return { ok: false, error: (e as Error)?.message ?? 'browser view failed' }; }
  });

  /* Resolve `rel` to a canonical path that is provably INSIDE the project root.
     Defends against `..` escapes and symlinks pointing out of the repo. Accepts
     either a path relative to the root or an absolute path that lands inside it. */
  const resolveInsideRoot = (rawRoot: string, rel: string): string => {
    const root = rawRoot.startsWith('~/') || rawRoot === '~' ? path.join(app.getPath('home'), rawRoot.slice(1)) : rawRoot;
    const rootReal = realpathSync(path.resolve(root));
    const target = path.resolve(rootReal, String(rel ?? ''));
    const relToRoot = path.relative(rootReal, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new Error('path escapes project');
    const real = realpathSync(target);
    const relReal = path.relative(rootReal, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('symlink escapes project');
    return real;
  };
  const projectRoot = (projectId: unknown): string => {
    const root = store.getProject(String(projectId))?.path;
    if (!root) throw new Error('this project has no folder on disk');
    return root;
  };

  // Read a file's text — DESKTOP-ONLY, confined to the project folder. Never
  // added to the relay dispatch, so remotes can't read local files.
  ipcMain.handle('maestro:readFile', async (_e, projectId: string, rel: string) => {
    try {
      const real = resolveInsideRoot(projectRoot(projectId), rel);
      const st = await fsp.stat(real);
      if (!st.isFile()) return { ok: false, error: 'not a file' };
      if (st.size > 2 * 1024 * 1024) {
        const fd = await fsp.open(real, 'r');
        try { const buf = Buffer.alloc(512 * 1024); const { bytesRead } = await fd.read(buf, 0, buf.length, 0); return { ok: true, data: { path: real, text: buf.subarray(0, bytesRead).toString('utf8'), bytes: st.size, truncated: true } }; }
        finally { await fd.close(); }
      }
      const text = await fsp.readFile(real, 'utf8');
      if (text.includes('\u0000')) return { ok: false, error: 'binary file' };
      return { ok: true, data: { path: real, text, bytes: st.size, truncated: false } };
    } catch (e) { return { ok: false, error: (e as Error)?.message ?? 'read failed' }; }
  });

  // List a directory's immediate entries — DESKTOP-ONLY, confined to the project.
  ipcMain.handle('maestro:listDir', async (_e, projectId: string, rel: string) => {
    try {
      const real = resolveInsideRoot(projectRoot(projectId), rel);
      const st = await fsp.stat(real);
      if (!st.isDirectory()) return { ok: false, error: 'not a directory' };
      const dirents = await fsp.readdir(real, { withFileTypes: true });
      const entries = dirents
        .filter(d => d.name !== '.git' && d.name !== 'node_modules' && d.name !== '.DS_Store')
        .slice(0, 5000)
        .map(d => ({ name: d.name, path: path.join(real, d.name), kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
      return { ok: true, data: { path: real, entries } };
    } catch (e) { return { ok: false, error: (e as Error)?.message ?? 'list failed' }; }
  });

  // Run/Terminal: spawn a shell command in the project folder and stream output
  // back over 'maestro:cmd-output'. DESKTOP-ONLY (renderer↔main) — never on the
  // relay, so remotes can't run commands on this Mac.
  const runningCmds = new Map<string, ChildProcess>();
  ipcMain.handle('maestro:runCommand', async (e, projectId: string, command: string) => {
    try {
      const root = store.getProject(String(projectId))?.path;
      if (!root) return { ok: false, error: 'this project has no folder' };
      if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'command required' };
      const runId = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}`;
      const child = spawn('/bin/zsh', ['-lc', command], { cwd: root, env: { ...process.env } });
      runningCmds.set(runId, child);
      const send = (stream: string, chunk: string, code?: number) => { try { e.sender.send('maestro:cmd-output', { runId, stream, chunk, code }); } catch { /* window gone */ } };
      child.stdout?.on('data', (d: Buffer) => send('out', String(d)));
      child.stderr?.on('data', (d: Buffer) => send('err', String(d)));
      child.on('close', (code) => { runningCmds.delete(runId); send('exit', '', code ?? 0); });
      child.on('error', (err) => { runningCmds.delete(runId); send('err', err.message + '\n'); send('exit', '', 1); });
      return { ok: true, data: { runId } };
    } catch (err) { return { ok: false, error: (err as Error)?.message ?? 'run failed' }; }
  });
  ipcMain.handle('maestro:killCommand', async (_e, runId: string) => {
    const c = runningCmds.get(String(runId));
    if (c) { try { c.kill('SIGTERM'); } catch { /* gone */ } runningCmds.delete(String(runId)); }
    return { ok: true };
  });

  // Smoke test: run the end-to-end sequence against the fully-wired core, then
  // exit. No window — everything above (engine + image-gen + browser + dispatch)
  // is already set up exactly as the app uses it.
  if (process.env.MAESTRO_SMOKE) {
    void runSmoke({ dispatch, engine, browser, store })
      .then(code => { try { void browser.dispose(); browserBridge.stop(); } catch { /* */ } app.exit(code); })
      .catch(e => { console.error('smoke harness crashed:', e); app.exit(2); });
    return;
  }

  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});
