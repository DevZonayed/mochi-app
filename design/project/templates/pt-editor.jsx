/* Project Templates — full-page editor (left forms, right live preview). */

const ICON_CHOICES = ['spark', 'terminal', 'brush', 'telescope', 'play', 'bell', 'bolt', 'cpu', 'layers', 'gauge', 'send', 'shield'];
const COLOR_CHOICES = ['var(--blue)', 'var(--purple)', 'var(--teal)', 'var(--indigo)', 'var(--orange)', 'var(--green)', 'var(--red)'];
const ROLES = [
  { key: 'builder',  label: 'Builder',  hint: 'Writes and edits' },
  { key: 'driver',   label: 'Driver',   hint: 'Plans and coordinates' },
  { key: 'subagent', label: 'Subagent', hint: 'Parallel workers' },
  { key: 'reviewer', label: 'Reviewer', hint: 'Checks before gates' },
];

function EditorSection({ n, title, children, sub }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 12 }}>
        <span style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{n}</span>
        <h3 style={{ margin: 0, font: '600 var(--fs-headline)/1.2 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{title}</h3>
        {sub && <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function TokenChips({ items, onAdd, onRemove, tint = 'var(--blue)' }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12, background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 6px 0 11px', borderRadius: 'var(--r-pill)',
          background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
          {it}
          <button onClick={() => onRemove(i)} className="chip-x" style={{ width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', color: tint }}>
            <Icon name="x" size={11} stroke={2.5} />
          </button>
        </span>
      ))}
      <button onClick={onAdd} className="chip-add" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)',
        background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
        <Icon name="plus" size={13} stroke={2.4} /> Add
      </button>
    </div>
  );
}

function MiniDial({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 64, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', flexShrink: 0 }}>{label}</span>
      <EffortDial value={value} onChange={onChange} compact />
    </div>
  );
}

function TemplateEditor({ base, onBack, onExport, onHistory, onSave }) {
  const [name, setName] = React.useState(base.name + (base._cloned ? ' copy' : ''));
  const [icon, setIcon] = React.useState(base.icon);
  const [color, setColor] = React.useState(base.tint);
  const [iconOpen, setIconOpen] = React.useState(false);
  const [planE, setPlanE] = React.useState('BALANCED');
  const [buildE, setBuildE] = React.useState(base.effort);
  const [reviewE, setReviewE] = React.useState('FAST');
  const [reviewer, setReviewer] = React.useState(base.review);
  const [skills, setSkills] = React.useState(['TypeScript engineer', 'PR author', 'Test writer']);
  const [tools, setTools] = React.useState(['GitHub', 'Postgres (read-only)']);
  const [triggers, setTriggers] = React.useState({
    hand: base.triggers.includes('hand'), clock: base.triggers.includes('clock'),
    chat: base.triggers.includes('chat'), webhook: base.triggers.includes('webhook'),
  });

  const addSkill = () => setSkills(s => [...s, 'New skill']);
  const addTool = () => setTools(s => [...s, 'New tool']);

  return (
    <main style={{ flex: 1, overflowY: 'auto' }}>
      {/* editor header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: 14, padding: '16px 28px',
        background: 'color-mix(in srgb, var(--bg) 86%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '0.5px solid var(--separator)' }}>
        <button onClick={onBack} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px 0 10px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
          <Icon name="arrowLeft" size={16} /> Templates
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{name || 'Untitled template'}</span>
            <span style={{ height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/20px var(--font-mono)', color: 'var(--ink-secondary)' }}>draft v1.3.0</span>
          </div>
        </div>
        <button onClick={onHistory} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
          <Icon name="clock" size={15} /> History
        </button>
        <button onClick={onExport} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
          <Icon name="enter" size={15} style={{ transform: 'rotate(-90deg)' }} /> Export
        </button>
        <button onClick={onSave} className="primary-cta" style={{ height: 34, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff',
          font: '600 var(--fs-subhead)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Save template</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 28, padding: '24px 28px 40px', alignItems: 'start' }}>
        {/* ── left: forms ── */}
        <div style={{ maxWidth: 600 }}>
          {/* 1 identity */}
          <EditorSection n="1" title="Identity">
            <GroupedList>
              <Row>
                <span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>Name</span>
                <input value={name} onChange={e => setName(e.target.value)} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
                  font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)', padding: '13px 0' }} />
              </Row>
              <Row>
                <span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>Icon</span>
                <div style={{ flex: 1, position: 'relative' }}>
                  <button onClick={() => setIconOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 8px', borderRadius: 9, background: 'var(--fill-secondary)' }}>
                    <span style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
                      <Icon name={icon} size={16} />
                    </span>
                    <Icon name="chevronDown" size={14} style={{ color: 'var(--ink-tertiary)' }} />
                  </button>
                  {iconOpen && (
                    <div className="icon-pop" style={{ position: 'absolute', top: 44, left: 0, zIndex: 20, width: 232, padding: 10, borderRadius: 14,
                      background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
                      display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
                      {ICON_CHOICES.map(ic => (
                        <button key={ic} onClick={() => { setIcon(ic); setIconOpen(false); }} style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
                          background: icon === ic ? `color-mix(in srgb, ${color} 16%, transparent)` : 'var(--fill-tertiary)', color: icon === ic ? color : 'var(--ink-secondary)' }}>
                          <Icon name={ic} size={17} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Row>
              <Row last>
                <span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>Color</span>
                <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                  {COLOR_CHOICES.map(c => (
                    <button key={c} onClick={() => setColor(c)} style={{ width: 26, height: 26, borderRadius: '50%', background: c,
                      boxShadow: color === c ? `0 0 0 2px var(--bg-elevated), 0 0 0 4px ${c}` : 'none', transition: 'box-shadow 140ms ease' }} />
                  ))}
                </div>
              </Row>
            </GroupedList>
          </EditorSection>

          {/* 2 engine & effort */}
          <EditorSection n="2" title="Engine & effort">
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', padding: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                {ROLES.map(r => (
                  <span key={r.key} title={r.hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)',
                    background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--ink-tertiary)' }} />{r.label}
                  </span>
                ))}
              </div>
              <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 16 }}>Roles are routed by config — the engine behind each is chosen per workspace.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
                <MiniDial label="Plan" value={planE} onChange={setPlanE} />
                <MiniDial label="Build" value={buildE} onChange={setBuildE} />
                <MiniDial label="Review" value={reviewE} onChange={setReviewE} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Reviewer
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>A second pass before any gate.</span>
                </span>
                {reviewer && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)',
                  background: 'rgba(52,199,89,0.16)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><Icon name="shield" size={13} /> Eval-gated</span>}
                <Switch on={reviewer} onChange={setReviewer} />
              </div>
            </div>
          </EditorSection>

          {/* 3 skills & tools */}
          <EditorSection n="3" title="Starter skills & allowed tools">
            <div style={{ marginBottom: 12 }}>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', padding: '0 2px 7px' }}>Skills</div>
              <TokenChips items={skills} onAdd={addSkill} onRemove={i => setSkills(s => s.filter((_, x) => x !== i))} tint="var(--blue)" />
            </div>
            <div>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', padding: '0 2px 7px' }}>Allowed tools</div>
              <TokenChips items={tools} onAdd={addTool} onRemove={i => setTools(s => s.filter((_, x) => x !== i))} tint="var(--teal)" />
            </div>
          </EditorSection>

          {/* 4 triggers */}
          <EditorSection n="4" title="Allowed triggers">
            <GroupedList>
              {[['hand', 'Manual', 'play'], ['clock', 'Schedule', 'clock'], ['chat', 'Chat message', 'command'], ['webhook', 'Webhook', 'bolt']].map(([k, label, ic], i) => (
                <Row key={k} last={i === 3}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}>
                    <Icon name={ic} size={16} />
                  </span>
                  <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
                  <Switch on={triggers[k]} onChange={v => setTriggers(t => ({ ...t, [k]: v }))} />
                </Row>
              ))}
            </GroupedList>
          </EditorSection>

          {/* 5 instruction scaffold */}
          <EditorSection n="5" title="Instruction scaffold">
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '0.5px solid var(--separator)' }}>
                <Icon name="terminal" size={15} style={{ color: 'var(--ink-secondary)' }} />
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>scaffold.md</span>
              </div>
              <textarea spellCheck={false} defaultValue={`You are a {{role}} on the {{project}} project.\n\nFollow the workspace and project instructions above this scaffold. Keep changes scoped. When unsure, ask before acting.\n\nDefinition of done\n- {{acceptance_criteria}}\n- Tests pass and a reviewer has signed off.`} style={{
                width: '100%', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
                font: '400 var(--fs-subhead)/1.6 var(--font-mono)', color: 'var(--ink)', padding: '14px 16px', minHeight: 150, boxSizing: 'border-box' }} />
            </div>
          </EditorSection>
        </div>

        {/* ── right: live preview ── */}
        <LivePreview name={name} icon={icon} color={color} buildE={buildE} reviewer={reviewer} triggers={triggers} />
      </div>
    </main>
  );
}

