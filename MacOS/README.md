# Maestro — native macOS app

A native **SwiftUI** rebuild of the Maestro desktop app, scoped to five surfaces (Codespace,
Design, Comms, WhatsApp, Settings). It replaces the Electron/Chromium UI with native SwiftUI
while **reusing the existing Node "brain"** (the `apps/desktop/electron/` logic) as a headless
sidecar over a loopback WebSocket. See `docs/superpowers/specs/2026-06-27-macos-native-migration-design.md`.

## Layout

```
MacOS/
├── app/                  # the SwiftUI app (SwiftPM executable)
│   ├── Package.swift
│   ├── Sources/Maestro/
│   │   ├── DesignSystem/  # Tokens, Theme, Icon, Brand — ported 1:1 from packages/design-tokens
│   │   ├── Core/          # MaestroClient (WS RPC + events), SidecarSupervisor, Models
│   │   ├── App/           # entry, window, genre top-nav, routing, wallpaper
│   │   └── Features/      # one folder per screen (Codespace … ; Design/Comms/WhatsApp/Settings WIP)
│   └── package-app.sh     # assembles Maestro.app (Info.plist + binary + codesign)
└── sidecar/              # the headless Node brain
    └── src/
        ├── electron-shim.ts   # headless replacement for the `electron` module
        ├── hooks.mjs          # ESM resolve hook: alias electron → shim, rewrite .js→.ts
        ├── register.mjs       # registers the hook (node --import)
        ├── ws-host.ts         # zero-dependency RFC6455 WebSocket server (the transport)
        ├── headless-main.ts   # constructs the real Store + serves the dispatch
        └── smoke-test.mjs     # standalone end-to-end check
```

## Architecture

The renderer↔brain boundary was already a single clean RPC surface
(`window.maestro.call(method, params)` + a `maestro:event` push stream). The native app speaks
the **same** contract over a token-gated loopback WebSocket:

```
→  {"t":"call","id":N,"method":"…","params":{…}}
←  {"t":"res","id":N,"ok":true,"data":…}  /  {"ok":false,"error":"…","status":N}
←  {"t":"event","name":"…","data":…}
```

`SidecarSupervisor` (Swift) spawns the sidecar, reads its stdout handshake
(`{"ready":true,"port":N,"token":"…"}`), hands the endpoint to `MaestroClient`, and restarts on
crash. In **dev** the sidecar runs the brain's TypeScript directly via Node ≥23 type-stripping
(no build step). In **production** it's a Node SEA single binary embedded in `Maestro.app/Contents/Resources`.

## Build & run

```sh
# Compile the app
cd MacOS/app && swift build

# Headless end-to-end self-test (boots sidecar, connects, calls listProjects, exits)
swift run Maestro --selftest

# Run the sidecar on its own (prints handshake, serves WS)
cd MacOS/sidecar && npm run dev        # or: node --import ./src/register.mjs ./src/headless-main.ts

# Sidecar standalone smoke test (spawn + connect + health + listProjects)
node MacOS/sidecar/src/smoke-test.mjs

# Assemble a distributable Maestro.app
cd MacOS/app && ./package-app.sh release   # → MacOS/app/dist/Maestro.app
```

## Status — all five surfaces + packaging complete (2026-06-27)

- **P0** foundation/proof · **P1** Codespace (gallery · inline create · chat thread · project
  settings) · **P2** Design (rail · chat · live WKWebView preview · comment harness · hand-off) ·
  **P3** Comms + WhatsApp (gateway + two-pane messenger) · **P4** Settings (6 sections) ·
  **P5** packaging (esbuild → single 11 MB brain bundle, self-contained `.app`).
- Every screen runs on the real headless brain and is verified against the operator's live data
  (`swift build` clean + `Maestro --selftest`): 13 projects, 28 sessions, 24 skills, 236 WhatsApp
  chats, 4 providers, both engines ready.

### Measured footprint (P5)

| | Package | Idle RAM |
|---|---|---|
| Electron (before) | ~200 MB | ~550 MB (Chromium ~300 + brain ~250) |
| **Native (this)** | **~120 MB** (29 MB `.app` + ~90 MB Node) | **~320 MB** (SwiftUI ~20 + brain ~300) |

The dominant win is replacing Chromium's ~300 MB renderer with a ~20 MB native SwiftUI process.
`./package-app.sh release` builds the self-contained app (the Node binary must be a real runtime —
Homebrew's is a wrapper; ship official Node or fetch on first run like the engines). Notarization
needs a Developer ID (ad-hoc signed otherwise).

### Backlog (non-blocking polish)
Chat: composer model/effort/Plan/Goal toggles, queue/scheduled/bg panels, AskUserQuestion card,
inline image bytes, minimap. WhatsApp: media send/full-download, reaction picker, load-earlier.
Design: splitter resize, snapshot, fullscreen. Settings: live engine-download %, GitHub device-code.

## Guardrails

The merge policy is preserved end-to-end: `mergeSessionPR`/`resolveSession` stay
HUMAN-confirmed and desktop-only; the agent path never sets `confirmed:true`. Provider secrets
stay encrypted on-device; the relay never sees Mac-local data.
