/* Bundled `browser` SKILL.md — auto-installed into every project's
   `.claude/skills/browser/SKILL.md` the first time browser mode is enabled.

   Why bundled (not pulled from the registry):
   - The full tool set is owned by THIS desktop build (engine.ts) — the canonical
     docs ship with the binary, not a remote relay. No version drift.
   - The skill must be present BEFORE the first browser_* tool fires so the agent
     reads it through `settingSources:['project']` on the same turn.
   - One file. No fetch, no failure path, no relay round-trip.

   `ensureBrowserSkill(projectRoot)` is idempotent: it writes the SKILL.md only
   when missing (so the operator can edit their copy and we won't clobber it),
   and creates the disabled marker so the registry UI shows it as "enabled" by
   default. Returns the slug ('browser'). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const BROWSER_SKILL_SLUG = 'browser';
export const BROWSER_SKILL_ID = 'mochi/browser';

/* The skill body. Documents EVERY agent-facing browser_* MCP tool that
   apps/desktop/electron/engine.ts registers, plus the recipes a real session
   needs: heavy-DOM rescue, connection-loss recovery, image extraction, file
   download, network/console debugging. Keep this in lock-step with the tool
   block in engine.ts — when you add a tool there, add a one-liner here. */
export const BROWSER_SKILL_MD = `---
name: browser
description: "Use this skill whenever the user asks you to drive their REAL Chrome browser (via the Mochi extension) — open a site, log in, click, type, screenshot, extract data, watch the network, download a file, run JS in a page. Do NOT use WebFetch/WebSearch for these — use the browser_* tools listed below."
allowed-tools: [mcp__maestro__browser_status, mcp__maestro__browser_navigate, mcp__maestro__browser_snapshot, mcp__maestro__browser_read, mcp__maestro__browser_links, mcp__maestro__browser_click, mcp__maestro__browser_type, mcp__maestro__browser_screenshot, mcp__maestro__browser_evaluate, mcp__maestro__browser_scroll, mcp__maestro__browser_press_key, mcp__maestro__browser_click_at, mcp__maestro__browser_hover, mcp__maestro__browser_drag, mcp__maestro__browser_wait, mcp__maestro__browser_wait_for_selector, mcp__maestro__browser_find_by_role_name, mcp__maestro__browser_match_count, mcp__maestro__browser_resolve_box, mcp__maestro__browser_assert, mcp__maestro__browser_open_tab, mcp__maestro__browser_list_tabs, mcp__maestro__browser_close_tab, mcp__maestro__browser_tab_url, mcp__maestro__browser_go_back, mcp__maestro__browser_go_forward, mcp__maestro__browser_console_messages, mcp__maestro__browser_network_requests, mcp__maestro__browser_upload_file, mcp__maestro__browser_download_url, mcp__maestro__browser_grab_image, mcp__maestro__browser_save_image, mcp__maestro__browser_storage_get, mcp__maestro__browser_storage_set, mcp__maestro__browser_storage_clear, mcp__maestro__browser_cookies_get, mcp__maestro__browser_cookies_set, mcp__maestro__browser_cookies_clear, mcp__maestro__browser_cdp, mcp__maestro__browser_pdf, mcp__maestro__browser_window_resize, mcp__maestro__browser_emulate_viewport, mcp__maestro__browser_clear_emulation, mcp__maestro__browser_session_start, mcp__maestro__browser_session_end, mcp__maestro__browser_watch, mcp__maestro__browser_watch_list, mcp__maestro__browser_watch_cancel]
---

# Browser

You can drive the user's REAL Chrome (their logged-in profiles, cookies, sessions) through the Mochi extension. Everything you do happens in a visible browser window with a live cursor; the user can watch.

## The first call, always

\`\`\`
mcp__maestro__browser_status
\`\`\`

This tells you: is a browser connected? which profile? what tab is open? If no profile is connected, ask the user to open the Mochi Chrome extension and pair it (the app shows the token under Settings → Browser extension). Do NOT silently fall back to WebFetch.

## The 48+ tools, grouped

### Navigate
- \`browser_navigate({url})\` — open URL in active session (creates one on demand).
- \`browser_open_tab({url, makePrimary?})\` — additional tab in the same session.
- \`browser_close_tab({tabId})\` — close a non-primary tab.
- \`browser_list_tabs()\` — list every tab in the session.
- \`browser_tab_url({tabId?})\` — current URL + title.
- \`browser_go_back()\` / \`browser_go_forward()\`.

### Read
- \`browser_read({query?, limit?})\` — extract VISIBLE TEXT. Cheap. **Try this first.**
- \`browser_links({query?})\` — list links (text + href). For navigation choices.
- \`browser_snapshot()\` — accessibility tree (roles, names, CSS refs). Capped at 24KB. Heavier than \`browser_read\` — use it when you need refs for clicking, not for bulk reading.
- \`browser_find_by_role_name({role, name, exact?})\` — find ONE element by accessibility role + name (button "Submit", textbox "Search"). Works on heavy SPA DOM where CSS selectors fail. **The selector rescue.**
- \`browser_match_count({ref})\` — how many elements match a CSS selector (with 5 samples). Diagnostic — call when a click "failed" to learn whether the selector hit 0, 1, or N.
- \`browser_resolve_box({ref})\` — bounding box (x, y, w, h, visible). Use before \`browser_click_at\` for canvas/overlay clicks.
- \`browser_assert({kind, target?, value?})\` — built-in page assertion (\`title-contains\`, \`url-contains\`, \`selector-visible\`, \`selector-count\`, \`text-present\`). Fail loudly instead of scraping text and second-guessing.
- \`browser_screenshot({fullPage?, elementRef?, format?})\` — PNG/JPEG dataUrl. Element-scoped via elementRef; full-page via fullPage:true.
- \`browser_console_messages({level?, since?, limit?, clear?})\` — captured console output (log/info/warn/error). Auto-attached.
- \`browser_network_requests({urlContains?, method?, statusGte?, statusLt?, failedOnly?})\` — captured HTTP traffic with timings + status. Filter before reading.

### Interact
- \`browser_click({ref})\` — click by CSS selector.
- \`browser_click_at({x, y, button?, clickCount?})\` — click by coordinates (after resolveBox, for overlays without a stable selector).
- \`browser_type({ref, text, submit?, clear?})\` — type into input/textarea; \`submit:true\` presses Enter; \`clear:true\` (default) replaces.
- \`browser_press_key({key})\` — Enter, Tab, Escape, ArrowDown, etc.
- \`browser_scroll({deltaX?, deltaY?, x?, y?})\` — scrollBy(dx,dy) by default; absolute scrollTo if x/y given.
- \`browser_hover({ref})\` — move the cursor over an element. The right way to open a hover-menu / tooltip — synthetic events from \`browser_evaluate\` fail for many UIs.
- \`browser_drag({fromRef, toRef, steps?})\` — drag a Trello card, Figma object, slider handle, file-drop zone. Real CDP mouse sequence so HTML5 drag listeners fire.
- \`browser_upload_file({filePaths, target, strategies?})\` — drive a file input. \`target\` is the input's CSS selector; \`strategies\` defaults to ["direct"].

### Wait
- \`browser_wait({ms})\` — sleep ms (0..60000). Use sparingly — prefer browser_wait_for_selector.
- \`browser_wait_for_selector({ref, timeoutMs?, visible?})\` — poll until the element exists (and is visible). Returns when ready or throws.

### Power tools (use these — the user's real workflows need them)
- \`browser_evaluate({expression, awaitPromise?, timeoutMs?})\` — run arbitrary JavaScript in the page (CDP Runtime.evaluate). The serializable result comes back as \`{ok, value}\`. **Unlocks anything the page CAN do but no other tool exposes.**
- \`browser_grab_image({ref?, minSize?})\` — pick an \`<img>\` on the page, draw it onto a canvas, return its bytes as base64. Use to "save the image Gemini/ChatGPT/Midjourney generated" without a download button.
- \`browser_save_image({dataUrl, filename})\` — write a data: URL (or raw base64) to disk under the project. Pair with \`browser_grab_image\` to one-shot extract → save without Bash + \`base64 -D\`.
- \`browser_download_url({url, filename?, conflictAction?})\` — Chrome download. Saves to the user's Downloads folder; if you give \`saveToProjectAssets:true\`, it lands inside the project's assets/ folder.
- \`browser_pdf({filename?, landscape?, paperWidth?, paperHeight?, scale?, printBackground?})\` — render the current page as a PDF (Page.printToPDF) and download it.
- \`browser_cdp({method, params?})\` — **THE MASTER KEY.** Run any Chrome DevTools Protocol method on the active tab. Use when nothing else exposes what you need: Emulation.setGeolocationOverride, Network.setRequestInterception, Emulation.setCPUThrottlingRate, Accessibility.getFullAXTree, Storage.clearDataForOrigin, Network.setBlockedURLs, etc. Method names use "Domain.method" form — see https://chromedevtools.github.io/devtools-protocol/

### Cookies + storage
- \`browser_cookies_get({url?, name?, domain?})\` — read cookies. Use to check "is the user still logged in?", read a session id, debug auth.
- \`browser_cookies_set({url, name, value, secure?, httpOnly?, sameSite?, expirationDate?})\` — write a cookie. Use to script logged-in fixtures, drop a session cookie, override a flag.
- \`browser_cookies_clear({url?, name?, domain?})\` — remove cookies. Without \`name\`: clears every cookie matching the URL/domain. Use to fully sign a user out before a test.
- \`browser_storage_get({area, key?})\` — read \`localStorage\` (\`area:"local"\`) or \`sessionStorage\` (\`area:"session"\`). With \`key\` returns one value, without returns ALL keys.
- \`browser_storage_set({area, key, value})\` — write a value. Pass \`value:null\` to remove the key. Use to script test fixtures, override a feature flag, restore a saved state.
- \`browser_storage_clear({area})\` — empty the entire storage area for the active tab's origin (symmetric with \`browser_cookies_clear\` — use to fully reset SPA state before re-testing).

### Layout
- \`browser_window_resize({width?, height?, left?, top?, state?})\` — move/resize the Chrome window.
- \`browser_emulate_viewport({preset?, width?, height?, mobile?, userAgent?, deviceScaleFactor?})\` — device emulation. Presets: \`iphone-15-pro\`, \`iphone-se\`, \`pixel-7\`, \`ipad\`, \`desktop-hd\`, \`desktop-fhd\`, \`desktop-2k\`.
- \`browser_clear_emulation()\` — back to a normal desktop viewport.

### Lifecycle
- \`browser_session_start({title?, color?, url?, newWindow?})\` — explicit start (almost never needed — \`browser_navigate\` opens one automatically).
- \`browser_session_end({closeTabs?})\` — close the session group; \`closeTabs:true\` to also close the tabs.

### Watch (observe + post-on-trigger) — **the killer feature**
The agent's CURRENT turn doesn't have to stay alive to wait. Place a watch on the page; the desktop polls it; when the condition fires it posts a NEW message into THIS chat that starts a fresh agent turn (with the full session memory + tools).
- \`browser_watch({title, condition, message?, intervalMs?, maxDurationMs?, repeat?})\` — \`condition\` is a JS expression evaluated in the page (same engine as \`browser_evaluate\`); must return a truthy/falsy value. Returns a watch id. Use to "wait for X to happen and then act" — generation finishing, price hitting target, captcha solved, upload done, status flipping. Survives turn end + desktop restarts. One-shot by default (auto-cancels after first fire); \`repeat:true\` re-fires on every false→true transition.
- \`browser_watch_list()\` — list watches bound to THIS chat with their state (active, fireCount, lastResult: true/false/error/no-browser, lastError, expiresAt). The diagnostic call when a watch seems stuck.
- \`browser_watch_cancel({id})\` — stop watching. Idempotent.

## The reading ladder (cheap → expensive)

Always climb in this order. Each step shows more, costs more context:

1. \`browser_status\` — is there even a tab?
2. \`browser_read\` — visible text. Read like a human.
3. \`browser_links\` — navigation choices.
4. \`browser_find_by_role_name\` — locate a SPECIFIC button/input you intend to drive.
5. \`browser_snapshot\` — only when you need refs for many elements.
6. \`browser_evaluate\` — only when nothing else exposes what you need.

**Never start with \`browser_snapshot\` on a heavy page (Gmail, Gemini, Figma, Linear).** It will hit the 24KB cap and you'll still be blind. Read first, then drill in by role+name.

## Heavy-DOM rescue

If \`browser_snapshot\` returns garbage or times out:
1. \`browser_read({query: "Send"})\` — find what you need by visible text.
2. \`browser_find_by_role_name({role: "button", name: "Send"})\` — get a stable selector back.
3. If still nothing: \`browser_evaluate({expression: "Array.from(document.querySelectorAll('button')).filter(b => /send/i.test(b.textContent)).map(b => ({txt:b.textContent.trim(), id:b.id, cls:b.className}))"})\` — list candidates yourself.
4. \`browser_match_count({ref: "..."})\` — confirm your selector hits exactly 1.

## Connection-loss recovery

Browser tools auto-retry once when the active profile drops briefly (the extension reconnects with exponential backoff up to 15s). If you get \`"browser profile disconnected"\` or \`"No browser connected"\` AFTER the retry:
1. Call \`browser_status\` — confirm.
2. Tell the user one line: *"The Mochi extension dropped — open it (Chrome toolbar) and click Reconnect, or activate a profile."* Then stop. Do not loop.

## Recipes

### "Save the image the website just generated"
\`\`\`
browser_grab_image({ref: "img[alt*='generated' i]"})
   → { dataUrl: "data:image/png;base64,..." }
browser_save_image({dataUrl: "<the dataUrl above>", filename: "assets/generated/01-login.png"})
\`\`\`
One round-trip, no Bash, no \`base64 -D\`. The path is project-relative by default.

### "Download the file that's behind a button"
\`\`\`
browser_evaluate({expression: "document.querySelector('a.download').href"})
   → { value: "https://..." }
browser_download_url({url: "...", filename: "report-2026-q1.pdf"})
\`\`\`

### "What's broken on this page?"
\`\`\`
browser_console_messages({level: "error"})
browser_network_requests({failedOnly: true})
\`\`\`

### "Drive a SPA chat (Gemini/ChatGPT) — paste a prompt + submit"
\`\`\`
browser_find_by_role_name({role: "textbox", name: ""})         // discover the editor's ref
browser_type({ref: "<the ref>", text: "<long prompt>", submit: false})
browser_press_key({key: "Enter"})
browser_wait_for_selector({ref: "img[alt*='generated' i]", timeoutMs: 90000})
browser_grab_image({ref: "img[alt*='generated' i]"})
\`\`\`

### "Test the site on iPhone"
\`\`\`
browser_emulate_viewport({preset: "iphone-15-pro"})
browser_navigate({url: "https://..."})
browser_screenshot({fullPage: true})
browser_clear_emulation()
\`\`\`

### "Open the hover menu so I can click 'Edit'"
\`\`\`
browser_hover({ref: "[data-testid='row-3']"})
browser_wait_for_selector({ref: "[data-testid='row-3-actions']", timeoutMs: 2000})
browser_click({ref: "[data-testid='row-3-actions'] [data-action='edit']"})
\`\`\`

### "Drag this Trello card into another column"
\`\`\`
browser_drag({fromRef: "[data-card='task-42']", toRef: "[data-column='done']", steps: 18})
\`\`\`

### "Save this page as a PDF"
\`\`\`
browser_pdf({filename: "invoice-2026-04.pdf", printBackground: true})
\`\`\`

### "Am I still logged in?"
\`\`\`
browser_cookies_get({url: "https://app.example.com", name: "session"})
\`\`\`

### "Pretend the user is in Tokyo" (test geo-gated UI)
\`\`\`
browser_cdp({method: "Emulation.setGeolocationOverride", params: {latitude: 35.6762, longitude: 139.6503, accuracy: 50}})
browser_navigate({url: "https://..."})
// when done:
browser_cdp({method: "Emulation.clearGeolocationOverride"})
\`\`\`

### "Simulate slow 3G to test loading skeletons"
\`\`\`
browser_cdp({method: "Network.emulateNetworkConditions", params: {offline: false, latency: 400, downloadThroughput: 50000, uploadThroughput: 20000}})
// when done:
browser_cdp({method: "Network.emulateNetworkConditions", params: {offline: false, latency: 0, downloadThroughput: 0, uploadThroughput: 0}})
\`\`\`

### "Block all third-party trackers and re-test"
\`\`\`
browser_cdp({method: "Network.setBlockedURLs", params: {urls: ["*googletagmanager*", "*google-analytics*", "*hotjar*"]}})
browser_navigate({url: "https://..."})
\`\`\`

### "Wait for the Gemini/ChatGPT/Midjourney image to finish, then save it"
This is the canonical use-case the transcript needed. End your turn — don't sit polling. The watcher fires a new turn the moment the image lands.
\`\`\`
browser_navigate({url: "https://gemini.google.com/app"})
browser_find_by_role_name({role: "textbox", name: ""})       // discover the editor ref
browser_type({ref: "<the ref>", text: "<prompt>"})
browser_press_key({key: "Enter"})
browser_watch({
  title: "Wait for Gemini image",
  condition: "document.querySelectorAll('img[alt*=generated i], img[src*=blob:]').length > 0",
  message: "The image is ready — save it with browser_grab_image + browser_save_image.",
  intervalMs: 2000,
  maxDurationMs: 300000     // 5 min cap
})
// Your current turn ends. When the image appears, a new turn starts in this
// same chat — you (the next-turn agent) read this message + the watch context
// and immediately call browser_grab_image → browser_save_image.
\`\`\`

### "Watch a price and ping me when it hits a target"
\`\`\`
browser_navigate({url: "https://coinmarketcap.com/currencies/solana/"})
browser_watch({
  title: "SOL ≤ $145",
  condition: "Number(document.querySelector('[data-test=text-cdp-price-display]').textContent.replace(/[^0-9.]/g,'')) <= 145",
  message: "SOL crossed your threshold — decide whether to buy.",
  intervalMs: 30000,         // every 30s — don't hammer the site
  maxDurationMs: 86400000    // up to 24h
})
\`\`\`

### "Watch for the captcha to be solved by the user"
\`\`\`
browser_watch({
  title: "Captcha cleared",
  condition: "!document.querySelector('.g-recaptcha, iframe[src*=recaptcha]')",
  message: "Captcha is gone — continue the original flow.",
  intervalMs: 1500
})
\`\`\`

### "Watch a long-running CI build for status changes (repeat mode)"
\`\`\`
browser_watch({
  title: "CI status",
  condition: "['success','failure','cancelled'].includes(document.querySelector('[data-status]').dataset.status)",
  message: "CI finished — read the result and decide next steps.",
  intervalMs: 15000,
  repeat: true,              // re-fire on every false→true transition
  maxDurationMs: 7200000     // 2h
})
\`\`\`

## Watch debugging

If a watch isn't firing, call \`browser_watch_list\` and check \`lastResult\`:
- \`true\` + \`fireCount > 0\` → it fired (look for the chat turn).
- \`false\` → condition is being evaluated and returning false. Check the condition.
- \`error\` + \`lastError\` → your expression throws. After 5 identical errors in a row the watch auto-cancels as \`invalid-condition\` and posts a notice into the chat.
- \`no-browser\` → no Chrome profile is currently active. The watch DOES NOT expire on this — it picks back up when a profile reconnects.

## Things to NEVER do

- Don't fall back to WebFetch/WebSearch when the user said "use my browser".
- Don't open a new \`browser_session_start\` if one already exists (\`browser_navigate\` reuses it).
- Don't paste base64 image data into your reply — pass the dataUrl through and let the user save it.
- Don't loop \`browser_snapshot\` waiting for content — use \`browser_wait_for_selector\`.
- Don't sit polling inside the same turn for something that might take minutes (image generation, CI build, price target) — \`browser_watch\` instead and END YOUR TURN. The next turn fires automatically when the condition is met.
- Don't read sensitive form values (passwords, OTP) into the transcript — drive them, don't echo them.
`;

