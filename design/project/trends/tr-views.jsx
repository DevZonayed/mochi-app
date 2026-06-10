/* Trend Intelligence — signal cards, brief feed, right rail. */

// ── signal cards
const TOPICS = [
  { name: 'AI agents that run overnight', m: 'up', d: '+128%' },
  { name: 'Self-hosted video models', m: 'up', d: '+74%' },
  { name: 'Cost-per-token explainers', m: 'up', d: '+31%' },
  { name: 'Prompt engineering tips', m: 'down', d: '−12%' },
  { name: 'No-code app builders', m: 'down', d: '−8%' },
];
const AUDIO = [
  { name: 'Aphex-style ambient loop', use: 'used in 12k posts' },
  { name: 'Lo-fi tape beat 84bpm', use: 'used in 9.4k posts' },
  { name: 'Cinematic riser + drop', use: 'used in 6.1k posts' },
];

function SignalCard({ title, icon, children }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 13 }}>
        <Icon name={icon} size={15} style={{ color: 'var(--indigo)' }} />
        <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function SignalRow() {
  const heat = [0.2, 0.5, 0.8, 1, 0.6, 0.3, 0.1, 0.4, 0.7, 0.9, 0.5, 0.2, 0.6, 0.85, 1, 0.7, 0.4, 0.2, 0.3, 0.5, 0.8];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
      <SignalCard title="Trending topics" icon="telescope">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {TOPICS.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 14 }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, font: '600 var(--fs-caption)/1 var(--font-mono)', color: t.m === 'up' ? 'var(--green)' : 'var(--red)' }}>
                {t.m === 'up' ? '▲' : '▼'} {t.d}
              </span>
            </div>
          ))}
        </div>
      </SignalCard>

      <SignalCard title="Trending audio" icon="play">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {AUDIO.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <button className="tr-play" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--indigo)' }}><Icon name="play" size={12} /></button>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{a.use}</span>
              </span>
            </div>
          ))}
        </div>
      </SignalCard>

      <SignalCard title="Best times to post" icon="clock">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
          {heat.map((v, i) => <div key={i} style={{ aspectRatio: '1', borderRadius: 3, background: `color-mix(in srgb, var(--blue) ${Math.round(v * 80)}%, var(--fill-secondary))` }} />)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
          <span>Mon</span><span>Sun</span>
        </div>
        <div style={{ font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 8 }}>Peak: <b style={{ color: 'var(--ink)' }}>Wed & Sat, 6–8pm</b></div>
      </SignalCard>

      <SignalCard title="Competitor pulse" icon="cpu">
        <svg viewBox="0 0 120 50" style={{ width: '100%', height: 50 }} preserveAspectRatio="none">
          <polyline points="0,40 15,38 30,30 45,33 60,22 75,25 90,14 105,18 120,8" fill="none" stroke="var(--indigo)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="0,50 0,40 15,38 30,30 45,33 60,22 75,25 90,14 105,18 120,8 120,50" fill="color-mix(in srgb, var(--indigo) 10%, transparent)" stroke="none" />
        </svg>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
          <span style={{ font: '700 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>+18%</span>
          <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>posting velocity vs last week</span>
        </div>
      </SignalCard>
    </div>
  );
}

// ── brief feed
const BRIEFS = [
  { id: 'b1', title: 'Why agents that survive sleep change everything', hook: 'Your best ideas don’t clock out at 5pm — why should your tools?',
    titles: ['I let AI agents run my projects overnight — here’s what I woke up to', 'The case for durable agents (that don’t die when your laptop sleeps)', 'Overnight automation: a calm operator’s setup'],
    platforms: ['youtube', 'x'], conf: 92, live: false },
  { id: 'b2', title: 'Self-hosted video for under a dollar a minute', hook: 'A video minute can cost $45. Here’s how we got ours to $0.90.',
    titles: ['How I render AI video for pennies on my own GPU', 'Stop paying $45/min for AI video — self-host instead', 'The economics of self-hosted video models'],
    platforms: ['youtube', 'linkedin'], conf: 84, live: false },
];

function BriefCard({ b, live, onStudio }) {
  const [sel, setSel] = React.useState(0);
  return (
    <div data-brief={b.id} className="brief-card" style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1, font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{b.title}</h3>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--green) 14%, transparent)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)', flexShrink: 0 }}>
          {b.conf}% confidence
        </span>
      </div>

      {/* hook — the expressive type moment */}
      <div style={{ padding: '14px 18px', borderRadius: 12, background: 'color-mix(in srgb, var(--indigo) 7%, transparent)', borderLeft: '3px solid var(--indigo)', marginBottom: 18 }}>
        <span style={{ font: '500 italic 22px/1.4 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>“{b.hook}”</span>
        {live && <span className="cursor-blink" style={{ marginLeft: 3, color: 'var(--indigo)' }}>▍</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        <div>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Suggested titles</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {b.titles.map((t, i) => (
              <button key={i} onClick={() => setSel(i)} className="title-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, textAlign: 'left',
                background: sel === i ? 'color-mix(in srgb, var(--indigo) 9%, transparent)' : 'var(--fill-tertiary)', border: `1px solid ${sel === i ? 'color-mix(in srgb, var(--indigo) 35%, transparent)' : 'var(--separator)'}` }}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: sel === i ? 'var(--indigo)' : 'transparent', border: sel === i ? 'none' : '1.5px solid var(--separator-strong)' }}>{sel === i && <Icon name="check" size={11} stroke={3} style={{ color: '#fff' }} />}</span>
                <span style={{ font: '500 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)' }}>{t}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Thumbnail concepts</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {['linear-gradient(135deg,#2a1b4a,#5856D6)', 'linear-gradient(135deg,#1b2a4a,#007AFF)', 'linear-gradient(135deg,#1b3a2a,#1F8A5B)', 'linear-gradient(135deg,#3a2a1b,#FF9500)'].map((g, i) => (
              <div key={i} style={{ aspectRatio: '16/10', borderRadius: 9, background: g, display: 'grid', placeItems: 'center', border: '0.5px solid var(--separator)' }}>
                <Icon name="image" size={18} style={{ color: 'rgba(255,255,255,0.7)' }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, paddingTop: 16, borderTop: '0.5px solid var(--separator)' }}>
        <div style={{ display: 'flex', gap: 6 }}>{b.platforms.map(p => <span key={p} style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: PLATFORMS[p].tint }}><PGlyph p={p} size={14} /></span>)}</div>
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="calendar" size={16} /> Schedule series</button>
        <button onClick={() => onStudio(b.id)} className="studio-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--teal)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(48,176,199,0.32)' }}><Icon name="clapper" size={16} /> Send to Studio</button>
      </div>
    </div>
  );
}

