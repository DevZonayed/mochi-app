# Maestro — native macOS app (WebKit)

The **maintained** Maestro macOS app. A thin native **WKWebView** shell
(`webview-app/`) hosts the existing React UI (`renderer/`), backed by the
existing Node **brain** (`brain/`) run headlessly as a loopback-WebSocket
**sidecar** (`sidecar/`). Everything the app needs lives in this one folder.

> The old Electron app and the earlier pure-SwiftUI app are **deprecated and
> removed**. Only the WebKit app in this folder is maintained.

## Layout

```
MacOS/
├── package.json          # @maestro/macos — deps for the brain + renderer (pnpm workspace pkg)
├── tsconfig.json         # typechecks brain/ + renderer/
├── vite.web.config.ts    # builds the renderer for the WKWebView (base: './')
├── index.html            # renderer entry → /renderer/main.tsx
├── vitest.*.{ts,mjs}     # brain (node) + renderer (node/happy-dom) test suites
├── brain/                # the Node "brain" (Store, engine, providers, whatsapp, git, cron, …)
├── renderer/             # the React renderer (screens, components, hooks, lib)
├── extension/            # the unpacked Chrome extension (ExtensionBridge control channel)
├── webview-app/          # the native Swift WKWebView shell (SwiftPM executable) + package-app.sh
│   └── Sources/
└── sidecar/              # runs the brain outside Electron, served over loopback WS
    ├── build.mjs             # esbuild bundle → dist/maestro-sidecar.mjs (prod)
    ├── embed-externals.mjs   # copies native deps beside the bundle
    └── src/
        ├── electron-shim.ts  # headless replacement for the `electron` module
        ├── hooks.mjs         # ESM resolve/load hooks: alias electron→shim, rewrite .js→.ts, transpile TS
        ├── register.mjs      # registers the hooks (node --import) — the dev path
        ├── ws-host.ts        # zero-dependency RFC6455 WebSocket server (the transport)
        ├── design-serve.ts   # loopback HTTP server for design-project live preview
        ├── headless-main.ts  # constructs the real brain + serves the dispatch
        └── smoke-test.mjs     # standalone end-to-end check (add --bundle to test the prod bundle)
```

Runtime identity is `@maestro/desktop` (data dir
`~/Library/Application Support/@maestro/desktop`) — kept for back-compat with
existing installs; it is intentionally independent of the npm package name.

## Architecture

The renderer↔brain boundary is a single clean RPC surface
(`window.maestro.call(method, params)` + a `maestro:event` push stream). The
WKWebView shell speaks the **same** contract over a token-gated loopback
WebSocket:

```
→  {"t":"call","id":N,"method":"…","params":{…}}
←  {"t":"res","id":N,"ok":true,"data":…}  /  {"ok":false,"error":"…","status":N}
←  {"t":"event","name":"…","data":…}
```

The Swift shell spawns the sidecar, reads its stdout handshake
(`{"ready":true,"port":N,"token":"…"}`), points the WKWebView at the built
renderer, and restarts the sidecar on crash. In **dev** the sidecar runs the
brain's TypeScript directly via Node loader hooks (no build step). In
**production** it's a single esbuild bundle (`maestro-sidecar.mjs`) with an
embedded Node runtime and externalized native deps, all inside
`Maestro WebKit.app/Contents/Resources`.

## Build & run

```sh
# from the repo root — install workspace deps first
pnpm install

# Sidecar (dev, loader-hook path): prints handshake, serves WS
cd MacOS/sidecar && npm run dev

# Sidecar standalone smoke test (spawn + connect + health + listProjects)
node MacOS/sidecar/src/smoke-test.mjs           # dev path
node MacOS/sidecar/src/smoke-test.mjs --bundle  # prod bundle path

# Build the renderer on its own
cd MacOS && pnpm run build      # tsc --noEmit && vite build --config vite.web.config.ts

# Assemble the distributable app (renderer + swift shell + sidecar bundle + node)
MacOS/webview-app/package-app.sh release        # → MacOS/webview-app/dist/Maestro WebKit.app
```

CI: `.github/workflows/native-macos-build.yml` runs `package-app.sh release`,
the bundled smoke test, and packages a DMG.

## Guardrails

The merge policy is preserved end-to-end: `mergeSessionPR`/`resolveSession`
stay HUMAN-confirmed and app-only; the agent path never sets `confirmed:true`.
Provider secrets stay encrypted on-device; the relay never sees Mac-local data.
