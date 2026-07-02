# Maestro → native macOS (SwiftUI) migration — design spec

**Date:** 2026-06-27 · **Branch:** `DevZonayed/philadelphia` · **Status:** approved architecture (Approach B), screen specs ready for review

## 1. Goal & motivation

Migrate the Maestro/Mochi desktop app to a **native macOS SwiftUI app** under a new
top-level `MacOS/` folder, **pixel-perfect** to the current React UI but **scoped** to five
surfaces only. Primary operator motivation: **reduce package size and resource (RAM) use.**

The dominant cost in the current Electron app is **Chromium** (~150 MB of the bundle and the
bulk of idle RAM — a Chromium renderer sits at 250–400 MB). Engines (Claude 213 MB + Codex
225 MB) are already downloaded-not-bundled. Replacing Chromium with native SwiftUI captures
essentially all the realistically-achievable win on both axes.

| | Bundle | Idle RAM |
|---|---|---|
| Now (Electron) | ~200 MB | ~300–500 MB |
| **Target (SwiftUI + Node sidecar)** | **~120–160 MB** | **~80–150 MB** (sidecar lazy-starts) |

**MEASURED (P5, 2026-06-27):** shipped `Maestro.app` = **29 MB** (Swift binary 6.4 MB + esbuild brain
bundle 11 MB + native deps 11 MB) **+ ~90 MB Node runtime** (ship official Node, or fetch on first
run like the engines) ≈ **~120 MB installed** vs Electron ~200 MB. Idle RAM: **SwiftUI app ~13–26 MB**
+ Node brain sidecar **~300 MB** (agent SDK + live Baileys WhatsApp socket [236 chats] + git watchers
— the same working set the old Electron *main* process carried) ≈ **~320 MB** vs Electron ~550 MB
(Chromium renderer ~300 + brain main ~250). The dominant win is replacing Chromium's ~300 MB renderer
with a ~20 MB native SwiftUI process; the Node brain footprint is unchanged (it does the same work).
Net ≈ **40% smaller package + ~40% less RAM**, honestly measured. (Node binary not embeddable from
Homebrew's split build — production ships official Node or downloads it; notarization needs a
Developer ID — ad-hoc signed here, like the existing electron-builder setup.)

## 2. Scope

**KEEP (5 surfaces):**
1. **Codespace** — coding-projects gallery; project cards with rename / pin(hide) / archive /
   delete; **inline** project creation (New / Add existing folder / From GitHub URL) with **no
   page redirection**; per-project hub with hidden **chat/session management** (rename, pin,
   archive, delete sessions) + the full chat/transcript/composer; **project settings**
   (memory/instructions, project-scoped **skills**, project-scoped **MCP**, WhatsApp
   assignment).
2. **Design** — design-only projects: rail, multi-session chat, **live preview** (WKWebView),
   visual **comment** harness, device presets, hand-off-to-code.
3. **Comms** — Telegram + WhatsApp connection gateway (channels / bindings / activity).
4. **WhatsApp** — full WhatsApp-app-style two-pane messenger (chat list + conversation,
   bubbles/ticks/day-separators/reactions/media, QR-driven connect).
5. **Settings** — six in-scope sections only: **Extension connection**, **Device connection**,
   **Skills & tools**, **MCP servers**, **Accounts & keys**, **Engines**.

**DROP:** Studio/Media, Research/Trends, Costs/Budget, Audit, Publishing, Job Monitor,
Approvals (as a standing nav item — keep only the demand-driven bell), standalone Scheduler,
the General/Notifications/Costs/Security/Power/Updates/Danger Settings panes, the
GeneralShell left-sidebar variant, and all seed/mock data.

## 3. Architecture (Approach B — approved)

Native SwiftUI front-end + the **existing Node "brain" reused as a headless sidecar**,
speaking the **same** `call(method, params)` + event contract over a **loopback WebSocket**
instead of Electron IPC.

```
MacOS/
├── Maestro.xcodeproj / Package.swift     # native SwiftUI app (the UI)
│   └── Sources/Maestro/
│       ├── App/            # window, genre top-nav, routing (Codespace·Design·Comms·WhatsApp·Settings)
│       ├── DesignSystem/   # Tokens (Color/Font/metric catalog) ported 1:1 from design-tokens
│       ├── Core/           # MaestroClient (WS RPC + event stream), SidecarSupervisor, stores
│       └── Features/       # one folder per kept screen
└── sidecar/                # the existing electron/ brain, headless
    ├── src/                # symlinked/copied modules + electron-shim + ws-host + headless entry
    └── build → maestro-sidecar (Node SEA single binary) → Maestro.app/Contents/Resources
```

**Three pieces, one contract:**

