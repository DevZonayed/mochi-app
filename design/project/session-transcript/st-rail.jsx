/* Session Transcript — left run outline + right rail meters. */

// ── Left: run outline (connected dot-line) + checkpoints
function RunOutline({ runState, onJump }) {
  // node state derives from runState
  const phaseStates = {
    live:   { plan: 'done', build: 'live', review: 'todo', gate: 'todo' },
    gate:   { plan: 'done', build: 'done', review: 'done', gate: 'live' },
    done:   { plan: 'done', build: 'done', review: 'done', gate: 'done' },
    failed: { plan: 'done', build: 'fail', review: 'todo', gate: 'todo' },
  }[runState];
  const nodes = [
    { key: 'plan', label: 'Plan', meta: '8 steps · 0:42' },
    { key: 'build', label: 'Build', meta: phaseStates.build === 'live' ? 'in progress…' : phaseStates.build === 'fail' ? 'failed' : '14 steps · 3:20' },
    { key: 'review', label: 'Review', meta: phaseStates.review === 'done' ? 'passed' : 'pending' },
    { key: 'gate', label: 'Gate', meta: phaseStates.gate === 'live' ? 'waiting' : phaseStates.gate === 'done' ? 'approved' : 'pending' },
  ];
  const dot = (s) => {
    if (s === 'done') return { bg: 'var(--green)', node: <Icon name="check" size={11} stroke={3} style={{ color: '#fff' }} /> };
    if (s === 'live') return { bg: 'var(--purple)', node: <span className="ol-pulse" style={{ width: 8, height: 8, borderRadius: 4, background: '#fff' }} /> };
    if (s === 'fail') return { bg: 'var(--red)', node: <Icon name="x" size={11} stroke={3} style={{ color: '#fff' }} /> };
    return { bg: 'var(--fill-secondary)', node: null };
  };
  return (
    <aside style={{ width: 220, flexShrink: 0, borderRight: '0.5px solid var(--separator)', padding: '20px 16px', overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 16 }}>Run outline</div>
      <div style={{ position: 'relative' }}>
        {nodes.map((n, i) => {
          const s = phaseStates[n.key]; const d = dot(s);
          const active = s === 'live';
          return (
            <button key={n.key} onClick={() => onJump(n.key)} className="ol-node" style={{ display: 'flex', gap: 12, width: '100%', textAlign: 'left', padding: '0 0 18px', position: 'relative' }}>
              {i < nodes.length - 1 && <span style={{ position: 'absolute', left: 10, top: 22, bottom: -2, width: 2, background: s === 'done' ? 'var(--green)' : 'var(--separator)' }} />}
              <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', zIndex: 1,
                background: d.bg, border: s === 'todo' ? '1.5px solid var(--separator-strong)' : 'none',
                boxShadow: active ? '0 0 0 4px color-mix(in srgb, var(--purple) 16%, transparent)' : 'none' }}>{d.node}</span>
              <span style={{ paddingTop: 1 }}>
                <span style={{ display: 'block', font: `${active ? 700 : 600} var(--fs-callout)/1.1 var(--font-text)`, color: s === 'todo' ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{n.label}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{n.meta}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', margin: '12px 0 12px' }}>Checkpoints</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {[['Checkpoint 4', '2 min ago'], ['Checkpoint 3', '6 min ago'], ['Checkpoint 2', '9 min ago'], ['Checkpoint 1', '12 min ago']].map(([c, t], i) => (
          <div key={i} className="ckpt" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8 }}>
            <Icon name="clock" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>{c}</span>
              <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{t}</span>
            </span>
            <button className="ckpt-restore" title="Restore" style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
              <Icon name="refresh" size={14} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── Right rail: live meters + chips + controls
function RailMeter({ label, value, tint }) {
  return (
    <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: '12px 14px' }}>
      <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 6 }}>{label}</div>
      <div style={{ font: '600 var(--fs-title2)/1 var(--font-mono)', color: tint || 'var(--ink)', letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  );
}

function RightRail({ runState, cost, tokens, elapsed, onPause, onCancel }) {
  const skills = ['TypeScript engineer', 'PR author', 'Test writer'];
  const live = runState === 'live';
  return (
    <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18,
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* meters */}
      <div style={{ display: 'flex', gap: 10 }}>
        <RailMeter label="Cost" value={`$${cost.toFixed(2)}`} />
        <RailMeter label="Tokens" value={tokens} />
      </div>
      <RailMeter label="Elapsed" value={elapsed} />

      {/* effort */}
      <div>
        <RailLabel>Effort</RailLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ChipRow label="Build"><EffortPill v="DEEP" /></ChipRow>
          <ChipRow label="Review"><EffortPill v="FAST" /></ChipRow>
        </div>
      </div>

      {/* roles → per-role model switchers */}
      <div>
        <RailLabel>Model per role</RailLabel>
        <RoleModels />
      </div>

      {/* skills */}
      <div>
        <RailLabel>Loaded skills</RailLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {skills.map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', borderRadius: 9, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <Icon name="shield" size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
              <span style={{ flex: 1, font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>{s}</span>
            </div>
          ))}
        </div>
      </div>

      <span style={{ flex: 1 }} />

      {/* controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, position: 'sticky', bottom: 0 }}>
        {live && (
          <div style={{ display: 'flex', gap: 9 }}>
            <button onClick={onPause} className="ctrl" style={{ flex: 1, height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="pause" size={15} /> Pause</button>
            <button onClick={onCancel} className="ctrl-cancel" style={{ flex: 1, height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="x" size={15} /> Cancel</button>
          </div>
        )}
        <button className="ctrl" style={{ height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="gitMerge" size={15} /> Fork from checkpoint</button>
      </div>
    </aside>
  );
}

function RailLabel({ children }) {
  return <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>{children}</div>;
}
function RoleModels() {
  const [roles, setRoles] = React.useState({ builder: 'opus', reviewer: 'sonnet' });
  const ROWS = [['builder', 'Builder', 'var(--purple)'], ['reviewer', 'Reviewer', 'var(--teal)']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ROWS.map(([k, label, t]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 84, flexShrink: 0, font: '600 var(--fs-footnote)/1 var(--font-text)', color: t }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: t }} /> {label}
          </span>
          <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
            <ModelSwitcher value={roles[k]} onChange={v => setRoles(r => ({ ...r, [k]: v }))} compact align="right" />
          </span>
        </div>
      ))}
    </div>
  );
}
function ChipRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 48, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{label}</span>
      {children}
    </div>
  );
}
function EffortPill({ v }) {
  const t = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' }[v];
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
    background: `color-mix(in srgb, ${t} 14%, transparent)`, color: t, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em' }}>{v}</span>;
}

Object.assign(window, { RunOutline, RightRail });
