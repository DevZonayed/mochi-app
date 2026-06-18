/* Comms Gateway — a real Telegram remote control. Connect a bot (token from
   @BotFather, validated + stored encrypted on this Mac, never in the relay).
   Chats that message the bot land in Pending; bind one (project + permissions)
   and it can /run jobs and approve gates from Telegram — all executing here.
   WhatsApp is an honest preview (not wired). */

import React from 'react';
import { Icon, type IconName } from '../lib/icons';
import { AppShell } from '../lib/appShell';
import { api, type CommsStatus, type ChatBinding, type PendingChat, type CommEvent, type Project, type ChatPermissions, type WhatsAppState, type WaChatSummary, type ChatSession, type CommsProvider, ApiError, IS_LOCAL } from '../lib/api';

/** Pending chats don't carry a provider; a WhatsApp JID always contains '@'
    (…@s.whatsapp.net / …@g.us), a Telegram chat id is numeric — so the id tells us. */
function providerOf(chatId: string): CommsProvider { return chatId.includes('@') ? 'whatsapp' : 'telegram'; }

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
/** The right glyph (and tint) for a chat's channel. */
function ProviderGlyph({ provider, size = 17 }: { provider: CommsProvider; size?: number }) {
  return provider === 'whatsapp' ? <WhatsAppGlyph size={size} /> : <TelegramGlyph size={size} />;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} style={{ width: 44, height: 26, borderRadius: 13, padding: 2, background: on ? 'var(--green)' : 'var(--fill-secondary)', transition: 'background 160ms ease', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 22, height: 22, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transform: on ? 'translateX(18px)' : 'none', transition: 'transform 160ms var(--spring)' }} />
    </button>
  );
}