1. **SwiftUI app** — native window, native scroll/perf; pixel-perfect rebuild of the five
   surfaces; replaces Chromium entirely.
2. **Headless Node sidecar** — the current `electron/` brain. `main.ts:434` already assembles
   everything into one `createDispatch(store, engine, …, emit, …)`. We add a headless entry
   that builds the same dispatch and serves it over WS; `emit` pushes events to connected
   clients. The agent/WhatsApp/git/MCP logic is **unchanged**.
3. **`MaestroClient` (Swift actor)** — mirrors `window.maestro`: `call(method, params) async
   throws -> T` + an `AsyncStream<Event>` feeding `@Observable` stores. The whole bridge.

### 3.1 The electron-shim (the one real engineering cost)

~A dozen brain modules import `electron`. The shim provides the needed surface without
Electron:

| Electron API | Used for | Headless replacement |
|---|---|---|
| `app.getPath('userData'/'home'/…)` | data dirs | `os.homedir()` + `~/Library/Application Support/@maestro/desktop` (passed from Swift) |
| `safeStorage` | encrypt provider keys/tokens | macOS Keychain via a tiny `security`/native helper (Swift owns Keychain; or `node-keytar`-style) |
| `dialog.showOpenDialog` (pickFolder) | folder picker | **Swift side** `NSOpenPanel`; path passed as an RPC param |
| `shell.openPath`/`showItemInFolder` (revealPath) | Finder reveal | **Swift side** `NSWorkspace` |
| `powerMonitor` | sleep/wake for WhatsApp timers | Node `process` + a Swift `NSWorkspace` notification bridge (RPC event) |
| `Notification` | native notifications | **Swift side** `UNUserNotificationCenter` |
| `protocol` (`maestro-design://`) | design live-preview | served by the sidecar over `http://127.0.0.1:<port>/design/<projectId>/…`; WKWebView loads that |
| `BrowserWindow`/`ipcMain` | renderer host | **deleted** — replaced by the WS host |

**Native affordances move to Swift** (they were already separate IPC channels, not part of the
dispatch): `pickFolder`, `revealPath`, `importAsset`, `assetImage`, `readFile`/`writeFile`/
`listDir`/`listProjectFiles`, `runCommand`/`killCommand`. The file/command ones that need the
brain's project context are re-exposed as **dispatch methods** (added to `createDispatch`) so
they ride the same WS; the purely-native ones (pick/reveal/notify) live in Swift.

### 3.2 Transport protocol (WS)

- Sidecar listens on `127.0.0.1:<ephemeral port>`, **token-gated** (token handed to Swift on
  spawn via stdout handshake `{"ready":true,"port":N,"token":"…"}`), loopback only — same
  posture as the existing ExtensionBridge (127.0.0.1, token).
- **Request:** `{"t":"call","id":<n>,"method":"…","params":{…}}` →
  **Response:** `{"t":"res","id":<n>,"ok":true,"data":…}` or `{"ok":false,"error":"…","status":n}`.
- **Event push:** `{"t":"event","name":"…","data":…}` (the `emit` channel; 1:1 with today's
  `maestro:event`).
- Mirrors `localApi`/`preload` exactly so no brain logic changes.

### 3.3 Lifecycle / size

- `SidecarSupervisor` (Swift) spawns the SEA binary, reads the handshake, restarts on crash,
  kills on app quit. **Lazy-start** acceptable later (start on first `call`).
- Build sidecar to a **Node SEA single binary** (`--experimental-sea-config`) with tree-shaken
  deps (esbuild bundle → SEA), embedded in `Maestro.app/Contents/Resources`. Engines stay
  downloaded-not-bundled (existing `engines.ts`).

## 4. Design system (port 1:1 from `packages/design-tokens`)

A SwiftUI `Tokens` catalog reproduces the CSS custom properties **exactly**. Load-bearing
values (light / dark):

- **Accents (same both themes):** blue `#007AFF` (press `#0062CC`), green `#34C759`, red
  `#FF3B30`, orange `#FF9500`, purple `#AF52DE`, teal `#30B0C7`, indigo `#5856D6`. Anthropic
  brand `#D97757`.
- **Surfaces — light:** bg `#F2F2F7`, bg-elevated `#FFFFFF`, bg-grouped `rgba(255,255,255,.72)`,
  fill-secondary `rgba(118,118,128,.12)`, fill-tertiary `rgba(118,118,128,.08)`.
  **dark:** bg `#000000`, bg-elevated `#1C1C1E`, bg-grouped `rgba(44,44,46,.66)`,
  fill-secondary `rgba(120,120,128,.24)`, fill-tertiary `rgba(120,120,128,.16)`.
- **Ink — light:** `#000`, sec `rgba(60,60,67,.60)`, tert `rgba(60,60,67,.30)`.
  **dark:** `#FFF`, sec `rgba(235,235,245,.60)`, tert `rgba(235,235,245,.30)`.
