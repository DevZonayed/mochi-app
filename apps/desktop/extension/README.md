# Mochi Chrome extension

This is the Manifest V3 Chrome extension that pairs with the Mochi desktop app
over the local WebSocket bridge on `127.0.0.1:9234`
(see `apps/desktop/electron/extension-bridge.ts`). It gives the in-app agent
real-browser superpowers — every `browser_*` MCP tool the agent calls is
implemented here.

## What's in here

- `manifest.json` — MV3 manifest. Permissions: `tabs tabGroups scripting storage alarms activeTab debugger downloads cookies`. `<all_urls>` host permission.
- `background.js` — service worker. Owns the WebSocket connection to the app, per-Chrome-profile session state, the command dispatch table (~40 commands), the CDP debugger attachments, and the console/network capture buffers.
- `popup.html` / `popup.js` — the toolbar popup (pair with the app's token, see profile status, take over, send a quick message to a chat).
- `mochi-modal.js` — the keyboard-shortcut send-hint modal (Cmd/Ctrl+Shift+M).
- `overlay.js` — the visible-cursor + HUD overlay injected into automated pages.
- `upload.js` — `browser_upload_file` strategy chain (drives `<input type=file>` reliably).
- `icons/` — toolbar icons (16/32/48/128).

## How it ships

Bundled into the desktop installer as `extension/` via `electron-builder.yml`
extraResources. At runtime, `electron/main.ts` exposes an
`openExtensionFolder` dispatch (Settings → Browser extension → "Reveal
extension folder") that opens this directory in Finder/Explorer so the user
can Load Unpacked it in `chrome://extensions`.

## How to install (developer / power-user)

1. Open the Mochi desktop app once.
2. Settings → Browser extension → "Reveal extension folder" (or: open the app
   bundle's `Resources/extension/`).
3. In Chrome: `chrome://extensions` → enable Developer mode → "Load unpacked"
   → select that folder.
4. Click the Mochi toolbar icon → paste the pairing token shown in Settings.
   The dot turns green.

## How to modify (for contributors)

Edit files in place. Reload the extension from `chrome://extensions` to pick
up changes. Keep the dispatch table in `background.js` in lock-step with the
MCP tools registered in `apps/desktop/electron/engine.ts` (the bundled
`browser-skill.ts` SKILL.md must also list the new tool name).
