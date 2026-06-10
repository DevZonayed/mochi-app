/* Job Monitor — table view + right inspector slide-over + cancel sheet. */

const EFFORT_TINT = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' };
const MON_TRIG_ICON = { hand: 'play', clock: 'clock', chat: 'command', webhook: 'bolt' };

function laneOf(id) { return LANES.find(l => l.id === id); }

function MonStatus({ status }) {
  const m = STATUS_META[status];
  const node = {
    running: <Spinner size={12} color={m.tint} />, gated: <Icon name="pause" size={13} />,
    queued: <Icon name="clock" size={13} />, failed: <Icon name="x" size={13} stroke={2.6} />,
    done: <Icon name="check" size={13} stroke={2.6} />, scheduled: <Icon name="clock" size={13} />,
  }[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: m.tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
      {node} {m.label}
    </span>
  );
}

function MonTable({ jobs, onSelect, selectedId, onCancel }) {
  const cols = '1.1fr 1.8fr 1.1fr 0.7fr 1fr 0.8fr 0.7fr 0.8fr 0.7fr 64px';
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 12, padding: '11px 16px',
        borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {['Project', 'Job', 'Shape', 'Trigger', 'Status', 'Effort', 'Cost', 'Started', 'Duration', ''].map((h, i) => (
          <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)',
            textAlign: i === 6 ? 'right' : 'left' }}>{h}</span>
        ))}
      </div>
      {jobs.map((j, i) => {
        const lane = laneOf(j.lane);
        const dur = j.status === 'scheduled' ? `~${j.dur}m` : j.end != null ? `${j.end - j.start}m` : '—';
        const started = j.status === 'scheduled' ? `in ${j.start - NOW_MIN}m` : `${NOW_MIN - j.start}m ago`;
        return (
          <div key={j.id} onClick={() => onSelect(j)} className="mon-row" style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 12,
            padding: '12px 16px', borderBottom: i < jobs.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer',
            background: selectedId === j.id ? 'var(--fill-tertiary)' : 'transparent' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0 }} />
              <span style={{ font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
            </span>
            <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            <span><ShapeChip shape={j.shape} /></span>
            <span title={j.trigger} style={{ color: 'var(--ink-tertiary)' }}><Icon name={MON_TRIG_ICON[j.trigger]} size={15} /></span>
            <span><MonStatus status={j.status} /></span>
            <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', color: EFFORT_TINT[j.effort] }}>{j.effort}</span>
            <span style={{ textAlign: 'right', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{j.cost > 0 ? '$' + j.cost.toFixed(2) : '—'}</span>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{started}</span>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{dur}</span>
            <span style={{ display: 'inline-flex', gap: 4, justifyContent: 'flex-end' }}>
              {(j.status === 'running' || j.status === 'gated') && (
                <button onClick={e => { e.stopPropagation(); onCancel(j); }} className="row-act" title="Cancel" style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Inspector slide-over ── */
function Inspector({ job, onClose, onCancel }) {
  if (!job) return null;
  const lane = laneOf(job.lane);
  const m = STATUS_META[job.status];
  const cost = job.status === 'running' ? job._liveCost ?? job.cost : job.cost;
  const cap = job.lane === 'scan' ? 30 : 50;
  return (
    <div className="inspector inspector-in" data-open="true" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 380, zIndex: 40,
      background: 'var(--bg-elevated)',
      borderLeft: '0.5px solid var(--separator)', boxShadow: '-12px 0 40px rgba(10,15,40,0.18)', display: 'flex', flexDirection: 'column' }}>
      <React.Fragment>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 18px 16px', borderBottom: '0.5px solid var(--separator)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0, marginTop: 7 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', textWrap: 'pretty' }}>{job.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{lane.name}</span>
                <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
                <MonStatus status={job.status} />
              </div>
            </div>
            <button onClick={onClose} className="tb-icon" style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}>
              <Icon name="x" size={17} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Tag icon="bolt" tint={EFFORT_TINT[job.effort]}>{job.effort}</Tag>
              <Tag icon="shield" tint="var(--blue)">{job.autonomy}</Tag>
              <Tag icon={MON_TRIG_ICON[job.trigger]} tint="var(--ink-secondary)">{job.trigger}</Tag>
              <ShapeChip shape={job.shape} />
            </div>

            {/* live last line */}
            <div>
              <Label>Live output</Label>
              <div style={{ background: 'var(--bg-elevated)', borderRadius: 10, border: '0.5px solid var(--separator)', padding: '12px 14px',
                font: '400 var(--fs-footnote)/1.5 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                <span style={{ color: m.tint, marginRight: 6 }}>›</span>{job.last}
                {job.status === 'running' && <span className="cursor-blink" style={{ marginLeft: 2 }}>▍</span>}
              </div>
            </div>

            {/* budget mini-meter */}
            <div>
              <Label>Project budget</Label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, (cost + (job.lane === 'scan' ? 28.8 : 22) ) / cap * 100)}%`, height: '100%', borderRadius: 4,
                    background: job.lane === 'scan' ? 'var(--red)' : 'var(--green)' }} />
                </div>
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>
                  ${(cost + (job.lane === 'scan' ? 28.8 : 22)).toFixed(2)} / ${cap}
                </span>
              </div>
              {job.lane === 'scan' && <div style={{ font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--red)', marginTop: 7 }}>Project cap reached — jobs are blocked.</div>}
            </div>

            {/* this run cost */}
            <div style={{ display: 'flex', gap: 10 }}>
              <Stat label="This run" value={cost > 0 ? `$${cost.toFixed(2)}` : '—'} />
              <Stat label={job.status === 'scheduled' ? 'Starts in' : 'Elapsed'} value={job.status === 'scheduled' ? `${job.start - NOW_MIN}m` : `${NOW_MIN - job.start}m`} />
            </div>
          </div>

          {/* actions */}
          <div style={{ display: 'flex', gap: 10, padding: 16, borderTop: '0.5px solid var(--separator)' }}>
            <a href="../session-transcript/Session Transcript.html" className="primary-cta" style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>
              <Icon name="terminal" size={16} /> Open transcript
            </a>
            {(job.status === 'running' || job.status === 'gated') && (
              <button onClick={() => onCancel(job)} className="cancel-btn" style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)',
                background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
            )}
          </div>
        </React.Fragment>
    </div>
  );
}

function Tag({ icon, tint, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-footnote)/1 var(--font-text)', textTransform: 'capitalize' }}>
      <Icon name={icon} size={13} /> {children}
    </span>
  );
}
function Label({ children }) {
  return <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>{children}</div>;
}
function Stat({ label, value }) {
  return (
    <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 10, border: '0.5px solid var(--separator)', padding: '10px 12px' }}>
      <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>{label}</div>
      <div style={{ font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

function CancelSheet({ job, onClose, onConfirm }) {
  if (!job) return null;
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 90, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ padding: '24px 24px 18px', textAlign: 'center' }}>
          <span style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
            <Icon name="alert" size={24} />
          </span>
          <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Cancel this job?</h2>
          <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
            “{job.name}” will stop immediately. Work in progress is discarded and you’ll be billed for ${(job._liveCost ?? job.cost).toFixed(2)} already spent.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '0 18px 18px' }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Keep running</button>
          <button onClick={() => onConfirm(job)} className="cancel-confirm" style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--red)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(255,59,48,0.32)' }}>Cancel job</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { MonTable, Inspector, CancelSheet, MonStatus, laneOf, EFFORT_TINT });
