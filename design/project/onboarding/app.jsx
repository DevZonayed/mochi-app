/* Maestro onboarding — app shell, stepper, navigation, state machine.
   Renders a floating macOS setup-assistant window with an animated
   muted blue/purple backdrop and a centered frosted glass card. */

const WIN_W = 1240, WIN_H = 800;

function useScale(w, h, pad = 48) {
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const fit = () => setScale(Math.min((window.innerWidth - pad) / w, (window.innerHeight - pad) / h, 1));
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, [w, h]);
  return scale;
}

// ── traffic lights (no sidebar, onboarding chrome)
function TrafficLights() {
  return (
    <div style={{ display: 'flex', gap: 8, position: 'absolute', top: 18, left: 20, zIndex: 30 }}>
      {['#ff5f57', '#febc2e', '#28c840'].map(c => (
        <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, border: '0.5px solid rgba(0,0,0,0.12)' }} />
      ))}
    </div>
  );
}

// ── step dots
function Stepper({ step, maxVisited, onJump }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 26 }}>
      {[0, 1, 2, 3, 4].map(i => {
        const done = i < step, current = i === step;
        const clickable = i <= maxVisited;
        return (
          <button key={i} onClick={() => clickable && onJump(i)} aria-label={`Step ${i + 1}`}
            style={{ padding: 4, cursor: clickable ? 'pointer' : 'default', lineHeight: 0 }}>
            <span style={{
              display: 'grid', placeItems: 'center',
              width: current ? 26 : 8, height: 8, borderRadius: 'var(--r-pill)',
              background: done ? 'var(--green)' : current ? 'var(--blue)' : 'var(--fill-secondary)',
              border: (done || current) ? 'none' : '0.5px solid var(--separator-strong)',
              transition: 'width 320ms var(--spring), background 220ms ease',
            }}>
              {done && <Icon name="check" size={6} stroke={3.5} style={{ color: '#fff' }} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function App() {
  const scale = useScale(WIN_W, WIN_H);
  const [theme, setTheme] = React.useState('light');
  const [step, setStep] = React.useState(0);
  const [maxVisited, setMaxVisited] = React.useState(0);
  const [dir, setDir] = React.useState('');
  const [phase, setPhase] = React.useState('card'); // card | finishing | done

  const [workspace, setWorkspace] = React.useState('');
  const [providers, setProviders] = React.useState({ anthropic: 'idle', openai: 'idle' });
  const [budget, setBudget] = React.useState(200);
  const [secondsLeft, setSecondsLeft] = React.useState(120);
  const openaiTries = React.useRef(0);

  React.useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // pairing countdown
  React.useEffect(() => {
    if (step !== 4 || phase !== 'card') return;
    setSecondsLeft(120);
    const t = setInterval(() => setSecondsLeft(s => (s <= 0 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [step, phase]);

  const go = (next) => {
    if (next === step) return;
    setDir(next > step ? 'fwd' : 'back');
    setStep(next);
    setMaxVisited(m => Math.max(m, next));
  };

  const connect = (key) => {
    setProviders(p => ({ ...p, [key]: 'waiting' }));
    const willFail = key === 'openai' && openaiTries.current === 0;
    if (key === 'openai') openaiTries.current += 1;
    setTimeout(() => {
      setProviders(p => ({ ...p, [key]: willFail ? 'error' : 'connected' }));
    }, willFail ? 1700 : 1500);
  };

  const finish = () => {
    setPhase('finishing');
    setTimeout(() => setPhase('done'), 1500);
  };
  const restart = () => {
    setPhase('card'); setStep(0); setMaxVisited(0); setWorkspace('');
    setProviders({ anthropic: 'idle', openai: 'idle' }); setBudget(200);
    openaiTries.current = 0;
  };

  const providerOk = providers.anthropic === 'connected' || providers.openai === 'connected';
  const canContinue = [true, workspace.trim().length > 0, providerOk, true, true][step];

  const steps = [
    <WelcomeStep />,
    <WorkspaceStep value={workspace} onChange={setWorkspace} />,
    <ProvidersStep providers={providers} onConnect={connect} />,
    <BudgetStep amount={budget} onAmount={setBudget} />,
    <PairStep secondsLeft={secondsLeft} onRefresh={() => setSecondsLeft(120)} />,
  ];

  const continueLabel = ['Get started', 'Continue', 'Continue', 'Continue', 'Finish setup'][step];

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <div style={{
        width: WIN_W, height: WIN_H, transform: `scale(${scale})`, transformOrigin: 'center',
        borderRadius: 18, overflow: 'hidden', position: 'relative',
        background: 'var(--backdrop-base)',
        boxShadow: '0 0 0 0.5px rgba(0,0,0,0.18), 0 40px 100px rgba(10,15,40,0.45)',
      }}>
        {/* animated backdrop */}
        <div className="backdrop" aria-hidden="true">
          <span className="blob b1" /><span className="blob b2" /><span className="blob b3" />
          <span className="grain" />
        </div>
        <TrafficLights />

        {/* appearance toggle */}
        <div style={{ position: 'absolute', top: 16, right: 18, zIndex: 30, display: 'flex', gap: 2, padding: 3,
          borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          {[['light', 'sun'], ['dark', 'moon']].map(([t, ic]) => (
            <button key={t} onClick={() => setTheme(t)} style={{
              width: 30, height: 26, borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center',
              background: theme === t ? 'var(--bg-elevated)' : 'transparent',
              color: theme === t ? 'var(--ink)' : 'var(--on-glass)',
              boxShadow: theme === t ? '0 1px 3px rgba(0,0,0,0.18)' : 'none', transition: 'all 200ms ease',
            }}><Icon name={ic} size={15} /></button>
          ))}
        </div>

        {/* dashboard behind */}
        {phase !== 'card' && (
          <div className="dash-wrap" data-phase={phase}>
            <DashboardPeek workspace={workspace} budget={budget} />
          </div>
        )}

        {/* finishing flourish */}
        {phase === 'finishing' && (
          <div className="youre-set">
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 56, height: 56, borderRadius: '50%',
              background: 'var(--green)', color: '#fff', marginBottom: 16, boxShadow: '0 10px 30px rgba(52,199,89,0.4)' }}>
              <Icon name="check" size={30} stroke={3} />
            </span>
            <div style={{ font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>You're set</div>
          </div>
        )}

        {/* the card */}
        {phase === 'card' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 40, zIndex: 20 }}>
            <div className="glass-card">
              <Stepper step={step} maxVisited={maxVisited} onJump={go} />
              <div className="card-body" key={step} data-dir={dir}>
                {steps[step]}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 30, minHeight: 44 }}>
                <div>
                  {step > 0 && (
                    <PillButton kind="quiet" onClick={() => go(step - 1)}>
                      <Icon name="arrowLeft" size={16} style={{ marginRight: 2 }} /> Back
                    </PillButton>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {step === 4 && (
                    <PillButton kind="quiet" onClick={finish}>Skip for now</PillButton>
                  )}
                  <PillButton kind="primary" disabled={!canContinue}
                    onClick={() => (step === 4 ? finish() : go(step + 1))}
                    icon={step === 4 ? null : 'arrowRight'}>
                    {continueLabel}
                  </PillButton>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* restart affordance when done */}
        {phase === 'done' && (
          <button onClick={restart} style={{
            position: 'absolute', bottom: 20, right: 22, zIndex: 40, display: 'inline-flex', alignItems: 'center', gap: 7,
            height: 36, padding: '0 14px', borderRadius: 'var(--r-pill)',
            background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', color: 'var(--ink)',
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            font: '500 var(--fs-subhead)/1 var(--font-text)',
          }}>
            <Icon name="refresh" size={15} /> Replay setup
          </button>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
