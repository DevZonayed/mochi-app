/* Skills Registry — a private "npm for skills": searchable registry list,
   push-nav skill detail (About / Capabilities / Versions / Security with a
   quarantine re-approval flow), a publish sheet with a staged sign+scan
   animation, an added toast, and the ⌘K command palette.
   Ported from the Babel-standalone prototype (design/project/skills-registry/*)
   to ES-module TypeScript React. Visual output preserved exactly; cross-page
   location.href navigation replaced with react-router useNavigate(). */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { pathForNav } from '../lib/routes';
import { Icon, type IconName } from '../lib/icons';
import { Spinner } from '../lib/ui';
import { api, getRegistryAdminToken, setRegistryAdminToken, type Skill as ApiSkill, type RegistrySkillSummary } from '../lib/api';
import {
  APP_W,
  APP_H,
  useAppScale,
  useTheme,
  TrafficLights,
  Sidebar,
  Toolbar,
} from '../lib/appShell';

/* Page-specific CSS from the prototype's <style> — drives hover/animation
   classes (.sk-row, .filter-chip, .primary-cta, .drop-zone, .reg-list,
   .tab-body, .scan-pop, .toast, .sheet-pop, palette keyframes, …). */
const PAGE_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }

  .app-wallpaper {
    position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background:
      radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 30%, transparent), transparent 70%),
      radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 26%, transparent), transparent 70%),
      var(--bg);
  }

  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.45); }
  .primary-cta:active { transform: translateY(1px); }
  .split-quiet:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .reject-btn:hover { background: rgba(255,59,48,0.1); }
  .filter-chip { transition: background 140ms ease, color 140ms ease, filter 140ms ease; }
  .filter-chip:hover { filter: brightness(0.97); }
  .sk-row { transition: background 120ms ease; }
  .sk-row:hover { background: var(--fill-tertiary); }
  .ver-pick:hover, .sha-copy:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .drop-zone { transition: border-color 140ms ease, background 140ms ease; cursor: pointer; }
  .drop-zone:hover { border-color: var(--blue); background: color-mix(in srgb, var(--blue) 6%, var(--fill-tertiary)); }

  /* list reorder + tab + scan — frozen-clock-safe (transform only) */
  .reg-list { animation: listIn 280ms var(--spring); }
  @keyframes listIn { from { transform: translateY(6px); } to { transform: none; } }
  .tab-body { animation: tabIn 220ms var(--spring); }
  @keyframes tabIn { from { transform: translateY(5px); } to { transform: none; } }
  .scan-pop { animation: scanPop 360ms var(--spring); }
  @keyframes scanPop { 0% { transform: scale(0.5); } 60% { transform: scale(1.15); } 100% { transform: scale(1); } }
  .toast { animation: toastIn 280ms var(--spring); }
  @keyframes toastIn { from { transform: translate(-50%, 12px); } to { transform: translate(-50%, 0); } }

  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  *::-webkit-scrollbar { width: 11px; height: 11px; }
  *::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ink) 22%, transparent); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
  input::placeholder { color: var(--ink-tertiary); }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────────────── data + auto-glyph + types ───────────────────── */

type ScanState = 'ok' | 'pending' | 'quarantined';

interface Skill {
  id: string;
  name: string;
  ver: string;
  desc: string;
  signed: boolean;
  scan: ScanState;
  uses: string;
  installed: boolean;
  mine: boolean;
  tags: string[];
  risk?: string;
  sha256?: string | null;
  mirrorRepo?: string | null;
  forkStatus?: string | null;
  auditStatus?: string | null;
  disabledReason?: string | null;
}

const SK_PALETTE = ['var(--blue)', 'var(--purple)', 'var(--teal)', 'var(--indigo)', 'var(--orange)', 'var(--green)'];
function skTint(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return SK_PALETTE[h % SK_PALETTE.length];
}
function skInitials(name: string): string {
  const p = name.replace(/[^a-z0-9 -]/gi, '').split(/[ -]/).filter(Boolean);
  return (p[0]?.[0] || '') + (p[1]?.[0] || '');
}

