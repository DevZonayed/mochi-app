/* Approvals Center — gate queue data + left list (grouped by urgency). */

const AC_PROJ = {
  atlas:   { name: 'Atlas API',     color: 'var(--blue)' },
  content: { name: 'Q3 Content',    color: 'var(--purple)' },
  scan:    { name: 'Market Scan',   color: 'var(--indigo)' },
  brand:   { name: 'Brand Refresh', color: 'var(--teal)' },
  infra:   { name: 'Infra / CI',    color: 'var(--orange)' },
};

const GATE_TYPE = {
  plan:    { icon: 'sliders', tint: 'var(--blue)',   label: 'Plan' },
  publish: { icon: 'play',    tint: 'var(--purple)', label: 'Publish' },
  merge:   { icon: 'gitMerge',tint: 'var(--green)',  label: 'Merge' },
  send:    { icon: 'send',     tint: 'var(--teal)',   label: 'Send' },
  budget:  { icon: 'gauge',    tint: 'var(--orange)', label: 'Over budget' },
  skill:   { icon: 'shield',   tint: 'var(--indigo)', label: 'Skill' },
};

const GATES = [
  // over budget
  { id: 'g1', type: 'budget', proj: 'scan', urgency: 'budget', summary: 'Deep run needs $4.10 over the $50 cap', age: '1 min', scheduled: true, unread: true,
    detail: { need: 4.10, cap: 50, spent: 49.30, run: 'Competitor digest' } },
  // waiting longest
  { id: 'g2', type: 'merge', proj: 'atlas', urgency: 'old', summary: 'Merge PR #482 — auth refactor', age: '14 min',
    detail: { pr: 482, files: 12, add: 840, del: 210, verdict: 'clear', findings: '2 issues → fixed in loop' } },
  { id: 'g3', type: 'skill', proj: 'brand', urgency: 'old', summary: 'Allow unverified skill: figma-export', age: '13 min',
    detail: { skill: 'figma-export', ver: '0.3.1', publisher: 'community', caps: [
      { kind: 'net', label: 'api.figma.com', risk: 'amber' }, { kind: 'net', label: '*.amazonaws.com', risk: 'red' },
      { kind: 'fs', label: '~/Exports (read-write)', risk: 'amber' }, { kind: 'fs', label: 'project assets (read)', risk: 'grey' } ] } },
  { id: 'g4', type: 'publish', proj: 'content', urgency: 'old', summary: 'Publish “Launch week” thread to X', age: '9 min',
    detail: { platform: 'X', caption: 'Maestro is live. One operator, a fleet of agents — projects, schedules, and budgets from one calm place. Here’s what shipped this week ↓', posts: 6, consent: false } },
  // new
  { id: 'g5', type: 'plan', proj: 'atlas', urgency: 'new', unread: true, summary: 'Approve plan — add rate-limiter tests', age: '1 min',
    detail: { title: 'Add rate-limiter tests', effort: 'BALANCED', cost: '0.30', mins: '4', steps: ['Generate fixtures for the 429 path', 'Mock the Redis token bucket', 'Assert the Retry-After header', 'Wire into the CI matrix'] } },
  { id: 'g6', type: 'send', proj: 'content', urgency: 'new', unread: true, summary: 'Send newsletter to 3,210 subscribers', age: '2 min',
    detail: { channel: 'Email · Resend', recipients: '3,210', subject: 'What shipped in Maestro this week', consent: true } },
  { id: 'g7', type: 'publish', proj: 'brand', urgency: 'new', summary: 'Publish icon set to Dribbble', age: '4 min',
    detail: { platform: 'Dribbble', caption: 'Fresh system icons — 48 glyphs, 3 weights, exported @3x.', posts: 1, consent: false } },
  { id: 'g8', type: 'plan', proj: 'infra', urgency: 'new', summary: 'Approve plan — dependency upgrade', age: '6 min',
    detail: { title: 'Upgrade dependencies (minor)', effort: 'FAST', cost: '0.12', mins: '2', steps: ['Bump 14 minor versions', 'Run the full test suite', 'Open a PR if green'] } },
];

const URGENCY = [
  { key: 'budget', label: 'Over budget', tint: 'var(--orange)' },
  { key: 'old', label: 'Waiting longest', tint: 'var(--ink-secondary)' },
  { key: 'new', label: 'New', tint: 'var(--blue)' },
];

function QueueRow({ g, active, onClick }) {
  const t = GATE_TYPE[g.type];
  const p = AC_PROJ[g.proj];
  return (
    <button onClick={() => onClick(g)} className="q-row" style={{ display: 'flex', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: 12,
      background: active ? 'var(--fill-secondary)' : 'transparent', border: active ? '0.5px solid var(--separator)' : '0.5px solid transparent', position: 'relative' }}>
      {g.unread && <span style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', width: 7, height: 7, borderRadius: 4, background: 'var(--blue)' }} />}
      <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${t.tint} 14%, transparent)`, color: t.tint }}>
        <Icon name={t.icon} size={19} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color, flexShrink: 0 }} />
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{p.name}</span>
          {g.scheduled && <Icon name="clock" size={11} style={{ color: 'var(--ink-tertiary)' }} title="Raised by a scheduled job" />}
          <span style={{ flex: 1 }} />
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{g.age}</span>
        </span>
        <span style={{ display: 'block', font: `${g.unread ? 700 : 500} var(--fs-subhead)/1.3 var(--font-text)`, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.summary}</span>
      </span>
    </button>
  );
}

function QueueList({ gates, activeId, onPick }) {
  return (
    <aside style={{ width: 360, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 18px 14px' }}>
        <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Approvals</h1>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 24, height: 24, padding: '0 8px', borderRadius: 'var(--r-pill)',
          background: 'var(--red)', color: '#fff', font: '700 var(--fs-footnote)/1 var(--font-mono)' }}>{gates.length}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 14px' }}>
        {URGENCY.map(u => {
          const rows = gates.filter(g => g.urgency === u.key);
          if (!rows.length) return null;
          return (
            <div key={u.key} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 8px 7px' }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: u.tint }} />
                <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{u.label}</span>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>· {rows.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {rows.map(g => <QueueRow key={g.id} g={g} active={activeId === g.id} onClick={onPick} />)}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

Object.assign(window, { AC_PROJ, GATE_TYPE, GATES, URGENCY, QueueRow, QueueList });