function ResearchRail() {
  const runs = [['Tech explainers · YouTube', '12 min ago', 'done'], ['TikTok hooks · short-form', '2 hr ago', 'done'], ['Competitor sweep · weekly', 'Yesterday', 'done']];
  const sources = [['Official APIs', 'ok'], ['YouTube Data API', 'ok'], ['Scraper · trend mirror', 'risk']];
  return (
    <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', padding: 18, overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Research history</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 22 }}>
        {runs.map((r, i) => (
          <a key={i} href="../session-transcript/Session Transcript.html" className="run-link" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 11px', borderRadius: 10, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', textDecoration: 'none' }}>
            <Icon name="checkCircle" size={15} style={{ color: 'var(--green)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r[0]}</span>
              <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{r[1]}</span>
            </span>
            <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
          </a>
        ))}
      </div>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Source health</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sources.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 11px', borderRadius: 10, background: s[1] === 'risk' ? 'rgba(255,149,0,0.08)' : 'var(--fill-tertiary)', border: `0.5px solid ${s[1] === 'risk' ? 'rgba(255,149,0,0.3)' : 'var(--separator)'}` }}>
            <Icon name={s[1] === 'risk' ? 'alert' : 'check'} size={14} stroke={2.4} style={{ color: s[1] === 'risk' ? 'var(--orange)' : 'var(--green)', flexShrink: 0 }} />
            <span style={{ flex: 1, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>{s[0]}{s[1] === 'risk' && <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--orange)', marginTop: 2 }}>Risk-flagged · isolated</span>}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

Object.assign(window, { SignalRow, BriefCard, BRIEFS, ResearchRail });
