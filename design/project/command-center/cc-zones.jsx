/* Command Center data + the three content zones:
   NeedsYouStrip, ActiveJobs, RightRail. */

const PROJECTS = {
  atlas:  { name: 'Atlas API',     color: 'var(--blue)' },
  brand:  { name: 'Brand Refresh', color: 'var(--teal)' },
  content:{ name: 'Q3 Content',    color: 'var(--purple)' },
  scan:   { name: 'Market Scan',   color: 'var(--indigo)' },
};

function ProjectChip({ id, small }) {
  const p = PROJECTS[id];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, flexShrink: 0 }} />
      <span style={{ font: `600 ${small ? 'var(--fs-caption)' : 'var(--fs-footnote)'}/1 var(--font-text)`, color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{p.name}</span>
    </span>
  );
}

/* ───────────────────────── Needs-you strip ───────────────────────── */
const GATES = [
  { id: 'g1', project: 'atlas',  type: 'merge',  icon: 'gitMerge', tint: 'var(--blue)',   summary: 'Merge PR #482 — auth refactor', meta: '12 files · +840 −210', age: '4 min' },
  { id: 'g2', project: 'scan',   type: 'budget', icon: 'alert',    tint: 'var(--red)',    summary: 'Deep run will exceed the $5 cap', meta: 'Est. $6.40 · competitor digest', age: '1 min' },
  { id: 'g3', project: 'content',type: 'publish',icon: 'send',     tint: 'var(--purple)', summary: 'Publish “Launch week” thread to X', meta: '6 posts · scheduled 14:00', age: '9 min' },
  { id: 'g4', project: 'brand',  type: 'plan',   icon: 'sliders',  tint: 'var(--teal)',   summary: 'Approve export plan — icon set @3x', meta: '48 assets · 2 formats', age: '12 min' },
];

