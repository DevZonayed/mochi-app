/* Plan/Diff Gate — findings rail + app assembly (header, mode switch,
   action bars, approve check-pop, resolved-elsewhere overlay). */

const FINDINGS_INIT = [
  { id: 'f1', sev: 'red',   text: 'Bearer parsing assumes a "Bearer " prefix — a malformed Authorization header will throw before the fallback runs.', line: 5, state: 'open' },
  { id: 'f2', sev: 'amber', text: 'Legacy cookie fallback has no expiry check; stale sessions persist until the cookie is cleared.', line: 11, state: 'open' },
  { id: 'f3', sev: 'grey',  text: 'clearSession is now explicitly typed (sid: string). Good catch on the loose param.', line: 15, state: 'fixed' },
];
const SEV = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };

function FindingsRail({ findings, onJump, onRequestFixes }) {
  const open = findings.filter(f => f.state === 'open').length;
  return (
    <aside style={{ width: 320, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ width: 24, height: 24, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><OpenAIGlyph size={15} /></span>
          <span style={{ flex: 1, font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>Review · GPT reviewer<br/><span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>pass 2 of 2</span></span>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 12px', borderRadius: 'var(--r-pill)',
          background: open > 0 ? 'rgba(255,149,0,0.14)' : 'rgba(52,199,89,0.16)', color: open > 0 ? 'var(--orange)' : 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
          {open > 0 ? <Icon name="alert" size={13} /> : <Icon name="check" size={13} stroke={2.6} />}
          {open > 0 ? `${open} issue${open > 1 ? 's' : ''} remaining` : 'All clear'}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {findings.map(f => {
          const fixed = f.state === 'fixed';
          return (
            <div key={f.id} className={`finding ${fixed ? 'finding-fixed' : ''}`} style={{ position: 'relative', background: 'var(--bg-elevated)', borderRadius: 12,
              border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 13, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: SEV[f.sev], flexShrink: 0 }} />
                <span style={{ flex: 1, font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: SEV[f.sev] }}>{f.sev === 'red' ? 'Blocking' : f.sev === 'amber' ? 'Warning' : 'Note'}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)',
                  background: fixed ? 'rgba(52,199,89,0.16)' : 'var(--fill-secondary)', color: fixed ? 'var(--green)' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
                  {fixed ? <><Icon name="check" size={10} stroke={3} /> Fixed in loop</> : 'Open'}
                </span>
              </div>
              <div className="finding-text" style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty', marginBottom: 9 }}>{f.text}</div>
              <button onClick={() => onJump(f.line)} className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--blue)' }}>
                <Icon name="arrowRight" size={12} /> Jump to line {f.line}
              </button>
              <span className="fixed-sweep" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent, rgba(52,199,89,0.18), transparent)', transform: 'translateX(-100%)', pointerEvents: 'none' }} />
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ── action bars ── */
function ActionBar({ children }) {
  return (
    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 24px',
      background: 'var(--glass-tint)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      borderTop: '0.5px solid var(--separator)' }}>{children}</div>
  );
}
function GhostBtn({ icon, children, onClick, danger }) {
  return (
    <button onClick={onClick} className={danger ? 'reject-btn' : 'ghost-btn'} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)',
      background: danger ? 'transparent' : 'var(--fill-secondary)', color: danger ? 'var(--red)' : 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
      {icon && <Icon name={icon} size={16} />}{children}
    </button>
  );
}
function PrimaryBtn({ icon, children, onClick }) {
  return (
    <button onClick={onClick} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 42, padding: '0 22px', borderRadius: 'var(--r-pill)',
      background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>
      <Icon name={icon} size={17} />{children}
    </button>
  );
}

function GateApp() {
  const [theme, setTheme] = useTheme('light');
  const [mode, setMode] = React.useState('plan'); // plan | diff
  const [diffView, setDiffView] = React.useState('unified');
  const [editing, setEditing] = React.useState(false);
  const [responding, setResponding] = React.useState(false);
  const [findings, setFindings] = React.useState(FINDINGS_INIT);
  const [resolved, setResolved] = React.useState(false);
  const [approved, setApproved] = React.useState(null); // null | 'building' | 'merging'
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const jumpToLine = (n) => { const el = document.querySelector(`[data-line="${n}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el && el.classList.add('line-flash'); setTimeout(() => el && el.classList.remove('line-flash'), 1200); };

  const requestFixes = () => {
    document.querySelectorAll('.finding').forEach(f => f.classList.add('sweeping'));
    setTimeout(() => setFindings(fs => fs.map(f => ({ ...f, state: 'fixed' }))), 700);
  };

  const approve = () => {
    setApproved(mode === 'plan' ? 'building' : 'merging');
  };

  const openOpen = findings.filter(f => f.state === 'open').length;

  return (
    <WindowFrame>
      <Sidebar active="approvals" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        {/* job header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 24px', borderBottom: '0.5px solid var(--separator)', position: 'relative', zIndex: 5,
          background: 'color-mix(in srgb, var(--bg) 86%, transparent)' }}>
          <a href="../job-monitor/Job Monitor.html" className="ghost-btn" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', textDecoration: 'none', flexShrink: 0 }}><Icon name="arrowLeft" size={17} /></a>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>
              <span>Atlas API</span><Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)' }} /><span style={{ color: 'var(--ink)', fontWeight: 600 }}>Refactor auth service</span>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
              background: 'color-mix(in srgb, var(--orange) 15%, transparent)', color: 'var(--orange)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
              <Icon name="enter" size={13} /> Waiting at gate · 12 min
            </span>
          </div>
          <div style={{ display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
            {[['plan', 'Plan gate'], ['diff', 'Diff gate']].map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)} style={{ padding: '7px 14px', borderRadius: 7, font: '600 var(--fs-footnote)/1 var(--font-text)',
                background: mode === k ? 'var(--bg-elevated)' : 'transparent', color: mode === k ? 'var(--ink)' : 'var(--ink-secondary)',
                boxShadow: mode === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none', transition: 'all 160ms ease' }}>{label}</button>
            ))}
          </div>
          <button onClick={() => setResolved(true)} className="tb-icon" title="Simulate approval from phone" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}>
            <Icon name="smartphone" size={18} />
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          {mode === 'plan' ? (
            <React.Fragment>
              <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px 28px' }}><PlanGate editing={editing} /></div>
              {responding && <RespondField onClose={() => setResponding(false)} />}
              <ActionBar>
                <PrimaryBtn icon="check" onClick={approve}>Approve &amp; build</PrimaryBtn>
                <GhostBtn icon="sliders" onClick={() => setEditing(e => !e)}>{editing ? 'Done editing' : 'Edit plan'}</GhostBtn>
                <GhostBtn icon="command" onClick={() => setResponding(r => !r)}>Respond</GhostBtn>
                <span style={{ flex: 1 }} />
                <GhostBtn danger onClick={() => {}}>Reject</GhostBtn>
              </ActionBar>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                <FileTree files={FILES} active={0} onPick={() => {}} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
                    <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>3 of 5 files reviewed</span>
                    <span style={{ flex: 1 }} />
                    <div style={{ display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 8 }}>
                      {[['unified', 'Unified'], ['split', 'Side-by-side']].map(([k, label]) => (
                        <button key={k} onClick={() => setDiffView(k)} style={{ padding: '5px 11px', borderRadius: 6, font: '600 var(--fs-caption)/1 var(--font-text)',
                          background: diffView === k ? 'var(--bg-elevated)' : 'transparent', color: diffView === k ? 'var(--ink)' : 'var(--ink-secondary)',
                          boxShadow: diffView === k ? '0 1px 2px rgba(0,0,0,0.14)' : 'none' }}>{label}</button>
                      ))}
                    </div>
                  </div>
                  <DiffViewer mode={diffView} />
                </div>
                <FindingsRail findings={findings} onJump={jumpToLine} onRequestFixes={requestFixes} />
              </div>
              <ActionBar>
                <PrimaryBtn icon="gitMerge" onClick={approve}>Approve &amp; merge to PR</PrimaryBtn>
                <GhostBtn icon="refresh" onClick={requestFixes}>Request fixes</GhostBtn>
                <GhostBtn danger onClick={() => {}}>Reject</GhostBtn>
                <span style={{ flex: 1 }} />
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)',
                  background: 'rgba(52,199,89,0.13)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                  <Icon name="shield" size={14} /> Judge panel: 3/3 approve
                </span>
              </ActionBar>
            </React.Fragment>
          )}

          {/* approve check-pop */}
          {approved && <CheckPop label={approved === 'building' ? 'Building…' : 'Merging to PR…'} />}
          {/* resolved elsewhere */}
          {resolved && <ResolvedOverlay onClose={() => setResolved(false)} />}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

function RespondField({ onClose }) {
  return (
    <div style={{ flexShrink: 0, padding: '14px 24px', borderTop: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ flex: 1, background: 'var(--fill-tertiary)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: '10px 14px' }}>
          <textarea autoFocus rows={2} placeholder="Reply to the agent — ask a question or steer the plan…" style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
            font: '400 var(--fs-callout)/1.5 var(--font-text)', color: 'var(--ink)' }} />
        </div>
        <button onClick={onClose} className="primary-cta" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--blue)', color: '#fff', boxShadow: '0 6px 16px rgba(0,122,255,0.34)' }}>
          <Icon name="arrowRight" size={19} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>
    </div>
  );
}

function CheckPop({ label }) {
  return (
    <div className="checkpop" style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'grid', placeItems: 'center',
      background: 'color-mix(in srgb, var(--bg) 70%, transparent)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
      <div style={{ textAlign: 'center' }}>
        <span className="checkpop-circle" style={{ display: 'inline-grid', placeItems: 'center', width: 72, height: 72, borderRadius: '50%', background: 'var(--green)', color: '#fff', marginBottom: 16, boxShadow: '0 12px 36px rgba(52,199,89,0.42)' }}>
          <Icon name="check" size={38} stroke={3} />
        </span>
        <div style={{ font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Approved</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 8, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <Spinner size={14} color="var(--purple)" /> {label}
        </div>
      </div>
    </div>
  );
}

function ResolvedOverlay({ onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(20,22,30,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
      <div onClick={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, textAlign: 'center', background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: '28px 24px 22px' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', marginBottom: 16 }}>
          <Icon name="smartphone" size={26} />
        </span>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Already approved</h2>
        <p style={{ margin: '0 0 6px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>You approved this gate from your phone · 2 min ago. The job is already building.</p>
        <p style={{ margin: '0 0 20px', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
          <Icon name="shield" size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />Gate survived a restart — state is durable.
        </p>
        <button onClick={onClose} className="primary-cta" style={{ height: 42, padding: '0 24px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Got it</button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<GateApp />);
