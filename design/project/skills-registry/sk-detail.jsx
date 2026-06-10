/* Skills Registry — skill detail (push nav): header card, tabs, quarantine. */

const SKILL_DOC = {
  what: 'Writes and refactors TypeScript with your project conventions, then proves the change with tests.',
  when: 'Use on any TypeScript codebase when you want a feature built, a module refactored, or a bug fixed behind a test — not for greenfield architecture decisions.',
  body: 'Reads the surrounding code before editing and matches its style. Keeps handlers thin and logic in services. Never adds a dependency without noting why. Runs the suite before handing off; a red suite never reaches review.',
};
const CAPABILITIES = [
  { kind: 'fs', label: 'Project source (read-write)', plain: 'Reads and edits files inside the active project only.', risk: 'amber' },
  { kind: 'tool', label: 'bash · npm, tsc, git', plain: 'Runs builds, type-checks, and version control in a sandbox.', risk: 'amber' },
  { kind: 'net', label: 'registry.npmjs.org', plain: 'Resolves package metadata. No other hosts are reachable.', risk: 'grey' },
];
const VERSIONS = [
  { ver: '2.4.0', date: 'Mar 14, 2026', scan: 'ok', note: 'Added monorepo workspace detection', current: true },
  { ver: '2.3.1', date: 'Feb 20, 2026', scan: 'ok', note: 'Patch: respect .prettierrc' },
  { ver: '2.3.0', date: 'Jan 30, 2026', scan: 'ok', note: 'Reviewer hand-off protocol' },
  { ver: '2.2.0', date: 'Jan 8, 2026', scan: 'ok', note: 'Initial public version' },
];

function SkillDetail({ s, onBack, onAdd }) {
  const [tab, setTab] = React.useState(s.scan === 'quarantined' ? 'security' : 'about');
  const [copied, setCopied] = React.useState(false);
  const sha = 'sha256:9f2c4a' + (s.id === 's9' ? 'b81e' : '7d10') + '…e3a1';
  const tint = skTint(s.name);
  const tabs = ['About', 'Capabilities', 'Versions', 'Security'];

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '20px 28px 40px' }}>
        <button onClick={onBack} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px 0 9px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)', marginBottom: 18 }}>
          <Icon name="arrowLeft" size={15} /> Registry
        </button>

        {/* header card */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 22 }}>
          <SkillGlyph name={s.name} size={64} radius={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{s.name}</h1>
              <span className="ver-pick" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-mono)', cursor: 'pointer' }}>
                v{s.ver} <Icon name="chevronDown" size={13} style={{ color: 'var(--ink-tertiary)' }} />
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
              <SigShield signed={s.signed} />
              <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{s.signed ? 'Signed by you · key ····7F2A' : 'Unsigned — publisher unverified'}</span>
            </div>
            <button onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }} className="sha-copy" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{sha}</span>
              <Icon name={copied ? 'check' : 'layers'} size={13} style={{ color: copied ? 'var(--green)' : 'var(--ink-tertiary)' }} />
              <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: copied ? 'var(--green)' : 'var(--ink-tertiary)' }}>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <button onClick={() => onAdd(s)} className="primary-cta" style={{ height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', alignSelf: 'flex-start', flexShrink: 0,
            background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="plus" size={16} stroke={2.4} /> Add to project…
          </button>
        </div>

        {/* tabs */}
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--fill-secondary)', borderRadius: 10, marginBottom: 22, width: 'fit-content' }}>
          {tabs.map(t => {
            const k = t.toLowerCase();
            const on = tab === k;
            return (
              <button key={t} onClick={() => setTab(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 7, font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
                background: on ? 'var(--bg-elevated)' : 'transparent', color: on ? 'var(--ink)' : 'var(--ink-secondary)', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.14)' : 'none' }}>
                {t} {t === 'Security' && s.scan === 'quarantined' && <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--red)' }} />}
              </button>
            );
          })}
        </div>

        <div className="tab-body" key={tab}>
          {tab === 'about' && <AboutTab />}
          {tab === 'capabilities' && <CapabilitiesTab />}
          {tab === 'versions' && <VersionsTab />}
          {tab === 'security' && <SecurityTab quarantined={s.scan === 'quarantined'} />}
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 9 }}><Icon name="spark" size={13} /> What</div>
          <div style={{ font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{SKILL_DOC.what}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--purple)', marginBottom: 9 }}><Icon name="clock" size={13} /> When</div>
          <div style={{ font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{SKILL_DOC.when}</div>
        </div>
      </div>
      <div>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>SKILL.md</div>
        <p style={{ margin: 0, font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 680, textWrap: 'pretty' }}>{SKILL_DOC.body}</p>
      </div>
    </div>
  );
}

function CapabilitiesTab() {
  const riskTint = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };
  const kindIcon = { net: 'wifi', fs: 'folder', tool: 'terminal' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {CAPABILITIES.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 13, padding: 15, paddingRight: 28, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', position: 'relative' }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${riskTint[c.risk]} 13%, transparent)`, color: riskTint[c.risk] }}>
            <Icon name={kindIcon[c.kind]} size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-mono)', color: 'var(--ink)', marginBottom: 4 }}>{c.label}</div>
            <div style={{ font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{c.plain}</div>
          </div>
          <span style={{ position: 'absolute', top: 17, right: 15, width: 8, height: 8, borderRadius: 4, background: riskTint[c.risk] }} title={c.risk} />
        </div>
      ))}
    </div>
  );
}

