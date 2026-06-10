/* Project Templates — data + gallery view (cards with hover Use/Clone). */

const EFFORT_BADGE = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' };

const TEMPLATE_DATA = [
  { id: 't1', name: 'Claude', icon: 'spark', tint: 'var(--purple)', ver: '2.1.0', shipped: true,
    purpose: 'General-purpose operator for writing, analysis, and chat.',
    effort: 'BALANCED', review: true, triggers: ['hand', 'chat'] },
  { id: 't2', name: 'Claude Code', icon: 'terminal', tint: 'var(--blue)', ver: '3.4.1', shipped: true,
    purpose: 'Ships code — builds features, runs tests, opens PRs behind a merge gate.',
    effort: 'DEEP', review: true, triggers: ['hand', 'webhook', 'clock'] },
  { id: 't3', name: 'Claude Design', icon: 'brush', tint: 'var(--teal)', ver: '1.2.0', shipped: true,
    purpose: 'Generates and exports brand assets at scale with review gates.',
    effort: 'BALANCED', review: true, triggers: ['hand', 'chat'] },
  { id: 't4', name: 'Research Scout', icon: 'telescope', tint: 'var(--indigo)', ver: '1.0.3', shipped: false,
    purpose: 'Recurring scans and citation-backed digests on a schedule.',
    effort: 'FAST', review: false, triggers: ['clock'] },
  { id: 't5', name: 'Content Studio', icon: 'play', tint: 'var(--orange)', ver: '0.9.0', shipped: false, draft: true,
    purpose: 'Drafts, schedules, and publishes across channels — every post gated.',
    effort: 'BALANCED', review: true, triggers: ['hand', 'clock'] },
  { id: 't6', name: 'Triage Bot', icon: 'bell', tint: 'var(--green)', ver: '1.1.0', shipped: false,
    purpose: 'Auto-labels and routes incoming tickets the moment they land.',
    effort: 'FAST', review: false, triggers: ['webhook', 'chat'] },
];

const TRIG_ICON = { hand: 'play', clock: 'clock', chat: 'command', webhook: 'bolt' };

function OriginChip({ shipped }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)',
      background: shipped ? 'color-mix(in srgb, var(--purple) 13%, transparent)' : 'var(--fill-secondary)',
      color: shipped ? 'var(--purple)' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap' }}>
      {shipped && <MaestroMark size={11} />}{shipped ? 'Maestro' : 'Yours'}
    </span>
  );
}

function TemplateCard({ t, onUse, onClone, onEdit }) {
  return (
    <div className="tpl-card" data-tpl={t.id} onClick={() => onEdit(t.id)} style={{
      position: 'relative', background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)',
      boxShadow: 'var(--card-shadow)', padding: 16, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={23} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ font: '600 var(--fs-headline)/1.2 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{t.name}</span>
            <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)',
              font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>v{t.ver}</span>
            {t.draft && <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.15)',
              font: '600 var(--fs-caption)/18px var(--font-text)', color: 'var(--orange)' }}>Draft</span>}
          </div>
        </div>
        <OriginChip shipped={t.shipped} />
      </div>

      <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty', minHeight: 42 }}>{t.purpose}</p>

      {/* capability footer */}
      <div className="tpl-footer" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12, borderTop: '0.5px solid var(--separator)' }}>
        <span title={`${t.effort} effort default`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 'var(--r-pill)',
          background: `color-mix(in srgb, ${EFFORT_BADGE[t.effort]} 13%, transparent)`, color: EFFORT_BADGE[t.effort], font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em' }}>
          <Icon name="gauge" size={12} /> {t.effort}
        </span>
        <span title={t.review ? 'Reviewer on' : 'No reviewer'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
          color: t.review ? 'var(--green)' : 'var(--ink-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
          <Icon name={t.review ? 'shield' : 'xCircle'} size={14} /> {t.review ? 'Review' : 'No review'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-tertiary)' }}>
          {t.triggers.map(tr => <Icon key={tr} name={TRIG_ICON[tr]} size={14} />)}
        </span>
      </div>

      {/* hover actions */}
      <div className="tpl-actions" style={{ position: 'absolute', inset: 0, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        background: 'color-mix(in srgb, var(--bg-elevated) 80%, transparent)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
        opacity: 0, pointerEvents: 'none', transition: 'opacity 140ms ease' }}>
        <button onClick={e => { e.stopPropagation(); onUse(t.id); }} className="primary-cta" style={{ height: 40, padding: '0 22px', borderRadius: 'var(--r-pill)',
          background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Use</button>
        <button onClick={e => { e.stopPropagation(); onClone(t.id); }} style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Clone</button>
      </div>
    </div>
  );
}

function TemplateGalleryView({ templates, onUse, onClone, onEdit, onNew, onImport }) {
  return (
    <main style={{ flex: 1, overflowY: 'auto', padding: '26px 28px 36px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Templates</h1>
          <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 520 }}>
            The hats your agents wear — saved presets for engine role, effort, skills, and triggers. Clone one to make it yours.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <button onClick={onImport} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 15px', borderRadius: 'var(--r-pill)',
            background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
            <Icon name="enter" size={16} style={{ transform: 'rotate(90deg)' }} /> Import
          </button>
          <button onClick={onNew} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
            background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
            <Icon name="plus" size={16} stroke={2.4} /> New template
          </button>
        </div>
      </div>

      {['Shipped by Maestro', 'Your templates'].map(section => {
        const items = TEMPLATE_DATA.filter(t => section.startsWith('Shipped') ? t.shipped : !t.shipped);
        return (
          <div key={section} style={{ marginBottom: 28 }}>
            <ZoneLabel icon={section.startsWith('Shipped') ? 'shield' : 'layers'} tint={section.startsWith('Shipped') ? 'var(--purple)' : 'var(--blue)'}>{section} · {items.length}</ZoneLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(336px, 1fr))', gap: 16 }}>
              {items.map(t => <TemplateCard key={t.id} t={t} onUse={onUse} onClone={onClone} onEdit={onEdit} />)}
            </div>
          </div>
        );
      })}
    </main>
  );
}

Object.assign(window, { TEMPLATE_DATA, EFFORT_BADGE, TRIG_ICON, TemplateCard, TemplateGalleryView });