/** Write the bundled browser SKILL.md into the project IF it's not already there
    (or if it's a stale copy of a prior bundled version we shipped). Returns
    `installed` when we wrote new content, `kept` when we left an operator's
    customised copy alone, `unchanged` when the existing file already matches. */
export function ensureBrowserSkill(projectRoot: string): { slug: string; status: 'installed' | 'kept' | 'unchanged' } {
  const dir = join(projectRoot, '.claude', 'skills', BROWSER_SKILL_SLUG);
  const file = join(dir, 'SKILL.md');
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8');
      if (existing === BROWSER_SKILL_MD) return { slug: BROWSER_SKILL_SLUG, status: 'unchanged' };
      // Detect a prior bundled copy by its frontmatter `name: browser` line + the
      // distinctive "N+ tools" header (number-agnostic — we've gone 30 → 40 once
      // already and will go higher). If both are present, treat it as ours and
      // upgrade in place. Otherwise the operator has edited the file — leave it.
      const ours = /^name:\s*browser\s*$/m.test(existing) && /## The \d+\+ tools/m.test(existing);
      if (!ours) return { slug: BROWSER_SKILL_SLUG, status: 'kept' };
    }
    writeFileSync(file, BROWSER_SKILL_MD, 'utf8');
    return { slug: BROWSER_SKILL_SLUG, status: 'installed' };
  } catch {
    // Best-effort. Don't fail the run because we couldn't drop a doc file.
    return { slug: BROWSER_SKILL_SLUG, status: 'kept' };
  }
}

/** Stable hash of the bundled SKILL.md — for the registry-summary UI. */
export function browserSkillSha256(): string {
  return createHash('sha256').update(BROWSER_SKILL_MD).digest('hex');
}