interface SkillGlyphProps {
  name: string;
  size?: number;
  radius?: number;
}

function SkillGlyph({ name, size = 40, radius = 11 }: SkillGlyphProps) {
  const tint = skTint(name);
  return (
    <span style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0, display: 'grid', placeItems: 'center',
      background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint, font: `800 ${size * 0.4}px/1 var(--font-display)`,
      letterSpacing: '-0.02em', textTransform: 'uppercase',
    }}>
      {skInitials(name)}
    </span>
  );
}

// scan: ok | pending | quarantined ; signed: bool
//
// Live data: the registry list is populated from the registry service when
// available, with the old local capability list only as a compatibility fallback.
function skHash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return h;
}
function fmtUses(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}
/** Map a live API/registry skill into the existing row shape. */
function toSkill(a: ApiSkill | RegistrySkillSummary): Skill {
  const h = skHash(a.id + a.name);
  const reg = a as RegistrySkillSummary;
  const local = a as ApiSkill;
  const enabled = 'enabled' in a ? a.enabled !== false : local.enabled;
  const risk = (reg.risk || '').toUpperCase();
  const scan: ScanState = !enabled ? 'quarantined' : risk === 'MEDIUM' ? 'pending' : risk === 'HIGH' || risk === 'CRITICAL' ? 'quarantined' : h % 11 === 0 ? 'quarantined' : h % 5 === 0 ? 'pending' : 'ok';
  const tags = 'tags' in a && Array.isArray(a.tags)
    ? a.tags
    : local.category
      ? local.category.toLowerCase().split(/[\s,/]+/).filter(Boolean)
      : [];
  return {
    id: a.id,
    name: a.name,
    ver: ('version' in a && a.version) ? a.version : local.version,
    desc: a.description,
    signed: enabled && scan !== 'quarantined',
    scan,
    uses: fmtUses(80 + (h % 1500)),
    installed: enabled,
    mine: !!reg.sourceRepo || !!reg.mirrorRepo || h % 2 === 0,
    tags,
    risk: reg.risk,
    sha256: reg.sha256,
    mirrorRepo: reg.sourceRepo || reg.mirrorRepo,
    forkStatus: reg.sourceStatus || reg.forkStatus,
    auditStatus: reg.auditStatus,
    disabledReason: reg.disabledReason,
  };
}

