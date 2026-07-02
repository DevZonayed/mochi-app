# Maestro WebKit App

This is the native macOS WebKit host for the existing Maestro React renderer.
It does not bundle Electron or Chromium.

- `WKWebView` renders the Vite-built React UI from `Contents/Resources/web`.
- The existing headless sidecar is embedded under `Contents/Resources/sidecar`.
- A document-start JavaScript bridge exposes `window.maestro` with the same call
  shape as Electron preload, backed by the sidecar WebSocket.
- Native macOS pickers are handled through `WKScriptMessageHandler`.

Build:

```sh
cd MacOS/webview-app
./package-app.sh debug
open "dist/Maestro WebKit.app"
```
