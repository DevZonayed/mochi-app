/* Comms Gateway — channels (Telegram / WhatsApp two-lane), chat bindings,
   activity queue, plus the Lane A risk sheet with hold-to-confirm.

   Ported from the Babel-standalone prototype (design/project/comms/*.jsx +
   command-center/cc-palette.jsx) to an ES-module TypeScript React screen.
   The prototype's WindowFrame + Sidebar + Toolbar chrome maps onto the shared
   AppShell; cross-page navTo navigation becomes react-router useNavigate.
   CommandPalette is defined locally (not exported by the shared lib). Visual
   output — inline styles, classNames, var(--…) variables, SVG geometry,
   animation class names — is preserved exactly. */

import React from 'react';
import { Icon, type IconName } from '../lib/icons';
import { Switch, Spinner } from '../lib/ui';
import { AppShell } from '../lib/appShell';

// Page-specific CSS the prototype's <style> block defined that the shared
// AppShell / global stylesheet don't already provide (the wallpaper, nav,
// search, toolbar, scrollbar, spin + palette keyframes come from there).
const COMMS_CSS = `
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { filter: brightness(1.03); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .tab-fade { animation: tfade 240ms var(--spring); }
  @keyframes tfade { from { transform: translateY(6px); } to { transform: none; } }
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

// ──────────────────────────────────────────────────────────────────────────
// Channel glyphs
// ──────────────────────────────────────────────────────────────────────────

function TelegramGlyph({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M21 5 3 12l5 1.8L17 7l-7 8.2.3 4 2.8-3 4 3L21 5Z" fill="currentColor" /></svg>;
}
function WhatsAppGlyph({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M9 8.5c.2 2 1.3 3.7 3 4.8 1 .6 1.8.6 2.3 0l.5-.7-1.8-1.1-.7.6c-.7-.4-1.3-1-1.6-1.7l.5-.7-1-1.8-.7.3Z" fill="currentColor" /></svg>;
}

// ──────────────────────────────────────────────────────────────────────────
// QR + hold-to-confirm + risk sheet
// ──────────────────────────────────────────────────────────────────────────

function QRCode({ size = 64 }: { size?: number }) {
  const N = 21, cell = size / N;
  let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const finder = (r: number, c: number) => { const box = (br: number, bc: number) => r >= br && r < br + 7 && c >= bc && c < bc + 7; return box(0, 0) || box(0, N - 7) || box(N - 7, 0); };
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { if (finder(r, c)) continue; if (rnd() > 0.5) cells.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} />); }
  const F = (x: number, y: number) => <g><rect x={x} y={y} width={cell * 7} height={cell * 7} rx={cell} fill="none" stroke="#000" strokeWidth={cell} /><rect x={x + cell * 2} y={y + cell * 2} width={cell * 3} height={cell * 3} fill="#000" /></g>;
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="#000" shapeRendering="crispEdges">{cells}{F(0, 0)}{F(size - cell * 7, 0)}{F(0, size - cell * 7)}</svg>;
}

function HoldToConfirm({ onConfirm }: { onConfirm: () => void }) {
  const [pct, setPct] = React.useState(0);
  const [confirmed, setConfirmed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const start = () => {
    if (confirmed) return;
    const t0 = Date.now();
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / 1000);
      setPct(p);
      if (p >= 1) { if (timer.current) clearInterval(timer.current); setConfirmed(true); setTimeout(onConfirm, 250); }
    }, 16);
  };
  const end = () => { if (!confirmed) { if (timer.current) clearInterval(timer.current); setPct(0); } };
  return (
    <button onMouseDown={start} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchEnd={end}
      style={{ position: 'relative', width: '100%', height: 48, borderRadius: 'var(--r-pill)', overflow: 'hidden', background: 'var(--fill-secondary)', userSelect: 'none' }}>
      <span style={{ position: 'absolute', inset: 0, width: `${pct * 100}%`, background: confirmed ? 'var(--green)' : 'var(--orange)', transition: pct === 0 ? 'width 200ms ease' : 'none' }} />
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', height: '100%', font: '600 var(--fs-callout)/1 var(--font-text)', color: pct > 0.4 ? '#fff' : 'var(--ink)' }}>
        {confirmed ? <><Icon name="check" size={17} stroke={3} /> Confirmed</> : <><Icon name="lock" size={15} /> Hold to enable Lane A</>}
      </span>
    </button>
  );
}

function RiskSheet({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = React.useState(false);
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 480, background: 'var(--bg-elevated)', borderRadius: 20, border: '1px solid rgba(255,149,0,0.4)', boxShadow: '0 0 0 5px rgba(255,149,0,0.10), 0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ padding: '24px 24px 18px', textAlign: 'center' }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: 54, height: 54, borderRadius: '50%', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', marginBottom: 16 }}><Icon name="alert" size={27} /></span>
          <h2 style={{ margin: '0 0 10px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Enable Lane A — your own number</h2>
          <p style={{ margin: 0, font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
            Unofficial connection. Accounts get banned — sometimes within weeks. It runs <b style={{ color: 'var(--ink)' }}>isolated</b>; a ban can’t touch your jobs.
          </p>
        </div>
        <div style={{ padding: '0 24px 20px' }}>
          {/* typed confirm */}
          <button onClick={() => setTyped(t => !t)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', textAlign: 'left', marginBottom: 14 }}>
            <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', background: typed ? 'var(--orange)' : 'transparent', border: typed ? 'none' : '1.5px solid var(--separator-strong)' }}>{typed && <Icon name="check" size={13} stroke={3} style={{ color: '#fff' }} />}</span>
            <span style={{ font: '500 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)' }}>I understand this number may be banned, and accept the risk.</span>
          </button>
          {/* QR pairing preview */}
          <div style={{ display: 'flex', gap: 14, padding: 14, borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', marginBottom: 16, opacity: typed ? 1 : 0.5, transition: 'opacity 200ms ease' }}>
            <div style={{ width: 76, height: 76, borderRadius: 10, background: '#fff', flexShrink: 0, padding: 6, border: '0.5px solid var(--separator)' }}><QRCode size={64} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>Pair with WhatsApp</div>
              <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>On your phone: Settings → Linked Devices → Link a Device, then scan.</div>
            </div>
          </div>
          {typed ? <HoldToConfirm onConfirm={onConfirm} /> : <button disabled style={{ width: '100%', height: 48, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Confirm the risk first</button>}
          <button onClick={onClose} style={{ width: '100%', height: 40, marginTop: 10, borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Channels tab
// ──────────────────────────────────────────────────────────────────────────

function Badge2({ icon, tint, children }: { icon: IconName; tint: string; children?: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name={icon} size={12} /> {children}</span>;
}

function ChannelsTab({ onEnableLaneA, laneAOn }: { onEnableLaneA: () => void; laneAOn: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      {/* Telegram */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', background: 'color-mix(in srgb, var(--blue) 8%, transparent)', borderBottom: '0.5px solid var(--separator)' }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 16%, transparent)', color: 'var(--blue)' }}><TelegramGlyph /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>Telegram</div>
            <div style={{ font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>@atlas_ops_bot</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.16)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Connected</span>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <Badge2 icon="check" tint="var(--green)">2GB media server ✓</Badge2>
            <Badge2 icon="command" tint="var(--ink-secondary)">142 messages today</Badge2>
          </div>
          <button className="ghost-btn" style={{ width: '100%', height: 40, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Configure</button>
        </div>
      </div>

      {/* WhatsApp */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', background: 'color-mix(in srgb, var(--green) 8%, transparent)', borderBottom: '0.5px solid var(--separator)' }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--green) 16%, transparent)', color: 'var(--green)' }}><WhatsAppGlyph /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)' }}>WhatsApp</div>
            <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Two lanes</div>
          </div>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Lane A */}
          <div style={{ padding: 14, borderRadius: 12, background: laneAOn ? 'rgba(255,149,0,0.07)' : 'var(--fill-tertiary)', border: `0.5px solid ${laneAOn ? 'rgba(255,149,0,0.3)' : 'var(--separator)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Lane A · Your own number</div>
                <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Opt-in · high ban risk · isolated</div>
              </div>
              <Switch on={laneAOn} onChange={v => { if (v) onEnableLaneA(); }} />
            </div>
            {laneAOn && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--separator)' }}>
                <span className="breathe" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--orange)' }} />
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--orange)' }}>Isolated process · healthy</span>
                <span style={{ flex: 1 }} />
                <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>1 linked device</span>
              </div>
            )}
          </div>
          {/* Lane B */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 14, borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Lane B · Business API</div>
              <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>$0.004–0.025 / message</div>
            </div>
            <button className="primary-cta" style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--green)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(52,199,89,0.28)' }}>Connect via provider</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Chat bindings tab