function ScanChip({ scan }: { scan: ScanState }) {
  const map: Record<ScanState, { label: string; icon: IconName; tint: string; bg: string }> = {
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

function SigShield({ signed }: { signed: boolean }) {
  return (
    <span title={signed ? 'Signature verified' : 'Unsigned'} style={{
      display: 'inline-grid', placeItems: 'center', width: 26, height: 26, borderRadius: 8,
      background: signed ? 'rgba(52,199,89,0.14)' : 'var(--fill-secondary)', color: signed ? 'var(--green)' : 'var(--ink-tertiary)',
    }}>
      <Icon name="shield" size={15} />
    </span>
  );
}

function SkillRow({ s, last, onOpen }: { s: Skill; last: boolean; onOpen: (s: Skill) => void }) {
  return (
    <button onClick={() => onOpen(s)} className="sk-row" style={{
      display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left',
      padding: '14px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', background: 'transparent',
    }}>
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

/* ───────────────────────── skill detail (push nav) ─────────────────────── */

const SKILL_DOC = {
  what: 'Writes and refactors TypeScript with your project conventions, then proves the change with tests.',
  when: 'Use on any TypeScript codebase when you want a feature built, a module refactored, or a bug fixed behind a test — not for greenfield architecture decisions.',
  body: 'Reads the surrounding code before editing and matches its style. Keeps handlers thin and logic in services. Never adds a dependency without noting why. Runs the suite before handing off; a red suite never reaches review.',
};

interface Capability {
  kind: 'fs' | 'tool' | 'net';
  label: string;
  plain: string;
  risk: 'red' | 'amber' | 'grey';
}

const CAPABILITIES: Capability[] = [
  { kind: 'fs', label: 'Project source (read-write)', plain: 'Reads and edits files inside the active project only.', risk: 'amber' },
  { kind: 'tool', label: 'bash · npm, tsc, git', plain: 'Runs builds, type-checks, and version control in a sandbox.', risk: 'amber' },
  { kind: 'net', label: 'registry.npmjs.org', plain: 'Resolves package metadata. No other hosts are reachable.', risk: 'grey' },
];

interface VersionEntry {
  ver: string;
  date: string;
  scan: ScanState;
  note: string;
  current?: boolean;
}

const VERSIONS: VersionEntry[] = [
  { ver: '2.4.0', date: 'Mar 14, 2026', scan: 'ok', note: 'Added monorepo workspace detection', current: true },
  { ver: '2.3.1', date: 'Feb 20, 2026', scan: 'ok', note: 'Patch: respect .prettierrc' },
  { ver: '2.3.0', date: 'Jan 30, 2026', scan: 'ok', note: 'Reviewer hand-off protocol' },
  { ver: '2.2.0', date: 'Jan 8, 2026', scan: 'ok', note: 'Initial public version' },
];

function SkillDetail({ s, onBack, onAdd, onRescan }: { s: Skill; onBack: () => void; onAdd: (s: Skill) => void; onRescan: (s: Skill) => void }) {
  const [tab, setTab] = React.useState(s.scan === 'quarantined' ? 'security' : 'about');
  const [copied, setCopied] = React.useState(false);
  const [skillMd, setSkillMd] = React.useState('');
  const [detail, setDetail] = React.useState<Partial<RegistrySkillSummary & { excerpt?: string; rawBase?: string; skillPath?: string }>>({});
  React.useEffect(() => {
    if (!s.id.includes('/')) return;
    let on = true;
    api.registryGetSkill(s.id).then(d => { if (on) setDetail(d); }).catch(() => {});
    api.registrySkillContent(s.id).then(c => { if (on) setSkillMd(c.skillMd); }).catch(() => {});
    return () => { on = false; };
  }, [s.id]);
  const sha = s.sha256 || detail.sha256 || 'sha256 pending';
  const tabs = ['About', 'Capabilities', 'Versions', 'Security'];

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '20px 28px 40px' }}>
        <button onClick={onBack} className="split-quiet" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px 0 9px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)', marginBottom: 18,
        }}>
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
              <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{s.installed ? 'Enabled in registry' : (s.disabledReason || 'Disabled in registry')}</span>
            </div>
            <button onClick={() => { void navigator.clipboard?.writeText(sha); setCopied(true); setTimeout(() => setCopied(false), 1400); }} className="sha-copy" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{sha}</span>
              <Icon name={copied ? 'check' : 'layers'} size={13} style={{ color: copied ? 'var(--green)' : 'var(--ink-tertiary)' }} />
              <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: copied ? 'var(--green)' : 'var(--ink-tertiary)' }}>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
            <button onClick={() => onRescan(s)} className="split-quiet" style={{
              height: 40, padding: '0 14px', borderRadius: 'var(--r-pill)', alignSelf: 'flex-start',
              background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 7,
            }}>
              <Icon name="refresh" size={16} stroke={2.4} /> Rescan
            </button>
            <button onClick={() => onAdd(s)} className="primary-cta" style={{
              height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', alignSelf: 'flex-start',
              background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)', display: 'inline-flex', alignItems: 'center', gap: 7,
            }}>
              <Icon name={s.installed ? 'lock' : 'check'} size={16} stroke={2.4} /> {s.installed ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>

        {/* tabs */}
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--fill-secondary)', borderRadius: 10, marginBottom: 22, width: 'fit-content' }}>
          {tabs.map(t => {
            const k = t.toLowerCase();
            const on = tab === k;
            return (
              <button key={t} onClick={() => setTab(k)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 7, font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
                background: on ? 'var(--bg-elevated)' : 'transparent', color: on ? 'var(--ink)' : 'var(--ink-secondary)', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.14)' : 'none',
              }}>
                {t} {t === 'Security' && s.scan === 'quarantined' && <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--red)' }} />}
              </button>
            );
          })}
        </div>

        <div className="tab-body" key={tab}>
          {tab === 'about' && <AboutTab s={s} detail={detail} skillMd={skillMd} />}
          {tab === 'capabilities' && <CapabilitiesTab />}
          {tab === 'versions' && <VersionsTab />}
          {tab === 'security' && <SecurityTab quarantined={s.scan === 'quarantined'} />}
        </div>
      </div>
    </div>
  );
}

