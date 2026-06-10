/* Comms Gateway — Channels, Chat bindings, Activity + Lane A risk sheet. */

// ── Channels
function TelegramGlyph({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M21 5 3 12l5 1.8L17 7l-7 8.2.3 4 2.8-3 4 3L21 5Z" fill="currentColor"/></svg>;
}
function WhatsAppGlyph({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Z" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M9 8.5c.2 2 1.3 3.7 3 4.8 1 .6 1.8.6 2.3 0l.5-.7-1.8-1.1-.7.6c-.7-.4-1.3-1-1.6-1.7l.5-.7-1-1.8-.7.3Z" fill="currentColor"/></svg>;
}

function ChannelsTab({ onEnableLaneA, laneAOn }) {
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

function Badge2({ icon, tint, children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name={icon} size={12} /> {children}</span>;
}

// ── Chat bindings
const BINDINGS = [
  { chat: 'Ops War Room', avatar: 'var(--blue)', proj: 'Atlas API', start: true, reports: true, approve: true },
  { chat: 'Content Crew', avatar: 'var(--purple)', proj: 'Q3 Content', start: true, reports: true, approve: false },
  { chat: 'Jillur (DM)', avatar: 'var(--teal)', proj: 'Market Scan', start: false, reports: true, approve: true },
];
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
            {[['Can start jobs', b.start], ['Receives reports', b.reports], ['Can approve gates', b.approve]].map(([label, on], j) => (
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
function PermToggle({ label, on: initial }) {
  const [on, setOn] = React.useState(initial);
  return (
    <button onClick={() => setOn(o => !o)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 11, textAlign: 'left',
      background: on ? 'color-mix(in srgb, var(--blue) 9%, transparent)' : 'var(--fill-tertiary)', border: `1px solid ${on ? 'color-mix(in srgb, var(--blue) 30%, transparent)' : 'var(--separator)'}` }}>
      <span style={{ width: 18, height: 18, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', background: on ? 'var(--blue)' : 'transparent', border: on ? 'none' : '1.5px solid var(--separator-strong)' }}>{on && <Icon name="check" size={12} stroke={3} style={{ color: '#fff' }} />}</span>
      <span style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: on ? 'var(--ink)' : 'var(--ink-secondary)' }}>{label}</span>
    </button>
  );
}

// ── Activity
const QUEUE = [
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

Object.assign(window, { TelegramGlyph, WhatsAppGlyph, ChannelsTab, BindingsTab, ActivityTab });
