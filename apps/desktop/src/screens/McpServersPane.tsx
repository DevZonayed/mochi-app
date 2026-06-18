/* Settings → MCP servers: a managed list of custom MCP servers (the operator's
   global library) plus the "Connect to a custom MCP" form (STDIO + Streamable
   HTTP), matching the connect-MCP design. Skills can be attached to a server so
   the agent is made aware of them whenever that server is active in a run.

   Mac-local + desktop-only (the Mac owns all config); data flows through
   api.{list,add,update,setEnabled,remove}McpServer → localApi → store. */

import React from 'react';
import { Icon } from '../lib/icons';
import { GroupedList, Row, Switch, PillButton, Spinner } from '../lib/ui';
import { api, ApiError, type CustomMcpServer, type McpServerInput, type McpKv, type RegistrySkillSummary } from '../lib/api';

/* ───────────────────────── shared bits ───────────────────────── */
const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, border: '0.5px solid var(--separator-strong)', borderRadius: 8, outline: 'none',
  background: 'var(--fill-tertiary)', font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', padding: '0 11px',
};
const labelStyle: React.CSSProperties = { display: 'block', font: '600 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)', marginBottom: 9 };
const hintStyle: React.CSSProperties = { font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 7 };
const skillName = (id: string) => id.split('/').pop() || id;

function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', borderRadius: 'var(--r-group)', padding: 14 }}>
      <span style={labelStyle}>{label}</span>
      {children}
      {hint && <div style={hintStyle}>{hint}</div>}
    </div>
  );
}

