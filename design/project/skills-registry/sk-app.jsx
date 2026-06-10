/* Skills Registry — assembly: header, search, segmented, list↔detail nav. */

const SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'installed', label: 'Installed in projects' },
  { key: 'mine', label: 'Published by you' },
  { key: 'quarantined', label: 'Quarantined' },
];

// crude semantic-ish ranking: matches name/desc/tags, weights tag hits
function rank(skill, q) {
  if (!q) return 0;
  const t = q.toLowerCase();
  let score = 0;
  if (skill.name.toLowerCase().includes(t)) score += 5;
  if (skill.desc.toLowerCase().includes(t)) score += 2;
  skill.tags.forEach(tag => { if (tag.includes(t) || t.includes(tag)) score += 4; });
  // loose semantic aliases
  const alias = { code: ['typescript', 'refactor', 'build'], write: ['writing', 'content', 'newsletter'], test: ['testing'], image: ['images', 'design', 'social'], db: ['database', 'sql'] };
  Object.entries(alias).forEach(([k, arr]) => { if (t.includes(k)) arr.forEach(a => { if (skill.tags.includes(a)) score += 3; }); });
  return score;
}

function SkillsRegistry() {
  const [theme, setTheme] = useTheme('light');
  const [seg, setSeg] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(null); // skill detail
  const [publish, setPublish] = React.useState(false);
  const [added, setAdded] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  let rows = SKILLS.filter(s => seg === 'all' || (seg === 'installed' && s.installed) || (seg === 'mine' && s.mine) || (seg === 'quarantined' && s.scan === 'quarantined'));
  if (query) rows = rows.map(s => ({ s, r: rank(s, query) })).filter(x => x.r > 0).sort((a, b) => b.r - a.r).map(x => x.s);

  return (
    <WindowFrame>
      <Sidebar active="skills" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        {open ? (
          <SkillDetail s={open} onBack={() => setOpen(null)} onAdd={s => setAdded(s)} />
        ) : (
          <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 36px' }}>
            <div style={{ maxWidth: 920, margin: '0 auto' }}>
              {/* header */}
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
                <div>
                  <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Skills</h1>
                  <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Your private registry — npm for skills, found by meaning, zero payments.</p>
                </div>
                <button onClick={() => setPublish(true)} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
                  background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
                  <Icon name="plus" size={16} stroke={2.4} /> Publish skill
                </button>
              </div>

              {/* search */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, height: 50, padding: '0 16px', borderRadius: 14, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', marginBottom: 16,
                backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
                <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your registry — semantic (try “write code” or “make images”)"
                  style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }} />
                {query && <button onClick={() => setQuery('')} className="tb-icon" style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}><Icon name="x" size={14} /></button>}
              </div>

              {/* segmented */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
                {SEGMENTS.map(sg => {
                  const on = seg === sg.key;
                  const count = SKILLS.filter(s => sg.key === 'all' || (sg.key === 'installed' && s.installed) || (sg.key === 'mine' && s.mine) || (sg.key === 'quarantined' && s.scan === 'quarantined')).length;
                  const isQ = sg.key === 'quarantined';
                  return (
                    <button key={sg.key} onClick={() => setSeg(sg.key)} className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px', borderRadius: 'var(--r-pill)',
                      background: on ? (isQ ? 'var(--red)' : 'var(--blue)') : 'var(--fill-secondary)', color: on ? '#fff' : (isQ && count ? 'var(--red)' : 'var(--ink-secondary)'), font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
                      {isQ && <Icon name="lock" size={13} />}{sg.label}
                      <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)', background: on ? 'rgba(255,255,255,0.25)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-tertiary)', font: '700 var(--fs-caption)/18px var(--font-mono)', textAlign: 'center' }}>{count}</span>
                    </button>
                  );
                })}
              </div>

              {/* list */}
              {rows.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '70px 20px' }}>
                  <span style={{ display: 'inline-grid', placeItems: 'center', width: 64, height: 64, borderRadius: 18, background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', marginBottom: 18 }}><Icon name="spark" size={32} /></span>
                  <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.15 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{query ? 'Nothing matches' : 'Publish your first skill'}</h2>
                  <p style={{ margin: 0, font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>{query ? 'Try a different phrase — search works by meaning, not name.' : 'Agents will find it by meaning, not name.'}</p>
                </div>
              ) : (
                <div key={query + seg} className="reg-list" style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
                  backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
                  {rows.map((s, i) => <SkillRow key={s.id} s={s} last={i === rows.length - 1} onOpen={setOpen} />)}
                </div>
              )}
            </div>
          </main>
        )}
      </div>

      <PublishSheet open={publish} onClose={() => setPublish(false)} />
      {added && <AddedToast skill={added} onDone={() => setAdded(null)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

function AddedToast({ skill, onDone }) {
  React.useEffect(() => { const t = setTimeout(onDone, 2400); return () => clearTimeout(t); }, []);
  return (
    <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 18px',
      borderRadius: 'var(--r-pill)', background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--green)', display: 'grid', placeItems: 'center' }}><Icon name="check" size={13} stroke={3} style={{ color: '#fff' }} /></span>
      <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>Added <b style={{ fontFamily: 'var(--font-mono)' }}>{skill.name}</b> to Atlas API</span>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<SkillsRegistry />);
