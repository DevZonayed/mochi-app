/* Skills Registry — publish sheet (drop zone, manifest, signing, staged scan). */

function PublishSheet({ open, onClose }) {
  const [stage, setStage] = React.useState(0); // 0 drop, 1 ready, 2..4 scanning, 5 done
  React.useEffect(() => { if (open) setStage(0); }, [open]);
  if (!open) return null;

  const drop = () => { setStage(1); };
  const publish = () => {
    setStage(2);
    let s = 2;
    const t = setInterval(() => { s += 1; setStage(s); if (s >= 5) clearInterval(t); }, 850);
  };

  const scanSteps = [
    { label: 'Integrity check', sub: 'Hash & signature verified' },
    { label: 'Static scan', sub: 'Capabilities match declaration' },
    { label: 'Listed in registry', sub: 'Discoverable by meaning' },
  ];

  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 520, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Publish skill</h2>
            <p style={{ margin: '3px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Signed, scanned, and listed to your private registry. No payments, ever.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {stage === 0 ? (
            <button onClick={drop} className="drop-zone" style={{ width: '100%', padding: '40px 20px', borderRadius: 16, border: '2px dashed var(--separator-strong)', background: 'var(--fill-tertiary)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 56, height: 56, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="enter" size={28} style={{ transform: 'rotate(90deg)' }} /></span>
              <span style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)' }}>Drop your skill bundle here</span>
              <span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>.zip with SKILL.md + manifest · or click to browse</span>
            </button>
          ) : (
            <React.Fragment>
              {/* manifest preview */}
              <div style={{ display: 'flex', gap: 13, padding: 15, borderRadius: 14, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', marginBottom: 14 }}>
                <SkillGlyph name="newsletter-writer" size={44} radius={12} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ font: '600 var(--fs-callout)/1.3 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>newsletter-writer</span>
                    <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)', flexShrink: 0 }}>v0.9.0</span>
                  </div>
                  <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>Drafts on-brand newsletters from a week of project activity. 3 capabilities declared.</div>
                </div>
              </div>

              {/* signing row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', marginBottom: 16 }}>
                <Icon name="key" size={17} style={{ color: 'var(--green)' }} />
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Sign with your key <span style={{ font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>····7F2A</span></span>
                <Icon name="check" size={16} stroke={2.6} style={{ color: 'var(--green)' }} />
              </div>

              {/* scan steps */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {scanSteps.map((st, i) => {
                  const stepN = i + 2; // stages 2,3,4
                  const done = stage > stepN || stage === 5;
                  const activeNow = stage === stepN;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12,
                      background: done ? 'rgba(52,199,89,0.08)' : 'var(--fill-tertiary)', border: `0.5px solid ${done ? 'rgba(52,199,89,0.3)' : 'var(--separator)'}` }}>
                      <span className={done ? 'scan-pop' : ''} style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                        background: done ? 'var(--green)' : 'var(--fill-secondary)', color: done ? '#fff' : 'var(--ink-tertiary)' }}>
                        {done ? <Icon name="check" size={14} stroke={3} /> : activeNow ? <Spinner size={13} color="var(--blue)" /> : <span style={{ font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{i + 1}</span>}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ font: '600 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)' }}>{st.label}</div>
                        <div style={{ font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{st.sub}</div>
                      </div>
                      {done && <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}>Done</span>}
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            {stage === 5 ? 'Published · agents can now find it by meaning.' : 'Your registry is private to this workspace.'}
          </span>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{stage === 5 ? 'Done' : 'Cancel'}</button>
          {stage >= 1 && stage < 2 && (
            <button onClick={publish} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Sign &amp; publish</button>
          )}
          {stage >= 2 && stage < 5 && (
            <button disabled style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 7 }}><Spinner size={13} /> Scanning…</button>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PublishSheet });