- **Separator — light** `rgba(60,60,67,.18)` (strong `.29`); **dark** `rgba(84,84,88,.55)`
  (strong `.65`). Hairlines render at 0.5pt.
- **Type ramp (px):** largeTitle 34, title1 28, title2 22, headline/body 17, callout 16,
  subhead 15, footnote 13, caption 11. Weights 400/500/600/700. Families: SF Pro Display
  (display), SF Pro Text (text), SF Mono (mono).
- **Radii:** pill 980, card 20, group 12; icon buttons 8–9; popovers/menus 12.
- **Shadows:** card light `0 1px 3px rgba(0,0,0,.06), 0 12px 40px rgba(15,20,60,.10)`; primary
  button `0 6px 18px rgba(0,122,255,.32)`; popover `~0 18px 50px rgba(15,20,60,.22)`.
- **Glass/blur:** top bars + sidebar + grouped lists use `NSVisualEffectView`/`.ultraThinMaterial`
  over `bg-grouped`; bar height 46 (genre).
- **Motion:** spring `cubic-bezier(0.32,0.72,0,1)`, default 320ms; nav expand 200ms; reduced-motion → 0.
- **Wallpaper:** two soft radial blobs (top-left blob-a, bottom-right blob-b) over bg.
- **Theme + purpose** persisted in `@AppStorage` (`maestro.theme` light/dark/auto;
  `maestro.purpose` default `coding`).

Shared primitives ported to SwiftUI: `PillButton`, `Switch` (51×31), `GroupedList`/`Row`
(min-height 56), `StatusPill`, `Spinner`, `SegmentedControl` (sliding indicator),
`ModelPicker`, `EffortDial`, `CountUp`, `MaestroMark`, the Lucide-style `Icon` set (~80 names),
the genre **top-nav** (slim 46px frosted bar: MaestroMark + expanding icon-pill nav
[CodeSpace·Design·Comms·WhatsApp] + theme toggle + ⌘K search + Settings gear), `NotificationCenter`
(audio cues via AVFoundation), global thin overlay scrollbars.

## 5. Screens (condensed — full pixel spec in the surface map; load-bearing structure here)

> The exhaustive per-pixel map (layout regions, sizes, spacing, every control, every RPC) was
> produced by the `map-maestro-ui-surface` workflow and is the build reference. Each phase plan
> re-states its screen's spec inline.

### 5.1 Codespace
- **Projects gallery** (`Projects`): header (title + count + Grid/List segmented + Hidden(N)
  toggle + New-project CTA); grid of `ProjectCard` (tint stripe, 42×42 avatar + rollup state
  dot, name/template, ⋯ menu [Hide/Unhide, Delete], status line, source pill, clock) /
  sortable `ListTable`; skeleton + empty states; drag-to-reorder (`reorderProjects`).
- **Inline creation** — consolidate the two existing modals into ONE native create surface with
  three flows (From folder / New / From GitHub URL), preserving the GitHub-first richness
  (owner picker, live slug-availability chip, push-to-GitHub toggle, FolderDecision card,
  clone metadata preview + live clone progress). **No navigation.** RPCs: `pickFolder`(Swift),
  `adoptFolderInspect`, `bootstrapProject`, `createProject`, `cloneRepo`, `listOwners`,
  `checkSlug`, `githubRepoMetadata`.
- **Project detail** (`ProjectDetail` chat tab + settings tabs): 236px **sessions rail**
  (New chat, sync, Recent/Archived, per-row state-dot/source-chip/codename·time, inline rename,
  archive, delete) + **ChatThread** (header, streamed transcript: UserBubble / AssistantTurn
  with thinking/tool/question/image blocks, WorkBar, TurnMeta, minimap, jump-to-latest) +
  **composer** (RichComposer inline chips, send/queue/steer, ⌘Enter run-next, attachments,
  slash menu, @-mention+file search, ModelPicker, EffortDial, Plan/Goal/Autopilot/Review,
  Schedule, reviewer picker), QueuePanel, ScheduledQueue, BgTasksPanel, SyncModal,
  AskUserQuestion auto-answer countdown. Settings tabs: **Instructions** (memory editor,
  debounced save + resolved-view rail), **Skills & tools** (registry search→add, installed
  list, built-in capabilities, Allowed MCP w/ deny-by-default banner), **Settings** (project
  info wired to live fields incl. defaultBaseBranch/setupScript/copyGlobs/runMode + Archive).

