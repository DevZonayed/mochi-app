/* Media Studio — assembly: pipeline stepper, stage state, consent gate, budget block. */

function PipelineStepper({ active, onPick, done }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', padding: '2px 0' }} className="pipe-scroll">
      {STUDIO_STAGES.map((s, i) => {
        const isDone = done.includes(s);
        const isActive = active === s;
        return (
          <React.Fragment key={s}>
            {i > 0 && <span style={{ width: 14, height: 2, borderRadius: 1, background: isDone || (done.includes(STUDIO_STAGES[i - 1])) ? 'var(--teal)' : 'var(--separator)', flexShrink: 0 }} />}
            <button onClick={() => onPick(s)} className="pipe-stage" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', flexShrink: 0,
              background: isActive ? 'var(--teal)' : isDone ? 'color-mix(in srgb, var(--teal) 14%, transparent)' : 'var(--fill-secondary)',
              color: isActive ? '#fff' : isDone ? 'var(--teal)' : 'var(--ink-tertiary)',
              font: `${isActive ? 700 : 600} var(--fs-footnote)/1 var(--font-text)`,
              boxShadow: isActive ? '0 0 0 4px color-mix(in srgb, var(--teal) 16%, transparent)' : 'none', transition: 'all 160ms ease' }}>
              {isDone && <Icon name="check" size={12} stroke={3} />}
              {isActive && <span className="breathe" style={{ width: 6, height: 6, borderRadius: 3, background: '#fff' }} />}
              {s}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ConsentGate({ stage, onRecord, onClose }) {
  return (
    <div style={{ maxWidth: 520, margin: '40px auto 0', background: 'var(--bg-elevated)', borderRadius: 18, border: '1px solid rgba(255,149,0,0.4)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.10), var(--card-shadow)', padding: 26, textAlign: 'center' }}>
      <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', marginBottom: 16 }}><Icon name="shield" size={26} /></span>
      <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Consent required before cloning</h2>
      <p style={{ margin: '0 0 20px', font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
        The <b style={{ color: 'var(--ink)' }}>{stage}</b> stage clones a real voice or likeness. Record a consent statement from the person before Maestro will generate anything.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button onClick={onClose} style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Pick another stage</button>
        <button onClick={onRecord} className="primary-cta" style={{ height: 42, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--orange)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(255,149,0,0.32)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="play" size={16} /> Record consent now
        </button>
      </div>
    </div>
  );
}

function MediaStudio() {
  const [theme, setTheme] = useTheme('light');
  const [active, setActive] = React.useState('B-roll');
  const [lane, setLane] = React.useState('hero');
  const [dur, setDur] = React.useState(24);
  const [voice, setVoice] = React.useState(0);
  const [playing, setPlaying] = React.useState(-1);
  const [heroIdx, setHeroIdx] = React.useState(0);
  const [consentDone, setConsentDone] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  // cost estimate reacts to controls
  const base = lane === 'hero' ? 0.32 : lane === 'selfhost' ? 0.04 : 0.10;
  const est = +(2.9 + dur * base + (voice === 1 ? 0.4 : 0)).toFixed(2);

  const done = ['Brief', 'Voice'];
  const needsConsent = (active === 'Avatar' || active === 'Voice') && !consentDone;

  return (
    <WindowFrame>
      <Sidebar active="studio" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        {/* top: context + pipeline */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', borderBottom: '0.5px solid var(--separator)', background: 'color-mix(in srgb, var(--bg) 86%, transparent)', position: 'relative', zIndex: 5 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--teal) 12%, transparent)', color: 'var(--teal)', font: '600 var(--fs-footnote)/1 var(--font-text)', flexShrink: 0 }}>
            <Icon name="clapper" size={14} /> Q3 Content · Launch film
          </span>
          <div style={{ flex: 1, minWidth: 0 }}><PipelineStepper active={active} onPick={s => { setActive(s); }} done={done} /></div>
        </div>

        {/* 3 columns */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <BriefPanel lane={lane} setLane={setLane} dur={dur} setDur={setDur} est={est} voice={voice} setVoice={setVoice} playing={playing} setPlaying={setPlaying} />
          <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '28px 28px', display: 'flex', flexDirection: 'column' }} key={active} className="canvas-fade">
            {needsConsent ? <ConsentGate stage={active} onRecord={() => setConsentDone(true)} onClose={() => setActive('B-roll')} />
              : active === 'Assemble' ? <AssembleCanvas />
              : <VideoCanvas heroIdx={heroIdx} setHeroIdx={setHeroIdx} rendering={false} />}
          </main>
          <StudioQueue />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<MediaStudio />);
