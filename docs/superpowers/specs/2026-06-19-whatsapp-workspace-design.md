# WhatsApp Workspace — Design Spec

**Date:** 2026-06-19
**Branch:** DevZonayed/lyon
**Status:** Approved (design), implementing.

## Problem

WhatsApp is linked in the desktop Comms page ("Live · Linked as Jonayed's PA · 0 tracked chats") but the product is a dead end:

1. **No chat list.** `apps/desktop/electron/whatsapp.ts` only listens to `messages.upsert`; it ignores WhatsApp's on-connect history/chat-list sync. A chat is only ever seen after it messages you (as a "pending" chat).
2. **No message view.** Messages are captured *only for bound chats*, into a hidden rolling 300-msg buffer in `maestro-store.json::waChats`, and shown *only to the summarizer AI*. No UI ever renders a message.
3. **Agent can't see/use WhatsApp.** The in-app agent (`engine.ts → runClaude`) is given only the `maestro` in-process MCP (browser/schedule/skills) + user custom MCP servers. The WhatsApp socket is never exposed, so the agent reports "no WhatsApp integration available."
4. **No per-project assignment.** Project settings (`ProjectPanel.tsx`) expose only Name / Type / Folder / Repository. Chat→project binding lives only in the global Comms page and only for chats that already messaged you.
5. **Two split WhatsApp connections.** The desktop's own Baileys socket (the linked one) and a *separate* plugin `comms` MCP (`.continuum/comms/`, own QR) share nothing. Source of confusion.

## Architecture decision

The **desktop Baileys socket (`whatsapp.ts`) is the single source of truth** (consistent with the "the Mac is the brain" invariant). We surface it fully in a real UI, expose it to the in-app agent via the existing `maestro` in-process MCP pattern, and assign chats to projects from project settings. The plugin `comms` MCP is **not used** for the desktop experience (no second QR, no split brain).

## Data model

WhatsApp message history for *all* chats must not bloat the monolithic `maestro-store.json` (loaded/saved wholesale). Introduce a dedicated **`WaStore`** (`apps/desktop/electron/wa-store.ts`):

- **Chat metadata** → `userData/whatsapp/<account>/chats.json` — array of `WaChatMeta`:
  ```ts
  interface WaChatMeta {
    chatId: string;            // JID
    name: string;
    kind: 'dm' | 'group' | 'channel';
    avatarUrl?: string | null; // cached profile picture URL
    lastMessageAt: number;     // ms
    lastMessageText: string;   // preview
    lastMessageFromMe: boolean;
    unreadCount: number;
    pinned?: boolean;
    muted?: boolean;
    isContact?: boolean;       // in address book vs unknown
  }
  ```
- **Messages** → per-chat append-only JSONL at `userData/whatsapp/<account>/messages/<safeChatId>.jsonl`. Reader tails the last N. Each line is a `WaMessage`:
  ```ts
  interface WaMessage {
    id: string; chatId: string; fromMe: boolean; senderId?: string;
    senderName: string; text: string; kind: WaMsgKind; ts: number;
    quotedText?: string; reactions?: { emoji: string; fromMe: boolean }[];
    media?: { kind: string; mimetype?: string; fileName?: string; thumbBase64?: string; localPath?: string };
    status?: 'sent' | 'delivered' | 'read';
  }
  ```
- Per-chat message cap (default 1000, configurable) — JSONL compacted on write when exceeded.

`WaStore` methods: `upsertChat`, `listChats`, `getChat`, `appendMessage`, `getMessages(chatId,{limit,before})`, `markRead`, `setUnread`, `forgetChat`, plus the watermark API the summarizer needs (`getTranscriptSinceReported`, `markReported`) so the existing quiet-timer keeps working.

The existing `store.waChats` / `recordWaMessage` / `getWaTranscript` / `listWaChats` / `markWaReported` / `forgetWaChat` are **re-pointed to delegate to `WaStore`** (back-compat shim) so the analyzer and Bindings tab keep functioning during/after migration.

## Components & changes (file-by-file)

