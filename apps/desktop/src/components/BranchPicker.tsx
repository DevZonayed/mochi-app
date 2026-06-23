/* BranchPicker — the popover that opens when you click "+" on a project to
   start a new chat. Lists every branch (local + origin) so the operator can
   fork from anywhere, not just origin/HEAD. Keyboard-first: ↑/↓ to move,
   Enter to pick, Esc to close, `/` to focus the filter input. */

import React from 'react';
import { Icon } from '../lib/icons';
import { api, type BranchInfo } from '../lib/api';

export interface BranchPickerProps {
  projectId: string;
  /** Called with the chosen branch + whether it's the repo's default
      (`origin/HEAD`). Default picks normally translate to "no base override"
      so the tab title stays clean and the engine's existing
      `resolveBaseBranch` flow handles it. */
  onPick: (branch: string, isDefault: boolean) => void;
  /** Esc / outside-click closes the popover. */
  onClose: () => void;
}

function relTime(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts * 1000) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

/** Filter + select-and-fire — both helpers are pure (testable in isolation). */
export function filterBranches(all: BranchInfo[], q: string): BranchInfo[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return all;
  return all.filter(b => b.name.toLowerCase().includes(needle)
    || (b.lastCommit?.subject.toLowerCase().includes(needle) ?? false));
}

/** Index of the branch flagged default; falls back to 0 (top of the sorted list). */
export function defaultIndex(all: BranchInfo[]): number {
  const i = all.findIndex(b => b.isDefault);
  return i === -1 ? 0 : i;
}

export function BranchPicker({ projectId, onPick, onClose }: BranchPickerProps) {
  const [all, setAll] = React.useState<BranchInfo[] | null>(null);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<number>(0);
  const queryRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api.listBranches(projectId)
      .then(list => {
        if (cancelled) return;
        setAll(list);
        setActive(defaultIndex(list));
      })
      .catch(e => { if (!cancelled) setLoadErr(e instanceof Error ? e.message : 'could not load branches'); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Filter recomputes — keep the active row in bounds (cap to last row).
  const visible = React.useMemo(() => filterBranches(all ?? [], query), [all, query]);
  React.useEffect(() => {
    if (!visible.length) { setActive(0); return; }
    setActive(a => Math.min(a, visible.length - 1));
  }, [visible.length]);

  // Auto-focus the filter input so typing immediately narrows the list.
  React.useEffect(() => { queryRef.current?.focus(); }, []);

  // Scroll the active row into view on arrow navigation.
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-bp-row="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (b: BranchInfo | undefined): void => {
    if (!b) return;
    onPick(b.name, b.isDefault);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, visible.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter')     { e.preventDefault(); pick(visible[active]); return; }
    // `/` focuses the filter input (matches the in-app keyboard convention).
    if (e.key === '/' && document.activeElement !== queryRef.current) {
      e.preventDefault(); queryRef.current?.focus();
    }
  };

  return (
    <div role="dialog" aria-label="Pick a base branch" onKeyDown={onKeyDown}
      style={{
        width: 320, maxHeight: 420, display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)',
        borderRadius: 12, boxShadow: 'var(--card-shadow)', padding: 6, overflow: 'hidden',
      }}>

      {/* Header: title + filter input + close */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 6px' }}>
        <Icon name="gitBranch" size={13} style={{ color: 'var(--ink-tertiary)' }} />
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', letterSpacing: 0.2 }}>Base branch</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" title="Close (Esc)"
          style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
          <Icon name="x" size={11} stroke={2.4} />
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 30, padding: '0 9px', margin: '0 2px 6px',
        borderRadius: 9, background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)' }}>
        <Icon name="search" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
        <input ref={queryRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Filter branches…" aria-label="Filter branches"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
            font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }} />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear filter"
            style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
            <Icon name="x" size={10} stroke={2.4} />
          </button>
        )}
      </div>

      {/* List */}
      <div ref={listRef} role="listbox" aria-activedescendant={visible[active] ? `bp-row-${active}` : undefined}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 2px' }}>
        {all === null && !loadErr && (
          // Skeleton — three faint rows while we wait on the IPC.
          <>{[0, 1, 2].map(i => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 10px' }}>
              <div style={{ height: 11, width: '60%', borderRadius: 4, background: 'var(--fill-secondary)' }} />
              <div style={{ height: 9, width: '40%', borderRadius: 4, background: 'var(--fill-secondary)', opacity: 0.7 }} />
            </div>
          ))}</>
        )}

        {loadErr && (
          <div style={{ padding: '14px 12px', textAlign: 'center', font: '400 var(--fs-caption)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            Couldn’t load branches. {loadErr}
          </div>
        )}

        {all !== null && visible.length === 0 && !loadErr && (
          <div style={{ padding: '14px 12px', textAlign: 'center', font: '400 var(--fs-caption)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            {all.length === 0 ? 'No branches found in this project.' : `No branch matches “${query}”.`}
          </div>
        )}

        {visible.map((b, i) => {
          const on = i === active;
          return (
            <button key={b.name} id={`bp-row-${i}`} data-bp-row={i} role="option" aria-selected={on}
              onMouseEnter={() => setActive(i)} onClick={() => pick(b)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left',
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                background: on ? 'var(--fill-secondary)' : 'transparent',
                color: 'var(--ink)', border: 'none',
              }}>
              <Icon name="gitBranch" size={13} style={{ color: b.isDefault ? 'var(--blue)' : 'var(--ink-tertiary)', flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ font: '600 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {b.name}
                  </span>
                  {b.isDefault && <Badge tone="blue">default</Badge>}
                  {b.isCurrent && !b.isDefault && <Badge tone="ink">current</Badge>}
                  {!b.hasRemote && !b.isDefault && <Badge tone="ink-faint">local only</Badge>}
                </div>
                {b.lastCommit && (
                  <div style={{ marginTop: 3, font: '400 var(--fs-caption)/1.35 var(--font-text)', color: 'var(--ink-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.lastCommit.subject || b.lastCommit.sha}
                    {b.lastCommit.date ? <span style={{ marginLeft: 6, opacity: 0.75 }}>· {relTime(b.lastCommit.date)}</span> : null}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer hint */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 2px', borderTop: '0.5px solid var(--separator)', marginTop: 4,
        font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
        <Kbd>⌘</Kbd><span>+ click skips this picker</span>
        <span style={{ flex: 1 }} />
        <Kbd>↵</Kbd><span>pick</span>
        <Kbd>esc</Kbd><span>close</span>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'blue' | 'ink' | 'ink-faint'; children: React.ReactNode }) {
  const palette = tone === 'blue'
    ? { bg: 'color-mix(in srgb, var(--blue) 16%, transparent)', fg: 'var(--blue)' }
    : tone === 'ink'
    ? { bg: 'var(--fill-secondary)', fg: 'var(--ink-secondary)' }
    : { bg: 'transparent', fg: 'var(--ink-tertiary)' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', height: 14, padding: '0 6px', borderRadius: 6,
      background: palette.bg, color: palette.fg, font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: 0.2, flexShrink: 0 }}>
      {children}
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 14, height: 14, padding: '0 4px',
      borderRadius: 3, background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)',
      color: 'var(--ink-secondary)', font: '600 10px/1 var(--font-mono)',
    }}>{children}</kbd>
  );
}
