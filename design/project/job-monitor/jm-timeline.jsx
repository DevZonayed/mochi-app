/* Job Monitor — data model + timeline (swim-lane) view. */

// time axis in "minutes": now sits at NOW_MIN; axis spans 0..AXIS_MAX
const NOW_MIN = 60, AXIS_MAX = 96, PX = 10.6, LANE_LABEL = 158, LANE_H = 60, TRACK_W = AXIS_MAX * PX;

const LANES = [
  { id: 'atlas',   name: 'Atlas API',     color: 'var(--blue)' },
  { id: 'brand',   name: 'Brand Refresh', color: 'var(--teal)' },
  { id: 'content', name: 'Q3 Content',    color: 'var(--purple)' },
  { id: 'scan',    name: 'Market Scan',   color: 'var(--indigo)', capped: true },
  { id: 'infra',   name: 'Infra / CI',    color: 'var(--orange)' },
];

// status: running | gated | queued | failed | done | scheduled
const MON_JOBS = [
  { id: 'm1',  lane: 'atlas',   name: 'Refactor auth service', status: 'running',   start: 44, end: 60, cost: 0.42, shape: 'pbr',      trigger: 'hand',    effort: 'DEEP',     autonomy: 'Gated', last: 'patching 3 call sites in routes/' },
  { id: 'm2',  lane: 'atlas',   name: 'Add rate-limiter tests',status: 'running',   start: 53, end: 60, cost: 0.21, shape: 'fanout',   trigger: 'webhook', effort: 'BALANCED', autonomy: 'Gated', last: 'asserting retry-after header' },
  { id: 'm3',  lane: 'atlas',   name: 'Nightly test suite',    status: 'scheduled', start: 72, dur: 9,  cost: 0,    shape: 'pipeline', trigger: 'clock',   effort: 'FAST',     autonomy: 'Unattended', last: 'queued for 18:00' },
  { id: 'm4',  lane: 'brand',   name: 'Export icon set @3x',   status: 'running',   start: 55, end: 60, cost: 0.12, shape: 'fanout',   trigger: 'hand',    effort: 'BALANCED', autonomy: 'Gated', last: 'optimizing with pngquant…' },
  { id: 'm5',  lane: 'brand',   name: 'Generate OG images',    status: 'done',      start: 28, end: 41, cost: 0.34, shape: 'fanout',   trigger: 'hand',    effort: 'BALANCED', autonomy: 'Gated', last: 'zipped 24 assets' },
  { id: 'm6',  lane: 'brand',   name: 'Newsletter hero',       status: 'queued',    start: 60, dur: 5,  cost: 0,    shape: 'single',   trigger: 'hand',    effort: 'BALANCED', autonomy: 'Plan first', last: 'waiting for a slot' },
  { id: 'm7',  lane: 'content', name: 'Draft launch thread',   status: 'gated',     start: 49, end: 58, cost: 0.07, shape: 'single',   trigger: 'chat',    effort: 'BALANCED', autonomy: 'Gated', last: 'awaiting your review' },
  { id: 'm8',  lane: 'content', name: 'Newsletter draft',      status: 'scheduled', start: 79, dur: 10, cost: 0,    shape: 'pipeline', trigger: 'clock',   effort: 'BALANCED', autonomy: 'Gated', last: 'queued for 16:30' },
  { id: 'm9',  lane: 'scan',    name: 'Competitor digest',     status: 'failed',    start: 38, end: 47, cost: 1.20, shape: 'pipeline', trigger: 'clock',   effort: 'DEEP',     autonomy: 'Unattended', last: 'stopped — project cap reached' },
  { id: 'm10', lane: 'scan',    name: 'Trend summary',         status: 'queued',    start: 60, dur: 6,  cost: 0,    shape: 'single',   trigger: 'clock',   effort: 'FAST',     autonomy: 'Unattended', last: 'blocked by budget cap' },
  { id: 'm11', lane: 'infra',   name: 'Dependency audit',      status: 'done',      start: 18, end: 31, cost: 0.12, shape: 'pipeline', trigger: 'clock',   effort: 'FAST',     autonomy: 'Unattended', last: 'no advisories found' },
  { id: 'm12', lane: 'infra',   name: 'Deploy preview',        status: 'failed',    start: 47, end: 49, cost: 0.02, shape: 'single',   trigger: 'webhook', effort: 'FAST',     autonomy: 'Unattended', last: 'build error: missing env' },
  { id: 'm13', lane: 'infra',   name: 'CI hardening',          status: 'running',   start: 54, end: 60, cost: 0.18, shape: 'pbr',      trigger: 'hand',    effort: 'BALANCED', autonomy: 'Gated', last: 'rotating CI tokens' },
];

const STATUS_META = {
  running:   { label: 'Running',   tint: 'var(--purple)' },
  gated:     { label: 'Gated',     tint: 'var(--orange)' },
  queued:    { label: 'Queued',    tint: 'var(--ink-secondary)' },
  failed:    { label: 'Failed',    tint: 'var(--red)' },
  done:      { label: 'Done',      tint: 'var(--green)' },
  scheduled: { label: 'Scheduled', tint: 'var(--teal)' },
};

function axisLabel(min) {
  const d = min - NOW_MIN;
  if (d === 0) return 'now';
  return (d > 0 ? '+' : '') + d + 'm';
}

