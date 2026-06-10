/* Session Transcript — content blocks for the center canvas. */

// ── Agent narration (SF Pro body); `stream` enables typewriter + caret
function Narration({ text, streamed, live }) {
  return (
    <div style={{ font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty', maxWidth: 720 }}>
      {streamed != null ? streamed : text}
      {live && <span className="stream-caret" style={{ display: 'inline-block', width: 8, height: 19, background: 'var(--purple)', borderRadius: 1, marginLeft: 2, verticalAlign: 'text-bottom' }} />}
    </div>
  );
}

// ── Tool call: collapsed mono row, expands inline to stdout
function ToolCall({ tool, cmd, time, ok, stdout, lang }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ maxWidth: 720 }}>
      <button onClick={() => setOpen(o => !o)} className="tool-chip" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        padding: '9px 12px', borderRadius: open ? '10px 10px 0 0' : 10, background: 'var(--fill-secondary)', textAlign: 'left',
        border: '0.5px solid var(--separator)', borderBottom: open ? 'none' : '0.5px solid var(--separator)' }}>
        <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 180ms var(--spring)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--purple)', flexShrink: 0 }}>{tool}</span>
        <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
        <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cmd}</span>
        <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{time}</span>
        <Icon name={ok ? 'check' : 'x'} size={13} stroke={2.6} style={{ color: ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
      </button>
      {open && (
        <div className="tool-out" style={{ border: '0.5px solid var(--separator)', borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
          <pre style={{ margin: 0, padding: '12px 14px', background: 'var(--bg-elevated)', font: '400 13px/1.6 var(--font-mono)', color: 'var(--ink-secondary)',
            whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{stdout}</pre>
        </div>
      )}
    </div>
  );
}

// ── Thinking block (collapsed lavender)
function Thinking({ tokens, text }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ maxWidth: 720 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: open ? '100%' : 'auto',
        padding: '8px 12px', borderRadius: open ? '10px 10px 0 0' : 'var(--r-pill)', background: 'color-mix(in srgb, var(--purple) 9%, transparent)',
        border: '0.5px solid color-mix(in srgb, var(--purple) 22%, transparent)' }}>
        <Icon name="spark" size={14} style={{ color: 'var(--purple)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--purple)' }}>Thinking</span>
        <span style={{ font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'color-mix(in srgb, var(--purple) 70%, var(--ink-secondary))' }}>· {tokens} tokens</span>
        <Icon name="chevronDown" size={13} style={{ color: 'var(--purple)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms var(--spring)' }} />
      </button>
      {open && (
        <div style={{ padding: '12px 14px', background: 'color-mix(in srgb, var(--purple) 5%, var(--bg-elevated))', border: '0.5px solid color-mix(in srgb, var(--purple) 18%, transparent)',
          borderTop: 'none', borderRadius: '0 0 10px 10px', font: '400 var(--fs-subhead)/1.6 var(--font-text)', color: 'var(--ink-secondary)', fontStyle: 'italic', textWrap: 'pretty' }}>{text}</div>
      )}
    </div>
  );
}

// ── File diff card
function DiffCard({ file, add, del, hunks }) {
  return (
    <div style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: '0.5px solid var(--separator)' }}>
        <Icon name="terminal" size={15} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</span>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)' }}>+{add}</span>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--red)' }}>−{del}</span>
        <a href="../project-detail/Project Detail.html" className="link-btn" style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none', flexShrink: 0 }}>Open in review →</a>
      </div>
      <div style={{ font: '400 12.5px/1.7 var(--font-mono)', overflowX: 'auto' }}>
        {hunks.map((h, i) => (
          <div key={i} style={{ display: 'flex', padding: '0 0 0 0',
            background: h.t === 'add' ? 'rgba(52,199,89,0.10)' : h.t === 'del' ? 'rgba(255,59,48,0.09)' : 'transparent' }}>
            <span style={{ width: 4, flexShrink: 0, background: h.t === 'add' ? 'var(--green)' : h.t === 'del' ? 'var(--red)' : 'transparent' }} />
            <span style={{ width: 22, flexShrink: 0, textAlign: 'center', color: h.t === 'add' ? 'var(--green)' : h.t === 'del' ? 'var(--red)' : 'var(--ink-tertiary)' }}>{h.t === 'add' ? '+' : h.t === 'del' ? '−' : ' '}</span>
            <span style={{ flex: 1, paddingRight: 12, whiteSpace: 'pre', color: h.t === 'ctx' ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{h.c}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── System row (quiet grey)
function SystemRow({ icon = 'refresh', text }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', maxWidth: 720 }}>
      <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 11px', borderRadius: 'var(--r-pill)',
        background: 'var(--fill-secondary)', font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
        <Icon name={icon} size={13} /> {text}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--separator)' }} />
    </div>
  );
}

// ── Step label (Plan / Build / Review headers in the stream)
function PhaseMarker({ phase, tint }) {
  return (
    <div id={`phase-${phase.toLowerCase()}`} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, maxWidth: 720 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: '0 12px', borderRadius: 'var(--r-pill)',
        background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {phase}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--separator)' }} />
    </div>
  );
}

// ── Gate moment (full-width amber)
function GateCard({ onApprove, onChanges }) {
  return (
    <div className="gate-block" style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,149,0,0.45)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.10), var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', background: 'rgba(255,149,0,0.08)', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'rgba(255,149,0,0.16)', color: 'var(--orange)', flexShrink: 0 }}>
          <Icon name="gitMerge" size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Merge gate · PR #482</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>auth refactor · 12 files · +840 −210 · tests green</div>
        </div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 14, textWrap: 'pretty' }}>
          Build and review are complete. This is a hard gate — nothing merges or deploys until you approve.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onApprove} className="primary-cta" style={{ height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff',
            font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Approve &amp; merge</button>
          <button onClick={onChanges} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Request changes</button>
          <a href="../project-detail/Project Detail.html" className="link-btn" style={{ height: 40, display: 'inline-flex', alignItems: 'center', padding: '0 12px', color: 'var(--blue)', font: '600 var(--fs-callout)/1 var(--font-text)', textDecoration: 'none' }}>View diff</a>
        </div>
      </div>
    </div>
  );
}

