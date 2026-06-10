/* Projects Overview — page assembly: header, segmented Grid/List,
   skeleton-on-load, archive → empty state, template gallery modal. */

function ProjectsPage() {
  const [theme, setTheme] = useTheme('light');
  const [view, setView] = React.useState('grid');
  const [loading, setLoading] = React.useState(true);
  const [projects, setProjects] = React.useState(SEED);
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => { const t = setTimeout(() => setLoading(false), 850); return () => clearTimeout(t); }, []);

  const archive = (id) => setProjects(ps => ps.filter(p => p.id !== id));
  const open = () => { location.href = '../project-detail/Project Detail.html'; };

  const newBtn = (
    <button onClick={() => setGalleryOpen(true)} className="primary-cta" style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
      background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)',
    }}>
      <Icon name="plus" size={16} stroke={2.4} /> New project
    </button>
  );

  return (
    <WindowFrame>
      <Sidebar active="projects" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)}
          budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        <main style={{ flex: 1, overflowY: 'auto', padding: '26px 28px 32px' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22, gap: 16 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Projects</h1>
              <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
                {projects.length} project{projects.length !== 1 ? 's' : ''} in {WORKSPACE}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Segmented value={view} onChange={setView}
                options={[{ key: 'grid', label: 'Grid', icon: 'layers' }, { key: 'list', label: 'List', icon: 'jobs' }]} />
              {newBtn}
            </div>
          </div>

          {loading ? <SkeletonGrid view={view} />
            : projects.length === 0 ? <EmptyProjects onPick={() => setGalleryOpen(true)} />
            : view === 'grid'
              ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(316px, 1fr))', gap: 18 }}>
                  {projects.map(p => <ProjectCard key={p.id} p={p} onMenu={archive} onOpen={open} />)}
                </div>
              : <ListTable projects={projects} onMenu={archive} onOpen={open} />}
        </main>
      </div>

      <TemplateGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

function ListTable({ projects, onMenu, onOpen }) {
  const [sort, setSort] = React.useState('activity');
  const sorted = [...projects].sort((a, b) => sort === 'spend' ? b.spent - a.spent : 0);
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* header */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1.4fr 0.8fr 1fr 36px', alignItems: 'center', gap: 14,
        padding: '11px 16px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {[['Project', null], ['Status', null], ['Budget', 'spend'], ['Subs', null], ['Schedule', 'activity'], ['', null]].map(([label, key], i) => (
          <button key={i} onClick={() => key && setSort(key)} style={{ textAlign: 'left', cursor: key ? 'pointer' : 'default',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase',
            color: sort === key ? 'var(--blue)' : 'var(--ink-tertiary)' }}>
            {label}{key && <Icon name="chevronDown" size={11} />}
          </button>
        ))}
      </div>
      {sorted.map((p, i) => <ProjectRow key={p.id} p={p} onMenu={onMenu} onOpen={onOpen} last={i === sorted.length - 1} />)}
    </div>
  );
}

function SkeletonGrid({ view }) {
  if (view === 'list') {
    return (
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 16px', borderBottom: i < 5 ? '0.5px solid var(--separator)' : 'none' }}>
            <span className="shim" style={{ width: 32, height: 32, borderRadius: 9 }} />
            <span className="shim" style={{ width: 140, height: 12, borderRadius: 6 }} />
            <span style={{ flex: 1 }} />
            <span className="shim" style={{ width: 90, height: 8, borderRadius: 5 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(316px, 1fr))', gap: 18 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--separator)', padding: 18, boxShadow: 'var(--card-shadow)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span className="shim" style={{ width: 42, height: 42, borderRadius: 12 }} />
            <span><span className="shim" style={{ display: 'block', width: 120, height: 13, borderRadius: 6 }} /><span className="shim" style={{ display: 'block', width: 60, height: 9, borderRadius: 5, marginTop: 7 }} /></span>
          </div>
          <span className="shim" style={{ display: 'block', width: 150, height: 10, borderRadius: 5, marginBottom: 16 }} />
          <span className="shim" style={{ display: 'block', width: '100%', height: 5, borderRadius: 3, marginBottom: 10 }} />
          <span className="shim" style={{ display: 'block', width: 80, height: 9, borderRadius: 5 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyProjects({ onPick }) {
  const items = Object.entries(TEMPLATES);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '70px 20px' }}>
      <span style={{ width: 64, height: 64, borderRadius: 18, display: 'grid', placeItems: 'center', marginBottom: 20,
        background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)' }}>
        <Icon name="layers" size={32} />
      </span>
      <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.15 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>No projects yet</h2>
      <p style={{ margin: '0 0 26px', maxWidth: 380, font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
        Projects keep instructions, budget, and schedules together. Create one from a template.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
        {items.map(([k, t]) => (
          <button key={k} onClick={onPick} className="tpl-pick" style={{
            display: 'inline-flex', alignItems: 'center', gap: 9, height: 44, padding: '0 16px 0 12px', borderRadius: 'var(--r-pill)',
            background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
            font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
              background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}><Icon name={t.icon} size={16} /></span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ProjectsPage />);