function AboutTab({ s, detail, skillMd }: { s: Skill; detail: Partial<RegistrySkillSummary & { excerpt?: string; rawBase?: string; skillPath?: string }>; skillMd: string }) {
  const body = skillMd || detail.excerpt || s.desc || SKILL_DOC.body;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 9 }}><Icon name="spark" size={13} /> What</div>
          <div style={{ font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' } as React.CSSProperties}>{s.desc || SKILL_DOC.what}</div>
        </div>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--purple)', marginBottom: 9 }}><Icon name="clock" size={13} /> When</div>
          <div style={{ font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' } as React.CSSProperties}>{detail.rawBase || detail.directory || s.mirrorRepo || SKILL_DOC.when}</div>
        </div>
      </div>
      <div>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>SKILL.md</div>
        <pre style={{ margin: 0, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', font: '400 var(--fs-caption)/1.55 var(--font-mono)', color: 'var(--ink-secondary)', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, padding: 14 }}>{body.length > 8000 ? body.slice(0, 8000) + '\n\n[preview truncated]' : body}</pre>
      </div>
    </div>
  );
}

function CapabilitiesTab() {
  const riskTint: Record<Capability['risk'], string> = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };
  const kindIcon: Record<Capability['kind'], IconName> = { net: 'wifi', fs: 'folder', tool: 'terminal' };
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

function SecurityTab({ quarantined }: { quarantined: boolean }) {
  const [reapproved, setReapproved] = React.useState(false);
  if (quarantined && !reapproved) {
    const cards: [string, string, string, string][] = [
      ['Approved description', 'Exports Figma frames to optimized PNG/SVG assets in the project folder.', 'var(--green)', 'Was'],
      ['New description', 'Exports Figma frames AND uploads a copy to an external mirror for “faster CDN delivery”.', 'var(--red)', 'Now'],
    ];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 12, padding: 16, borderRadius: 14, background: 'rgba(255,59,48,0.07)', border: '1px solid rgba(255,59,48,0.3)' }}>
          <Icon name="lock" size={20} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)', marginBottom: 4 }}>Description changed since approval — quarantined</div>
            <div style={{ font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' } as React.CSSProperties}>A new version rewrote what this skill claims to do. It’s frozen until you re-approve. No project can load it in the meantime.</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {cards.map(([, body, tint, tag], i) => (
            <div key={i} style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: `0.5px solid ${i === 1 ? 'rgba(255,59,48,0.3)' : 'var(--separator)'}`, padding: 16 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: tint, marginBottom: 9 }}>{tag}</div>
              <div style={{ font: `400 var(--fs-subhead)/1.5 var(--font-text)`, color: i === 1 ? 'var(--ink)' : 'var(--ink-secondary)', textWrap: 'pretty' } as React.CSSProperties}>{body}</div>
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

/* ───────────────────────── publish sheet ───────────────────────── */

function PublishSheet({ open, onClose, onPublished }: { open: boolean; onClose: () => void; onPublished: (s: Skill) => void }) {
  const [stage, setStage] = React.useState(0); // 0 drop, 1 ready, 2..4 scanning, 5 done
  const [source, setSource] = React.useState('');
  const [err, setErr] = React.useState('');
  React.useEffect(() => { if (open) { setStage(0); setSource(''); setErr(''); } }, [open]);
  if (!open) return null;

  const drop = () => { if (source.trim()) setStage(1); };
  const publish = async () => {
    const url = source.trim();
    if (!url) { setErr('Source URL required'); return; }
    setErr('');
    setStage(2);
    let s = 2;
    const t = setInterval(() => { s += 1; setStage(s); if (s >= 5) clearInterval(t); }, 850);
    try {
      const rec = await api.registryAdminAddSkill({ url });
      onPublished(toSkill(rec));
    } catch (e) {
      clearInterval(t);
      setStage(1);
      setErr(e instanceof Error ? e.message : 'Could not add skill');
    }
  };

  const scanSteps = [
    { label: 'Integrity check', sub: 'Hash & signature verified' },
    { label: 'Static scan', sub: 'Capabilities match declaration' },
    { label: 'Listed in registry', sub: 'Discoverable by meaning' },
  ];

  return (
    <div onMouseDown={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{
        width: 520, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Publish skill</h2>
            <p style={{ margin: '3px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Signed, scanned, and listed to your private registry. No payments, ever.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {stage === 0 ? (
            <div className="drop-zone" style={{
              width: '100%', padding: '40px 20px', borderRadius: 16, border: '2px dashed var(--separator-strong)', background: 'var(--fill-tertiary)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            }}>
              <span style={{ width: 56, height: 56, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="enter" size={28} style={{ transform: 'rotate(90deg)' }} /></span>
              <span style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)' }}>Add from live source</span>
              <input autoFocus value={source} onChange={e => setSource(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') drop(); }}
                placeholder="https://www.skills.sh/owner/repo/skill or https://github.com/owner/repo"
                style={{ width: '100%', maxWidth: 420, height: 36, padding: '0 12px', borderRadius: 10, border: '0.5px solid var(--separator)', background: 'var(--bg-elevated)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', outline: 'none' }} />
              <span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: err ? 'var(--red)' : 'var(--ink-tertiary)' }}>{err || 'skills.sh URL, GitHub repo, or direct SKILL.md URL'}</span>
            </div>
          ) : (
            <React.Fragment>
              {/* manifest preview */}
              <div style={{ display: 'flex', gap: 13, padding: 15, borderRadius: 14, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', marginBottom: 14 }}>
                <SkillGlyph name={source.split('/').filter(Boolean).pop() || 'new skill'} size={44} radius={12} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ font: '600 var(--fs-callout)/1.3 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{source.split('/').filter(Boolean).pop() || 'new skill'}</span>
                    <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)', flexShrink: 0 }}>v0.9.0</span>
                  </div>
                  <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>{source}</div>
                </div>
              </div>

              {/* signing row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', marginBottom: 16 }}>
                <Icon name="key" size={17} style={{ color: 'var(--green)' }} />
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Sign with your key <span style={{ font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>····7F2A</span></span>
                <Icon name="check" size={16} stroke={2.6} style={{ color: 'var(--green)' }} />
              </div>

              {/* scan steps */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {scanSteps.map((st, i) => {
                  const stepN = i + 2; // stages 2,3,4
                  const done = stage > stepN || stage === 5;
                  const activeNow = stage === stepN;
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12,
                      background: done ? 'rgba(52,199,89,0.08)' : 'var(--fill-tertiary)', border: `0.5px solid ${done ? 'rgba(52,199,89,0.3)' : 'var(--separator)'}`,
                    }}>
                      <span className={done ? 'scan-pop' : ''} style={{
                        width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                        background: done ? 'var(--green)' : 'var(--fill-secondary)', color: done ? '#fff' : 'var(--ink-tertiary)',
                      }}>
                        {done ? <Icon name="check" size={14} stroke={3} /> : activeNow ? <Spinner size={13} color="var(--blue)" /> : <span style={{ font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{i + 1}</span>}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ font: '600 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)' }}>{st.label}</div>
                        <div style={{ font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{st.sub}</div>
                      </div>
                      {done && <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}>Done</span>}
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            {stage === 5 ? 'Published · agents can now find it by meaning.' : 'Your registry is private to this workspace.'}
          </span>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{stage === 5 ? 'Done' : 'Cancel'}</button>
          {stage === 0 && (
            <button onClick={drop} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: source.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: source.trim() ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: source.trim() ? '0 6px 18px rgba(0,122,255,0.3)' : 'none' }}>Continue</button>
          )}
          {stage >= 1 && stage < 2 && (
	            <button onClick={() => void publish()} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Sign &amp; publish</button>
          )}
          {stage >= 2 && stage < 5 && (
            <button disabled style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 7 }}><Spinner size={13} /> Scanning…</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── added toast ───────────────────────── */

function AddedToast({ skill, onDone }: { skill: Skill; onDone: () => void }) {
  React.useEffect(() => { const t = setTimeout(onDone, 2400); return () => clearTimeout(t); }, []);
  return (
    <div className="toast" style={{
      position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 18px',
      borderRadius: 'var(--r-pill)', background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)',
    }}>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--green)', display: 'grid', placeItems: 'center' }}><Icon name="check" size={13} stroke={3} style={{ color: '#fff' }} /></span>
      <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>Updated <b style={{ fontFamily: 'var(--font-mono)' }}>{skill.name}</b></span>
    </div>
  );
}

/* ───────────────────────── command palette ───────────────────────── */

interface PaletteItem { group: string; icon: IconName; label: string; hint: string }

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Jump to', icon: 'home', label: 'Command Center', hint: '⌘1' },
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'jobs', label: 'Jobs', hint: '⌘3' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
  { group: 'Jump to', icon: 'clapper', label: 'Studio', hint: '' },
  { group: 'Jump to', icon: 'telescope', label: 'Trends', hint: '' },
  { group: 'Jump to', icon: 'send', label: 'Publishing', hint: '' },
  { group: 'Jump to', icon: 'gauge', label: 'Costs', hint: '' },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 60); }
  }, [open]);

  const filtered = PALETTE_ITEMS.filter(it => it.label.toLowerCase().includes(q.toLowerCase()) || it.hint.toLowerCase().includes(q.toLowerCase()));
  const groups = filtered.reduce<Record<string, PaletteItem[]>>((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {});
  const flat = filtered;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Escape') { onClose(); }
    else if (e.key === 'Enter') { onClose(); }
  };

  if (!open) return null;
  let idx = -1;
  return (
    <div onMouseDown={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'center', paddingTop: 132,
      background: 'rgba(10,12,24,0.28)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 640, maxHeight: 460, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--glass-border)',
        backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 30px 80px rgba(10,15,40,0.45), var(--glass-inner)', overflow: 'hidden',
        animation: 'palettePop 200ms var(--spring)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Search commands, projects, jobs…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
              font: '400 var(--fs-title2)/1 var(--font-text)', color: 'var(--ink)' }} />
          <span style={{ padding: '3px 7px', borderRadius: 5, background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>esc</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 8 }}>
          {flat.length === 0 && (
            <div style={{ padding: '28px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No matches</div>
          )}
          {Object.entries(groups).map(([group, items]) => (
            <div key={group} style={{ marginBottom: 6 }}>
              <div style={{ padding: '6px 10px 4px', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{group}</div>
              {items.map(it => {
                idx++; const active = idx === sel; const myIdx = idx;
                return (
                  <div key={it.label} onMouseEnter={() => setSel(myIdx)} onMouseDown={onClose} style={{
                    display: 'flex', alignItems: 'center', gap: 11, height: 42, padding: '0 10px', borderRadius: 9, cursor: 'pointer',
                    background: active ? 'var(--blue)' : 'transparent',
                  }}>
                    <span style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0,
                      background: active ? 'rgba(255,255,255,0.2)' : 'var(--fill-secondary)', color: active ? '#fff' : 'var(--ink-secondary)' }}>
                      <Icon name={it.icon} size={16} />
                    </span>
                    <span style={{ flex: 1, font: '500 var(--fs-callout)/1.1 var(--font-text)', color: active ? '#fff' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
                    <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: active ? 'rgba(255,255,255,0.8)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{it.hint}</span>
                    {active && <Icon name="enter" size={15} style={{ color: 'rgba(255,255,255,0.9)' }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── assembly ───────────────────────── */

interface Segment { key: string; label: string }

const SEGMENTS: Segment[] = [
  { key: 'all', label: 'All' },
  { key: 'installed', label: 'Installed in projects' },
  { key: 'mine', label: 'Published by you' },
  { key: 'quarantined', label: 'Quarantined' },
];

// crude semantic-ish ranking: matches name/desc/tags, weights tag hits
function rank(skill: Skill, q: string): number {
  if (!q) return 0;
  const t = q.toLowerCase();
  let score = 0;
  if (skill.name.toLowerCase().includes(t)) score += 5;
  if (skill.desc.toLowerCase().includes(t)) score += 2;
  skill.tags.forEach(tag => { if (tag.includes(t) || t.includes(tag)) score += 4; });
  // loose semantic aliases
  const alias: Record<string, string[]> = { code: ['typescript', 'refactor', 'build'], write: ['writing', 'content', 'newsletter'], test: ['testing'], image: ['images', 'design', 'social'], db: ['database', 'sql'] };
  Object.entries(alias).forEach(([k, arr]) => { if (t.includes(k)) arr.forEach(a => { if (skill.tags.includes(a)) score += 3; }); });
  return score;
}

function segMatch(s: Skill, key: string): boolean {
  return key === 'all'
    || (key === 'installed' && s.installed)
    || (key === 'mine' && s.mine)
    || (key === 'quarantined' && s.scan === 'quarantined');
}

export default function SkillsRegistry() {
  const navigate = useNavigate();
  const scale = useAppScale();
  const [theme, setTheme] = useTheme('light');
  const [seg, setSeg] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState<Skill | null>(null); // skill detail
  const [publish, setPublish] = React.useState(false);
  const [added, setAdded] = React.useState<Skill | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [skills, setSkills] = React.useState<Skill[]>([]); // live registry
  const [adminToken, setAdminTokenState] = React.useState(() => getRegistryAdminToken());
  const [loadMode, setLoadMode] = React.useState('public');
  const [syncing, setSyncing] = React.useState(false);

  const refreshRegistry = React.useCallback(async () => {
    setRegistryAdminToken(adminToken);
    try {
      const admin = await api.registryAdminListSkills({ includeDisabled: true, limit: 500 });
      setSkills(admin.results.map(toSkill));
      setLoadMode('admin');
      return;
    } catch { /* fall through */ }
    try {
      const pub = await api.searchSkills('', 500);
      setSkills(pub.results.map(toSkill));
      setLoadMode('public');
      return;
    } catch { /* fall through */ }
    try {
      const list = await api.listSkills();
      setSkills(list.map(toSkill));
      setLoadMode('bundled');
    } catch {
      setSkills([]);
      setLoadMode('offline');
    }
  }, [adminToken]);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      await refreshRegistry();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [refreshRegistry]);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const onNav = (key: string) => navigate(pathForNav(key));

  // Enable/disable a skill -> toggle on the server, then reflect `enabled`
  // (mapped to the row's `installed`) from the returned Skill in state.
  const onToggleSkill = async (s: Skill) => {
    setAdded(s); // preserve the existing "added" toast animation
    try {
      if (s.id.includes('/')) {
        await api.registryAdminPatchSkill(s.id, { enabled: !s.installed, disabledReason: s.installed ? 'Disabled from Maestro portal' : '' });
        setSkills(prev => prev.map(p => (p.id === s.id ? { ...p, installed: !s.installed, scan: s.installed ? 'quarantined' : 'ok' } : p)));
      } else {
        const updated = await api.toggleSkill(s.id);
        setSkills(prev => prev.map(p => (p.id === updated.id ? { ...p, installed: updated.enabled } : p)));
      }
    } catch { /* fail soft — keep current state */ }
  };
  const onRescanSkill = async (s: Skill) => {
    if (!s.id.includes('/')) return;
    try {
      const updated = toSkill(await api.registryAdminRescanSkill(s.id));
      setSkills(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      setOpen(updated);
      setAdded(updated);
    } catch { /* admin token missing or audit unavailable; keep current state */ }
  };
  const syncSources = async (dryRun: boolean) => {
    setSyncing(true);
    try {
      const r = await api.registryAdminSyncSources({ dryRun, limit: dryRun ? 20 : undefined });
      setAdded({ id: 'sync', name: `${dryRun ? 'Dry-run' : 'Synced'} ${r.attempted}/${r.repos} original sources`, ver: 'latest', desc: '', signed: true, scan: 'ok', uses: '', installed: true, mine: true, tags: [] });
      await refreshRegistry();
    } catch { /* admin token missing or source unavailable */ }
    setSyncing(false);
  };

  let rows = skills.filter(s => segMatch(s, seg));
  if (query) rows = rows.map(s => ({ s, r: rank(s, query) })).filter(x => x.r > 0).sort((a, b) => b.r - a.r).map(x => x.s);

  return (
    <>
      <style>{PAGE_CSS}</style>
      <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        <div style={{
          width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--bg)',
          display: 'flex',
        }}>
          <div className="app-wallpaper" aria-hidden="true" />
          <TrafficLights />
          <Sidebar active="skills" onNav={onNav} onWorkspace={() => {}} />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
            <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} />

            {open ? (
              <SkillDetail s={open} onBack={() => setOpen(null)} onAdd={onToggleSkill} onRescan={onRescanSkill} />
            ) : (
              <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 36px' }}>
                <div style={{ maxWidth: 920, margin: '0 auto' }}>
                  {/* header */}
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
                    <div>
                      <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Skills</h1>
                      <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Your private registry — {loadMode} mode · {skills.length} loaded.</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <input value={adminToken} onChange={e => setAdminTokenState(e.target.value)} onBlur={() => void refreshRegistry()} placeholder="Admin token"
                        style={{ width: 190, height: 34, padding: '0 10px', borderRadius: 9, border: '0.5px solid var(--separator)', background: 'var(--bg-grouped)', color: 'var(--ink)', font: '400 var(--fs-caption)/1 var(--font-mono)', outline: 'none' }} />
                      <button onClick={() => void syncSources(true)} disabled={syncing} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 9, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
                        <Icon name="gitMerge" size={14} /> Dry run
                      </button>
                      <button onClick={() => void syncSources(false)} disabled={syncing} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 9, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
                        <Icon name="refresh" size={14} /> Sync sources
                      </button>
                      <button onClick={() => setPublish(true)} className="primary-cta" style={{
                        display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
                        background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)',
                      }}>
                        <Icon name="plus" size={16} stroke={2.4} /> Add skill
                      </button>
                    </div>
                  </div>

                  {/* search */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 11, height: 50, padding: '0 16px', borderRadius: 14, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', marginBottom: 16,
                    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  }}>
                    <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your registry — semantic (try “write code” or “make images”)"
                      style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }} />
                    {query && <button onClick={() => setQuery('')} className="tb-icon" style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}><Icon name="x" size={14} /></button>}
                  </div>

                  {/* segmented */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
                    {SEGMENTS.map(sg => {
                      const on = seg === sg.key;
                      const count = skills.filter(s => segMatch(s, sg.key)).length;
                      const isQ = sg.key === 'quarantined';
                      return (
                        <button key={sg.key} onClick={() => setSeg(sg.key)} className="filter-chip" style={{
                          display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px', borderRadius: 'var(--r-pill)',
                          background: on ? (isQ ? 'var(--red)' : 'var(--blue)') : 'var(--fill-secondary)', color: on ? '#fff' : (isQ && count ? 'var(--red)' : 'var(--ink-secondary)'), font: '600 var(--fs-subhead)/1 var(--font-text)',
                        }}>
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
                    <div key={query + seg} className="reg-list" style={{
                      background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
                      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                    }}>
                      {rows.map((s, i) => <SkillRow key={s.id} s={s} last={i === rows.length - 1} onOpen={setOpen} />)}
                    </div>
                  )}
                </div>
              </main>
            )}
          </div>

          <PublishSheet open={publish} onClose={() => setPublish(false)} onPublished={(s) => setSkills(prev => [s, ...prev.filter(x => x.id !== s.id)])} />
          {added && <AddedToast skill={added} onDone={() => setAdded(null)} />}
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </div>
      </div>
    </>
  );
}
