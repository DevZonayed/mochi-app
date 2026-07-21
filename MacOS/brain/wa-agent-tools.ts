/**
 * WhatsApp agent tool construction — the SINGLE production source for tool names,
 * handlers, and the allowed-tools list. Consumed by engine.ts runClaude and by tests.
 *
 * This module owns:
 * - WA_TOOL_NAMES: the canonical list of registered tool names (drift-proof)
 * - resolveWaTarget: the recipient cascade shared by send_message and send_media
 * - handleWaSendMedia: the confined-reader → sendMedia pipeline
 * - buildWaTools: returns SDK-ready tool definitions for the maestro MCP
 *
 * These commsCtx tools are mounted by runClaude into the in-process maestro MCP.
 * Codex does not receive this in-process comms surface today.
 */

import { z } from 'zod';
import { readAttachment, AttachmentError } from './attachment-reader.js';
import { waSendAllowed } from './whatsapp.js';
import type { CommsCtx } from './engine.js';

// ────── Canonical tool-name list ──────

/** The exact tool names registered in the maestro MCP for WhatsApp. */
export const WA_TOOL_NAMES = [
  'wa_list_chats',
  'wa_get_messages',
  'wa_send_message',
  'wa_send_media',
  'wa_mark_read',
] as const;

export type WaToolName = (typeof WA_TOOL_NAMES)[number];

// ────── Recipient resolution ──────

export interface WaRecipientArgs {
  chatId?: string;
  phone?: string;
}

/**
 * Resolve a WhatsApp recipient JID from chatId/phone/fallbacks.
 * Returns the target JID or null if unresolvable.
 */
export function resolveWaTarget(args: WaRecipientArgs, commsCtx: CommsCtx): string | null {
  const target = args.chatId
    || (args.phone ? `${args.phone.replace(/[^0-9]/g, '')}@s.whatsapp.net` : '')
    || commsCtx.notifyJid()
    || commsCtx.ownJid()
    || '';
  return target || null;
}

// ────── Tool result helpers (same shape as SDK) ──────

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

function txt(s: string): ToolResult { return { content: [{ type: 'text', text: s }] }; }

// ────── wa_send_media handler ──────

export interface SendMediaArgs {
  chatId?: string;
  phone?: string;
  path: string;
  caption?: string;
}

/**
 * The production handler for wa_send_media. Resolves the recipient, reads the
 * confined attachment, sends via commsCtx, returns a safe result (no path leaks).
 * On success with a genuinely nonblank (trimmed) caption, calls recordContextSend
 * so a quote-reply to that caption routes back to the context session.
 */
export async function handleWaSendMedia(
  args: SendMediaArgs,
  commsCtx: CommsCtx,
  cwd: string,
): Promise<ToolResult> {
  const target = resolveWaTarget(args, commsCtx);
  if (!target) return txt('No recipient: pass a chatId (from wa_list_chats) or a phone number, or have the user set their personal number in Comms.');
  if (!waSendAllowed(target, [commsCtx.ownJid(), commsCtx.notifyJid()], commsCtx.canSendOthers())) {
    return txt('Blocked: messaging contacts other than your own number(s) is OFF by default (a safety gate). The user can turn on "Let the agent message contacts" in Comms. Media NOT sent.');
  }
  // Read + confine the attachment.
  let attachment;
  try {
    attachment = readAttachment({ cwd, path: args.path });
  } catch (err) {
    if (err instanceof AttachmentError) return txt(`Attachment rejected: ${err.message}`);
    throw err;
  }
  // Send via the WhatsApp socket. Bytes stay Mac-local — not logged or relayed.
  const ok = await commsCtx.sendMedia(target, {
    kind: attachment.kind,
    data: attachment.data,
    mimetype: attachment.mimetype,
    fileName: attachment.fileName,
    caption: args.caption,
  });
  const trimmedCaption = args.caption?.trim();
  if (ok && trimmedCaption && commsCtx.recordContextSend) {
    try { commsCtx.recordContextSend(target, trimmedCaption); } catch { /* best-effort bookkeeping */ }
  }
  return txt(ok
    ? `Sent ${attachment.kind} "${attachment.fileName}" (${attachment.byteCount} bytes) to ${target}.`
    : `Could not send to ${target} — is WhatsApp still linked?`);
}

// ────── Tool builder ──────

/** Dependencies injected by runClaude — just the SDK's tool() + wrap().
 *  Types use `any` to decouple from the SDK's internal generics; the call site
 *  in engine.ts enforces compatibility at the actual spread site. */
export interface WaToolDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrap: (fn: any) => any;
  commsCtx: CommsCtx;
  cwd: string;
}

