/* Settings — macOS System Settings model: left nav + right grouped panes. */

const SET_NAV = [
  { key: 'general', icon: 'settings', label: 'General', tint: 'var(--ink-secondary)' },
  { key: 'accounts', icon: 'key', label: 'Accounts & keys', tint: 'var(--blue)' },
  { key: 'security', icon: 'shield', label: 'Security', tint: 'var(--green)' },
  { key: 'devices', icon: 'smartphone', label: 'Devices', tint: 'var(--teal)' },
  { key: 'power', icon: 'bolt', label: 'Power & reliability', tint: 'var(--orange)' },
  { key: 'updates', icon: 'refresh', label: 'Updates', tint: 'var(--indigo)' },
  { key: 'danger', icon: 'alert', label: 'Danger zone', tint: 'var(--red)' },
];

function PaneHead({ children, sub }) {
  return <div style={{ marginBottom: 18 }}><h2 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{children}</h2>{sub && <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{sub}</p>}</div>;
}
function Seg({ options, value, onChange }) {
  const i = options.findIndex(o => o === value);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${i} * (100% - 4px) / ${options.length} + 2px)`, width: `calc((100% - 4px) / ${options.length})`, background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
      {options.map(o => <button key={o} onClick={() => onChange(o)} style={{ position: 'relative', zIndex: 1, padding: '6px 14px', font: '600 var(--fs-footnote)/1 var(--font-text)', color: value === o ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{o}</button>)}
    </div>
  );
}

function GeneralPane({ theme, setTheme }) {
  const [eff, setEff] = React.useState('BALANCED');
  const [model, setModel] = React.useState('auto');
  return (
    <div>
      <PaneHead>General</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList header="Workspace">
          <Row><span style={{ width: 110, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Name</span><input defaultValue="Atlas Studio" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)', padding: '13px 0' }} /></Row>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Appearance</span><Seg options={['Light', 'Dark', 'Auto']} value={theme === 'dark' ? 'Dark' : 'Light'} onChange={v => setTheme(v === 'Dark' ? 'dark' : 'light')} /></Row>
        </GroupedList>
        <GroupedList header="Defaults" footer="Applies to new jobs across the workspace; projects can override.">
          <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Default effort</span><EffortDial value={eff} onChange={setEff} compact /></Row>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Default model</span><ModelSwitcher value={model} onChange={setModel} align="right" /></Row>
        </GroupedList>
        <GroupedList header="Startup">
          <ToggleRow label="Open Maestro at login" on={true} />
          <ToggleRow label="Resume in-flight jobs on launch" on={true} last />
        </GroupedList>
      </div>
    </div>
  );
}

function ToggleRow({ label, sub, on: initial, last }) {
  const [on, setOn] = React.useState(initial);
  return (
    <Row last={last}>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', font: '400 var(--fs-body)/1.2 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
        {sub && <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{sub}</span>}
      </span>
      <Switch on={on} onChange={setOn} />
    </Row>
  );
}

const PROVIDERS = [
  { name: 'Anthropic', tint: '#D97757', glyph: 'A', status: 'Auto-refreshing ✓', used: '2 min ago' },
  { name: 'OpenAI', tint: 'var(--ink)', glyph: 'O', status: 'Key in Keychain', used: '14 min ago' },
  { name: 'fal', tint: 'var(--purple)', glyph: 'f', status: 'Key in Keychain', used: '1 hr ago' },
  { name: 'Replicate', tint: 'var(--teal)', glyph: 'R', status: 'Key in Keychain', used: 'Yesterday' },
  { name: 'ElevenLabs', tint: 'var(--indigo)', glyph: 'E', status: 'Key in Keychain', used: '3 hr ago' },
  { name: 'Google', tint: 'var(--blue)', glyph: 'G', status: 'Auto-refreshing ✓', used: '5 min ago' },
];
function AccountsPane() {
  return (
    <div>
      <PaneHead sub="Agents use keys; they never see them.">Accounts &amp; keys</PaneHead>
      <GroupedList footer="Keys live in your Mac's Keychain. We show status, never the value.">
        {PROVIDERS.map((p, i) => (
          <Row key={p.name} last={i === PROVIDERS.length - 1}>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${p.tint} 15%, transparent)`, color: p.tint, font: '800 var(--fs-callout)/1 var(--font-display)' }}>{p.glyph}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{p.name}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: p.status.includes('✓') ? 'var(--green)' : 'var(--ink-secondary)', marginTop: 2 }}>
                <Icon name="lock" size={11} /> {p.status} · used {p.used}
              </span>
            </span>
            <button className="ghost-btn" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Replace key</button>
          </Row>
        ))}
      </GroupedList>
    </div>
  );
}