### 5.2 Design (`DesignWorkspace`)
200px design rail · resizable chat panel (shared ChatThread, design-mode via
`project.kind==='design'`) · splitter · **preview** (WKWebView of `design/index.html` over the
sidecar's `http://127.0.0.1:<port>/design/…`; device presets Desktop/Tablet 834/Phone 390;
fullscreen; reload-on-job; nonce refresh). Visual **comment harness** (postMessage teardrop
pins, drawer, "address N with agent"), **hand-off-to-code** stack-picker → `copyDesignToCode`,
design **skills** sheet, image modal.

### 5.3 Comms (`CommsGateway`)
Single scroll column; 3-tab segmented (Channels / Bindings / Activity). Telegram card
(BotFather token connect). WhatsApp card (link/QR/pairing, send-gate, RecipientField,
agent-send toggle, Pause/Unlink). Bindings (pending→Track/Bind, bound list, BindSheet w/
project+session/permissions). Activity log. RPCs: `commsStatus`, `connectTelegram`,
`whatsappLink`/`whatsappQr`/`whatsappStatus`, `listChatBindings`/`listPendingChats`/`bindChat`/
`unbindChat`/`setChatPermissions`, `listCommEvents`, `approveWhatsappSend`,
`setWhatsappRecipient`, `setWhatsappAgentSend`.

### 5.4 WhatsApp (`WhatsApp`)
Two-pane: 360px **ChatList** (search, rows: avatar / name+pin / time / preview "You:" / unread
badge) + **Conversation** (header, messages scroller = chat wallpaper, day-separator chips,
**Bubble** with tails [outgoing pale-green right tail-TR, incoming elevated left tail-TL],
ticks ✓/✓✓ gray/✓✓ blue, group sender names, quoted replies, **MediaBlock** image/video/audio/
document lazy-load, reactions, hover ReactButton) + **Composer** (attach, textarea Enter-send,
green send). RPCs: `waListChats`, `waGetMessages`, `waSendText`, `waSendMedia`, `waReact`,
`waMarkRead`, `waFetchAvatar`, `waDownloadMedia`. Events: `wa-message`, `wa-chats`,
`wa-message-update`, `whatsapp-qr`.

### 5.5 Settings (`Settings`)
System-Settings model: 232px left nav (scoped to 6 items) + right pane. **Engines** (role
pickers + media routing + engine status). **Skills & tools** (embedded registry: search,
filters, rows, detail, enable/disable). **MCP servers** (`McpServersPane` list + `McpServerForm`
STDIO/HTTP + SkillPicker — the live managed-server surface). **Accounts & keys** (Anthropic/
OpenAI/fal/GitHub connect; ChatGPT + GitHub OAuth; **EngineSetup** runtime download lives here,
IS_LOCAL). **Browser extension** (control-channel status, install path/reveal, pairing token
copy, Chrome-profile list + make-active). **Devices** (This-Mac / remotes / sign-out).

## 6. Build & packaging

- **Sidecar:** esbuild-bundle the headless entry + brain (externalizing only true natives) →
  Node SEA single binary `maestro-sidecar`. Verify `pnpm test` (existing 287+ tests) still
  passes after the electron-shim refactor.
- **App:** Swift Package (SPM) for the app + an `Maestro.xcodeproj` wrapper (or xcodegen) that
  embeds `maestro-sidecar` + the bundled extension in `Resources`; `xcodebuild -scheme Maestro
  -configuration Release` → `Maestro.app`. Codesign + `notarytool` step (Developer ID; ad-hoc
  fallback like today's electron-builder).
- **Verification gate (per phase):** `xcodebuild` builds clean; the app launches, spawns the
  sidecar, and the phase's screens show **live** data over real RPCs (no mocks).

## 7. Guardrails preserved
- **Merge policy:** `mergeSessionPR`/`resolveSession` stay HUMAN-confirmed, desktop-only,
  surfaced via `pr-confirm-request`; the agent path never sets `confirmed:true`. Agents never
  merge/push to master. (CLAUDE.md.)
- Provider keys/tokens stay encrypted on-device (Keychain); relay never sees Mac-local data
  (WhatsApp, files, keys).

## 8. Phased delivery
- **P0 — Foundation/proof:** sidecar extraction + electron-shim + WS host + SEA build; SwiftUI
  shell + MaestroClient + DesignSystem tokens + genre top-nav; ONE live screen (Codespace
  projects via `listProjects`) end-to-end. Buildable `.app`.
- **P1 — Codespace:** gallery + inline creation + project detail (sessions/chat/transcript/
  composer) + project settings.
- **P2 — Design** workspace (preview + comments + hand-off).
- **P3 — Comms + WhatsApp.**
- **P4 — Settings** (6 sections).
- **P5 — Packaging/hardening:** SEA size pass, lazy-start, notarize, RAM/size verification vs §1.

Each phase: its own plan doc under `docs/superpowers/plans/`, built behind the P0 foundation,
verified by a real build + live data before moving on.