// ──────────────────────────────────────────────────────────────────────────

interface Binding { chat: string; avatar: string; proj: string; start: boolean; reports: boolean; approve: boolean }

const BINDINGS: Binding[] = [
  { chat: 'Ops War Room', avatar: 'var(--blue)', proj: 'Atlas API', start: true, reports: true, approve: true },
  { chat: 'Content Crew', avatar: 'var(--purple)', proj: 'Q3 Content', start: true, reports: true, approve: false },
  { chat: 'Jillur (DM)', avatar: 'var(--teal)', proj: 'Market Scan', start: false, reports: true, approve: true },
];

function PermToggle({ label, on: initial }: { label: string; on: boolean }) {
  const [on, setOn] = React.useState(initial);
  return (
    <button onClick={() => setOn(o => !o)} style={{
      flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 11, textAlign: 'left',
      background: on ? 'color-mix(in srgb, var(--blue) 9%, transparent)' : 'var(--fill-tertiary)', border: `1px solid ${on ? 'color-mix(in srgb, var(--blue) 30%, transparent)' : 'var(--separator)'}`,
    }}>
      <span style={{ width: 18, height: 18, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', background: on ? 'var(--blue)' : 'transparent', border: on ? 'none' : '1.5px solid var(--separator-strong)' }}>{on && <Icon name="check" size={12} stroke={3} style={{ color: '#fff' }} />}</span>
      <span style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: on ? 'var(--ink)' : 'var(--ink-secondary)' }}>{label}</span>
    </button>
  );
}

function BindingsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820 }}>
      {BINDINGS.map((b, i) => (
        <div key={i} style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <span style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${b.avatar} 18%, transparent)`, color: b.avatar, font: '700 var(--fs-callout)/1 var(--font-display)' }}>{b.chat[0]}</span>
            <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{b.chat}</span>
            <Icon name="arrowRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: b.avatar }} /> {b.proj}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {([['Can start jobs', b.start], ['Receives reports', b.reports], ['Can approve gates', b.approve]] as [string, boolean][]).map(([label, on], j) => (
              <PermToggle key={j} label={label} on={on} />
            ))}
          </div>
          <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="lock" size={12} /> Messages are input, never authority — sensitive actions still gate.
          </div>
        </div>
      ))}
      <button className="ghost-btn" style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--blue)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="plus" size={16} stroke={2.4} /> Add binding</button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Activity tab
// ──────────────────────────────────────────────────────────────────────────

interface QueueRow { ch: 'tg' | 'wa'; to: string; payload: string; state: 'sent' | 'queued' | 'limited'; countdown?: string }

const QUEUE: QueueRow[] = [
  { ch: 'tg', to: 'Ops War Room', payload: 'Build complete — PR #482 ready for review', state: 'sent' },
  { ch: 'wa', to: '+1 469 ··· 2231', payload: 'Daily digest: 3 jobs done, 1 gate waiting', state: 'sent' },
  { ch: 'tg', to: 'Content Crew', payload: 'Newsletter draft ready for approval', state: 'queued' },
  { ch: 'wa', to: '+1 469 ··· 8841', payload: 'Render finished: launch-film-v3.mp4', state: 'limited', countdown: '0:42' },
];

function ActivityTab() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', marginBottom: 16 }}>
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Global rate limit</span>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden', maxWidth: 320 }}>
          <div style={{ width: '38%', height: '100%', borderRadius: 3, background: 'var(--blue)' }} />
        </div>
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>23 / 60 per min</span>
      </div>
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        {QUEUE.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderBottom: i < QUEUE.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: r.ch === 'tg' ? 'var(--blue)' : 'var(--green)' }}>{r.ch === 'tg' ? <TelegramGlyph size={16} /> : <WhatsAppGlyph size={16} />}</span>
            <span style={{ width: 150, flexShrink: 0, font: '600 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.to}</span>
            <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.payload}</span>
            {r.state === 'sent' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--green)', flexShrink: 0 }}><Icon name="check" size={13} stroke={2.6} /> Sent</span>}
            {r.state === 'queued' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', flexShrink: 0 }}><Spinner size={12} /> Queued</span>}
            {r.state === 'limited' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--orange)', flexShrink: 0 }}><Icon name="clock" size={13} /> Rate-limited · {r.countdown}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ⌘K command palette (ported from command-center/cc-palette.jsx; not exported
// by the shared lib)
// ──────────────────────────────────────────────────────────────────────────

interface PaletteItem { group: string; icon: IconName; label: string; hint: string }

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Actions', icon: 'play', label: 'Run job…', hint: 'Start a new job in a project' },
  { group: 'Actions', icon: 'plus', label: 'New project…', hint: 'From a template' },
  { group: 'Actions', icon: 'calendar', label: 'Schedule a run…', hint: 'Pick time & cadence' },
  { group: 'Actions', icon: 'gauge', label: 'Adjust budget cap…', hint: 'Workspace or project' },
  { group: 'Recent', icon: 'gitMerge', label: 'Merge PR #482 — auth refactor', hint: 'Atlas API' },
  { group: 'Recent', icon: 'send', label: 'Publish “Launch week” thread', hint: 'Q3 Content' },
  { group: 'Recent', icon: 'telescope', label: 'Competitor digest', hint: 'Market Scan' },
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 60); }
  }, [open]);

  const filtered = PALETTE_ITEMS.filter(it => it.label.toLowerCase().includes(q.toLowerCase()) || it.hint.toLowerCase().includes(q.toLowerCase()));
  const groups = filtered.reduce((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {} as Record<string, PaletteItem[]>);
  const flat = filtered;

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Escape') { onClose(); }
    else if (e.key === 'Enter') { onClose(); }
  };

  if (!open) return null;
  let idx = -1;
  return (
    <div onMouseDown={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'center', paddingTop: 132,
      background: 'rgba(10,12,24,0.28)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 640, maxHeight: 460, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--glass-border)',
        backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 30px 80px rgba(10,15,40,0.45), var(--glass-inner)', overflow: 'hidden',
        animation: 'palettePop 200ms var(--spring)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Search commands, projects, jobs…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
              font: '400 var(--fs-title2)/1 var(--font-text)', color: 'var(--ink)' }} />
          <span style={{ padding: '3px 7px', borderRadius: 5, background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>esc</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 8 }}>
          {flat.length === 0 && (
            <div style={{ padding: '28px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No matches</div>
          )}
          {Object.entries(groups).map(([group, items]) => (
            <div key={group} style={{ marginBottom: 6 }}>
              <div style={{ padding: '6px 10px 4px', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{group}</div>
              {items.map(it => {
                idx++; const active = idx === sel; const myIdx = idx;
                return (
                  <div key={it.label} onMouseEnter={() => setSel(myIdx)} onMouseDown={onClose} style={{
                    display: 'flex', alignItems: 'center', gap: 11, height: 42, padding: '0 10px', borderRadius: 9, cursor: 'pointer',
                    background: active ? 'var(--blue)' : 'transparent',
                  }}>
                    <span style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0,
                      background: active ? 'rgba(255,255,255,0.2)' : 'var(--fill-secondary)', color: active ? '#fff' : 'var(--ink-secondary)' }}>
                      <Icon name={it.icon} size={16} />
                    </span>
                    <span style={{ flex: 1, font: '500 var(--fs-callout)/1.1 var(--font-text)', color: active ? '#fff' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
                    <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: active ? 'rgba(255,255,255,0.8)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{it.hint}</span>
                    {active && <Icon name="enter" size={15} style={{ color: 'rgba(255,255,255,0.9)' }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Comms Gateway page root (cg-app)
// ──────────────────────────────────────────────────────────────────────────

interface CommsTab { key: string; label: string }

const CG_TABS: CommsTab[] = [
  { key: 'channels', label: 'Channels' },
  { key: 'bindings', label: 'Chat bindings' },
  { key: 'activity', label: 'Activity' },
];

export default function CommsGateway() {
  const [tab, setTab] = React.useState('channels');
  const [riskOpen, setRiskOpen] = React.useState(false);
  const [laneAOn, setLaneAOn] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const ti = CG_TABS.findIndex(t => t.key === tab);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <AppShell active="" budget={{ spent: 38.20, cap: 200, animateKey: 0 }} onSearch={() => setPaletteOpen(true)}>
      <style>{COMMS_CSS}</style>

      <div style={{ padding: '24px 28px 36px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22 }}>
          <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Comms</h1>
          <span style={{ flex: 1 }} />
          <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
            <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * 128px + 3px)`, width: 128, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
            {CG_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 128, padding: '8px 0', font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>{t.label}</button>)}
          </div>
        </div>

        <div key={tab} className="tab-fade">
          {tab === 'channels' && <ChannelsTab laneAOn={laneAOn} onEnableLaneA={() => setRiskOpen(true)} />}
          {tab === 'bindings' && <BindingsTab />}
          {tab === 'activity' && <ActivityTab />}
        </div>
      </div>

      {riskOpen && <RiskSheet onClose={() => setRiskOpen(false)} onConfirm={() => { setLaneAOn(true); setRiskOpen(false); }} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