// ── WhatsApp card (link + connection + send gate) ───────────────────────────
function WhatsAppCard({ wa, tracked, onChanged }: { wa: WhatsAppState | null; tracked: number; onChanged: () => void }) {
  const [qr, setQr] = React.useState<string | null>(null);
  const [pairing, setPairing] = React.useState<string | null>(null);
  const [linking, setLinking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const connected = !!wa?.connected;
  const linked = wa?.linkedAt != null;

  const startLink = async () => {
    setBusy(true); setErr(''); setPairing(null);
    try {
      const r = await api.whatsappLink();
      if (r.method === 'qr') { setQr(r.dataUrl); setLinking(true); } else setPairing(r.code);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not start linking'); }
    finally { setBusy(false); }
  };
  // While a QR is pending: refresh it as it rotates and watch for the link landing.
  React.useEffect(() => {
    if (!linking) return;
    const t = setInterval(() => {
      api.whatsappQr().then(r => { if (r.dataUrl) setQr(r.dataUrl); }).catch(() => {});
      api.whatsappStatus().then(s => { if (s.connected) { setLinking(false); setQr(null); onChanged(); } }).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [linking, onChanged]);

  const disconnect = async () => { setBusy(true); try { await api.disconnectWhatsApp(); onChanged(); } finally { setBusy(false); } };
  const unlink = async () => { setBusy(true); try { await api.unlinkWhatsApp(); setLinking(false); setQr(null); onChanged(); } finally { setBusy(false); } };
  const approve = async () => { setBusy(true); try { await api.approveWhatsappSend(); onChanged(); } finally { setBusy(false); } };

  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <span style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--green) 16%, transparent)', color: 'var(--green)' }}><WhatsAppGlyph /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>WhatsApp</div>
          <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
            {connected ? <>Linked{wa?.name ? <> as <b style={{ color: 'var(--ink)' }}>{wa.name}</b></> : ''} · {tracked} tracked chat{tracked !== 1 ? 's' : ''}</>
              : 'Summarize quiet chats and send the digest to your own number.'}
          </div>
        </div>
        {connected && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Live</span>}
      </div>

      {/* The one-time send gate: never message your number until you allow it. */}
      {connected && wa && !wa.sendApproved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, background: 'color-mix(in srgb, var(--orange, #ff9f0a) 12%, transparent)', border: '0.5px solid color-mix(in srgb, var(--orange, #ff9f0a) 40%, transparent)', marginBottom: 14 }}>
          <Icon name="shield" size={18} style={{ color: 'var(--orange, #ff9f0a)', flexShrink: 0 }} />
          <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink)' }}>
            Before Maestro messages summaries to your own number, it needs your OK.{wa.pendingSummary ? ' One summary is waiting.' : ''}
          </span>
          {IS_LOCAL && <button onClick={approve} disabled={busy} style={{ height: 34, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--green)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', flexShrink: 0 }}>{busy ? '…' : 'Allow'}</button>}
        </div>
      )}

      {connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>Assign chats to a project + session under Bindings. A chat that goes quiet for 15 min gets summarized to you.</div>
          {IS_LOCAL && <button onClick={disconnect} disabled={busy} style={{ height: 38, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--ink)', border: '0.5px solid var(--separator)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Pause</button>}
          {IS_LOCAL && <button onClick={unlink} disabled={busy} style={{ height: 38, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', border: '0.5px solid var(--separator)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Unlink</button>}
        </div>
      ) : !IS_LOCAL ? (
        <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Link your WhatsApp number from the desktop app.</div>
      ) : qr ? (
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <img src={qr} alt="WhatsApp QR" width={180} height={180} style={{ borderRadius: 12, background: '#fff', padding: 8, boxSizing: 'border-box' }} />
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)', marginBottom: 6 }}>Scan to link your number</div>
            <ol style={{ margin: 0, paddingLeft: 18, font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <li>Open WhatsApp on your phone</li>
              <li>Settings → Linked Devices → Link a Device</li>
              <li>Point it at this code</li>
            </ol>
            <button onClick={unlink} disabled={busy} style={{ marginTop: 10, height: 32, padding: '0 12px', borderRadius: 8, background: 'transparent', color: 'var(--ink-tertiary)', border: '0.5px solid var(--separator)', font: '500 var(--fs-caption)/1 var(--font-text)' }}>Cancel</button>
          </div>
        </div>
      ) : pairing ? (
        <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink)' }}>Pairing code: <b style={{ font: 'var(--fs-title2) var(--font-mono)', letterSpacing: '0.1em' }}>{pairing}</b><div style={{ color: 'var(--ink-tertiary)', marginTop: 4 }}>Enter it in WhatsApp → Linked Devices → Link with phone number.</div></div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 12, background: 'color-mix(in srgb, var(--red) 9%, transparent)', border: '0.5px solid color-mix(in srgb, var(--red) 30%, transparent)', marginBottom: 14 }}>
            <Icon name="alert" size={16} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>This links your <b style={{ color: 'var(--ink)' }}>personal</b> number via an unofficial connection. WhatsApp may ban numbers that automate — this is your own informed choice. Maestro only reads tracked chats and messages summaries to you.</span>
          </div>
          <button onClick={startLink} disabled={busy} style={{ height: 42, padding: '0 20px', borderRadius: 11, background: 'var(--green)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{busy ? 'Starting…' : linked ? 'Re-link number' : 'Link your number'}</button>
          {err && <div style={{ marginTop: 10, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red)' }}>{err}</div>}
        </>
      )}
    </div>
  );
}

// ── Channels ──────────────────────────────────────────────────────────────
function ChannelsTab({ status, wa, onChanged }: { status: CommsStatus | null; wa: WhatsAppState | null; onChanged: () => void }) {
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

      {/* WhatsApp — quiet-timer sync */}
      <WhatsAppCard wa={wa} tracked={status?.whatsapp.tracked ?? 0} onChanged={onChanged} />
    </div>
  );
}

// ── Bindings ──────────────────────────────────────────────────────────────
function BindSheet({ pending, projects, onClose, onBound }: { pending: PendingChat; projects: Project[]; onClose: () => void; onBound: () => void }) {
  const isWa = providerOf(pending.chatId) === 'whatsapp';
  const [projectId, setProjectId] = React.useState('');
  const [sessionId, setSessionId] = React.useState('');
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [perms, setPerms] = React.useState<ChatPermissions>({ startJobs: true, receiveReports: true, approveGates: false });
  const [busy, setBusy] = React.useState(false);

  // WhatsApp files a chat under a session — load the chosen project's sessions.
  React.useEffect(() => {
    if (!isWa) return;
    setSessionId('');
    if (!projectId) { setSessions([]); return; }
    api.listSessions(projectId).then(s => setSessions(s.filter(x => !x.archived))).catch(() => setSessions([]));
  }, [isWa, projectId]);

  const bind = async () => {
    setBusy(true);
    try {
      await api.bindChat(isWa
        ? { chatId: pending.chatId, name: pending.name, provider: 'whatsapp', projectId: projectId || null, sessionId: sessionId || null }
        : { chatId: pending.chatId, name: pending.name, projectId: projectId || null, permissions: perms });
      onBound();
    } catch { /* fail soft */ } finally { setBusy(false); }
  };
  const rows: [keyof ChatPermissions, string, string][] = [
    ['startJobs', 'Start jobs', 'Run tasks from this chat'],
    ['receiveReports', 'Receive reports', 'Get the result when a job finishes'],
    ['approveGates', 'Approve gates', 'Approve / deny pending gates inline'],
  ];
  const labelStyle: React.CSSProperties = { display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 };
  const selectStyle: React.CSSProperties = { width: '100%', height: 40, borderRadius: 10, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', padding: '0 10px', font: '400 var(--fs-body)/1 var(--font-text)' };
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 440, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 22 }}>
        <h2 style={{ margin: '0 0 4px', font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>{isWa ? 'Track' : 'Bind'} “{pending.name}”</h2>
        <p style={{ margin: '0 0 16px', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>{isWa ? 'File this chat under a project and session. When it goes quiet for 15 minutes, Maestro summarizes it to your number.' : 'Let this chat control Maestro with the permissions you choose.'}</p>
        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={labelStyle}>{isWa ? 'Project' : 'Default project'}</span>
          <select value={projectId} onChange={e => setProjectId(e.target.value)} style={selectStyle}>
            <option value="">First project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {isWa ? (
          <label style={{ display: 'block', marginBottom: 18 }}>
            <span style={labelStyle}>Session</span>
            <select value={sessionId} onChange={e => setSessionId(e.target.value)} disabled={!projectId} style={{ ...selectStyle, opacity: projectId ? 1 : 0.5 }}>
              <option value="">{projectId ? 'No specific session' : 'Pick a project first'}</option>
              {sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </label>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
            {rows.map(([k, label, sub]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1 }}><span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{label}</span><span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>{sub}</span></span>
                <Toggle on={perms[k]} onChange={v => setPerms(pr => ({ ...pr, [k]: v }))} />
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={bind} disabled={busy} style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: isWa ? 'var(--green)' : 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{busy ? 'Saving…' : isWa ? 'Track chat' : 'Bind chat'}</button>
        </div>
      </div>
    </div>
  );
}

function ago(ts: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function BindingsTab({ bindings, pending, projects, sessions, waChats, onChanged }: { bindings: ChatBinding[]; pending: PendingChat[]; projects: Project[]; sessions: ChatSession[]; waChats: WaChatSummary[]; onChanged: () => void }) {
  const [bindTarget, setBindTarget] = React.useState<PendingChat | null>(null);
  const projName = (id: string | null) => projects.find(p => p.id === id)?.name ?? 'First project';
  const sessName = (id?: string | null) => (id ? sessions.find(s => s.id === id)?.title : undefined);
  const tint = (provider: CommsProvider) => provider === 'whatsapp' ? 'var(--green)' : 'var(--blue)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 760 }}>
      <div>
        <div style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Pending · {pending.length}</div>
        {pending.length === 0 ? <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No chats waiting. Message your Telegram bot or send to a linked WhatsApp chat, and it’ll appear here.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pending.map(c => { const prov = providerOf(c.chatId); return (
                <div key={c.chatId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)' }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${tint(prov)} 13%, transparent)`, color: tint(prov) }}><ProviderGlyph provider={prov} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{c.name}</span>
                    <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>“{c.firstText}”</span>
                  </span>
                  <button onClick={() => setBindTarget(c)} style={{ height: 32, padding: '0 14px', borderRadius: 8, background: tint(prov), color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>{prov === 'whatsapp' ? 'Track' : 'Bind'}</button>
                </div>
              ); })}
            </div>}
      </div>

      <div>
        <div style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Bound chats · {bindings.length}</div>
        {bindings.length === 0 ? <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No bound chats yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bindings.map(b => { const prov = b.provider ?? 'telegram'; const isWa = prov === 'whatsapp'; const wc = isWa ? waChats.find(w => w.chatId === b.chatId) : undefined; return (
                <div key={b.chatId} style={{ padding: 14, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: isWa ? 0 : 12 }}>
                    <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${tint(prov)} 13%, transparent)`, color: tint(prov) }}><ProviderGlyph provider={prov} /></span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{b.name}</span>
                      <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)' }}>{projName(b.projectId)}{isWa && sessName(b.sessionId) ? ` · ${sessName(b.sessionId)}` : ''}</span>
                    </span>
                    {isWa && <span title="Summarized to your number after 15 min of silence" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="clock" size={12} /> Quiet 15m</span>}
                    <button onClick={() => void api.unbindChat(b.chatId).then(onChanged)} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: 'transparent', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>{isWa ? 'Untrack' : 'Unbind'}</button>
                  </div>
                  {isWa ? (
                    <div style={{ marginTop: 8, font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>{wc ? `${wc.count} message${wc.count !== 1 ? 's' : ''} captured · last summary ${ago(wc.lastReportedAt)}` : 'No messages captured yet.'}</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                      {([['startJobs', 'Start jobs'], ['receiveReports', 'Reports'], ['approveGates', 'Approve gates']] as [keyof ChatPermissions, string][]).map(([k, label]) => (
                        <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Toggle on={b.permissions[k]} onChange={v => void api.setChatPermissions(b.chatId, { [k]: v }).then(onChanged)} />
                          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ); })}
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

const TABS: [string, string][] = [['channels', 'Channels'], ['bindings', 'Bindings'], ['activity', 'Activity']];

export default function CommsGateway() {
  const [tab, setTab] = React.useState('channels');
  const [status, setStatus] = React.useState<CommsStatus | null>(null);
  const [wa, setWa] = React.useState<WhatsAppState | null>(null);
  const [bindings, setBindings] = React.useState<ChatBinding[]>([]);
  const [pending, setPending] = React.useState<PendingChat[]>([]);
  const [events, setEvents] = React.useState<CommEvent[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [waChats, setWaChats] = React.useState<WaChatSummary[]>([]);

  const refetch = React.useCallback(() => {
    api.commsStatus().then(setStatus).catch(() => {});
    api.whatsappStatus().then(setWa).catch(() => {});
    api.listChatBindings().then(setBindings).catch(() => {});
    api.listPendingChats().then(setPending).catch(() => {});
    api.listCommEvents().then(setEvents).catch(() => {});
    api.listWaChats().then(setWaChats).catch(() => {});
  }, []);
  React.useEffect(() => {
    refetch();
    api.listProjects().then(setProjects).catch(() => {});
    api.listSessions().then(setSessions).catch(() => {});
    const unsub = api.subscribe({ onComms: refetch });
    const poll = setInterval(refetch, 8000); // pending chats arrive via long-poll on the Mac
    return () => { unsub(); clearInterval(poll); };
  }, [refetch]);

  return (
    <AppShell active="comms" onSearch={() => {}}>
      <style>{CSS}</style>
      <div style={{ padding: '24px 28px 36px' }}>
        <h1 style={{ margin: '0 0 4px', font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Comms</h1>
        <p style={{ margin: '0 0 20px', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Drive Maestro from Telegram, and let WhatsApp chats summarize themselves to your number when they go quiet — all on this Mac.</p>

        <div style={{ display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11, marginBottom: 22 }}>
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{ width: 116, padding: '8px 0', textAlign: 'center', borderRadius: 8, font: `${tab === k ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === k ? 'var(--ink)' : 'var(--ink-secondary)', background: tab === k ? 'var(--bg-elevated)' : 'transparent', boxShadow: tab === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none' }}>
              {label}{k === 'bindings' && pending.length > 0 ? ` · ${pending.length}` : ''}
            </button>
          ))}
        </div>

        <div key={tab} className="tab-fade">
          {tab === 'channels' && <ChannelsTab status={status} wa={wa} onChanged={refetch} />}
          {tab === 'bindings' && <BindingsTab bindings={bindings} pending={pending} projects={projects} sessions={sessions} waChats={waChats} onChanged={refetch} />}
          {tab === 'activity' && <ActivityTab events={events} />}
        </div>
      </div>
    </AppShell>
  );
}
