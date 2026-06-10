/* Job Monitor — assembly: header, counters, filters, view switch,
   live now-line drift + cost ticking, inspector + cancel flow. */

const MON_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'gated', label: 'Gated' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'failed', label: 'Failed' },
];

function CounterPill({ n, label, tint }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
      <b style={{ font: '700 var(--fs-callout)/1 var(--font-mono)' }}>{n}</b> {label}
    </span>
  );
}

function JobMonitor() {
  const [theme, setTheme] = useTheme('light');
  const [view, setView] = React.useState('timeline');
  const [filter, setFilter] = React.useState('all');
  const [jobs, setJobs] = React.useState(() => MON_JOBS.map(j => ({ ...j, _liveCost: j.cost })));
  const [nowMin, setNowMin] = React.useState(NOW_MIN);
  const [sel, setSel] = React.useState(null);
  const [cancelJob, setCancelJob] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // live drift: advance now-line + tick running costs
  React.useEffect(() => {
    const t = setInterval(() => {
      setNowMin(n => (n < 67 ? +(n + 0.08).toFixed(2) : n));
      setJobs(js => js.map(j => j.status === 'running' ? { ...j, _liveCost: +(j._liveCost + 0.002 + Math.random() * 0.004).toFixed(3) } : j));
    }, 900);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const counts = {
    running: jobs.filter(j => j.status === 'running').length,
    gated: jobs.filter(j => j.status === 'gated').length,
    queued: jobs.filter(j => j.status === 'queued').length,
  };
  const shown = jobs.filter(j => filter === 'all' || j.status === filter);

  const doCancel = (job) => {
    const cap = document.querySelector(`[data-cap="${job.id}"]`);
    if (cap) cap.classList.add('cap-cancelling');
    setCancelJob(null);
    setTimeout(() => {
      setJobs(js => js.map(j => j.id === job.id ? { ...j, status: 'failed', end: Math.round(nowMin), last: 'cancelled by operator' } : j));
      setSel(s => s && s.id === job.id ? { ...s, status: 'failed', last: 'cancelled by operator' } : s);
    }, 360);
  };

  return (
    <WindowFrame>
      <Sidebar active="jobs" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '24px 28px 0' }}>
          {/* header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Jobs</h1>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              <CounterPill n={counts.running} label="running" tint="var(--purple)" />
              <CounterPill n={counts.gated} label="gated" tint="var(--orange)" />
              <CounterPill n={counts.queued} label="queued" tint="var(--ink-secondary)" />
            </div>
            <span style={{ flex: 1 }} />
            <Segmented value={view} onChange={setView}
              options={[{ key: 'timeline', label: 'Timeline', icon: 'sliders' }, { key: 'table', label: 'Table', icon: 'jobs' }]} />
          </div>

          {/* filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
            <button className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)',
              background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
              All projects <Icon name="chevronDown" size={14} />
            </button>
            <span style={{ width: 1, height: 20, background: 'var(--separator)' }} />
            {MON_FILTERS.map(f => {
              const on = filter === f.key;
              const c = f.key === 'all' ? jobs.length : jobs.filter(j => j.status === f.key).length;
              return (
                <button key={f.key} onClick={() => setFilter(f.key)} className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)',
                  background: on ? 'var(--blue)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
                  {f.label}
                  <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)', background: on ? 'rgba(255,255,255,0.25)' : 'var(--fill-secondary)',
                    color: on ? '#fff' : 'var(--ink-tertiary)', font: '700 var(--fs-caption)/18px var(--font-mono)', textAlign: 'center' }}>{c}</span>
                </button>
              );
            })}
          </div>

          {/* board */}
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 28 }}>
            {view === 'timeline'
              ? <Timeline jobs={shown} nowMin={nowMin} onSelect={setSel} selectedId={sel && sel.id} />
              : <MonTable jobs={shown} onSelect={setSel} selectedId={sel && sel.id} onCancel={setCancelJob} />}
          </div>
        </main>
      </div>

      <Inspector job={sel} onClose={() => setSel(null)} onCancel={setCancelJob} />
      <CancelSheet job={cancelJob} onClose={() => setCancelJob(null)} onConfirm={doCancel} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<JobMonitor />);
