/* Project Templates — assembly: gallery ⇄ editor, clone animation,
   version history sheet, export toast. */

const VERSIONS = [
  { ver: '1.2.0', date: 'Mar 14, 2026', note: 'Added PR-author skill; default effort → BALANCED', current: true },
  { ver: '1.1.0', date: 'Feb 2, 2026', note: 'Reviewer made eval-gated' },
  { ver: '1.0.2', date: 'Jan 9, 2026', note: 'Patch: webhook trigger scope' },
  { ver: '1.0.0', date: 'Dec 20, 2025', note: 'First shipped version' },
];

function VersionSheet({ open, onClose }) {
  if (!open) return null;
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 540, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Version history</h2>
            <p style={{ margin: '4px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Editing creates v1.3.0. Existing projects keep their snapshot.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ padding: 10, overflowY: 'auto' }}>
          {VERSIONS.map((v, i) => (
            <div key={v.ver} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ width: 11, height: 11, borderRadius: 6, background: v.current ? 'var(--blue)' : 'var(--fill-secondary)', border: v.current ? 'none' : '1.5px solid var(--separator-strong)', marginTop: 3 }} />
                {i < VERSIONS.length - 1 && <span style={{ width: 1.5, flex: 1, minHeight: 26, background: 'var(--separator)', marginTop: 4 }} />}
              </div>
              <div style={{ flex: 1, paddingBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>v{v.ver}</span>
                  {v.current && <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/18px var(--font-text)' }}>Current</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{v.date}</span>
                </div>
                <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>{v.note}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Toast({ msg, onDone }) {
  React.useEffect(() => { if (msg) { const t = setTimeout(onDone, 2600); return () => clearTimeout(t); } }, [msg]);
  if (!msg) return null;
  return (
    <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
      display: 'inline-flex', alignItems: 'center', gap: 10, height: 44, padding: '0 18px', borderRadius: 'var(--r-pill)',
      background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--green)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name="check" size={12} stroke={3} style={{ color: '#fff' }} />
      </span>
      <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>{msg}</span>
    </div>
  );
}

function TemplatesPage() {
  const [theme, setTheme] = useTheme('light');
  const [view, setView] = React.useState('gallery'); // gallery | editor
  const [editBase, setEditBase] = React.useState(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [toast, setToast] = React.useState('');
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const byId = id => TEMPLATE_DATA.find(t => t.id === id);
  const openEditor = (base) => { setEditBase(base); setView('editor'); document.querySelector('main') && document.querySelector('main').scrollTo(0, 0); };

  const onEdit = (id) => openEditor(byId(id));
  const onUse = () => { location.href = '../project-detail/Project Detail.html'; };
  const onClone = (id) => {
    const card = document.querySelector(`[data-tpl="${id}"]`);
    if (card) { card.classList.add('cloning'); setTimeout(() => { card.classList.remove('cloning'); openEditor({ ...byId(id), _cloned: true }); }, 420); }
    else openEditor({ ...byId(id), _cloned: true });
  };
  const onNew = () => openEditor({ name: '', icon: 'spark', tint: 'var(--blue)', ver: '0.1.0', effort: 'BALANCED', review: true, triggers: ['hand'] });

  return (
    <WindowFrame>
      <Sidebar active="templates" onNav={navTo} onWorkspace={() => {}} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        {view === 'gallery'
          ? <TemplateGalleryView templates={TEMPLATE_DATA} onUse={onUse} onClone={onClone} onEdit={onEdit} onNew={onNew} onImport={() => setToast('Template imported')} />
          : <TemplateEditor base={editBase} onBack={() => setView('gallery')} onExport={() => setToast('Template exported')} onHistory={() => setHistoryOpen(true)} onSave={() => { setToast('Saved as v1.3.0'); setView('gallery'); }} />}
      </div>

      <VersionSheet open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <Toast msg={toast} onDone={() => setToast('')} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<TemplatesPage />);
