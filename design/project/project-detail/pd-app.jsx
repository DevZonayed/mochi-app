/* Project Detail — page assembly: header, sticky tab bar, tab router,
   gate-arrives micro-interaction. */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'skills', label: 'Skills & tools' },
  { key: 'budget', label: 'Budget' },
  { key: 'settings', label: 'Settings' },
];

function Breadcrumb() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, font: '500 var(--fs-subhead)/1 var(--font-text)' }}>
      <a href="../projects/Projects.html" className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none' }}>{WORKSPACE}</a>
      <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
      <a href="../projects/Projects.html" className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none' }}>Projects</a>
      <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Atlas API</span>
    </div>
  );
}

function GateBanner({ gate, onApprove, onDismiss }) {
  if (!gate) return null;
  return (
    <div className="gate-banner" style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', marginBottom: 20,
      background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,149,0,0.4)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.12), var(--card-shadow)',
    }}>
      <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: 'rgba(255,149,0,0.15)', color: 'var(--orange)' }}>
        <Icon name="enter" size={19} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1.25 var(--font-text)', color: 'var(--ink)' }}>A job is waiting at a gate</span>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>Merge PR #482 — auth refactor · 12 files · +840 −210</span>
      </span>
      <button onClick={onDismiss} style={{ height: 34, padding: '0 14px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Review</button>
      <button onClick={onApprove} className="primary-cta" style={{ height: 34, padding: '0 16px', borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Approve &amp; merge</button>
    </div>
  );
}

function ProjectDetail() {
  const [theme, setTheme] = useTheme('light');
  const [tab, setTab] = React.useState('overview');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [gate, setGate] = React.useState(false);

  // ⌘K
  React.useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && document.activeElement.tagName !== 'TEXTAREA') { setGate(true); setTab('overview'); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const tabIdx = TABS.findIndex(t => t.key === tab);

  return (
    <WindowFrame>
      <Sidebar active="projects" onNav={navTo} onWorkspace={() => {}} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)}
          budget={{ spent: 22.90, cap: 50, animateKey: 0 }} />

        <main style={{ flex: 1, overflowY: 'auto' }}>
          {/* header block */}
          <div style={{ padding: '24px 28px 0' }}>
            <Breadcrumb />
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <span style={{ width: 52, height: 52, borderRadius: 15, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: 'color-mix(in srgb, var(--blue) 15%, transparent)', color: 'var(--blue)' }}>
                <Icon name="terminal" size={28} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Atlas API</h1>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
                    background: 'rgba(52,199,89,0.16)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                    <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Active · 2 running
                  </span>
                </div>
                <div style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 7 }}>Code · 4 sub-projects · TypeScript, Fastify, Postgres</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <button className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 15px', borderRadius: 'var(--r-pill)',
                  background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                  <Icon name="layers" size={16} /> Run from template
                </button>
                <button onClick={() => setPaletteOpen(true)} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)',
                  background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
                  <Icon name="plus" size={16} stroke={2.4} /> New job
                </button>
              </div>
            </div>
          </div>

          {/* sticky tab bar */}
          <div style={{ position: 'sticky', top: 0, zIndex: 10, padding: '14px 28px 12px', marginTop: 18,
            background: 'color-mix(in srgb, var(--bg) 86%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            borderBottom: '0.5px solid var(--separator)' }}>
            <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
              <div className="tab-pill" style={{ position: 'absolute', top: 3, bottom: 3, left: `${tabIdx * 116 + 3}px`, width: 116,
                background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
              {TABS.map(t => (
                <button key={t.key} onClick={() => setTab(t.key)} style={{
                  position: 'relative', zIndex: 1, width: 116, padding: '8px 0', textAlign: 'center',
                  font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
                  color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)', transition: 'color 160ms ease',
                }}>{t.label}</button>
              ))}
            </div>
          </div>

          {/* tab content */}
          <div style={{ padding: '22px 28px 36px' }}>
            {tab === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
                <GateBanner gate={gate} onApprove={() => setGate(false)} onDismiss={() => setGate(false)} />
                <GoalComposer />
                <SubProjects />
                <RecentJobs jobs={PROJECT_JOBS.slice(0, 5)} />
              </div>
            )}
            {tab === 'jobs' && <JobsTab />}
            {tab === 'instructions' && <InstructionsTab />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'budget' && <BudgetTab />}
            {tab === 'settings' && <SettingsTab />}
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ProjectDetail />);
