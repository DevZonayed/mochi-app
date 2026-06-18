/* Baileys WAMessage → Maestro's normalized WaMessage. Pure, dependency-free.
   Ported (and trimmed to Maestro's needs) from the Mochi comms reference:
   unwrap envelope wrappers, coerce the Long timestamp, classify the content
   node into a kind/text/media. No fingerprint/dedupe here — the store dedupes
   by msgId on append. */

import type { WaMessage, WaMsgKind, WaMedia } from './store.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

// Unwrap baileys envelope wrappers that hide the real content node.
function unwrap(message: AnyObj | null | undefined): AnyObj | null {
  let m: AnyObj | null | undefined = message;
  let guard = 0;
  while (m && guard++ < 8) {
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2) { m = m.viewOnceMessageV2.message; continue; }
    if (m.viewOnceMessageV2Extension) { m = m.viewOnceMessageV2Extension.message; continue; }
    if (m.deviceSentMessage) { m = m.deviceSentMessage.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  return m || null;
}

// baileys messageTimestamp can be number | string | Long {low,high,unsigned}.
function toEpochSeconds(t: any): number {
  if (t == null) return 0;
  if (typeof t === 'number') return Math.floor(t);
  if (typeof t === 'string') { const n = Number(t); return Number.isFinite(n) ? Math.floor(n) : 0; }
  if (typeof t === 'object' && typeof t.low === 'number') return (t.high * 4294967296) + (t.low >>> 0);
  if (typeof t === 'object' && typeof t.toNumber === 'function') return Math.floor(t.toNumber());
  return 0;
}

function mediaFrom(node: AnyObj | null | undefined): WaMedia | null {
  if (!node) return null;
  const mimetype = node.mimetype || null;
  const fileName = node.fileName || node.title || null;
  let sizeBytes: number | null = null;
  if (node.fileLength != null) sizeBytes = toEpochSeconds(node.fileLength); // reuse Long coercion
  if (!mimetype && !fileName && sizeBytes == null) return null;
  return { mimetype, fileName, sizeBytes };
}

// Map an unwrapped content node → {kind, text, media}.
function classify(node: AnyObj | null): { kind: WaMsgKind; text: string; media: WaMedia | null } {
  if (!node) return { kind: 'system', text: '', media: null };
  if (node.conversation) return { kind: 'text', text: node.conversation, media: null };
  if (node.extendedTextMessage) return { kind: 'text', text: node.extendedTextMessage.text || '', media: null };
  if (node.imageMessage) return { kind: 'image', text: node.imageMessage.caption || '', media: mediaFrom(node.imageMessage) };
  if (node.videoMessage) return { kind: 'video', text: node.videoMessage.caption || '', media: mediaFrom(node.videoMessage) };
  if (node.audioMessage) return { kind: 'audio', text: '', media: mediaFrom(node.audioMessage) };
  if (node.documentMessage) return { kind: 'document', text: node.documentMessage.caption || '', media: mediaFrom(node.documentMessage) };
  if (node.locationMessage) {
    const l = node.locationMessage;
    const label = l.name ? `${l.name} ` : '';
    return { kind: 'location', text: `${label}(${l.degreesLatitude},${l.degreesLongitude})`, media: null };
  }
  if (node.pollCreationMessage || node.pollCreationMessageV3) {
    const p = node.pollCreationMessage || node.pollCreationMessageV3;
    return { kind: 'poll', text: p.name || '', media: null };
  }
  return { kind: 'system', text: '', media: null };
}

// contextInfo lives on extendedText/media nodes; find the first with a stanzaId.
function replyTo(node: AnyObj | null): string | null {
  if (!node) return null;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object' && v.contextInfo && v.contextInfo.stanzaId) return v.contextInfo.stanzaId;
  }
  return null;
}

/** Normalize a raw baileys message into a stored WaMessage (null if no chat). */
export function normalizeWaMessage(raw: AnyObj, source: 'live' | 'backfill'): WaMessage | null {
  const key = raw.key || {};
  const chatId: string = key.remoteJid || '';
  if (!chatId) return null;
  const isGroup = typeof chatId === 'string' && chatId.endsWith('@g.us');
  const senderId: string = isGroup ? (key.participant || key.remoteJid || '') : (key.remoteJid || '');
  const node = unwrap(raw.message);
  const { kind, text, media } = classify(node);
  const ts = toEpochSeconds(raw.messageTimestamp);
  return {
    msgId: key.id || '',
    chatId,
    fromMe: !!key.fromMe,
    senderId,
    senderName: raw.pushName || raw.verifiedBizName || '',
    ts,
    kind,
    text,
    media,
    replyTo: replyTo(node),
    source,
  };
}
