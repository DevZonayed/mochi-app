# Playwright-native browser for the macOS app — design

**Status:** approved design (brainstorming complete) · **Date:** 2026-06-28
**Owner branch:** `DevZonayed/native-playwright-mcp`
**Supersedes (for the native app path):** the ExtensionBridge + Chrome-extension
control channel as the browser backend.

---

## 1. Goal

Give the native macOS app (SwiftUI `MacOS/app` + Node sidecar `MacOS/sidecar`) a
first-class browser that:

1. Is driven by **Playwright**, embedded in the brain — *no bundled Chromium*. It
   drives the user's **installed Google Chrome** via `channel: "chrome"`.
2. Remembers cookies / logins / browser data **per project** (persistent profiles).
3. Carries the full "powers" of the old extension: **comment mode** (click an element,
   leave a pin/note) and **send / steer a message to a chat** straight from the page.
4. Lets any project **open a browser instance** on demand that is **tightly synced**
   with the app (open / close / navigate / live status / screenshot / comments, all
   reflected in a dedicated Swift surface).
5. Exposes **all related settings** in the Swift Settings screen.

Non-goals (this spec): rebranding the userData dir from `@maestro/desktop` → "Mochi";
removing the Electron app's existing ExtensionBridge; seeding cookies from the user's
personal default Chrome profile (noted as a future opt-in only).

## 2. Decisions (locked with operator)

