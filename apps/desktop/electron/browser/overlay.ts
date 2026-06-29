/* The injected "Send hint" overlay + its Playwright binding names.

   The overlay UI lives in the sibling `send-hint-overlay.js` (plain JS, so it
   needs no template-literal escaping) and is read at module load. It talks to
   the app through two bindings the BrowserManager exposes per project:
     window.__mochiSnapshot()    → { paired, projects:[{ id, name, sessions:[…] }] }
     window.__mochiSend(payload) → { ok, sessionId } | { ok:false, error }
   Only the sidecar constructs a BrowserManager, and it runs from TS source via
   the register loader, so reading the sibling file resolves cleanly. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SNAPSHOT_BINDING = '__mochiSnapshot';
export const SEND_BINDING = '__mochiSend';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OVERLAY_JS = readFileSync(path.join(here, 'send-hint-overlay.js'), 'utf8');
