/* Skills Registry — data + auto-glyph + list rows. */

const SK_PALETTE = ['var(--blue)', 'var(--purple)', 'var(--teal)', 'var(--indigo)', 'var(--orange)', 'var(--green)'];
function skTint(name) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff; return SK_PALETTE[h % SK_PALETTE.length]; }
function skInitials(name) { const p = name.replace(/[^a-z0-9 -]/gi, '').split(/[ -]/).filter(Boolean); return (p[0]?.[0] || '') + (p[1]?.[0] || ''); }

function SkillGlyph({ name, size = 40, radius = 11 }) {
  const tint = skTint(name);
  return (
    <span style={{ width: size, height: size, borderRadius: radius, flexShrink: 0, display: 'grid', placeItems: 'center',
      background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint, font: `800 ${size * 0.4}px/1 var(--font-display)`, letterSpacing: '-0.02em', textTransform: 'uppercase' }}>
      {skInitials(name)}
    </span>
  );
}

// scan: ok | pending | quarantined ; signed: bool
const SKILLS = [
  { id: 's1', name: 'typescript-engineer', ver: '2.4.0', desc: 'Writes and refactors TypeScript with project conventions and tests.', signed: true, scan: 'ok', uses: '1.2k', installed: true, mine: true, tags: ['code', 'typescript', 'refactor'] },
  { id: 's2', name: 'pr-author', ver: '1.8.1', desc: 'Opens clean pull requests with plain-language summaries and linked issues.', signed: true, scan: 'ok', uses: '980', installed: true, mine: true, tags: ['git', 'review', 'writing'] },
  { id: 's3', name: 'test-writer', ver: '3.0.2', desc: 'Generates unit and integration tests, fixtures, and mocks.', signed: true, scan: 'ok', uses: '1.5k', installed: true, mine: false, tags: ['testing', 'code'] },
  { id: 's4', name: 'postgres-migrator', ver: '1.2.0', desc: 'Authors reversible SQL migrations and backfills safely.', signed: true, scan: 'ok', uses: '420', installed: false, mine: true, tags: ['database', 'sql', 'migration'] },
  { id: 's5', name: 'og-image-gen', ver: '1.1.0', desc: 'Renders branded Open Graph and social preview images at scale.', signed: true, scan: 'ok', uses: '760', installed: true, mine: false, tags: ['design', 'images', 'social'] },
  { id: 's6', name: 'competitor-scout', ver: '1.0.3', desc: 'Recurring competitor scans with sourced, citation-backed digests.', signed: true, scan: 'pending', uses: '310', installed: true, mine: true, tags: ['research', 'scan'] },
  { id: 's7', name: 'newsletter-writer', ver: '0.9.0', desc: 'Drafts on-brand newsletters from a week of project activity.', signed: true, scan: 'ok', uses: '205', installed: false, mine: true, tags: ['writing', 'content'] },
  { id: 's8', name: 'ticket-triage', ver: '1.1.0', desc: 'Labels and routes inbound support tickets by intent and urgency.', signed: true, scan: 'ok', uses: '640', installed: false, mine: false, tags: ['support', 'routing'] },
  { id: 's9', name: 'figma-export', ver: '0.3.1', desc: 'Exports Figma frames to optimized assets. (Description drifted.)', signed: false, scan: 'quarantined', uses: '88', installed: false, mine: false, tags: ['design', 'export'] },
];

function ScanChip({ scan }) {
  const map = {
    ok: { label: 'Scanned', icon: 'check', tint: 'var(--green)', bg: 'rgba(52,199,89,0.15)' },
    pending: { label: 'Re-scan pending', icon: 'refresh', tint: 'var(--orange)', bg: 'rgba(255,149,0,0.14)' },
    quarantined: { label: 'Quarantined', icon: 'lock', tint: 'var(--red)', bg: 'rgba(255,59,48,0.13)' },
  };
  const s = map[scan];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: s.bg, color: s.tint, font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap' }}>
      <Icon name={s.icon} size={12} stroke={2.4} /> {s.label}
    </span>
  );
}

function SigShield({ signed }) {
  return (
    <span title={signed ? 'Signature verified' : 'Unsigned'} style={{ display: 'inline-grid', placeItems: 'center', width: 26, height: 26, borderRadius: 8,
      background: signed ? 'rgba(52,199,89,0.14)' : 'var(--fill-secondary)', color: signed ? 'var(--green)' : 'var(--ink-tertiary)' }}>
      <Icon name="shield" size={15} />
    </span>
  );
}

function SkillRow({ s, last, onOpen }) {
  return (
    <button onClick={() => onOpen(s)} className="sk-row" style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left',
      padding: '14px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', background: 'transparent' }}>
      <SkillGlyph name={s.name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
          <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-mono)', letterSpacing: '-0.01em', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{s.name}</span>
          <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>v{s.ver}</span>
          {s.mine && <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', font: '600 var(--fs-caption)/18px var(--font-text)', color: 'var(--blue)' }}>Yours</span>}
        </div>
        <div style={{ font: '400 var(--fs-subhead)/1.35 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.desc}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{s.uses} uses</span>
        <SigShield signed={s.signed} />
        <ScanChip scan={s.scan} />
        <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />
      </div>
    </button>
  );
}

Object.assign(window, { SKILLS, SkillGlyph, skTint, ScanChip, SigShield, SkillRow });