- **Surface:** **A — managed external Chrome window.** Playwright launches the real
  installed Chrome in its own visible window per project. The Swift app opens /
  controls / observes it; it is *not* embedded inside the Maestro window (a true
  Chrome view can't be embedded without bundling Chromium, which is ruled out).
- **Engine:** **In-process Playwright driver owned by the sidecar/brain** (not
  Microsoft's external `@playwright/mcp`). The existing `browser_*` agent tools keep
  their vocabulary; only their backend changes. This is the only option that delivers
  comment/steer + tight Swift coupling.
- **Dependency:** **`playwright-core`** (ships *no* browser binaries) added to
  `apps/desktop` deps. It hoists in the pnpm workspace so the sidecar resolves it via
  `apps/desktop/electron`. `channel: "chrome"` uses the installed Chrome.
- **Profiles:** **dedicated, Mochi-managed, per-project** Chrome profiles — *not* the
  user's everyday default profile (per-project cookie jars + avoiding a profile-lock
  conflict with the user's running Chrome both require this).
- **Profile path:** `<userData>/browser-profiles/<projectId>/`, where `<userData>`
  already carries the app identity (`~/Library/Application Support/@maestro/desktop`,
  resolved by `electron-shim.ts` in the sidecar and `app.getName()` in Electron). One
  exported helper `browserProfileDir(projectId)` is the single source of that path —
  no string literal scattered across modules.
- **Concurrency:** **one browser instance per project** (Chrome locks a profile dir).
  A project's multiple chat sessions share that one context and open tabs as needed.

## 3. Architecture overview

```
                 ┌──────────────────────── apps/desktop/electron (shared brain) ────────────────────────┐
 Agent (browser_*)│  engine.ts: browserCtx.call(type,params) ──► BrowserManager.call(projectId,type,...) │
                  │                                                      │                                 │
 Swift app  ──RPC─┤  localApi.ts: browserOpen/Close/Navigate/... ──────►│  BrowserManager (NEW)           │
 (MaestroClient)  │                                  emit('browser',…) ◄─┤   - per-project PwContext        │
                  │                                                      │   - launchPersistentContext(    │
                  │  store.ts: AppSettings.browser, browserProfileDir()  │       channel:'chrome')         │
                  └──────────────────────────────────────────────────────┼─────────────────────────────────┘
                                                                          ▼
                                       Installed Google Chrome (real visible window, per-project profile)
                                          + injected comment-mode overlay ──exposeBinding──► dispatch
                                              (__mochiComment → addDesignComment / __mochiSteer → sendChat)
```

Both the agent and the Swift app drive **one shared per-project context** through the
`BrowserManager`. The manager is wired into the engine (`setBrowserManager`) and into
`createDispatch` (new `browser*` RPCs), in **both** `main.ts` (Electron) and
`headless-main.ts` (sidecar).

## 4. Components & interfaces

Each unit has one purpose, a defined interface, and is testable in isolation.

### 4.1 `BrowserManager` — `apps/desktop/electron/browser/manager.ts` (NEW)

Owns Playwright. Pure-ish (filesystem + playwright only; no Electron import, so the
sidecar can use it). Keyed by `projectId`.

```ts
interface OpenOpts { startUrl?: string; headless?: boolean; chromePath?: string }
interface BrowserStatus {
  projectId: string; open: boolean; url: string | null; title: string | null;
  tabCount: number; lastScreenshotAt: number | null; chromeVersion: string | null;
}
class BrowserManager {
  constructor(deps: {
    userDataDir: string;                 // base; profiles under browser-profiles/<id>
    settings: () => BrowserSettings;     // live read of AppSettings.browser
    dispatch: (method: string, params: any) => Promise<any>; // for comment/steer round-trip
    emit: (status: BrowserStatus) => void;                   // → emit('browser', status)
  });
  open(projectId: string, opts?: OpenOpts): Promise<BrowserStatus>;
  close(projectId: string): Promise<void>;
  status(projectId: string): BrowserStatus;
  statusAll(): BrowserStatus[];
  // Generic command bus the agent tools use — maps a `type` to a Playwright action.
  call(projectId: string, type: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  screenshot(projectId: string, opts?: { fullPage?: boolean }): Promise<{ dataUrl: string }>;
  clearData(projectId: string): Promise<void>;   // close + rm -rf profile dir
  shutdown(): Promise<void>;                       // close all on app/sidecar exit
}
```

**Launch:** `chromium.launchPersistentContext(browserProfileDir(projectId), {
channel: "chrome", headless: settings.headless ?? false, viewport: null, args:
["--no-first-run","--no-default-browser-check"] })`. If `channel:"chrome"` fails
(Chrome not installed), surface a clear, actionable error (Settings shows install /
path override) — never silently fall back to a downloaded Chromium.

**`call` type map (parity with today's `browser_*` tools):** navigate→`page.goto`,
snapshot→aria-ref snapshot (see 4.2), click/type/press_key→`locator`/`keyboard`,
screenshot→`page.screenshot`, evaluate→`page.evaluate`, scroll, links, read/text,
network_requests→`page.on('request'|'response')` buffer, console_messages→
`page.on('console')` buffer, cdp→`context.newCDPSession(page)`. The set is the same
strings `engine.ts` already sends to `bridge.request`, so the engine call sites are
unchanged.

### 4.2 Snapshot / ref parity — `apps/desktop/electron/browser/snapshot.ts` (NEW)

The single highest-effort sub-task. Today `browser_snapshot` returns a ref-tagged
accessibility tree and `browser_click({ref})` resolves a `ref` back to an element.
Playwright models this natively (`aria-ref` locators — the same mechanism Microsoft's
`@playwright/mcp` uses). This module produces the ref-tagged snapshot and resolves
`ref → Locator` (`page.locator('aria-ref=<id>')`), preserving the exact tool contract
so the agent and `browser-skill.ts` docs need no changes.

### 4.3 Comment-mode + steer overlay — `apps/desktop/electron/browser/overlay.ts` (NEW)

- An init script (`context.addInitScript(OVERLAY_JS)`) injects a closed-shadow-DOM FAB
  + numbered pins + a comment popover into every page (ported/adapted from the
  existing shadow-DOM overlay; visual parity with the old comment mode).
- `context.exposeBinding("__mochiComment", (src, payload) => dispatch("addDesignComment",
  { id: projectId, selector, label, note }))` — comments land in the **same project
  design-comments store** the Swift Design workspace already reads.
- `context.exposeBinding("__mochiSteer", (src, { text }) => dispatch("sendChat",
  { projectId, sessionId, text }))` — "send to chat / steer" from the page.
- Agent tools `browser_comment_add/list/resolve` read/write the same store, so
  hand-placed and agent-placed comments converge.

### 4.4 Engine integration — `apps/desktop/electron/engine.ts` (EDIT)

- Add `private browserManager?: BrowserManager; setBrowserManager(m){…}` next to
  `setExtensionBridge`/`setBrowserWatcher` (engine.ts:2030-2038).
- In `run()` where `browserCtx` is built (engine.ts:3090), prefer the manager:
  `const useMgr = this.browserManager && !opts.plan;` build
  `browserCtx = { connected: () => mgr.status(pid).open, profile: () => 'project:'+pid,
  call: (type,params,timeoutMs) => mgr.call(pid, type, params, timeoutMs), watch: … }`
  where `pid = job.projectId ?? session.projectId`. Fall back to the existing
  `extBridge` path when no manager is set (keeps Electron's extension working).
- `browser-watch.ts` is unchanged — its `bridge.request('evaluate', …)` becomes
  `mgr.call(pid,'evaluate', …)` via the same `BrowserBridgeForWatch` shape.

### 4.5 RPC surface — `apps/desktop/electron/localApi.ts` (EDIT)

Add `browserManager?: BrowserManager` param to `createDispatch` and new switch cases:

| RPC | params | returns | emits |
|---|---|---|---|
| `browserOpen` | `{projectId, startUrl?}` | `BrowserStatus` | `browser` |
| `browserClose` | `{projectId}` | `void` | `browser` |
| `browserNavigate` | `{projectId, url}` | `BrowserStatus` | `browser` |
| `browserStatus` | `{projectId?}` | `BrowserStatus \| BrowserStatus[]` | — |
| `browserScreenshot` | `{projectId, fullPage?}` | `{dataUrl}` | — |
| `browserListComments` | `{projectId}` | reuse `listDesignComments` shape | — |
| `browserClearData` | `{projectId}` | `void` | `browser` |
| `browserRevealProfile` | `{projectId}` | `void` | — |

**Browser settings reuse the existing `getSettings` / `setSettings`** (patch the new
`{ browser }` key) — no dedicated settings RPCs. The manager calls
`emit('browser', status)` on every state change; the Swift app subscribes via
`MaestroClient.onEvent`.

### 4.6 Settings storage — `apps/desktop/electron/store.ts` (EDIT)

```ts
interface BrowserSettings {
  enabled: boolean;            // default true
  headless: boolean;           // default false (surface A wants a visible window)
  chromePath?: string;         // override; else channel:'chrome' auto-detect
  defaultStartUrl?: string;    // about:blank if unset
  windowWidth?: number; windowHeight?: number;
}
// AppSettings gains:  browser?: BrowserSettings;
// DEFAULT_SETTINGS gains:  browser: { enabled: true, headless: false }
```

### 4.7 Wiring — `main.ts` (EDIT) + `headless-main.ts` (EDIT)

In both: construct `const browserManager = new BrowserManager({ userDataDir,
settings: () => store.getSettings().browser ?? DEFAULTS, dispatch, emit: s =>
emit('browser', s) })`, then `engine.setBrowserManager(browserManager)` and pass it
to `createDispatch(...)`. (In `main.ts`, that `emit` is the Electron wrapper — pass
`{ desktopOnly: true }` so browser status/screenshots stay on the local UI and aren't
fanned out to the phone/relay.) In `headless-main.ts` this replaces the
`getExtensionBridge → null` TODO at line 134. Register `browserManager.shutdown()` on
app/sidecar exit.

### 4.8 Swift — new **Browser** genre

- `App/AppEnv.swift`: add `case browser` to `Route` (label "Browser", icon "globe"),
  add to `navBar`.
- `App/RootView.swift`: route `.browser → BrowserView()`.
- `Features/Browser/BrowserStore.swift` (NEW, `@Observable`): holds
  `status: BrowserStatus?`, `comments: [DesignComment]`, `screenshot: NSImage?`;
  subscribes to `browser` events; calls `browserOpen/Close/Navigate/Screenshot/
  ListComments`. Follows the active project from `WorkspaceStore`.
- `Features/Browser/BrowserView.swift` (NEW): project header + **Open / Close**, a
  URL/command bar (Go), live status line (open · URL · title), a **screenshot mirror**
  (periodic `browserScreenshot`), and the comment list with inline resolve + "send to
  chat". Tool-call viz already recognizes `browser_*` (`ToolCallViz.swift`).
- `Core/Models.swift` (NEW structs): `BrowserStatus`, `BrowserSettings` (Codable).

### 4.9 Swift — **Browser** Settings pane

- `Features/Settings/SettingsView.swift`: add a `.browser` `Section` case (icon/tint).
- `Features/Settings/BrowserPane.swift` (NEW): enable toggle · detected Chrome
  path/version (override field) · headless toggle · default start URL · window size ·
  per-project profile list with **Clear data** (`browserClearData`) and **Reveal in
  Finder**. Reads `getBrowserSettings`, writes `setBrowserSettings`.

## 5. Data flow (three representative paths)

1. **Agent automation:** `browser_navigate({url})` → maestro MCP tool →
   `browserCtx.call('navigate',{url})` → `BrowserManager.call(pid,'navigate',…)` →
   `page.goto` → real Chrome navigates → `emit('browser', status)` → Swift updates.
2. **App control:** Swift "Open" → `browserOpen({projectId})` →
   `BrowserManager.open` → `launchPersistentContext({channel:'chrome'})` → visible
   Chrome window → `emit('browser')` → `BrowserStore` shows open + screenshot.
3. **Comment from page:** user clicks element + writes note in Chrome → overlay calls
   `window.__mochiComment(payload)` → `exposeBinding` → `dispatch('addDesignComment')`
   (+ optional `sendChat`) → design comments store → Swift Design + Browser panes and
   the agent's `browser_comment_list` all see it.

## 6. Error handling

- **Chrome missing:** `launchPersistentContext({channel:'chrome'})` throws →
  `BrowserManager` returns a typed `{error:'chrome-not-found'}`; Settings surfaces an
  install link / path override. Never download Chromium.
- **Profile locked (already open):** `open()` is idempotent — return the existing
  context's status instead of relaunching.
- **Disconnected context** (user quit the Chrome window): manager detects `context`
  close, emits `open:false`; the agent's `call` returns a clear "browser not open for
  this project" error (mirrors today's disconnect message). The retry wrapper in
  `engine.ts` (≈766-774) still applies.
- **Concurrent session in same project:** shares the one context; opens a new tab.
- **Sidecar restart:** live contexts die with the process; profile dir persists, so a
  re-`open()` restores cookies/logins. No state assumed in memory beyond the live
  context map.

## 7. Testing

- **Unit (Node, in `apps/desktop`):** `browserProfileDir()` path helper;
  `BrowserManager.call` type-map dispatch (mock a `Page`); snapshot ref round-trip
  (snapshot → ref → locator) on a static HTML fixture; idempotent `open`; `clearData`
  removes the profile dir. Run via the existing electron test runner (note:
  renderer-style `src/**` tests aren't in the default suite — keep these under
  `electron/**`).
- **Integration (gated, real Chrome):** a smoke script (like `sidecar/smoke-test.mjs`)
  that opens a project browser, navigates to a local fixture, snapshots, clicks by ref,
  places a comment, asserts the design-comment store received it. Marked skip-by-default
  in CI (needs installed Chrome + a display).
- **Swift:** `swift build` + a `--selftest` path that exercises `browserStatus`
  decode and the Browser route renders (mirrors existing self-test/toolviz flags).
- **Manual verification per phase** (see §8): open from the app, watch the real Chrome
  window obey navigate, hand-place a comment and see it in chat.

## 8. Phasing (each phase independently verifiable)

- **P0 — Engine core.** `playwright-core` dep; `BrowserManager` (open/close/status/
  navigate/screenshot/clearData) + `browserProfileDir`; wire `setBrowserManager` +
  shutdown in `main.ts` and `headless-main.ts`. *Verify:* smoke script opens a real
  per-project Chrome, navigates, screenshots; second `open()` reuses it.
- **P1 — Agent tools backend.** Route `browserCtx` → manager; snapshot/ref parity;
  network/console buffers; cdp. *Verify:* agent runs `browser_navigate` + `browser_snapshot`
  + `browser_click({ref})` against a live page; `browser-watch` fires.
- **P2 — Powers.** Overlay init script + `__mochiComment`/`__mochiSteer` bindings.
  *Verify:* hand-place a comment in Chrome → appears in design comments + chat.
- **P3 — Swift Browser genre.** RPCs + events + `BrowserStore`/`BrowserView` + Route.
  *Verify:* open/close/navigate from the app; live status + screenshot mirror update.
- **P4 — Swift Settings pane.** `AppSettings.browser` + `BrowserPane` (enable, Chrome
  path, headless, profile clear/reveal). *Verify:* settings round-trip; Clear data
  wipes a project's cookies.
- **P5 — Future (out of scope now):** opt-in "seed cookies from my main Chrome
  profile"; richer multi-tab UI; deprecate the Electron ExtensionBridge once parity is
  proven.

Recommend planning **P0+P1** first (the engine foundation), verifying against real
Chrome, then P2–P4.

## 9. Risks / open implementation notes

- **Snapshot/ref fidelity** is the make-or-break for tool parity — budget the most time
  here; lean on Playwright's `aria-ref` support (proven by `@playwright/mcp`).
- **`channel:"chrome"` requires Chrome present**; document the dependency and make the
  Settings error path good.
- **`playwright-core` must not pull browser binaries** — verify the install adds no
  `~/.cache/ms-playwright` download (it shouldn't; `-core` skips it). Confirm packaged
  Electron build doesn't try to bundle it as a browser.
- **Profile size:** per-project Chrome profiles can grow; `clearData` + a Settings size
  readout mitigate. Profiles live under userData, already excluded from the repo.