function Seg({ options, value, onChange }: { options: string[]; value: string; onChange: (next: string) => void }) {
  const i = options.findIndex(o => o === value);
  return (
    <div style={{ position: 'relative', display: 'flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9, width: '100%' }}>
      <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${i} * (100% - 4px) / ${options.length} + 2px)`, width: `calc((100% - 4px) / ${options.length})`, background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
      {options.map(o => <button key={o} type="button" onClick={() => onChange(o)} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '7px 0', font: '600 var(--fs-footnote)/1 var(--font-text)', color: value === o ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{o}</button>)}
    </div>
  );
}

const addBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', height: 34, marginTop: 8,
  borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)',
};
function TrashBtn({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} title="Remove" style={{ flexShrink: 0, width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 7, color: 'var(--ink-tertiary)' }} className="ghost-btn"><Icon name="trash" size={15} /></button>;
}

/** A list of single string values (Arguments, Environment variable passthrough). */
function ListEditor({ values, onChange, placeholder, addLabel }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; addLabel: string }) {
  return (
    <div>
      {values.map((v, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input value={v} placeholder={placeholder} onChange={e => onChange(values.map((x, j) => (j === i ? e.target.value : x)))} style={inputStyle} />
          <TrashBtn onClick={() => onChange(values.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...values, ''])} style={addBtnStyle} className="ghost-btn"><Icon name="plus" size={14} stroke={2.4} /> {addLabel}</button>
    </div>
  );
}

/** A list of key/value pairs (Environment variables, Headers, Headers-from-env). */
function KvEditor({ rows, onChange, addLabel, keyPlaceholder = 'Key', valuePlaceholder = 'Value' }: { rows: McpKv[]; onChange: (r: McpKv[]) => void; addLabel: string; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const set = (i: number, patch: Partial<McpKv>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input value={r.key} placeholder={keyPlaceholder} onChange={e => set(i, { key: e.target.value })} style={{ ...inputStyle, flex: 1 }} />
          <input value={r.value} placeholder={valuePlaceholder} onChange={e => set(i, { value: e.target.value })} style={{ ...inputStyle, flex: 1 }} />
          <TrashBtn onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { key: '', value: '' }])} style={addBtnStyle} className="ghost-btn"><Icon name="plus" size={14} stroke={2.4} /> {addLabel}</button>
    </div>
  );
}

/* ───────────────────────── skill picker ───────────────────────── */
function SkillPicker({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<RegistrySkillSummary[]>([]);
  const [busy, setBusy] = React.useState(false);
  const names = React.useRef<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      api.searchSkills(q.trim(), 12).then(r => { if (alive) { setResults(r.results); r.results.forEach(s => { names.current[s.id] = s.name; }); } })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open]);

  const add = (id: string) => { if (!ids.includes(id)) onChange([...ids, id]); };

  return (
    <div>
      {ids.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: ids.length ? 8 : 0 }}>
          {ids.map(id => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--indigo) 16%, transparent)', color: 'var(--indigo)' }}><Icon name="spark" size={12} /></span>
              <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{names.current[id] || skillName(id)}</span>
              <button type="button" onClick={() => onChange(ids.filter(x => x !== id))} title="Detach" style={{ flexShrink: 0, color: 'var(--ink-tertiary)' }}><Icon name="x" size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {open ? (
        <div style={{ border: '0.5px solid var(--separator)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '0.5px solid var(--separator)' }}>
            <Icon name="search" size={14} style={{ color: 'var(--ink-tertiary)' }} />
            <input autoFocus value={q} placeholder="Search the skill registry…" onChange={e => setQ(e.target.value)} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }} />
            {busy && <Spinner size={13} />}
            <button type="button" onClick={() => { setOpen(false); setQ(''); }} style={{ color: 'var(--ink-tertiary)' }}><Icon name="x" size={14} /></button>
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {results.length === 0 && !busy && <div style={{ padding: '16px 12px', textAlign: 'center', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{q ? 'No matching skills' : 'Type to search the registry'}</div>}
            {results.map(s => {
              const added = ids.includes(s.id);
              return (
                <button key={s.id} type="button" disabled={added} onClick={() => add(s.id)} className="set-nav" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 11px', textAlign: 'left', opacity: added ? 0.5 : 1 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                    <span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.description || s.id}</span>
                  </span>
                  {added ? <Icon name="check" size={15} style={{ color: 'var(--green)', flexShrink: 0 }} /> : <Icon name="plus" size={15} stroke={2.4} style={{ color: 'var(--blue)', flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} style={addBtnStyle} className="ghost-btn"><Icon name="plus" size={14} stroke={2.4} /> Attach skill</button>
      )}
    </div>
  );
}

/* ───────────────────────── the connect form ───────────────────────── */
type FormState = {
  name: string; transport: 'stdio' | 'http';
  command: string; args: string[]; env: McpKv[]; passthrough: string[]; cwd: string;
  url: string; bearer: string; headers: McpKv[]; headerEnv: McpKv[];
  skillIds: string[];
};
function initialForm(s?: CustomMcpServer): FormState {
  return {
    name: s?.name ?? '', transport: s?.transport ?? 'stdio',
    command: s?.command ?? '', args: s?.args ?? [], env: s?.env ?? [], passthrough: s?.envPassthrough ?? [], cwd: s?.cwd ?? '',
    url: s?.url ?? '', bearer: s?.bearerTokenEnv ?? '', headers: s?.headers ?? [],
    headerEnv: (s?.headerEnv ?? []).map(h => ({ key: h.key, value: h.valueEnv })),
    skillIds: s?.skillIds ?? [],
  };
}
const cleanArr = (a: string[]) => a.map(x => x.trim()).filter(Boolean);
const cleanKv = (a: McpKv[]) => a.map(r => ({ key: r.key.trim(), value: r.value })).filter(r => r.key);

function McpServerForm({ initial, onBack, onSaved }: { initial?: CustomMcpServer; onBack: () => void; onSaved: () => void }) {
  const [f, setF] = React.useState<FormState>(() => initialForm(initial));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const patch = (p: Partial<FormState>) => setF(s => ({ ...s, ...p }));
  const isHttp = f.transport === 'http';
  const canSave = f.name.trim() !== '' && (isHttp ? f.url.trim() !== '' : f.command.trim() !== '');

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true); setError('');
    const input: McpServerInput = isHttp
      ? {
          name: f.name.trim(), enabled: initial?.enabled ?? true, transport: 'http', skillIds: f.skillIds,
          url: f.url.trim(), bearerTokenEnv: f.bearer.trim() || undefined,
          headers: cleanKv(f.headers),
          headerEnv: f.headerEnv.map(r => ({ key: r.key.trim(), valueEnv: r.value.trim() })).filter(r => r.key && r.valueEnv),
        }
      : {
          name: f.name.trim(), enabled: initial?.enabled ?? true, transport: 'stdio', skillIds: f.skillIds,
          command: f.command.trim(), args: cleanArr(f.args), env: cleanKv(f.env),
          envPassthrough: cleanArr(f.passthrough), cwd: f.cwd.trim() || undefined,
        };
    try {
      if (initial) await api.updateMcpServer(initial.id, input);
      else await api.addMcpServer(input);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={onBack} className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 16 }}>
        <Icon name="arrowLeft" size={16} /> Back
      </button>
      <h2 style={{ margin: '0 0 4px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{initial ? 'Edit MCP server' : 'Connect to a custom MCP'}</h2>
      <p style={{ margin: '0 0 20px', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
        Connect any MCP server — a local command (STDIO) or a streamable HTTP endpoint. Secrets are referenced by environment-variable name and resolved on this Mac at launch; the value itself is never stored.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          <input value={f.name} placeholder="MCP server name" onChange={e => patch({ name: e.target.value })} style={{ ...inputStyle, font: '400 var(--fs-footnote)/1 var(--font-text)' }} />
          <div style={{ marginTop: 12 }}>
            <Seg options={['STDIO', 'Streamable HTTP']} value={isHttp ? 'Streamable HTTP' : 'STDIO'} onChange={v => patch({ transport: v === 'STDIO' ? 'stdio' : 'http' })} />
          </div>
        </Field>

        {isHttp ? (
          <>
            <Field label="URL"><input value={f.url} placeholder="https://mcp.example.com/mcp" onChange={e => patch({ url: e.target.value })} style={inputStyle} /></Field>
            <Field label="Bearer token env var" hint="The name of an environment variable holding the token. Sent as Authorization: Bearer <value>.">
              <input value={f.bearer} placeholder="MCP_BEARER_TOKEN" onChange={e => patch({ bearer: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Headers"><KvEditor rows={f.headers} onChange={headers => patch({ headers })} addLabel="Add header" /></Field>
            <Field label="Headers from environment variables" hint="Each value is the NAME of an environment variable on this Mac, resolved at launch.">
              <KvEditor rows={f.headerEnv} onChange={headerEnv => patch({ headerEnv })} addLabel="Add variable" valuePlaceholder="ENV_VAR_NAME" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Command to launch" hint="Just the executable (e.g. npx, uvx, or an absolute path). Put each flag and argument separately under Arguments.">
              <input value={f.command} placeholder="npx" onChange={e => patch({ command: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Arguments" hint="One per row, e.g. -y then @modelcontextprotocol/server-filesystem then /path."><ListEditor values={f.args} onChange={args => patch({ args })} placeholder="--flag or value" addLabel="Add argument" /></Field>
            <Field label="Environment variables"><KvEditor rows={f.env} onChange={env => patch({ env })} addLabel="Add environment variable" /></Field>
            <Field label="Environment variable passthrough" hint="Names of environment variables on this Mac to forward into the server's process.">
              <ListEditor values={f.passthrough} onChange={passthrough => patch({ passthrough })} placeholder="ENV_VAR_NAME" addLabel="Add variable" />
            </Field>
            <Field label="Working directory"><input value={f.cwd} placeholder="~/code" onChange={e => patch({ cwd: e.target.value })} style={inputStyle} /></Field>
          </>
        )}

        <Field label="Skills" hint="When this server is active in a run, these skills are installed + the agent is told to read them before using the server's tools.">
          <SkillPicker ids={f.skillIds} onChange={skillIds => patch({ skillIds })} />
        </Field>
      </div>

      {error && <div style={{ marginTop: 14, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--red)' }}>{error}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button type="button" onClick={onBack} style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Cancel</button>
        <button type="button" onClick={save} disabled={!canSave || busy} style={{ height: 38, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', opacity: !canSave || busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/* ───────────────────────── list + pane root ───────────────────────── */
function ServerRow({ s, last, onToggle, onEdit, onDelete }: { s: CustomMcpServer; last: boolean; onToggle: (on: boolean) => void; onEdit: () => void; onDelete: () => void }) {
  const glyph = (s.name || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'MC';
  const subBits = [s.transport === 'http' ? 'Streamable HTTP' : 'STDIO', s.transport === 'http' ? (s.url || '') : (s.command || '')].filter(Boolean).join(' · ');
  return (
    <Row last={last} style={{ opacity: s.enabled ? 1 : 0.6, transition: 'opacity 200ms ease' }}>
      <span onClick={onEdit} style={{ cursor: 'pointer', width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--teal) 15%, transparent)', color: 'var(--teal)', font: '700 var(--fs-footnote)/1 var(--font-mono)' }}>{glyph}</span>
      <span onClick={onEdit} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
          {s.skillIds.length > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--indigo) 14%, transparent)', color: 'var(--indigo)', font: '600 var(--fs-caption)/18px var(--font-text)' }}><Icon name="spark" size={11} /> {s.skillIds.length}</span>}
        </span>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subBits}</span>
      </span>
      <TrashBtn onClick={onDelete} />
      <span style={{ width: 1, height: 26, background: 'var(--separator)' }} />
      <Switch on={s.enabled} onChange={onToggle} />
    </Row>
  );
}

export default function McpServersPane() {
  const [servers, setServers] = React.useState<CustomMcpServer[] | null>(null);
  const [view, setView] = React.useState<{ kind: 'list' } | { kind: 'new' } | { kind: 'edit'; server: CustomMcpServer }>({ kind: 'list' });

  const refetch = React.useCallback(() => { api.listMcpServers().then(setServers).catch(() => setServers([])); }, []);
  React.useEffect(() => { refetch(); }, [refetch]);

  const toggle = async (s: CustomMcpServer, on: boolean) => {
    setServers(prev => prev?.map(x => (x.id === s.id ? { ...x, enabled: on } : x)) ?? prev);
    try { await api.setMcpServerEnabled(s.id, on); } catch { refetch(); }
  };
  const remove = async (s: CustomMcpServer) => {
    setServers(prev => prev?.filter(x => x.id !== s.id) ?? prev);
    try { await api.removeMcpServer(s.id); } catch { refetch(); }
  };

  if (view.kind !== 'list') {
    return <McpServerForm initial={view.kind === 'edit' ? view.server : undefined} onBack={() => setView({ kind: 'list' })} onSaved={() => { refetch(); setView({ kind: 'list' }); }} />;
  }

  return (
    <div>
      <style>{`.link-btn:hover{text-decoration:underline}.set-nav:hover{background:var(--fill-tertiary)}.ghost-btn:hover{background:color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%)}`}</style>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>MCP servers</h2>
          <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Connect custom MCP servers once; enabled servers are available to every agent run, on Claude and Codex.</p>
        </div>
        <PillButton kind="primary" icon="plus" onClick={() => setView({ kind: 'new' })} style={{ height: 36, flexShrink: 0 }}>Connect a custom MCP</PillButton>
      </div>

      {servers === null ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner size={20} /></div>
      ) : servers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', borderRadius: 'var(--r-group)', border: '0.5px dashed var(--separator-strong)', background: 'var(--bg-grouped)' }}>
          <div style={{ width: 48, height: 48, margin: '0 auto 14px', borderRadius: 12, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--teal) 14%, transparent)', color: 'var(--teal)' }}><Icon name="bolt" size={24} /></div>
          <div style={{ font: '600 var(--fs-headline)/1.2 var(--font-text)', color: 'var(--ink)', marginBottom: 6 }}>No custom MCP servers yet</div>
          <div style={{ font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 380, margin: '0 auto 18px' }}>Add a server in one click and attach skills so the agent knows how to use it.</div>
          <PillButton kind="primary" icon="plus" onClick={() => setView({ kind: 'new' })} style={{ height: 38 }}>Connect a custom MCP</PillButton>
        </div>
      ) : (
        <GroupedList footer="Enabled servers are merged into every run. Codex uses STDIO servers; Streamable HTTP servers run on Claude.">
          {servers.map((s, i) => (
            <ServerRow key={s.id} s={s} last={i === servers.length - 1} onToggle={on => toggle(s, on)} onEdit={() => setView({ kind: 'edit', server: s })} onDelete={() => remove(s)} />
          ))}
        </GroupedList>
      )}
    </div>
  );
}
