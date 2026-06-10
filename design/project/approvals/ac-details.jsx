/* Approvals Center — right-side gate detail renderers (one per gate type). */

function DetailShell({ g, children }) {
  const t = GATE_TYPE[g.type];
  const p = AC_PROJ[g.proj];
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${t.tint} 14%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={23} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{p.name}</span>
            <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{t.label} gate · {g.age}</span>
          </div>
          <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', textWrap: 'pretty' }}>{g.summary}</h2>
        </div>
      </div>
      {children}
    </div>
  );
}

function Card({ children, pad = 20, style }) {
  return <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: pad, ...style }}>{children}</div>;
}

function Badge({ icon, children, tint }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
      {icon && <Icon name={icon} size={13} />}{children}
    </span>
  );
}

// ── Plan
function PlanDetail({ d }) {
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ font: '700 var(--fs-headline)/1.1 var(--font-text)', color: 'var(--ink)', flex: 1 }}>{d.title}</span>
        <Badge icon="gauge" tint="var(--blue)">PLANNED AT {d.effort}</Badge>
      </div>
      <div>
        {d.steps.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 20px', borderBottom: i < d.steps.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{i + 1}</span>
            <span style={{ font: '500 var(--fs-callout)/1.4 var(--font-text)', color: 'var(--ink)' }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '13px 20px', background: 'var(--fill-tertiary)', font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>≈ ${d.cost} · ~{d.mins} min</div>
    </Card>
  );
}

// ── Publish
function PublishDetail({ d }) {
  return (
    <Card>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ width: 150, height: 150, borderRadius: 12, flexShrink: 0, background: 'linear-gradient(135deg, #5E8BFF, #A24BE0)', display: 'grid', placeItems: 'center', position: 'relative', overflow: 'hidden' }}>
          <Icon name="image" size={34} style={{ color: 'rgba(255,255,255,0.85)' }} />
          <span style={{ position: 'absolute', bottom: 8, right: 8, width: 30, height: 30, borderRadius: '50%', background: 'rgba(0,0,0,0.35)', display: 'grid', placeItems: 'center', color: '#fff' }}><Icon name="play" size={14} /></span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 7, marginBottom: 10, flexWrap: 'wrap' }}>
            <Badge icon="send" tint="var(--purple)">{d.platform}</Badge>
            <Badge tint="var(--ink-secondary)">{d.posts} post{d.posts > 1 ? 's' : ''}</Badge>
          </div>
          <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{d.caption}</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--separator)', flexWrap: 'wrap' }}>
        <Badge icon="shield" tint="var(--green)">C2PA ✓ · AI label ✓</Badge>
        {d.consent
          ? <Badge icon="check" tint="var(--green)">Consent on file</Badge>
          : <Badge icon="alert" tint="var(--ink-tertiary)">No avatar / voice used</Badge>}
      </div>
    </Card>
  );
}

// ── Merge
function MergeDetail({ d }) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <div style={{ font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)' }}>PR #{d.pr}</div>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--green)' }}>+{d.add}</span>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--red)' }}>−{d.del}</span>
        <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{d.files} files</span>
        <span style={{ flex: 1 }} />
        <a href="../plan-diff-gate/Plan Diff Gate.html" className="link-btn" style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none' }}>Open full diff →</a>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderRadius: 12, background: 'rgba(52,199,89,0.10)', border: '0.5px solid rgba(52,199,89,0.3)' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', color: 'var(--ink-secondary)' }}><OpenAIGlyph size={17} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '600 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)' }}>Reviewer: all clear</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{d.findings}</div>
        </div>
        <Badge icon="shield" tint="var(--green)">3/3 judges</Badge>
      </div>
    </Card>
  );
}

// ── Over budget
function BudgetDetail({ d, onRaise }) {
  return (
    <Card>
      <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
        <div style={{ font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 10 }}>This run needs</div>
        <div style={{ font: '700 56px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--orange)' }}>+${d.need.toFixed(2)}</div>
        <div style={{ font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink-tertiary)', marginTop: 10 }}>${d.spent.toFixed(2)} spent of ${d.cap} cap · “{d.run}”</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button onClick={onRaise} className="budget-opt primary" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'var(--blue)', color: '#fff', textAlign: 'left', boxShadow: '0 6px 16px rgba(0,122,255,0.28)' }}>
          <Icon name="gauge" size={18} /><span style={{ flex: 1, font: '600 var(--fs-callout)/1.2 var(--font-text)' }}>Raise cap to $60</span><Icon name="chevronRight" size={16} />
        </button>
        <button className="budget-opt" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'var(--fill-secondary)', color: 'var(--ink)', textAlign: 'left' }}>
          <Icon name="cpu" size={18} style={{ color: 'var(--ink-secondary)' }} /><span style={{ flex: 1, font: '600 var(--fs-callout)/1.2 var(--font-text)' }}>Downgrade model <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>· finishes within cap</span></span>
        </button>
        <button className="budget-opt" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'transparent', color: 'var(--red)', textAlign: 'left', border: '0.5px solid var(--separator)' }}>
          <Icon name="x" size={18} /><span style={{ flex: 1, font: '600 var(--fs-callout)/1.2 var(--font-text)' }}>Abort run</span>
        </button>
      </div>
    </Card>
  );
}

// ── Skill
function SkillDetail({ d }) {
  const riskTint = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--indigo) 13%, transparent)', color: 'var(--indigo)' }}><Icon name="spark" size={19} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '600 var(--fs-headline)/1.1 var(--font-mono)', color: 'var(--ink)' }}>{d.skill} <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>v{d.ver}</span></div>
          <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>Publisher: {d.publisher}</div>
        </div>
        <Badge icon="alert" tint="var(--orange)">Unverified</Badge>
      </div>
      <div style={{ padding: '14px 20px' }}>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Requested capabilities</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {d.caps.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <Icon name={c.kind === 'net' ? 'wifi' : 'folder'} size={15} style={{ color: riskTint[c.risk], flexShrink: 0 }} />
              <span style={{ flex: 1, font: '500 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink)' }}>{c.label}</span>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: riskTint[c.risk] }} title={c.risk} />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Send
function SendDetail({ d }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--teal) 14%, transparent)', color: 'var(--teal)' }}><Icon name="send" size={18} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{d.channel}</div>
            <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>To <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{d.recipients}</b> subscribers</div>
          </div>
          {d.consent && <Badge icon="check" tint="var(--green)">Opt-in verified</Badge>}
        </div>
        <div style={{ padding: '13px 15px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
          <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Subject</div>
          <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)' }}>{d.subject}</div>
        </div>
      </div>
    </Card>
  );
}

function GateDetail({ g, onRaise }) {
  return (
    <DetailShell g={g}>
      {g.type === 'plan' && <PlanDetail d={g.detail} />}
      {g.type === 'publish' && <PublishDetail d={g.detail} />}
      {g.type === 'merge' && <MergeDetail d={g.detail} />}
      {g.type === 'budget' && <BudgetDetail d={g.detail} onRaise={onRaise} />}
      {g.type === 'skill' && <SkillDetail d={g.detail} />}
      {g.type === 'send' && <SendDetail d={g.detail} />}
    </DetailShell>
  );
}

Object.assign(window, { GateDetail, DetailShell, Card, Badge });
