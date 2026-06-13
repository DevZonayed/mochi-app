/* Comms Gateway — remote control + message capture across channels.
   • Telegram: a real remote control. Connect a bot (token from @BotFather,
     validated + stored encrypted on this Mac). Bind a chat (project +
     permissions) and it can /run jobs and approve gates — all executing here.
   • WhatsApp: a real channel over WhatsApp Web (Baileys, running on this Mac).
     Scan the QR under Channels to link; from then on EVERY message is captured
     into a per-chat history you can browse under History. Capture-only in v1.

   CommsPanel is the chrome-less body; the default export wraps it in AppShell
   for the standalone /comms route, and Settings embeds the same panel as a pane. */

import React from 'react';
import QRCode from 'qrcode';
import { Icon } from '../lib/icons';
import { AppShell } from '../lib/appShell';
import {
  api, type CommsStatus, type ChatBinding, type PendingChat, type CommEvent, type Project, type ChatPermissions,
  type WaChat, type WaMessage, type WaMsgKind, ApiError, IS_LOCAL,
} from '../lib/api';

const CSS = `
  .tab-fade { animation: tfade 240ms var(--spring); }
  @keyframes tfade { from { transform: translateY(6px); } to { transform: none; } }
  .row-hover:hover { background: var(--fill-tertiary); }
`;

function TelegramGlyph({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M21 5 3 12l5 1.8L17 7l-7 8.2.3 4 2.8-3 4 3L21 5Z" fill="currentColor" /></svg>;
}
function WhatsAppGlyph({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} style={{ width: 44, height: 26, borderRadius: 13, padding: 2, background: on ? 'var(--green)' : 'var(--fill-secondary)', transition: 'background 160ms ease', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 22, height: 22, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transform: on ? 'translateX(18px)' : 'none', transition: 'transform 160ms var(--spring)' }} />
    </button>
  );
}

