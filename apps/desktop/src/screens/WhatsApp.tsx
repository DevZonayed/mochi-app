/* WhatsApp workspace — a WhatsApp-Web-style two-pane messenger driven by THIS
   Mac's Baileys socket. Left: a searchable list of every chat (DMs, groups,
   channels). Right: the live conversation, with a composer to send text + media,
   reactions, and read receipts. All chat/message data is Mac-local (the relay
   never sees it); linking/auth lives in Comms. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { AppShell } from '../lib/appShell';
import { api, type WaChat, type WaMessage, type WaMediaData, type WhatsAppState, IS_LOCAL } from '../lib/api';

const CSS = `
  .wa-row:hover { background: var(--fill-tertiary); }
  .wa-row.sel { background: var(--fill-secondary); }
  .wa-msg-grp:hover .wa-react-btn { opacity: 1; }
  .wa-send:hover { filter: brightness(1.06); }
  @keyframes wapop { from { transform: translateY(4px); opacity: 0; } to { transform: none; opacity: 1; } }
`;

const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '#';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function clock(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function listTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return clock(ts);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function dayLabel(ts: number): string {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function sortChats(list: WaChat[]): WaChat[] {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return b.lastMessageAt - a.lastMessageAt;
  });
}

function Avatar({ chat, size = 46 }: { chat: WaChat; size?: number }) {
  const tint = chat.kind === 'group' ? 'var(--blue)' : chat.kind === 'channel' ? 'var(--purple, #9b6bff)' : 'var(--green)';
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', overflow: 'hidden', background: chat.avatarUrl ? 'transparent' : `color-mix(in srgb, ${tint} 18%, var(--fill-secondary))`, color: tint, font: `600 ${Math.round(size / 2.6)}px/1 var(--font-display)` }}>
      {chat.avatarUrl ? <img src={chat.avatarUrl} alt="" width={size} height={size} style={{ objectFit: 'cover' }} /> : initials(chat.name)}
    </span>
  );
}

// ── left: chat list ─────────────────────────────────────────────────────────
function ChatList({ chats, selectedId, query, setQuery, onSelect }: { chats: WaChat[]; selectedId: string | null; query: string; setQuery: (q: string) => void; onSelect: (id: string) => void }) {
  const filtered = query.trim()
    ? chats.filter(c => (c.name + ' ' + c.lastMessageText).toLowerCase().includes(query.trim().toLowerCase()))
    : chats;
  return (
    <div style={{ width: 360, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div style={{ padding: '16px 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--green) 16%, transparent)', color: 'var(--green)' }}><Icon name="whatsapp" size={18} /></span>
          <h1 style={{ margin: 0, font: '700 var(--fs-title2)/1 var(--font-display)', color: 'var(--ink)' }}>WhatsApp</h1>
        </div>
        <div style={{ position: 'relative' }}>
          <Icon name="search" size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-tertiary)' }} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search chats"
            style={{ width: '100%', height: 36, padding: '0 12px 0 32px', boxSizing: 'border-box', borderRadius: 'var(--r-pill)', border: '1px solid var(--separator)', background: 'var(--bg-elevated)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)' }} />
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>{query ? 'No chats match.' : 'No chats yet. WhatsApp only sends history on a fresh link — re-link in Comms to pull your chats.'}</div>
        ) : filtered.map(c => (
          <button key={c.chatId} onClick={() => onSelect(c.chatId)} className={`wa-row${c.chatId === selectedId ? ' sel' : ''}`}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', textAlign: 'left', borderBottom: '0.5px solid color-mix(in srgb, var(--separator) 50%, transparent)' }}>
            <Avatar chat={c} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}{c.pinned ? ' 📌' : ''}</span>
                <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: c.unreadCount ? 'var(--green)' : 'var(--ink-tertiary)', flexShrink: 0 }}>{listTime(c.lastMessageAt)}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.lastMessageFromMe ? <span style={{ color: 'var(--ink-tertiary)' }}>You: </span> : ''}{c.lastMessageText || ' '}
                </span>
                {c.unreadCount > 0 && <span style={{ flexShrink: 0, minWidth: 18, height: 18, padding: '0 5px', boxSizing: 'border-box', borderRadius: 9, background: 'var(--green)', color: '#fff', font: '600 11px/18px var(--font-text)', textAlign: 'center' }}>{c.unreadCount > 99 ? '99+' : c.unreadCount}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── media: inline thumbnail + on-demand full load (image/video/audio/document) ──
function humanSize(b: number): string { return b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`; }
function MediaChip({ icon, label, sub, onClick, loading, err }: { icon: IconNameLike; label: string; sub?: string; onClick: () => void; loading: boolean; err: boolean }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--fill-secondary)', maxWidth: 260, marginBottom: 4, textAlign: 'left' }}>
      <Icon name={loading ? 'refresh' : icon} size={16} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', font: '500 var(--fs-caption)/1.2 var(--font-text)', color: err ? 'var(--red)' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{err ? 'Couldn’t load — tap to retry' : label}</span>
        {sub ? <span style={{ display: 'block', font: '400 10px/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{sub}</span> : null}
      </span>
    </button>
  );
}
type IconNameLike = 'image' | 'play' | 'clapper' | 'file' | 'refresh';
function MediaBlock({ m, onLoad }: { m: WaMessage; onLoad: (msgId: string) => Promise<WaMediaData | null> }) {
  const [full, setFull] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState(false);
  const md = m.media!;
  const thumb = md.thumbBase64 ? `data:image/jpeg;base64,${md.thumbBase64}` : null;
  const dur = md.seconds ? `${Math.floor(md.seconds / 60)}:${String(md.seconds % 60).padStart(2, '0')}` : '';
  const get = async (): Promise<WaMediaData | null> => {
    if (!m.msgId || loading) return null;
    setLoading(true); setErr(false);
    const r = await onLoad(m.msgId).catch(() => null);
    setLoading(false); if (!r) setErr(true);
    return r;
  };
  const showInline = async () => { const r = await get(); if (r) setFull(r.dataUrl); };
  const download = async () => { const r = await get(); if (r) { const a = document.createElement('a'); a.href = r.dataUrl; a.download = r.fileName || m.kind; a.click(); } };
  const box: React.CSSProperties = { borderRadius: 8, display: 'block', marginBottom: m.text ? 6 : 2 };

  if (m.kind === 'image' || m.kind === 'sticker') {
    const src = full || thumb;
    if (!src) return <MediaChip icon="image" label={m.kind === 'sticker' ? 'Sticker' : 'Photo'} onClick={showInline} loading={loading} err={err} />;
    return <img src={src} onClick={() => { if (!full) void showInline(); }} title={full ? '' : 'Click to load full image'} style={{ ...box, width: m.kind === 'sticker' ? 120 : 240, maxWidth: '100%', cursor: full ? 'default' : 'zoom-in' }} />;
  }
  if (m.kind === 'video') {
    if (full) return <video src={full} controls autoPlay style={{ ...box, width: 280, maxWidth: '100%' }} />;
    return (
      <div onClick={showInline} style={{ ...box, position: 'relative', width: 240, minHeight: thumb ? undefined : 120, cursor: 'pointer', background: 'var(--fill-secondary)', overflow: 'hidden' }}>
        {thumb && <img src={thumb} style={{ width: '100%', display: 'block' }} />}
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><span style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'grid', placeItems: 'center' }}><Icon name={loading ? 'refresh' : 'play'} size={20} /></span></span>
        {dur ? <span style={{ position: 'absolute', right: 6, bottom: 6, font: '500 10px/1 var(--font-text)', color: '#fff', background: 'rgba(0,0,0,0.55)', padding: '2px 5px', borderRadius: 4 }}>{dur}</span> : null}
      </div>
    );
  }
  if (m.kind === 'audio') {
    if (full) return <audio src={full} controls autoPlay style={{ height: 38, maxWidth: 240, marginBottom: 4 }} />;
    return <MediaChip icon="play" label={`Voice message${dur ? ' · ' + dur : ''}`} onClick={showInline} loading={loading} err={err} />;
  }
  return <MediaChip icon="file" label={md.fileName || 'Document'} sub={md.sizeBytes ? humanSize(md.sizeBytes) : 'Tap to download'} onClick={download} loading={loading} err={err} />;
}

// ── right: one message bubble ────────────────────────────────────────────────
function Bubble({ m, isGroup, onLoadMedia }: { m: WaMessage; isGroup: boolean; onLoadMedia: (msgId: string) => Promise<WaMediaData | null> }) {
  const out = m.fromMe;
  const tick = m.status === 'read' ? { t: '✓✓', c: 'var(--blue)' } : m.status === 'delivered' ? { t: '✓✓', c: 'var(--ink-tertiary)' } : { t: '✓', c: 'var(--ink-tertiary)' };
  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', padding: '1px 0' }}>
      <div style={{ maxWidth: '72%', padding: '7px 10px 5px', borderRadius: 12, borderTopRightRadius: out ? 3 : 12, borderTopLeftRadius: out ? 12 : 3, background: out ? 'color-mix(in srgb, var(--green) 22%, var(--bg-elevated))' : 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
        {isGroup && !out && <div style={{ font: '600 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--blue)', marginBottom: 2 }}>{m.senderName}</div>}
        {m.quotedText ? <div style={{ borderLeft: '3px solid var(--green)', padding: '3px 8px', margin: '0 0 4px', borderRadius: 4, background: 'var(--fill-secondary)', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }}>{m.quotedText}</div> : null}
        {m.media ? <MediaBlock m={m} onLoad={onLoadMedia} /> : null}
        {m.text ? <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div> : null}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2, font: '400 10px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
          {clock(m.ts)}{out && <span style={{ color: tick.c }}>{tick.t}</span>}
        </div>
        {m.reactions && m.reactions.length > 0 && (
          <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
            {m.reactions.map((r, i) => <span key={i} style={{ font: '12px/1 var(--font-text)', background: 'var(--fill-secondary)', borderRadius: 'var(--r-pill)', padding: '2px 5px' }}>{r.emoji}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── right: conversation pane ─────────────────────────────────────────────────
function Conversation({ chat, messages, onSend, onSendFile, onReact, onLoadMore, onLoadMedia, hasMore, busy }: {
  chat: WaChat; messages: WaMessage[]; onSend: (t: string) => void; onSendFile: (f: File, caption: string) => void;
  onReact: (msgId: string, emoji: string) => void; onLoadMore: () => void; onLoadMedia: (msgId: string) => Promise<WaMediaData | null>; hasMore: boolean; busy: boolean;
}) {
  const [draft, setDraft] = React.useState('');
  const [reactFor, setReactFor] = React.useState<string | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const atBottom = React.useRef(true);

  // Keep pinned to the bottom as new messages arrive (unless the user scrolled up).
  React.useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, chat.chatId]);
  React.useEffect(() => { setDraft(''); atBottom.current = true; }, [chat.chatId]);

  const send = () => { const t = draft.trim(); if (!t) return; onSend(t); setDraft(''); };
  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (f) onSendFile(f, '');
    if (fileInput.current) fileInput.current.value = '';
  };

  let lastDay = '';
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
        <Avatar chat={chat} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{chat.name}</div>
          <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{chat.kind === 'group' ? 'Group' : chat.kind === 'channel' ? 'Channel' : chat.chatId.split('@')[0]}</div>
        </div>
      </div>

      {/* messages */}
      <div ref={scroller} onScroll={e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 18px', background: 'var(--bg-grouped)' }}>
        {!busy && messages.length === 0 && (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}>
            <div style={{ maxWidth: 320, font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>
              No messages synced for this chat yet. WhatsApp streams history after linking — give it a moment, or re-link in <b style={{ color: 'var(--ink-secondary)' }}>Comms</b> to pull full history.
            </div>
          </div>
        )}
        {hasMore && <div style={{ textAlign: 'center', marginBottom: 10 }}><button onClick={onLoadMore} disabled={busy} style={{ height: 30, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)' }}>{busy ? 'Loading…' : 'Load earlier messages'}</button></div>}
        {messages.map(m => {
          // Defensive: never render a blank bubble (no text, no media) — e.g. legacy
          // protocol frames captured before the skip-on-capture fix.
          if (!m.text && !m.media) return null;
          const day = dayLabel(m.ts);
          const sep = day !== lastDay; lastDay = day;
          return (
            <React.Fragment key={m.id}>
              {sep && <div style={{ textAlign: 'center', margin: '12px 0' }}><span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', background: 'var(--bg-elevated)', borderRadius: 'var(--r-pill)', padding: '4px 12px', border: '0.5px solid var(--separator)' }}>{day}</span></div>}
              <div className="wa-msg-grp" style={{ position: 'relative', display: 'flex', justifyContent: m.fromMe ? 'flex-end' : 'flex-start', alignItems: 'center', gap: 6 }}>
                {m.fromMe && m.msgId && <ReactButton open={reactFor === m.id} onToggle={() => setReactFor(reactFor === m.id ? null : m.id)} onPick={e => { onReact(m.msgId!, e); setReactFor(null); }} />}
                <Bubble m={m} isGroup={chat.kind === 'group'} onLoadMedia={onLoadMedia} />
                {!m.fromMe && m.msgId && <ReactButton open={reactFor === m.id} onToggle={() => setReactFor(reactFor === m.id ? null : m.id)} onPick={e => { onReact(m.msgId!, e); setReactFor(null); }} />}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* composer */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
        <input ref={fileInput} type="file" hidden onChange={pickFile} />
        <button onClick={() => fileInput.current?.click()} title="Attach a file" style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><Icon name="paperclip" size={18} /></button>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} rows={1} placeholder="Type a message"
          style={{ flex: 1, maxHeight: 120, minHeight: 38, padding: '9px 14px', boxSizing: 'border-box', resize: 'none', borderRadius: 19, border: '1px solid var(--separator)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1.3 var(--font-text)' }} />
        <button className="wa-send" onClick={send} disabled={!draft.trim()} title="Send" style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: draft.trim() ? 'var(--green)' : 'var(--fill-secondary)', color: draft.trim() ? '#fff' : 'var(--ink-tertiary)' }}><Icon name="send" size={17} /></button>
      </div>
    </div>
  );
}

function ReactButton({ open, onToggle, onPick }: { open: boolean; onToggle: () => void; onPick: (emoji: string) => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <button className="wa-react-btn" onClick={onToggle} title="React" style={{ opacity: open ? 1 : 0, transition: 'opacity 120ms ease', width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', color: 'var(--ink-tertiary)', font: '13px/1 var(--font-text)' }}>☺</button>
      {open && (
        <div style={{ position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)', zIndex: 5, display: 'flex', gap: 2, padding: 4, borderRadius: 'var(--r-pill)', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)', animation: 'wapop 140ms var(--spring)' }}>
          {QUICK_EMOJI.map(e => <button key={e} onClick={() => onPick(e)} style={{ width: 28, height: 28, borderRadius: '50%', font: '16px/1 var(--font-text)' }}>{e}</button>)}
        </div>
      )}
    </div>
  );
}

const PAGE = 200;

export default function WhatsAppScreen() {
  const navigate = useNavigate();
  const [wa, setWa] = React.useState<WhatsAppState | null>(null);
  const [chats, setChats] = React.useState<WaChat[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<WaMessage[]>([]);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const selRef = React.useRef<string | null>(null);
  selRef.current = selectedId;

  const refetchChats = React.useCallback(() => { api.waListChats().then(c => setChats(sortChats(c))).catch(() => {}); }, []);

  // Initial load + live updates. wa-message appends to the open chat and refreshes
  // the row; wa-chats (history sync / meta change) refetches the list.
  React.useEffect(() => {
    if (!IS_LOCAL) return;
    api.whatsappStatus().then(setWa).catch(() => {});
    refetchChats();
    const unsub = api.subscribe({
      onComms: () => api.whatsappStatus().then(setWa).catch(() => {}),
      onWaChats: () => refetchChats(),
      onWaMessageUpdate: (e) => { // reaction / delivery-status change on a loaded message
        if (e.chatId === selRef.current) api.waGetMessages(e.chatId, { limit: PAGE }).then(setMessages).catch(() => {});
      },
      onWaMessage: (e) => {
        setChats(prev => sortChats([e.chat ?? prev.find(c => c.chatId === e.chatId)!, ...prev.filter(c => c.chatId !== e.chatId)].filter(Boolean) as WaChat[]));
        if (e.chatId === selRef.current) {
          setMessages(prev => prev.some(m => m.id === e.message.id) ? prev : [...prev, e.message]);
          void api.waMarkRead(e.chatId);
        }
      },
    });
    // Fallback while history streams in. Pause entirely when the window is
    // hidden so the WhatsApp tab doesn't keep firing every 6s in the background.
    let poll: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!poll && !document.hidden) poll = setInterval(refetchChats, 6000); };
    const stop = () => { if (poll) { clearInterval(poll); poll = null; } };
    const onVis = () => { if (document.hidden) stop(); else { refetchChats(); start(); } };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { unsub(); stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [refetchChats]);

  const openChat = React.useCallback((chatId: string) => {
    setSelectedId(chatId);
    setMessages([]);
    setBusy(true);
    api.waGetMessages(chatId, { limit: PAGE }).then(ms => { setMessages(ms); setHasMore(ms.length >= PAGE); }).catch(() => {}).finally(() => setBusy(false));
    void api.waMarkRead(chatId).then(refetchChats);
    const c = chats.find(x => x.chatId === chatId);
    if (c && !c.avatarUrl) void api.waFetchAvatar(chatId).catch(() => {});
  }, [chats, refetchChats]);

  const loadMore = React.useCallback(() => {
    if (!selectedId || messages.length === 0) return;
    setBusy(true);
    api.waGetMessages(selectedId, { before: messages[0].ts, limit: PAGE })
      .then(older => { setMessages(prev => [...older.filter(o => !prev.some(p => p.id === o.id)), ...prev]); setHasMore(older.length >= PAGE); })
      .catch(() => {}).finally(() => setBusy(false));
  }, [selectedId, messages]);

  const loadMedia = React.useCallback((msgId: string) => selectedId ? api.waDownloadMedia(selectedId, msgId) : Promise.resolve(null), [selectedId]);
  const sendText = (t: string) => { if (selectedId) void api.waSendText(selectedId, t).catch(() => {}); };
  const react = (msgId: string, emoji: string) => {
    if (!selectedId) return;
    setMessages(prev => prev.map(m => m.msgId === msgId ? { ...m, reactions: emoji ? [{ emoji, fromMe: true }] : [] } : m)); // optimistic
    void api.waReact(selectedId, msgId, emoji).catch(() => {});
  };
  const sendFile = async (f: File, caption: string) => {
    if (!selectedId) return;
    const buf = await f.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const dataB64 = btoa(bin);
    const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'document';
    void api.waSendMedia(selectedId, { dataB64, kind, mimetype: f.type || undefined, fileName: f.name, caption: caption || undefined }).catch(() => {});
  };

  const selected = chats.find(c => c.chatId === selectedId) ?? null;
  const connected = !!wa?.connected;

  return (
    <AppShell active="whatsapp" onSearch={() => {}}>
      <style>{CSS}</style>
      {!IS_LOCAL ? (
        <Centered icon="smartphone" title="Open WhatsApp on the desktop app" sub="Your WhatsApp chats live on your Mac and aren’t available from a remote." />
      ) : !connected ? (
        <Centered icon="whatsapp" title="WhatsApp isn’t linked yet" sub="Link your number in Comms, then your chats appear here.">
          <button onClick={() => navigate('/comms')} style={{ marginTop: 14, height: 40, padding: '0 18px', borderRadius: 11, background: 'var(--green)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Go to Comms</button>
        </Centered>
      ) : (
        <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
          <ChatList chats={chats} selectedId={selectedId} query={query} setQuery={setQuery} onSelect={openChat} />
          {selected ? (
            <Conversation chat={selected} messages={messages} onSend={sendText} onSendFile={sendFile} onReact={react} onLoadMore={loadMore} onLoadMedia={loadMedia} hasMore={hasMore} busy={busy} />
          ) : chats.length ? (
            <Centered icon="whatsapp" title="Select a chat" sub="Pick a conversation on the left to read and reply." />
          ) : (
            <Centered icon="whatsapp" title="No chats synced yet" sub="WhatsApp only streams your history on a fresh link (not on reconnect). Re-link to pull your chats + messages — after that they’re saved here and survive restarts.">
              <button onClick={() => navigate('/comms')} style={{ marginTop: 14, height: 40, padding: '0 18px', borderRadius: 11, background: 'var(--green)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Re-link in Comms</button>
            </Centered>
          )}
        </div>
      )}
    </AppShell>
  );
}

function Centered({ icon, title, sub, children }: { icon: 'whatsapp' | 'smartphone'; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 40, background: 'var(--bg-grouped)' }}>
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 64, height: 64, borderRadius: 18, marginBottom: 14, background: 'color-mix(in srgb, var(--green) 14%, transparent)', color: 'var(--green)' }}><Icon name={icon} size={32} /></span>
        <h2 style={{ margin: '0 0 6px', font: '700 var(--fs-title2)/1.2 var(--font-display)', color: 'var(--ink)' }}>{title}</h2>
        <p style={{ margin: 0, font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>{sub}</p>
        {children}
      </div>
    </div>
  );
}