function NeedsYouStrip({ gates, onApprove }) {
  if (gates.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px',
        background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)',
      }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(52,199,89,0.16)', color: 'var(--green)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="check" size={19} stroke={2.5} />
        </span>
        <span style={{ font: '500 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Nothing needs you — the fleet is working.</span>
      </div>
    );
  }
  return (
    <div>
      <ZoneLabel icon="shield" tint="var(--red)">Needs you · {gates.length}</ZoneLabel>
      <div className="needs-scroll" style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4, scrollbarWidth: 'none' }}>
        {gates.map(g => (
          <div key={g.id} className="gate-card" style={{
            width: 290, flexShrink: 0, background: 'var(--bg-elevated)', borderRadius: 14,
            border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 14,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: `color-mix(in srgb, ${g.tint} 15%, transparent)`, color: g.tint }}>
                <Icon name={g.icon} size={17} />
              </span>
              <ProjectChip id={g.project} />
              <span style={{ flex: 1 }} />
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{g.age}</span>
            </div>
            <div>
              <div style={{ font: '600 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{g.summary}</div>
              <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 3 }}>{g.meta}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
              <button onClick={() => onApprove(g.id)} className="gate-approve" style={{
                flex: 1, height: 32, borderRadius: 8, background: 'var(--blue)', color: '#fff',
                font: '600 var(--fs-footnote)/1 var(--font-text)',
              }}>{g.type === 'budget' ? 'Raise cap' : 'Approve'}</button>
              <button className="gate-review" style={{
                flex: 1, height: 32, borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)',
                font: '600 var(--fs-footnote)/1 var(--font-text)',
              }}>Review</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Active jobs ───────────────────────── */
const JOBS = [
  { id: 'j1', project: 'atlas', title: 'Refactor auth service', status: 'Building', tint: 'var(--purple)', progress: 64, tokens: '18.2k', cost: '0.42', elapsed: '4:21',
    stream: ['writing migration for sessions table…', 'updating middleware/verifyToken.ts', 'running typecheck — 0 errors', 'patching 3 call sites in routes/'] },
  { id: 'j2', project: 'brand', title: 'Export icon set @3x', status: 'Rendering', tint: 'var(--teal)', progress: 88, tokens: '6.1k', cost: '0.12', elapsed: '1:08',
    stream: ['rasterizing nav-home@3x.png', 'optimizing with pngquant…', 'zipping 48 assets'] },
  { id: 'j3', project: 'content', title: 'Draft launch thread', status: 'Reviewing', tint: 'var(--orange)', progress: 100, tokens: '11.4k', cost: '0.07', elapsed: '0:52', review: true,
    stream: ['scoring hook variants…', 'awaiting your review'] },
  { id: 'j4', project: 'atlas', title: 'Add rate-limiter tests', status: 'Building', tint: 'var(--purple)', progress: 32, tokens: '9.7k', cost: '0.21', elapsed: '2:55',
    stream: ['generating fixtures for 429 path', 'mocking Redis token bucket', 'asserting retry-after header'] },
];

function ActiveJobs({ tick }) {
  return (
    <div>
      <ZoneLabel icon="bolt" tint="var(--purple)">Active jobs · {JOBS.length}</ZoneLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {JOBS.map((j, i) => {
          const line = j.stream[(tick + i) % j.stream.length];
          return (
            <div key={j.id} className="job-row" style={{
              background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
              boxShadow: 'var(--card-shadow)', padding: '13px 16px', cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={j.review ? '' : 'breathe'} style={{ width: 9, height: 9, borderRadius: 5, background: j.tint, flexShrink: 0,
                  boxShadow: `0 0 0 4px color-mix(in srgb, ${j.tint} 16%, transparent)` }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.title}</span>
                    <ProjectChip id={j.project} small />
                  </div>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1 var(--font-text)', color: j.tint, flexShrink: 0 }}>
                  {j.review ? <Icon name="enter" size={14} /> : <Spinner size={12} color={j.tint} />}
                  {j.status}
                </span>
              </div>

              {/* progress + meters */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 11 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                  <div style={{ width: `${j.progress}%`, height: '100%', borderRadius: 2,
                    background: j.review ? 'var(--orange)' : 'var(--blue)', transition: 'width 600ms var(--spring)' }} />
                </div>
                <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{j.tokens} tok</span>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>${j.cost}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>
                  <Icon name="clock" size={12} /> {j.elapsed}
                </span>
              </div>

              {/* streaming line */}
              {!j.review && (
                <div className="stream-line" style={{ marginTop: 9, position: 'relative', height: 16, overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', color: 'var(--ink-tertiary)', font: '400 var(--fs-caption)/16px var(--font-mono)', whiteSpace: 'nowrap' }}>
                    <span style={{ color: j.tint, marginRight: 6 }}>›</span>{line}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── Right rail ───────────────────────── */
const SCHEDULE = [
  { time: '14:00', project: 'scan',    label: 'Competitor digest' },
  { time: '16:30', project: 'content', label: 'Newsletter draft' },
  { time: '18:00', project: 'atlas',   label: 'Nightly test suite' },
  { time: '21:00', project: 'brand',   label: 'Asset backup' },
  { time: '06:00', project: 'atlas',   label: 'Dependency audit' },
];
const SPEND = [
  { project: 'atlas',   amount: 18.4 },
  { project: 'content', amount: 9.1 },
  { project: 'scan',    amount: 6.8 },
  { project: 'brand',   amount: 3.9 },
];
const DONE = [
  { ok: true,  project: 'brand',   title: 'Generate OG images', cost: '0.34' },
  { ok: true,  project: 'scan',    title: 'Summarize tickets', cost: '0.11' },
  { ok: false, project: 'atlas',   title: 'Deploy preview', cost: '0.02' },
  { ok: true,  project: 'content', title: 'Translate docs (ES)', cost: '0.46' },
];

function RailCard({ title, action, children }) {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ flex: 1, font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{title}</span>
        {action && <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>{action}</span>}
      </div>
      {children}
    </div>
  );
}

function RightRail() {
  const maxSpend = Math.max(...SPEND.map(s => s.amount));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RailCard title="Today's schedule" action="All">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SCHEDULE.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 0',
              borderBottom: i < SCHEDULE.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', width: 42, flexShrink: 0 }}>{s.time}</span>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: PROJECTS[s.project].color, flexShrink: 0 }} />
              <span style={{ flex: 1, font: '400 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
            </div>
          ))}
        </div>
      </RailCard>

      <RailCard title="Spend today">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SPEND.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 78, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>{PROJECTS[s.project].name}</span>
              <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                <div style={{ width: `${(s.amount / maxSpend) * 100}%`, height: '100%', borderRadius: 4, background: PROJECTS[s.project].color }} />
              </div>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', width: 44, textAlign: 'right', flexShrink: 0 }}>${s.amount.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </RailCard>

      <RailCard title="Recently completed">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {DONE.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
              borderBottom: i < DONE.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <Icon name={d.ok ? 'checkCircle' : 'xCircle'} size={16} style={{ color: d.ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
              <span style={{ flex: 1, font: '500 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: PROJECTS[d.project].color, flexShrink: 0 }} />
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 36, textAlign: 'right', flexShrink: 0 }}>${d.cost}</span>
            </div>
          ))}
        </div>
      </RailCard>
    </div>
  );
}

function ZoneLabel({ icon, tint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
      <Icon name={icon} size={15} style={{ color: tint }} />
      <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{children}</span>
    </div>
  );
}

Object.assign(window, { PROJECTS, ProjectChip, NeedsYouStrip, GATES, ActiveJobs, JOBS, RightRail, ZoneLabel });
