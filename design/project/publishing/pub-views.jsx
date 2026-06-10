/* Publishing Center — Drafts grid, Calendar, Platforms, Ledger. */

function PlatChip({ p, small }) {
  const pl = PLATFORMS[p];
  return (
    <span title={pl.name} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: small ? 24 : 28, height: small ? 24 : 28, borderRadius: 7,
      background: 'var(--fill-secondary)', color: pl.tint }}><PGlyph p={p} size={small ? 14 : 16} /></span>
  );
}

function DraftsGrid({ onApprove }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px,1fr))', gap: 18 }}>
      {DRAFTS.map(d => (
        <div key={d.id} data-draft={d.id} className="draft-card" style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 14, padding: 14 }}>
            <div style={{ width: d.ar === '9/16' ? 64 : 104, aspectRatio: d.ar, borderRadius: 10, background: d.tint, flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
              <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.85)' }}><Icon name="play" size={20} /></span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: '600 var(--fs-callout)/1.25 var(--font-text)', color: 'var(--ink)', marginBottom: 5 }}>{d.title}</div>
              <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.cap}</div>
            </div>
          </div>
          <div style={{ padding: '0 14px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>{d.dest.map(p => <PlatChip key={p} p={p} small />)}</div>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}><Icon name="clock" size={12} /> {d.when}</span>
          </div>
          <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={11} /> AI label ✓ · C2PA ✓</span>
            {d.inapp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)' }}><Icon name="alert" size={11} /> Goes to in-app drafts (platform rule)</span>}
          </div>
          <div style={{ display: 'flex', gap: 9, padding: '12px 14px', borderTop: '0.5px solid var(--separator)', marginTop: 'auto' }}>
            <button onClick={() => onApprove(d.id)} className="primary-cta" style={{ flex: 1, height: 38, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(0,122,255,0.28)' }}>Approve &amp; schedule</button>
            <button className="ghost-btn" style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Edit</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const PUB_WEEK = ['Mon 15', 'Tue 16', 'Wed 17', 'Thu 18', 'Fri 19', 'Sat 20', 'Sun 21'];
const PUB_EVENTS = [
  { day: 0, time: '09:00', p: 'instagram', label: 'Icon set' },
  { day: 2, time: '14:00', p: 'youtube', label: 'Launch film' },
  { day: 2, time: '16:30', p: 'x', label: 'Launch thread' },
  { day: 4, time: '11:00', p: 'youtube', label: 'Render farm' },
  { day: 4, time: '18:00', p: 'linkedin', label: 'Recap post' },
  { day: 5, time: '10:00', p: 'tiktok', label: 'Teaser' },
];
function PubCalendar() {
  const hours = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'];
  const rowFor = t => hours.findIndex(h => h >= t.slice(0, 2) + ':00') >= 0 ? Math.max(0, Math.floor((parseInt(t) - 8) / 2)) : 0;
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,1fr)', borderBottom: '0.5px solid var(--separator)' }}>
        <div style={{ borderRight: '0.5px solid var(--separator)' }} />
        {PUB_WEEK.map((d, i) => <div key={i} style={{ padding: '11px 0', textAlign: 'center', font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: i === 2 ? 'var(--red)' : 'var(--ink)', borderRight: i < 6 ? '0.5px solid var(--separator)' : 'none' }}>{d}</div>)}
      </div>
      {hours.map((h, hi) => (
        <div key={h} style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,1fr)', borderBottom: hi < hours.length - 1 ? '0.5px solid var(--separator)' : 'none', minHeight: 64 }}>
          <div style={{ borderRight: '0.5px solid var(--separator)', padding: '6px 8px 0', textAlign: 'right', font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{h}</div>
          {PUB_WEEK.map((_, di) => (
            <div key={di} style={{ borderRight: di < 6 ? '0.5px solid var(--separator)' : 'none', padding: 4, display: 'flex', flexDirection: 'column', gap: 4, background: di === 2 ? 'color-mix(in srgb, var(--red) 2%, transparent)' : 'transparent' }}>
              {PUB_EVENTS.filter(e => e.day === di && rowFor(e.time) === hi).map((e, i) => (
                <div key={i} className="pub-chip" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 7px', borderRadius: 7, cursor: 'grab',
                  background: `color-mix(in srgb, ${PLATFORMS[e.p].tint} 14%, var(--bg-elevated))`, border: `1px solid color-mix(in srgb, ${PLATFORMS[e.p].tint} 35%, transparent)` }}>
                  <span style={{ color: PLATFORMS[e.p].tint, flexShrink: 0 }}><PGlyph p={e.p} size={12} /></span>
                  <span style={{ font: '600 var(--fs-caption)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const PLAT_ROWS = [
  { p: 'youtube', status: 'connected', quota: '4 / 6 uploads today', pct: 0.66 },
  { p: 'tiktok', status: 'connected', quota: 'Tokens refresh in 14h', pct: 0.4, audit: 'Audit pending · posts are self-only' },
  { p: 'instagram', status: 'connected', quota: '8 / 25 posts today', pct: 0.32 },
  { p: 'x', status: 'connected', quota: 'Unlimited · paid tier', pct: 0.2, cost: '~$0.20 per post with URL — links go in replies' },
  { p: 'linkedin', status: 'connected', quota: '3 / 5 posts today', pct: 0.6 },
  { p: 'pinterest', status: 'exhausted', quota: 'Daily limit reached · resets 6h', pct: 1 },
  { p: 'bluesky', status: 'disconnected', quota: '', pct: 0 },
];
function PlatformsTab() {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {PLAT_ROWS.map((r, i) => {
        const pl = PLATFORMS[r.p];
        const sMap = { connected: ['Connected', 'var(--green)'], exhausted: ['Quota exhausted', 'var(--orange)'], disconnected: ['Not connected', 'var(--ink-tertiary)'] };
        const [sl, st] = sMap[r.status];
        return (
          <div key={r.p} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px', borderBottom: i < PLAT_ROWS.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: pl.tint }}><PGlyph p={r.p} size={22} /></span>
            <div style={{ width: 130, flexShrink: 0 }}>
              <div style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{pl.name}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: st, marginTop: 3 }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: st }} /> {sl}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {r.status !== 'disconnected' && (
                <React.Fragment>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: r.status === 'exhausted' ? 'var(--orange)' : 'var(--ink-secondary)' }}>{r.quota}</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden', maxWidth: 280 }}>
                    <div style={{ width: `${r.pct * 100}%`, height: '100%', borderRadius: 3, background: r.status === 'exhausted' ? 'var(--orange)' : pl.tint }} />
                  </div>
                </React.Fragment>
              )}
              {r.audit && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 7, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.13)', color: 'var(--orange)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={11} /> {r.audit}</div>}
              {r.cost && <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 6 }}>{r.cost}</div>}
            </div>
            <button className={r.status === 'disconnected' ? 'primary-cta' : 'ghost-btn'} style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', flexShrink: 0,
              background: r.status === 'disconnected' ? 'var(--blue)' : 'var(--fill-secondary)', color: r.status === 'disconnected' ? '#fff' : 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: r.status === 'disconnected' ? '0 4px 14px rgba(0,122,255,0.28)' : 'none' }}>
              {r.status === 'disconnected' ? 'Connect' : 'Reconnect'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const LEDGER = [
  { time: '14:02', p: ['youtube'], asset: 'linear-gradient(135deg,#0E2A5E,#30B0C7)', ok: true, cost: '1 unit', hash: '9f2c…e3a1' },
  { time: '13:40', p: ['x', 'linkedin'], asset: 'linear-gradient(135deg,#1b2a4a,#5856D6)', ok: true, cost: '$0.20', hash: '4ab8…77d1' },
  { time: '11:15', p: ['instagram'], asset: 'linear-gradient(135deg,#2a1b4a,#AF52DE)', ok: false, cost: '—', hash: 'c19e…02ba' },
  { time: '09:30', p: ['pinterest'], asset: 'linear-gradient(135deg,#3a1b2a,#FF3B30)', ok: true, cost: '1 pin', hash: '7d10…aa3f' },
  { time: 'Yest 18:00', p: ['tiktok'], asset: 'linear-gradient(135deg,#1b3a2a,#1F8A5B)', ok: true, cost: '1 token', hash: 'b81e…e3a1' },
];
function LedgerTab() {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 60px 1.4fr 0.9fr 0.8fr 1fr', gap: 14, padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {['Time', 'Asset', 'Platforms', 'Outcome', 'Cost', 'Provenance'].map((h, i) => <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{h}</span>)}
      </div>
      {LEDGER.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 60px 1.4fr 0.9fr 0.8fr 1fr', gap: 14, alignItems: 'center', padding: '12px 18px', borderBottom: i < LEDGER.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{r.time}</span>
          <span style={{ width: 30, height: 30, borderRadius: 7, background: r.asset, border: '0.5px solid var(--separator)' }} />
          <span style={{ display: 'flex', gap: 6 }}>{r.p.map(p => <PlatChip key={p} p={p} small />)}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1 var(--font-text)', color: r.ok ? 'var(--green)' : 'var(--red)' }}>
            <Icon name={r.ok ? 'checkCircle' : 'xCircle'} size={15} /> {r.ok ? 'Published' : 'Failed'}{!r.ok && <button className="link-btn" style={{ color: 'var(--blue)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Retry</button>}
          </span>
          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{r.cost}</span>
          <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{r.hash}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { PlatChip, DraftsGrid, PubCalendar, PlatformsTab, LedgerTab });
