/* Scheduler — assembly: header, Calendar/List switch, live now-line, sheet. */

function Scheduler() {
  const [theme, setTheme] = useTheme('light');
  const [view, setView] = React.useState('calendar');
  const [nowTime, setNowTime] = React.useState(14.62); // 14:37
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // live now-line
  React.useEffect(() => {
    const t = setInterval(() => setNowTime(n => (n < 21.9 ? +(n + 0.0025).toFixed(4) : n)), 1500);
    return () => clearInterval(t);
  }, []);
  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const openNew = () => { setEditing(null); setSheetOpen(true); };
  const openEdit = (s) => { setEditing(s); setSheetOpen(true); };

  return (
    <WindowFrame>
      <Sidebar active="scheduler" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '24px 28px 0' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 6 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Scheduler</h1>
            </div>
            <span style={{ flex: 1 }} />
            <Segmented value={view} onChange={setView} options={[{ key: 'calendar', label: 'Calendar', icon: 'calendar' }, { key: 'list', label: 'List', icon: 'jobs' }]} />
            <button onClick={openNew} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
              background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
              <Icon name="plus" size={16} stroke={2.4} /> New schedule
            </button>
          </div>
          {/* durability reassurance */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 18, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
            <Icon name="shield" size={14} style={{ color: 'var(--green)' }} />
            Schedules run even while you sleep — if the Mac sleeps too, the job resumes from checkpoint on wake.
          </div>

          {/* body */}
          <div style={{ flex: 1, minHeight: 0, overflowY: view === 'list' ? 'auto' : 'hidden', paddingBottom: view === 'list' ? 28 : 0 }}>
            {view === 'calendar'
              ? <CalendarView nowTime={nowTime} onPick={openEdit} />
              : <ListView onPick={openEdit} />}
          </div>
        </main>
      </div>

      <ScheduleSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onSave={() => setSheetOpen(false)} initial={editing} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Scheduler />);