function LivePreview({ name, icon, color, buildE, reviewer, triggers }) {
  const est = EFFORT_EST[buildE];
  const heavy = buildE === 'DEEP' || buildE === 'MAX';
  const trigList = Object.entries(triggers).filter(([, v]) => v).map(([k]) => k);
  return (
    <div style={{ position: 'sticky', top: 88 }}>
      <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Live preview</div>

      {/* mini project shell */}
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
            <Icon name={icon} size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>New {name || 'template'} project</div>
            <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>Overview preview</div>
          </div>
        </div>

        {/* mini goal composer */}
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: 14 }}>
          <div style={{ font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 14 }}>Hand this project a goal…</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Effort</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
              background: `color-mix(in srgb, ${EFFORT_BADGE[buildE]} 14%, transparent)`, color: EFFORT_BADGE[buildE], font: '700 var(--fs-caption)/1 var(--font-text)' }}>{buildE}</span>
            {reviewer && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={12} /> Review</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTop: '0.5px solid var(--separator)' }}>
            <span key={buildE} className="estimate" style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>≈ ${est.cost} · ~{est.mins} min</span>
            <span style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--blue)', color: '#fff' }}>
              <Icon name="arrowRight" size={15} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
            </span>
          </div>
        </div>

        {/* trigger summary */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Triggers</span>
          <span style={{ display: 'inline-flex', gap: 6, color: 'var(--ink-secondary)' }}>
            {trigList.length ? trigList.map(t => <Icon key={t} name={TRIG_ICON[t]} size={14} />) : <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>None</span>}
          </span>
        </div>
      </div>

      {/* effort callout */}
      {heavy && (
        <div className="effort-callout" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, padding: '12px 14px', borderRadius: 12,
          background: 'rgba(255,149,0,0.10)', border: '0.5px solid rgba(255,149,0,0.35)' }}>
          <Icon name="alert" size={17} style={{ color: 'var(--orange)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>
            <b style={{ fontWeight: 600 }}>{buildE} default ≈ {buildE === 'MAX' ? '5×' : '3×'} cost</b> on every run — sure? Most projects do well on BALANCED.
          </span>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { TemplateEditor, LivePreview, ICON_CHOICES, COLOR_CHOICES, ROLES });