// ── Channels ──────────────────────────────────────────────────────────────
function ChannelsTab({ status, onChanged }: { status: CommsStatus | null; onChanged: () => void }) {
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const tg = status?.telegram;

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true); setErr('');
    try { await api.connectTelegram(token.trim()); setToken(''); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not connect'); }
    finally { setBusy(false); }
  };
  const disconnect = async () => { setBusy(true); try { await api.disconnectTelegram(); onChanged(); } finally { setBusy(false); } };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {/* Telegram */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 16%, transparent)', color: 'var(--blue)' }}><TelegramGlyph /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>Telegram</div>
            <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
              {tg?.connected ? <>Connected as <b style={{ color: 'var(--ink)' }}>@{tg.botUsername}</b> · {tg.messagesToday} msg today</> : 'Run jobs and approve gates from a Telegram chat.'}
            </div>
          </div>
          {tg?.connected && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Live</span>}
        </div>

        {tg?.connected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>{tg.bindings} bound chat{tg.bindings !== 1 ? 's' : ''} · {tg.pending} pending. Message your bot, then bind the chat under Bindings.</div>
            <button onClick={disconnect} disabled={busy} style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', border: '0.5px solid var(--separator)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Disconnect</button>
          </div>
        ) : IS_LOCAL ? (
          <>
            <div style={{ display: 'flex', gap: 10 }}>
              <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Bot token from @BotFather (123456:ABC-…)" onKeyDown={e => { if (e.key === 'Enter') void connect(); }}
                style={{ flex: 1, height: 42, padding: '0 14px', borderRadius: 11, boxSizing: 'border-box', border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-mono)' }} />
              <button onClick={connect} disabled={busy || !token.trim()} style={{ height: 42, padding: '0 20px', borderRadius: 11, background: token.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: token.trim() ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{busy ? 'Connecting…' : 'Connect'}</button>
            </div>
            <p style={{ margin: '10px 0 0', font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>Create a bot in Telegram with @BotFather → /newbot, then paste the token here. It’s stored encrypted on this Mac and never sent to the relay.</p>
            {err && <div style={{ marginTop: 10, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red)' }}>{err}</div>}
          </>
        ) : <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Connect the Telegram bot from the desktop app.</div>}
      </div>

      {/* WhatsApp — real channel (capture + history) */}
      <WhatsAppCard status={status} onChanged={onChanged} />
    </div>
  );
}

// ── WhatsApp connect card (QR pairing) ──────────────────────────────────────
function WaQR({ qr }: { qr: string }) {
  const [src, setSrc] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    QRCode.toDataURL(qr, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(d => { if (alive) setSrc(d); }).catch(() => {});
    return () => { alive = false; };
  }, [qr]);
  return (
    <div style={{ width: 220, height: 220, display: 'grid', placeItems: 'center', background: '#fff', borderRadius: 14, border: '0.5px solid var(--separator)', flexShrink: 0 }}>
      {src ? <img src={src} width={196} height={196} alt="WhatsApp linking QR code" style={{ display: 'block' }} />
        : <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: '#888' }}>…</span>}
    </div>
  );
}

function WhatsAppCard({ status, onChanged }: { status: CommsStatus | null; onChanged: () => void }) {
  const wa = status?.whatsapp;
  const [busy, setBusy] = React.useState(false);
  const [linking, setLinking] = React.useState(false);
  const [err, setErr] = React.useState('');

  // Once a QR appears or we're connected, the "starting…" phase is over.
  React.useEffect(() => { if (wa?.qr || wa?.connected) setLinking(false); }, [wa?.qr, wa?.connected]);

  const connect = async () => {
    setBusy(true); setErr(''); setLinking(true);
    try { await api.connectWhatsApp(); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not start linking'); setLinking(false); }
    finally { setBusy(false); }
  };
  const disconnect = async () => { setBusy(true); try { await api.disconnectWhatsApp(); setLinking(false); onChanged(); } finally { setBusy(false); } };

  const connected = !!wa?.connected;
  const showQR = !connected && !!wa?.qr;

  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: connected || showQR || linking ? 16 : 0 }}>
        <span style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--green) 16%, transparent)', color: 'var(--green)' }}><WhatsAppGlyph /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>WhatsApp</div>
          <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
            {connected
              ? <>Linked as <b style={{ color: 'var(--ink)' }}>{wa?.name || wa?.jid?.split(':')[0] || 'this device'}</b> · {wa?.chats ?? 0} chat{(wa?.chats ?? 0) !== 1 ? 's' : ''} captured</>
              : 'Link your WhatsApp to capture every message into a searchable history.'}
          </div>
        </div>
        {connected && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Live</span>}
      </div>

      {connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>Messages are being saved on this Mac. Browse them under the History tab.</div>
          <button onClick={disconnect} disabled={busy} style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', border: '0.5px solid var(--separator)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Disconnect</button>
        </div>
      ) : !IS_LOCAL ? (
        <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Link WhatsApp from the desktop app.</div>
      ) : showQR ? (
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <WaQR qr={wa!.qr!} />
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)', marginBottom: 8 }}>Scan to link this device</div>
            <ol style={{ margin: 0, paddingLeft: 18, font: '400 var(--fs-footnote)/1.6 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <li>Open WhatsApp on your phone</li>
              <li>Tap <b>Settings → Linked Devices</b></li>
              <li>Tap <b>Link a Device</b> and scan this code</li>
            </ol>
            <button onClick={disconnect} disabled={busy} style={{ marginTop: 14, height: 34, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Cancel</button>
          </div>
        </div>
      ) : linking ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <span style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--separator)', borderTopColor: 'var(--green)', animation: 'spin 0.7s linear infinite' }} /> Generating QR code…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <>
          <button onClick={connect} disabled={busy} style={{ height: 42, padding: '0 20px', borderRadius: 11, background: 'var(--green)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{busy ? 'Starting…' : 'Link WhatsApp'}</button>
          <p style={{ margin: '10px 0 0', font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>Connects over WhatsApp Web on this Mac. Your session stays here and is never sent to the relay.</p>
          {err && <div style={{ marginTop: 10, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red)' }}>{err}</div>}
        </>
      )}
    </div>
  );
}

// ── WhatsApp History ────────────────────────────────────────────────────────
const KIND_LABEL: Record<WaMsgKind, string> = {
  text: '', system: '', image: '🖼 Photo', video: '🎬 Video', audio: '🎙 Voice message', document: '📄 Document', location: '📍 Location', poll: '📊 Poll',
};
function bubbleText(m: WaMessage): string {
  if (m.kind === 'text' || m.kind === 'system') return m.text;
  const label = m.kind === 'document' && m.media?.fileName ? `📄 ${m.media.fileName}` : KIND_LABEL[m.kind];
  return m.text ? `${label} · ${m.text}` : label;
}
const clockTime = (sec: number) => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayLabel = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function WhatsAppHistory({ connected, hasChats }: { connected: boolean; hasChats: boolean }) {
  const [chats, setChats] = React.useState<WaChat[]>([]);
  const [sel, setSel] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<WaMessage[]>([]);
  const threadRef = React.useRef<HTMLDivElement>(null);

  const loadChats = React.useCallback(() => { api.listWaChats().then(setChats).catch(() => {}); }, []);
  React.useEffect(() => { loadChats(); const unsub = api.subscribe({ onComms: loadChats }); return () => unsub(); }, [loadChats]);
  React.useEffect(() => { if (!sel && chats.length) setSel(chats[0].chatId); }, [chats, sel]);
  React.useEffect(() => {
    if (!sel) { setMsgs([]); return; }
    let alive = true;
    const load = () => api.listWaMessages(sel).then(m => { if (alive) setMsgs(m); }).catch(() => {});
    load();
    const unsub = api.subscribe({ onComms: load });
    return () => { alive = false; unsub(); };
  }, [sel]);
  React.useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);

  if (!connected && !hasChats) {
    return <div style={{ padding: '48px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1.5 var(--font-text)', color: 'var(--ink-tertiary)', maxWidth: 760 }}>Link WhatsApp under <b>Channels</b> to start capturing message history.</div>;
  }
  if (chats.length === 0) {
    return <div style={{ padding: '48px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1.5 var(--font-text)', color: 'var(--ink-tertiary)', maxWidth: 760 }}>No messages captured yet. Conversations will appear here as they arrive.</div>;
  }

  const selChat = chats.find(c => c.chatId === sel);
  let lastDay = '';
  return (
    <div style={{ display: 'flex', gap: 0, maxWidth: 860, height: 520, background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
      {/* chat list */}
      <div style={{ width: 240, flexShrink: 0, borderRight: '0.5px solid var(--separator)', overflow: 'auto' }}>
        {chats.map(c => {
          const on = c.chatId === sel;
          const title = c.name || c.chatId.split('@')[0];
          const initial = (title.trim()[0] || '?').toUpperCase();
          return (
            <button key={c.chatId} onClick={() => setSel(c.chatId)} className={on ? '' : 'row-hover'} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', textAlign: 'left', borderBottom: '0.5px solid var(--separator)', background: on ? 'var(--fill-secondary)' : 'transparent' }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: c.kind === 'group' ? 'color-mix(in srgb, var(--blue) 16%, transparent)' : 'color-mix(in srgb, var(--green) 16%, transparent)', color: c.kind === 'group' ? 'var(--blue)' : 'var(--green)', font: '700 var(--fs-footnote)/1 var(--font-display)' }}>
                {initial}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)' }}>{c.kind === 'group' ? 'Group · ' : ''}{c.count} message{c.count !== 1 ? 's' : ''}</span>
              </span>
            </button>
          );
        })}
      </div>
      {/* thread */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flexShrink: 0, padding: '12px 16px', borderBottom: '0.5px solid var(--separator)', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {selChat?.name || selChat?.chatId.split('@')[0] || 'Chat'}
        </div>
        <div ref={threadRef} style={{ flex: 1, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {msgs.map(m => {
            const day = dayLabel(m.ts);
            const showDay = day !== lastDay; lastDay = day;
            return (
              <React.Fragment key={m.msgId}>
                {showDay && <div style={{ alignSelf: 'center', margin: '8px 0 4px', padding: '3px 10px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{day}</div>}
                <div style={{ alignSelf: m.fromMe ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
                  {!m.fromMe && selChat?.kind === 'group' && m.senderName && <span style={{ display: 'block', font: '600 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--blue)', margin: '0 0 2px 2px' }}>{m.senderName}</span>}
                  <div style={{ padding: '7px 11px', borderRadius: 12, background: m.fromMe ? 'var(--blue)' : 'var(--bg-elevated)', color: m.fromMe ? '#fff' : 'var(--ink)', border: m.fromMe ? 'none' : '0.5px solid var(--separator)', font: '400 var(--fs-footnote)/1.4 var(--font-text)', wordBreak: 'break-word' }}>
                    {bubbleText(m) || <span style={{ opacity: 0.6 }}>·</span>}
                    <span style={{ display: 'inline-block', marginLeft: 8, font: '500 var(--fs-caption)/1 var(--font-mono)', color: m.fromMe ? 'rgba(255,255,255,0.7)' : 'var(--ink-tertiary)', verticalAlign: 'baseline' }}>{clockTime(m.ts)}</span>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Bindings ──────────────────────────────────────────────────────────────
function BindSheet({ pending, projects, onClose, onBound }: { pending: PendingChat; projects: Project[]; onClose: () => void; onBound: () => void }) {
  const [projectId, setProjectId] = React.useState('');
  const [perms, setPerms] = React.useState<ChatPermissions>({ startJobs: true, receiveReports: true, approveGates: false });
  const [busy, setBusy] = React.useState(false);
  const bind = async () => {
    setBusy(true);
    try { await api.bindChat({ chatId: pending.chatId, name: pending.name, projectId: projectId || null, permissions: perms }); onBound(); }
    catch { /* fail soft */ } finally { setBusy(false); }
  };
  const rows: [keyof ChatPermissions, string, string][] = [
    ['startJobs', 'Start jobs', 'Run tasks from this chat'],
    ['receiveReports', 'Receive reports', 'Get the result when a job finishes'],
    ['approveGates', 'Approve gates', 'Approve / deny pending gates inline'],
  ];
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 440, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 22 }}>
        <h2 style={{ margin: '0 0 4px', font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>Bind “{pending.name}”</h2>
        <p style={{ margin: '0 0 16px', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Let this chat control Maestro with the permissions you choose.</p>
        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 }}>Default project</span>
          <select value={projectId} onChange={e => setProjectId(e.target.value)} style={{ width: '100%', height: 40, borderRadius: 10, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', padding: '0 10px', font: '400 var(--fs-body)/1 var(--font-text)' }}>
            <option value="">First project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {rows.map(([k, label, sub]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: 1 }}><span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{label}</span><span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>{sub}</span></span>
              <Toggle on={perms[k]} onChange={v => setPerms(pr => ({ ...pr, [k]: v }))} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={bind} disabled={busy} style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{busy ? 'Binding…' : 'Bind chat'}</button>
        </div>
      </div>
    </div>
  );
}

function BindingsTab({ bindings, pending, projects, onChanged }: { bindings: ChatBinding[]; pending: PendingChat[]; projects: Project[]; onChanged: () => void }) {
  const [bindTarget, setBindTarget] = React.useState<PendingChat | null>(null);
  const projName = (id: string | null) => projects.find(p => p.id === id)?.name ?? 'First project';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 760 }}>
      <div>
        <div style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Pending · {pending.length}</div>
        {pending.length === 0 ? <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No chats waiting. Message your bot from Telegram and it’ll appear here to bind.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pending.map(c => (
                <div key={c.chatId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)' }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><TelegramGlyph size={17} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{c.name}</span>
                    <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>“{c.firstText}”</span>
                  </span>
                  <button onClick={() => setBindTarget(c)} style={{ height: 32, padding: '0 14px', borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Bind</button>
                </div>
              ))}
            </div>}
      </div>

      <div>
        <div style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Bound chats · {bindings.length}</div>
        {bindings.length === 0 ? <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No bound chats yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bindings.map(b => (
                <div key={b.chatId} style={{ padding: 14, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><TelegramGlyph size={17} /></span>
                    <span style={{ flex: 1 }}><span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{b.name}</span><span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)' }}>{projName(b.projectId)}</span></span>
                    <button onClick={() => void api.unbindChat(b.chatId).then(onChanged)} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: 'transparent', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Unbind</button>
                  </div>
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                    {([['startJobs', 'Start jobs'], ['receiveReports', 'Reports'], ['approveGates', 'Approve gates']] as [keyof ChatPermissions, string][]).map(([k, label]) => (
                      <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Toggle on={b.permissions[k]} onChange={v => void api.setChatPermissions(b.chatId, { [k]: v }).then(onChanged)} />
                        <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>}
      </div>

      {bindTarget && <BindSheet pending={bindTarget} projects={projects} onClose={() => setBindTarget(null)} onBound={() => { setBindTarget(null); onChanged(); }} />}
    </div>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────
function ActivityTab({ events }: { events: CommEvent[] }) {
  if (events.length === 0) return <div style={{ padding: '48px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No messages yet. Activity in and out of your bot shows here.</div>;
  const clock = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  return (
    <div style={{ maxWidth: 760, background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
      {events.map((e, i) => (
        <div key={e.id} className="row-hover" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < events.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: e.dir === 'in' ? 'var(--blue)' : 'var(--green)' }}>
            <Icon name={e.dir === 'in' ? 'enter' : 'send'} size={14} style={e.dir === 'in' ? { transform: 'rotate(90deg)' } : undefined} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.payload}</span>
            <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{e.chatName} · {e.dir === 'in' ? 'received' : 'sent'}</span>
          </span>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{clock(e.at)}</span>
        </div>
      ))}
    </div>
  );
}

const TABS: [string, string][] = [['channels', 'Channels'], ['history', 'History'], ['bindings', 'Bindings'], ['activity', 'Activity']];

/** Chrome-less Comms body. Used standalone (wrapped in AppShell below) and
    embedded as a Settings pane. */
export function CommsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [tab, setTab] = React.useState('channels');
  const [status, setStatus] = React.useState<CommsStatus | null>(null);
  const [bindings, setBindings] = React.useState<ChatBinding[]>([]);
  const [pending, setPending] = React.useState<PendingChat[]>([]);
  const [events, setEvents] = React.useState<CommEvent[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);

  const refetch = React.useCallback(() => {
    api.commsStatus().then(setStatus).catch(() => {});
    api.listChatBindings().then(setBindings).catch(() => {});
    api.listPendingChats().then(setPending).catch(() => {});
    api.listCommEvents().then(setEvents).catch(() => {});
  }, []);
  React.useEffect(() => {
    refetch();
    api.listProjects().then(setProjects).catch(() => {});
    const unsub = api.subscribe({ onComms: refetch });
    const poll = setInterval(refetch, 8000); // pending chats arrive via long-poll on the Mac
    return () => { unsub(); clearInterval(poll); };
  }, [refetch]);

  return (
    <div style={{ padding: embedded ? 0 : '24px 28px 36px' }}>
      <style>{CSS}</style>
      <h1 style={{ margin: '0 0 4px', font: `700 ${embedded ? 'var(--fs-title1)' : 'var(--fs-large-title)'}/1 var(--font-display)`, letterSpacing: '-0.02em', color: 'var(--ink)' }}>Comms</h1>
      <p style={{ margin: '0 0 20px', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Drive Maestro from Telegram, and capture your WhatsApp history — all on this Mac.</p>

      <div style={{ display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11, marginBottom: 22 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ width: 110, padding: '8px 0', textAlign: 'center', borderRadius: 8, font: `${tab === k ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === k ? 'var(--ink)' : 'var(--ink-secondary)', background: tab === k ? 'var(--bg-elevated)' : 'transparent', boxShadow: tab === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none' }}>
            {label}{k === 'bindings' && pending.length > 0 ? ` · ${pending.length}` : ''}
          </button>
        ))}
      </div>

      <div key={tab} className="tab-fade">
        {tab === 'channels' && <ChannelsTab status={status} onChanged={refetch} />}
        {tab === 'history' && <WhatsAppHistory connected={!!status?.whatsapp.connected} hasChats={(status?.whatsapp.chats ?? 0) > 0} />}
        {tab === 'bindings' && <BindingsTab bindings={bindings} pending={pending} projects={projects} onChanged={refetch} />}
        {tab === 'activity' && <ActivityTab events={events} />}
      </div>
    </div>
  );
}

export default function CommsGateway() {
  return (
    <AppShell active="comms" onSearch={() => {}}>
      <CommsPanel />
    </AppShell>
  );
}
