/* Mobile M07 — New Job quick-trigger sheet (rendered as a presented sheet). */

const NJ_PROJ = ['atlas', 'content', 'scan', 'brand', 'infra'];

function NewJob() {
  const [theme] = useTheme('light');
  const [proj, setProj] = React.useState('atlas');
  const [effort, setEffort] = React.useState('BALANCED');
  const [model, setModel] = React.useState('auto');
  const [auto, setAuto] = React.useState('plan');
  const [voice, setVoice] = React.useState(false);
  const est = { FAST: ['0.30', '3'], BALANCED: ['0.60', '6'], DEEP: ['1.80', '36'], MAX: ['3.00', '72'] }[effort];
  const autos = { plan: ['Plan first', "You'll approve the plan before anything runs."], gated: ['Gated', 'Runs freely but stops at every gate.'], unatt: ['Unattended', 'Runs end-to-end inside allowlists and caps.'] };

  return (
    <PhoneFrame bg="rgba(10,12,24,0.5)" noScroll statusTint="#fff">
      {/* dimmed home behind */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div className="m-sheet" style={{ background: 'var(--bg)', borderRadius: '16px 16px 0 0', maxHeight: '92%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}><span style={{ width: 36, height: 5, borderRadius: 3, background: 'var(--separator-strong)' }} /></div>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 20px 14px' }}>
            <h2 style={{ margin: 0, font: '700 22px/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>New job · {M_PROJ[proj].name}</h2>
            <span style={{ flex: 1 }} />
            <a href="../jobs/Jobs.html" style={{ width: 30, height: 30, borderRadius: 15, background: 'var(--fill-secondary)', display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={16} /></a>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 24px' }} className="m-scroll">
            {/* project picker */}
            <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 16 }} className="m-scroll">
              {NJ_PROJ.map(p => (
                <button key={p} onClick={() => setProj(p)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ width: 50, height: 50, borderRadius: 15, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${M_PROJ[p].color} 16%, transparent)`, color: M_PROJ[p].color, font: '800 19px/1 var(--font-display)', boxShadow: proj === p ? '0 0 0 2px var(--bg), 0 0 0 4px var(--blue)' : 'none' }}>{M_PROJ[p].name[0]}</span>
                </button>
              ))}
            </div>
            {/* goal field */}
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', padding: 14, marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              {voice ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 3, height: 60 }}>
                  {Array.from({ length: 28 }).map((_, i) => <span key={i} className="wave" style={{ flex: 1, background: 'var(--blue)', borderRadius: 2, height: `${20 + Math.abs(Math.sin(i * 0.7)) * 60}%`, animationDelay: `${i * 0.04}s` }} />)}
                </div>
              ) : <textarea rows={2} placeholder="What should it do?" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', resize: 'none', font: '400 17px/1.4 var(--font-text)', color: 'var(--ink)' }} />}
              <button onClick={() => setVoice(v => !v)} style={{ width: 38, height: 38, borderRadius: 19, flexShrink: 0, display: 'grid', placeItems: 'center', background: voice ? 'var(--blue)' : 'var(--fill-secondary)', color: voice ? '#fff' : 'var(--ink-secondary)' }}><Icon name="spark" size={18} /></button>
            </div>
            {/* effort */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>Effort</div>
              <div style={{ display: 'flex' }}><EffortDial value={effort} onChange={setEffort} /></div>
            </div>
            {/* model */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>Model</div>
              <ModelSwitcher value={model} onChange={setModel} />
            </div>
            {/* autonomy */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>Autonomy</div>
              <div style={{ display: 'flex', gap: 6, padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
                {Object.entries(autos).map(([k, v]) => <button key={k} onClick={() => setAuto(k)} style={{ flex: 1, padding: '9px 0', borderRadius: 8, font: '600 13px/1 var(--font-text)', background: auto === k ? 'var(--bg-elevated)' : 'transparent', color: auto === k ? 'var(--ink)' : 'var(--ink-secondary)', boxShadow: auto === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none' }}>{v[0]}</button>)}
              </div>
              <div style={{ font: '400 13px/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 9 }}>{autos[auto][1]}</div>
            </div>
            {/* estimate */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 14px/1 var(--font-mono)', color: 'var(--ink-secondary)', marginBottom: 18 }}>
              <Icon name="spark" size={14} style={{ color: 'var(--purple)' }} /> ≈ ${est[0]} · ~{est[1]} min · <span style={{ color: 'var(--green)' }}>within budget ✓</span>
            </div>
            <MPill onClick={() => {}} style={{ width: '100%' }} icon="arrowRight">{auto === 'plan' ? 'Get plan first' : 'Start job'}</MPill>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<NewJob />);