function Capsule({ job, nowMin, onClick, selected }) {
  const end = job.status === 'running' ? nowMin : (job.end != null ? job.end : job.start + job.dur);
  const left = job.start * PX;
  const width = Math.max((end - job.start) * PX, 64);
  const m = STATUS_META[job.status];
  const cost = job.status === 'running' ? job._liveCost ?? job.cost : job.cost;

  const base = { position: 'absolute', left, width, top: 10, height: 40, borderRadius: 11,
    display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px', cursor: 'pointer', overflow: 'hidden',
    boxSizing: 'border-box', transition: 'width 800ms linear, box-shadow 140ms ease, transform 140ms ease' };
  const fills = {
    running: { background: 'linear-gradient(120deg, color-mix(in srgb, var(--purple) 26%, var(--bg-elevated)), color-mix(in srgb, var(--purple) 14%, var(--bg-elevated)))',
      border: '1px solid color-mix(in srgb, var(--purple) 45%, transparent)', color: 'var(--ink)' },
    gated: { background: 'rgba(255,149,0,0.16)', border: '1px solid color-mix(in srgb, var(--orange) 55%, transparent)', color: 'var(--ink)' },
    queued: { background: 'var(--bg-elevated)', border: '1.5px dashed var(--separator-strong)', color: 'var(--ink-secondary)' },
    failed: { background: 'var(--bg-elevated)', border: '1.5px solid color-mix(in srgb, var(--red) 55%, transparent)', color: 'var(--ink)' },
    done: { background: 'var(--fill-secondary)', border: '1px solid var(--separator)', color: 'var(--ink-secondary)' },
    scheduled: { background: 'transparent', border: '1.5px dashed color-mix(in srgb, var(--teal) 55%, transparent)', color: 'var(--ink-secondary)' },
  };
  const icon = { running: <Spinner size={12} color="var(--purple)" />, gated: <Icon name="pause" size={13} style={{ color: 'var(--orange)' }} />,
    queued: <Icon name="clock" size={13} />, failed: <Icon name="x" size={13} stroke={2.6} style={{ color: 'var(--red)' }} />,
    done: <Icon name="check" size={13} stroke={2.6} style={{ color: 'var(--green)' }} />, scheduled: <Icon name="clock" size={13} style={{ color: 'var(--teal)' }} /> };

  return (
    <div data-cap={job.id} onClick={() => onClick(job)} className={`capsule cap-${job.status}`} style={{ ...base, ...fills[job.status],
      boxShadow: selected ? `0 0 0 2px var(--blue), var(--card-shadow)` : 'none' }}>
      <span style={{ flexShrink: 0, display: 'grid', placeItems: 'center' }}>{icon[job.status]}</span>
      <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1 var(--font-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.name}</span>
      {(job.status === 'running' || job.status === 'gated' || job.status === 'failed' || job.status === 'done') && cost > 0 && (
        <span style={{ flexShrink: 0, font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${cost.toFixed(2)}</span>
      )}
    </div>
  );
}

function Timeline({ jobs, nowMin, onSelect, selectedId }) {
  const ticks = [];
  for (let m = 0; m <= AXIS_MAX; m += 12) ticks.push(m);
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* scroll region */}
      <div style={{ overflowX: 'auto', overflowY: 'hidden' }} className="tl-scroll">
        <div style={{ minWidth: LANE_LABEL + TRACK_W, position: 'relative' }}>
          {/* axis header */}
          <div style={{ display: 'flex', height: 34, borderBottom: '0.5px solid var(--separator)', position: 'sticky', top: 0, background: 'var(--bg-grouped)', zIndex: 3 }}>
            <div style={{ width: LANE_LABEL, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', alignItems: 'center', padding: '0 14px',
              font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Project</div>
            <div style={{ position: 'relative', width: TRACK_W, flexShrink: 0 }}>
              {ticks.map(m => (
                <span key={m} style={{ position: 'absolute', left: m * PX, top: 0, height: '100%', display: 'flex', alignItems: 'center',
                  transform: 'translateX(-50%)', font: `${m === NOW_MIN ? 700 : 500} var(--fs-caption)/1 var(--font-mono)`,
                  color: m === NOW_MIN ? 'var(--blue)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{axisLabel(m)}</span>
              ))}
            </div>
          </div>

          {/* lanes */}
          <div style={{ position: 'relative' }}>
            {/* now-line spanning all lanes */}
            <div className="now-line" style={{ position: 'absolute', left: LANE_LABEL + nowMin * PX, top: 0, bottom: 0, width: 2, zIndex: 2,
              background: 'var(--blue)', transition: 'left 800ms linear' }}>
              <span className="now-dot" style={{ position: 'absolute', top: -4, left: -4, width: 10, height: 10, borderRadius: '50%', background: 'var(--blue)' }} />
            </div>

            {LANES.map(lane => {
              const laneJobs = jobs.filter(j => j.lane === lane.id);
              return (
                <div key={lane.id} style={{ display: 'flex', height: LANE_H, borderBottom: '0.5px solid var(--separator)' }}>
                  {/* label */}
                  <div style={{ width: LANE_LABEL, flexShrink: 0, borderRight: '0.5px solid var(--separator)', borderLeft: `3px solid ${lane.color}`,
                    display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', position: 'sticky', left: 0, background: 'var(--bg-grouped)', zIndex: 1 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
                    {lane.capped && <span title="Budget cap reached" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 18, padding: '0 6px', borderRadius: 'var(--r-pill)',
                      background: 'rgba(255,59,48,0.14)', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)', flexShrink: 0 }}><Icon name="lock" size={10} /> Cap</span>}
                  </div>
                  {/* track */}
                  <div style={{ position: 'relative', width: TRACK_W, flexShrink: 0, opacity: lane.capped ? 0.62 : 1 }}>
                    {laneJobs.map(j => <Capsule key={j.id} job={j} nowMin={nowMin} onClick={onSelect} selected={selectedId === j.id} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { NOW_MIN, LANES, MON_JOBS, STATUS_META, Capsule, Timeline });