function SecurityPane() {
  return (
    <div>
      <PaneHead>Security</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList header="Autonomy floor">
          <Row last>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><Icon name="lock" size={18} /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Unattended is the maximum autonomy</span>
              <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Always inside allowlists and caps. There is no bypass mode.</span>
            </span>
          </Row>
        </GroupedList>
        <GroupedList footer="Untrusted content (web pages, messages, files) is treated as input, never instructions.">
          <ToggleRow label="Review untrusted input" sub="Scan tool outputs and inbound messages for injected instructions." on={true} last />
        </GroupedList>
        <GroupedList header="Skill trust">
          <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Re-scan cadence</span><Seg options={['Daily', 'Weekly', 'On change']} value={'On change'} onChange={() => {}} /></Row>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>On drift</span><span style={{ font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--orange)' }}>Quarantine until re-approved</span></Row>
        </GroupedList>
        <GroupedList header="Audit log">
          <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Retention</span><Seg options={['90 days', '1 year', 'Forever']} value={'Forever'} onChange={() => {}} /></Row>
          <Row last onClick={() => {}}><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--blue)' }}>Export audit (JSONL)</span><Icon name="enter" size={16} style={{ color: 'var(--ink-tertiary)', transform: 'rotate(-90deg)' }} /></Row>
        </GroupedList>
      </div>
    </div>
  );
}

function DevicesPane() {
  const devs = [['Jillur’s iPhone 15 Pro', 'Last seen 2 min ago'], ['iPad Air', 'Last seen yesterday']];
  return (
    <div>
      <PaneHead>Devices</PaneHead>
      <GroupedList footer="Paired phones use the end-to-end encrypted relay.">
        {devs.map((d, i) => (
          <Row key={i}>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--teal) 13%, transparent)', color: 'var(--teal)' }}><Icon name="smartphone" size={18} /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{d[0]}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--green)' }}><Icon name="lock" size={10} /> E2EE</span> · {d[1]}</span>
            </span>
            <button className="reject-btn" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Revoke</button>
          </Row>
        ))}
        <Row last onClick={() => { location.href = '../device-pairing/Pair a Phone.html'; }}>
          <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="plus" size={18} stroke={2.4} /></span>
          <span style={{ flex: 1, font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--blue)' }}>Pair new device</span>
          <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />
        </Row>
      </GroupedList>
    </div>
  );
}

function PowerPane() {
  return (
    <div>
      <PaneHead>Power &amp; reliability</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList footer="Jobs survive sleep anyway — they resume from checkpoint.">
          <ToggleRow label="Keep Mac awake while jobs run" on={false} last />
        </GroupedList>
        <GroupedList header="Checkpoints">
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Interval</span><Seg options={['30s', '2 min', '5 min']} value={'2 min'} onChange={() => {}} /></Row>
        </GroupedList>
        <GroupedList header="Relay" footer={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Connected · 38ms</span>}>
          <Row last><span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Address</span><input defaultValue="relay.maestro.app:443" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)', padding: '13px 0' }} /></Row>
        </GroupedList>
      </div>
    </div>
  );
}

function UpdatesPane() {
  return (
    <div>
      <PaneHead>Updates</PaneHead>
      <GroupedList footer="Updates are signed and verified before install.">
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Current version</span><span style={{ font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>3.4.1 (build 8821)</span></Row>
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Channel</span><Seg options={['Stable', 'Beta']} value={'Stable'} onChange={() => {}} /></Row>
        <Row last><span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--green)' }}><Icon name="check" size={14} stroke={2.6} /> Up to date</span><button className="ghost-btn" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Check now</button></Row>
      </GroupedList>
    </div>
  );
}

function DangerPane({ onReset }) {
  return (
    <div>
      <PaneHead sub="Separated on purpose. These actions can't be undone.">Danger zone</PaneHead>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, border: '1px solid rgba(255,59,48,0.3)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 16px' }}>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Reset workspace</span>
            <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3, maxWidth: 460 }}>Removes projects, transcripts, synced copies, and media. The audit log keeps a tombstone.</span>
          </span>
          <button onClick={onReset} style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--red)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(255,59,48,0.3)' }}>Reset…</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { SET_NAV, GeneralPane, AccountsPane, SecurityPane, DevicesPane, PowerPane, UpdatesPane, DangerPane });