### Phase 1 — See everything
- **`electron/wa-store.ts`** (new): the store above.
- **`electron/whatsapp.ts`**: subscribe to `messaging-history.set` (chats+contacts+messages), `chats.upsert/update/delete`, `contacts.upsert`, `messages.upsert` (now for *all* chats), `messages.update` (edits/reactions/status), `message-receipt.update`. Normalize → `WaStore`. Lazy `profilePictureUrl` fetch → `avatarUrl`. Emit `wa-message` / `wa-chats` events.
- **`electron/localApi.ts`**: dispatch cases `waListChats`, `waGetMessages`, `waChatInfo`, `waSearchChats`.
- **`src/lib/api.ts`**: client methods + `WaChatMeta`/`WaMessage` types + `subscribe({ onWaMessage, onWaChats })`.
- **`src/screens/WhatsApp.tsx`** (new): two-pane WhatsApp-Web layout — left searchable chat list, right conversation (bubbles, media, timestamps, date separators). Live via subscribe.
- **Nav**: add a "WhatsApp" entry; the Comms WhatsApp card gets an "Open WhatsApp" button.

### Phase 2 — Control everything
- **`electron/whatsapp.ts`**: `sendText(chatId,text,{quotedId?})`, `sendMedia(chatId,{path|base64,kind,caption?})`, `sendReaction(chatId,msgId,emoji)`, `markRead(chatId)`, `sendPresence(chatId,state)`.
- **`electron/localApi.ts`** + **`api.ts`**: `waSendText`, `waSendMedia`, `waReact`, `waMarkRead`, `waSetPresence`.
- **`WhatsApp.tsx`**: composer (text + attach), reply, react, mark-read on open.

### Phase 3 — Agent integration
- **`electron/engine.ts`**: extend the `maestro` in-process MCP with a `CommsCtx` (mirrors `BrowserCtx` pattern) → tools `wa_list_chats`, `wa_search_chats`, `wa_get_messages`, `wa_send_message`, `wa_send_media`, `wa_react`, `wa_mark_read`. Add to `maestroAllowed`. Wire `commsCtx` through `runClaude` from the call site (backed by the live `WhatsAppClient` + `WaStore`).
- **Safety gate:** `wa_send_message`/`wa_send_media` to **your own number** send immediately; to **anyone else** they are held behind a one-tap approval (reuse the send-gate concept) unless `whatsappState().agentSendApproved` is set. Configurable in settings.
- **Composer affordance:** a `WHATSAPP_DIRECTIVE` (like `BROWSER_DIRECTIVE`) injected so the agent reliably picks up the deferred tools when the user references WhatsApp.

### Phase 4 — Per-project assignment
- **`electron/store.ts`**: `Project.whatsappChatIds?: string[]` (+ `addProjectWaChat`, `removeProjectWaChat`, `listProjectWaChats`). Assigning also upserts a `ChatBinding{provider:'whatsapp', projectId, chatId}` so incoming-message routing + quiet-timer reuse the existing machinery.
- **`electron/localApi.ts`** + **`api.ts`**: `addProjectWaChat`, `removeProjectWaChat`; extend `updateProject` allowed fields.
- **`src/lib/ProjectPanel.tsx`**: new "WhatsApp" tab/section listing assigned chats with add (picker from full chat list) / remove (mirrors the Skills pattern).
- **Agent scoping:** when the agent runs in a project, its `wa_*` tools default to that project's assigned chats (still able to list all, but the directive nudges to assigned ones).

## Data flow

Renderer → `api.call()` → preload bridge → `ipcMain('maestro:call')` → `dispatch()` → `WhatsAppClient` / `WaStore` → `emit()` events → renderer `subscribe()` (+ relay fan-out for phone/web later). Identical to the existing contract.

## Testing

- **Unit (vitest, main process):** `wa-store.ts` (append/cap/tail/read-watermark/forget), message normalization in `whatsapp.ts` (reuse/extend existing `normalizeWaMessage` tests), per-project assignment store methods, agent send-gate decision (self vs other).
- **Type:** `pnpm -C apps/desktop tsc --noEmit`.
- **Manual:** build desktop, open WhatsApp screen, confirm chat list + history render, send a text to self, ask the in-app agent to send a message, assign a chat to a project.

## Risks / honest caveats

- **History completeness:** Baileys on-connect sync returns *recent* history only; full backfill isn't guaranteed. We render what WhatsApp gives plus everything captured live. Flagged in the UI ("history syncs from WhatsApp; older messages may be partial").
- **Ban risk:** unofficial connection — sending is real. Existing warning retained; agent sends to others gated by default.
- **Store size:** per-chat JSONL with caps avoids monolithic-JSON bloat.
- **Mobile/web parity:** desktop-first; relay snapshot of chats/messages is a follow-up.

## Out of scope (v1)

Group create/admin, status/stories, voice/video calls, WhatsApp Channels (newsletter) posting, full mobile/web mirror. Tracked as stretch.