// ── Summary cards (done / failed)
function SummaryCard({ kind }) {
  if (kind === 'done') {
    return (
      <div className="summary-done" style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(52,199,89,0.4)',
        boxShadow: '0 0 0 4px rgba(52,199,89,0.08), var(--card-shadow)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--green)', color: '#fff', flexShrink: 0 }}><Icon name="check" size={19} stroke={3} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-text)', color: 'var(--ink)' }}>Job complete</div>
            <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Merged to main · all checks green</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <MiniStat label="Total cost" value="$0.58" />
          <MiniStat label="Duration" value="6m 12s" />
          <MiniStat label="Tokens" value="48.2k" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginRight: 4 }}>Artifacts</span>
          {['PR #482', '3 files changed', 'test report'].map(a => (
            <a key={a} href="../project-detail/Project Detail.html" className="artifact" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', textDecoration: 'none' }}><Icon name="terminal" size={12} /> {a}</a>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="summary-fail" style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,59,48,0.4)',
      boxShadow: '0 0 0 4px rgba(255,59,48,0.07), var(--card-shadow)', padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', flexShrink: 0 }}><Icon name="alert" size={19} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-text)', color: 'var(--ink)' }}>Job failed</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Stopped at Build · checkpoint 4 preserved</div>
        </div>
      </div>
      <pre style={{ margin: '0 0 14px', padding: '11px 13px', borderRadius: 10, background: 'rgba(255,59,48,0.06)', border: '0.5px solid rgba(255,59,48,0.2)',
        font: '400 12.5px/1.6 var(--font-mono)', color: 'var(--red)', whiteSpace: 'pre-wrap' }}>TypeError: cannot read 'sign' of undefined{'\n'}  at services/jwt.ts:24:18 — missing JWT_SECRET in env</pre>
      <button className="primary-cta" style={{ height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Retry from checkpoint</button>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ flex: 1, background: 'var(--fill-tertiary)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>{label}</div>
      <div style={{ font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

Object.assign(window, { Narration, ToolCall, Thinking, DiffCard, SystemRow, PhaseMarker, GateCard, SummaryCard, MiniStat });
