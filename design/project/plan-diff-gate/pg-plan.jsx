/* Plan/Diff Gate — Mode A: Plan gate (centered reading column). */

const PLAN_STEPS = [
  { title: 'Add a reversible migration', detail: 'Create migrations/0042 adding a nullable jwt_id column and an index. Backfill is a no-op; the column stays empty until tokens are issued.' },
  { title: 'Issue short-lived JWTs on login', detail: 'In routes/login.ts, sign a 15-minute token carrying the session id and set it alongside the existing cookie. Nothing is removed yet.' },
  { title: 'Read token-first with cookie fallback', detail: 'Update the three call sites that read req.session so they verify a bearer token first and fall back to the legacy cookie only when absent.' },
  { title: 'Add coverage', detail: 'Unit tests for token issue/verify/expiry and an integration test proving an existing cookie session keeps working through the rollout.' },
  { title: 'Open a PR behind the merge gate', detail: 'Summarize the change in plain language, link the issue, and stop at the gate — nothing merges without your approval.' },
];

function PlanGate({ editing }) {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* plan card */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 22px', borderBottom: '0.5px solid var(--separator)' }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)', flexShrink: 0 }}>
            <Icon name="sliders" size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Plan</h1>
            <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Refactor auth service to short-lived JWTs</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
            background: 'color-mix(in srgb, var(--orange) 14%, transparent)', color: 'var(--orange)', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em' }}>
            <Icon name="gauge" size={12} /> PLANNED AT DEEP
          </span>
        </div>

        {/* steps */}
        <div style={{ padding: '8px 0' }}>
          {PLAN_STEPS.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, padding: '14px 22px', borderBottom: i < PLAN_STEPS.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', marginTop: 1,
                background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-footnote)/1 var(--font-mono)' }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editing
                  ? <input defaultValue={s.title} style={{ width: '100%', border: 'none', outline: 'none', background: 'var(--fill-tertiary)', borderRadius: 7, padding: '6px 10px',
                      font: '600 var(--fs-headline)/1.3 var(--font-text)', color: 'var(--ink)', marginBottom: 6 }} />
                  : <div style={{ font: '600 var(--fs-headline)/1.3 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)', marginBottom: 4 }}>{s.title}</div>}
                <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>{s.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 22px', background: 'var(--fill-tertiary)', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>
            <Icon name="spark" size={15} style={{ color: 'var(--purple)' }} /> ≈ $0.60 · ~6 min
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>5 steps · 2 files touched · 1 migration</span>
        </div>
      </div>

      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderRadius: 10, background: 'color-mix(in srgb, var(--blue) 8%, transparent)', border: '0.5px solid color-mix(in srgb, var(--blue) 22%, transparent)' }}>
          <Icon name="sliders" size={15} style={{ color: 'var(--blue)' }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>Editing the plan. Your changes are sent back to the agent when you approve.</span>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { PLAN_STEPS, PlanGate });