/**
 * Build the WhatsApp MCP tools for the maestro server. Returns the tool list
 * ready to spread into the tools array. Production in engine.ts calls this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildWaTools(deps: WaToolDeps): any[] {
  const { tool, wrap, commsCtx, cwd } = deps;
  return [
    tool('wa_list_chats',
      'List the user\'s WhatsApp chats (DMs, groups, channels) on this Mac, most-recent first. Use when the user asks about their WhatsApp — who messaged, unread chats, or to find a chat to read/reply to. Chats assigned to THIS project are marked [project].',
      { query: z.string().optional().describe('Filter by name / last-message substring.'), limit: z.number().optional().describe('Max chats (default 30).') },
      wrap(async (a: { query?: string; limit?: number }) => {
        const assigned = new Set(commsCtx.projectChatIds());
        let chats = commsCtx.listChats();
        if (a.query) { const q = a.query.toLowerCase(); chats = chats.filter(c => (c.name + ' ' + c.lastMessageText).toLowerCase().includes(q)); }
        chats = chats.slice(0, a.limit ?? 30);
        if (!chats.length) return txt('No WhatsApp chats found yet (they fill in as WhatsApp syncs).');
        return txt(chats.map(c => `- ${c.chatId} — ${c.name} [${c.kind}]${assigned.has(c.chatId) ? ' [project]' : ''}${c.unreadCount ? ` · ${c.unreadCount} unread` : ''} · last: ${(c.lastMessageText || '').slice(0, 70)}`).join('\n'));
      })),
    tool('wa_get_messages',
      'Read recent messages from a WhatsApp chat. Pass the chatId from wa_list_chats.',
      { chatId: z.string(), limit: z.number().optional().describe('How many recent messages (default 30).') },
      wrap(async (a: { chatId: string; limit?: number }) => {
        const msgs = commsCtx.getMessages(a.chatId, a.limit ?? 30);
        if (!msgs.length) return txt('No messages captured for that chat yet.');
        return txt(msgs.map(m => `[${new Date(m.ts).toISOString().slice(11, 16)}] ${m.fromMe ? 'You' : m.senderName}: ${m.kind !== 'text' ? `[${m.kind}] ` : ''}${m.text}`).join('\n'));
      })),
    tool('wa_send_message',
      'Send a WhatsApp message. Give EITHER chatId (from wa_list_chats) OR phone (digits incl. country code, no +). Messaging the user\'s OWN number always works; other contacts require the user to have enabled "agent can message contacts" — if blocked, relay the tool\'s note to the user.',
      { chatId: z.string().optional(), phone: z.string().optional().describe('Recipient phone in digits, e.g. "15551234567".'), text: z.string().describe('The message to send.') },
      wrap(async (a: { chatId?: string; phone?: string; text: string }) => {
        const target = resolveWaTarget(a, commsCtx);
        if (!target) return txt('No recipient: pass a chatId (from wa_list_chats) or a phone number, or have the user set their personal number in Comms.');
        if (!waSendAllowed(target, [commsCtx.ownJid(), commsCtx.notifyJid()], commsCtx.canSendOthers())) return txt('Blocked: messaging contacts other than your own number(s) is OFF by default (a safety gate). The user can turn on "Let the agent message contacts" in Comms. Message NOT sent.');
        const ok = await commsCtx.sendText(target, a.text);
        if (ok && commsCtx.recordContextSend) {
          try { commsCtx.recordContextSend(target, a.text); } catch { /* best-effort bookkeeping */ }
        }
        return txt(ok ? `Sent to ${target}.` : `Could not send to ${target} — is WhatsApp still linked?`);
      })),
    tool('wa_send_media',
      'Send an image, video, audio, or document via WhatsApp. The file MUST already exist inside .continuum/Attachment/ under the working directory — save/copy it there first. Give EITHER chatId OR phone. Same recipient rules as wa_send_message.',
      {
        chatId: z.string().optional().describe('Recipient chatId from wa_list_chats.'),
        phone: z.string().optional().describe('Recipient phone in digits, e.g. "15551234567".'),
        path: z.string().describe('File path relative to .continuum/Attachment/ (e.g. "screenshot.png"). Absolute paths inside the attachment dir are also accepted.'),
        caption: z.string().optional().describe('Optional caption for the media.'),
      },
      wrap(async (a: SendMediaArgs) => handleWaSendMedia(a, commsCtx, cwd))),
    tool('wa_mark_read', 'Mark a WhatsApp chat as read (clears its unread badge).',
      { chatId: z.string() },
      wrap(async (a: { chatId: string }) => { await commsCtx.markRead(a.chatId); return txt(`Marked ${a.chatId} read.`); })),
  ];
}