function VersionsTab() {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: '6px 18px' }}>
      {VERSIONS.map((v, i) => (
        <div key={v.ver} style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: i < VERSIONS.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: v.current ? 'var(--blue)' : 'var(--fill-secondary)', border: v.current ? 'none' : '1.5px solid var(--separator-strong)', marginTop: 4 }} />
            {i < VERSIONS.length - 1 && <span style={{ width: 1.5, flex: 1, minHeight: 22, background: 'var(--separator)', marginTop: 4 }} />}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>v{v.ver}</span>
              {v.current && <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/18px var(--font-text)' }}>Current</span>}
              <span style={{ flex: 1 }} />
              <ScanChip scan={v.scan} />
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{v.date}</span>
            </div>
            <div style={{ font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 5 }}>{v.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SecurityTab({ quarantined }) {
  const [reapproved, setReapproved] = React.useState(false);
  if (quarantined && !reapproved) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 12, padding: 16, borderRadius: 14, background: 'rgba(255,59,48,0.07)', border: '1px solid rgba(255,59,48,0.3)' }}>
          <Icon name="lock" size={20} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)', marginBottom: 4 }}>Description changed since approval — quarantined</div>
            <div style={{ font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>A new version rewrote what this skill claims to do. It’s frozen until you re-approve. No project can load it in the meantime.</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[['Approved description', 'Exports Figma frames to optimized PNG/SVG assets in the project folder.', 'var(--green)', 'Was'],
            ['New description', 'Exports Figma frames AND uploads a copy to an external mirror for “faster CDN delivery”.', 'var(--red)', 'Now']].map(([title, body, tint, tag], i) => (
            <div key={i} style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: `0.5px solid ${i === 1 ? 'rgba(255,59,48,0.3)' : 'var(--separator)'}`, padding: 16 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: tint, marginBottom: 9 }}>{tag}</div>
              <div style={{ font: `400 var(--fs-subhead)/1.5 var(--font-text)`, color: i === 1 ? 'var(--ink)' : 'var(--ink-secondary)', textWrap: 'pretty' }}>{body}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setReapproved(true)} className="primary-cta" style={{ height: 42, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Icon name="shield" size={16} /> Re-approve this version
          </button>
          <button className="reject-btn" style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Remove from registry</button>
        </div>
      </div>
    );
  }
  const findings = [
    { sev: 'grey', t: 'No secrets or tokens found in the bundle.' },
    { sev: 'grey', t: 'Declared capabilities match static analysis — no hidden network calls.' },
    { sev: 'grey', t: 'Dependencies pinned; none on the advisory list.' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {reapproved && <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderRadius: 12, background: 'rgba(52,199,89,0.12)', border: '0.5px solid rgba(52,199,89,0.3)', font: '500 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)' }}><Icon name="check" size={16} stroke={2.6} style={{ color: 'var(--green)' }} /> Re-approved. The skill is live again and re-scanned clean.</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--green)' }}>
        <Icon name="shield" size={18} /> Last scan passed · 3 checks
      </div>
      {findings.map((f, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
          <Icon name="check" size={16} stroke={2.6} style={{ color: 'var(--green)', flexShrink: 0 }} />
          <span style={{ font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink)' }}>{f.t}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { SkillDetail });
