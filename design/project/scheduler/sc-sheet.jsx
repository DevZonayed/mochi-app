/* Scheduler — New/Edit schedule frosted sheet (520px). */

// tiny natural-language → cron parser (demo-grade)
function parseWhen(text) {
  const t = text.toLowerCase().trim();
  const dayMap = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  let time = '09:00', cron = '0 9 * * *', summary = 'Every day at 09:00', next = 'tomorrow 09:00';
  const tm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let hh = 9, mm = 0;
  if (tm) {
    hh = parseInt(tm[1], 10); mm = tm[2] ? parseInt(tm[2], 10) : 0;
    if (tm[3] === 'pm' && hh < 12) hh += 12;
    if (tm[3] === 'am' && hh === 12) hh = 0;
  }
  time = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  let dayPart = '*', label = 'Every day';
  if (/weekday|every weekday|mon-fri|monday to friday/.test(t)) { dayPart = '1-5'; label = 'Weekdays'; }
  else {
    const found = Object.keys(dayMap).filter(k => t.includes(k));
    if (found.length) { dayPart = found.map(k => ({ sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6 }[k])).join(','); label = found.map(k => dayMap[k]).join(', '); }
  }
  cron = `${mm} ${hh} * * ${dayPart}`;
  summary = `${label} at ${time}`;
  return { time, cron, summary, label };
}

function SheetSection({ n, title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{n}</span>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function Stepper({ value, set, min = 0, max = 10, suffix }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <button onClick={() => set(Math.max(min, value - 1))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 18px/1 var(--font-text)' }}>−</button>
      <span style={{ minWidth: 46, textAlign: 'center', font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}{suffix}</span>
      <button onClick={() => set(Math.min(max, value + 1))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 18px/1 var(--font-text)' }}>+</button>
    </div>
  );
}

function ScheduleSheet({ open, onClose, onSave, initial }) {
  const [when, setWhen] = React.useState('every weekday 9am');
  const [advanced, setAdvanced] = React.useState(false);
  const [misfire, setMisfire] = React.useState('fire');
  const [retries, setRetries] = React.useState(2);
  const [backoff, setBackoff] = React.useState('Exponential');
  const [conc, setConc] = React.useState(1);
  const [cap, setCap] = React.useState(0.5);
  React.useEffect(() => { if (open) { setWhen('every weekday 9am'); setAdvanced(false); setMisfire('fire'); setRetries(2); setConc(1); setCap(0.5); } }, [open]);
  if (!open) return null;

  const parsed = parseWhen(when);
  const perMonthRuns = parsed.label === 'Weekdays' ? 22 : parsed.label === 'Every day' ? 30 : 4;
  const monthly = (0.18 * perMonthRuns).toFixed(2);
  const misfireOpts = [
    { key: 'fire', label: 'Fire now', hint: 'Run immediately when the Mac wakes.' },
    { key: 'skip', label: 'Skip', hint: 'Drop the missed run; wait for the next.' },
    { key: 'coalesce', label: 'Coalesce', hint: 'Collapse multiple misses into one run.' },
  ];
  const mi = misfireOpts.findIndex(o => o.key === misfire);

  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 520, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>New schedule</h2>
            <p style={{ margin: '3px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Durable — it survives sleep, restarts, and resumes from checkpoint.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {/* 1 project + template */}
          <SheetSection n="1" title="Project & job">
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
              <SheetPick icon="layers" label="Project" value="Atlas API" tint="var(--blue)" />
              <SheetPick icon="terminal" label="Job template" value="Nightly tests" tint="var(--purple)" last />
            </div>
          </SheetSection>

          {/* 2 when */}
          <SheetSection n="2" title="When">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 46, padding: '0 14px', background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
              <Icon name="calendar" size={17} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
              <input value={when} onChange={e => setWhen(e.target.value)} placeholder="every Monday 9am"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }} />
            </div>
            <div className="parse-line" key={parsed.summary} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, padding: '0 4px' }}>
              <Icon name="check" size={14} stroke={2.6} style={{ color: 'var(--green)', flexShrink: 0 }} />
              <span style={{ font: '500 var(--fs-footnote)/1.3 var(--font-mono)', whiteSpace: 'nowrap', color: 'var(--ink-secondary)' }}>{parsed.summary} · next: 17 Jun</span>
            </div>
            <button onClick={() => setAdvanced(a => !a)} className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>
              <Icon name="chevronRight" size={13} style={{ transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform 180ms var(--spring)' }} /> Advanced cron
            </button>
            {advanced && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 14px', background: 'var(--fill-tertiary)', borderRadius: 10, border: '0.5px solid var(--separator)' }}>
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>cron</span>
                <input defaultValue={parsed.cron} key={parsed.cron} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }} />
              </div>
            )}
          </SheetSection>

          {/* 3 durability */}
          <SheetSection n="3" title="Durability">
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', padding: 14 }}>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>Misfire policy</div>
              <div style={{ position: 'relative', display: 'flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9, marginBottom: 8 }}>
                <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${mi} * (100% - 4px) / 3 + 2px)`, width: `calc((100% - 4px) / 3)`, background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
                {misfireOpts.map(o => (
                  <button key={o.key} onClick={() => setMisfire(o.key)} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '7px 0', font: '600 var(--fs-footnote)/1 var(--font-text)', color: misfire === o.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>{o.label}</button>
                ))}
              </div>
              <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 16 }}>{misfireOpts[mi].hint}</div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Retries</span>
                <Stepper value={retries} set={setRetries} min={0} max={5} />
                <select value={backoff} onChange={e => setBackoff(e.target.value)} className="sel" style={{ height: 34, padding: '0 10px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)' }}>
                  <option>Exponential</option><option>Linear</option><option>Fixed</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Concurrency limit</span>
                <Stepper value={conc} set={setConc} min={1} max={8} />
              </div>
            </div>
          </SheetSection>

          {/* 4 budget */}
          <SheetSection n="4" title="Budget">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 46, padding: '0 14px', background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
              <span style={{ font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)', flex: 1 }}>Per-run cap</span>
              <span style={{ font: '500 22px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>$</span>
              <input value={cap} onChange={e => setCap(e.target.value)} style={{ width: 56, border: 'none', outline: 'none', background: 'transparent', textAlign: 'right', font: '600 22px/1 var(--font-mono)', color: 'var(--ink)' }} />
            </div>
            <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 8, padding: '0 4px' }}>Project has <b style={{ color: 'var(--ink)', fontWeight: 600 }}>$31.40</b> left this month.</div>
          </SheetSection>
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1, font: '500 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)' }}>
            ≈ <b style={{ color: 'var(--ink)', fontWeight: 600 }}>$0.18</b>/run · ≈ <b style={{ color: 'var(--ink)', fontWeight: 600 }}>${monthly}</b>/mo
          </div>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onSave} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Save schedule</button>
        </div>
      </div>
    </div>
  );
}

function SheetPick({ icon, label, value, tint, last }) {
  return (
    <button className="sheet-pick" style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 52, padding: '10px 14px', textAlign: 'left',
      borderBottom: last ? 'none' : '0.5px solid var(--separator)' }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}><Icon name={icon} size={16} /></span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 3 }}>{label}</span>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>{value}</span>
      </span>
      <Icon name="chevronDown" size={16} style={{ color: 'var(--ink-tertiary)' }} />
    </button>
  );
}

Object.assign(window, { parseWhen, ScheduleSheet, Stepper });
