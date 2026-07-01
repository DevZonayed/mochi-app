/* The grouped model picker (Claude Code / Codex / Cursor), matching the
   Conductor-style selector. The list comes from the providers via
   api.listModels(); each provider is runnable or greyed-with-a-reason from live
   engine status. Rows carry a NEW badge, a ⌘-number shortcut, a ★ favorite, and
   a ✓ on the current selection. Reused in the composer (primary + reviewer) and
   in Settings → Engines. */

import React from 'react';
import { Icon } from './icons';
import { ProviderGlyph } from './ui';
import { api, type ModelGroup, type ModelProviderId, type RoleChoice } from './api';

/* one shared fetch of the catalog, shared across every mounted picker */
let groupsCache: ModelGroup[] | null = null;
const subs = new Set<(g: ModelGroup[]) => void>();
let inflight: Promise<void> | null = null;
const MODEL_REFRESH_MS = 60_000;

function publishGroups(g: ModelGroup[]) {
  groupsCache = g;
  subs.forEach(fn => fn(g));
}

export function refreshModelGroups(force = false): Promise<void> {
  if (inflight) return inflight;
  inflight = api.listModels(force)
    .then(publishGroups)
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}

export function useModelGroups(): ModelGroup[] {
  const [groups, setGroups] = React.useState<ModelGroup[]>(groupsCache ?? []);
  React.useEffect(() => {
    subs.add(setGroups);
    if (groupsCache) setGroups(groupsCache);
    void refreshModelGroups(!groupsCache);
    const onFocus = () => { void refreshModelGroups(true); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => { void refreshModelGroups(); }, MODEL_REFRESH_MS);
    return () => {
      subs.delete(setGroups);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, []);
  return groups;
}

const OFF_KEY = 'off';

/** A stored role (engine + model) → the matching picker key, for showing the
    current selection / seeding the composer from the workspace defaults. */
export function keyForRoleChoice(groups: ModelGroup[], rc: RoleChoice | 'off' | undefined): string {
  if (!rc || rc === 'off') return OFF_KEY;
  for (const g of groups) for (const d of g.models) if (d.provider === rc.engine && (d.id || '') === (rc.model || '')) return d.key;
  for (const g of groups) for (const d of g.models) if (d.provider === rc.engine) return d.key;
  return groups.find(g => g.provider === 'claude')?.models[0]?.key ?? 'claude:claude-opus-4-8';
}
function glyph(p: ModelProviderId, size: number) {
  if (p === 'claude') return <ProviderGlyph provider="anthropic" size={size} />;
  if (p === 'codex') return <ProviderGlyph provider="openai" size={size} />;
  return <Icon name="cpu" size={size} />;
}

/** A flat descriptor lookup across all groups. */
export function useModelLookup() {
  const groups = useModelGroups();
  return React.useMemo(() => {
    const m = new Map<string, { label: string; provider: ModelProviderId; runnable: boolean }>();
    for (const g of groups) for (const d of g.models) m.set(d.key, { label: d.label, provider: d.provider, runnable: g.runnable });
    return m;
  }, [groups]);
}

export interface ModelPickerProps {
  /** Current picker key, or 'off' (reviewer only). */
  value: string;
  onChange: (key: string) => void;
  /** Reviewer pickers add an "Off" row. */
  allowOff?: boolean;
  favorites?: string[];
  onToggleFavorite?: (key: string) => void;
  compact?: boolean;
  align?: 'left' | 'right';
  direction?: 'up' | 'down';
  /** Small label before the current model in the trigger, e.g. "Reviewer". */
  triggerLabel?: string;
}

export function ModelPicker({ value, onChange, allowOff, favorites = [], onToggleFavorite, compact, align = 'left', direction = 'down', triggerLabel }: ModelPickerProps) {
  const groups = useModelGroups();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);

  const cur = React.useMemo(() => {
    for (const g of groups) { const d = g.models.find(m => m.key === value); if (d) return d; }
    return undefined;
  }, [groups, value]);

  // flat list of runnable models → ⌘-number shortcuts (1..9)
  const runnableFlat = React.useMemo(() => groups.flatMap(g => g.runnable ? g.models.map(d => d.key) : []), [groups]);

  React.useEffect(() => {
    if (!open) return;
    void refreshModelGroups(true);
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key >= '1' && e.key <= '9') {
        const k = runnableFlat[Number(e.key) - 1];
        if (k) { onChange(k); setOpen(false); }
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, runnableFlat, onChange]);

  const isOff = allowOff && value === OFF_KEY;
  const h = compact ? 24 : 32;
  const fav = new Set(favorites);
  let shortcut = 0;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button onClick={() => setOpen(o => !o)} className="mp-trigger" style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: h, padding: compact ? '0 9px' : '0 11px',
        borderRadius: 9, background: 'var(--fill-secondary)', color: 'var(--ink)', cursor: 'pointer', maxWidth: 230,
      }}>
        {triggerLabel && <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{triggerLabel}</span>}
        <span style={{ display: 'inline-flex', flexShrink: 0, color: isOff ? 'var(--ink-tertiary)' : 'var(--ink)' }}>
          {isOff ? <Icon name="shield" size={compact ? 14 : 15} /> : cur ? glyph(cur.provider, compact ? 14 : 15) : <Icon name="cpu" size={14} />}
        </span>
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isOff ? 'Off' : cur?.label ?? 'Model'}
        </span>
        <Icon name="chevronDown" size={12} style={{ color: 'var(--ink-tertiary)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms var(--spring)' }} />
      </button>

      {open && (
        <div className="mp-pop" style={{
          position: 'absolute', ...(direction === 'up' ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }), [align]: 0, zIndex: 60,
          width: 268, maxHeight: 420, overflowY: 'auto', background: 'var(--bg-elevated)', borderRadius: 13,
          border: '0.5px solid var(--separator)', boxShadow: 'var(--shadow-lg, 0 18px 50px rgba(15,20,60,0.28))', padding: 5,
        }}>
          {groups.map(g => (
            <div key={g.provider} style={{ marginBottom: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 4px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', color: 'var(--ink-tertiary)' }}>
                {g.label}
                {!g.runnable && <span title={g.reason} style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--orange)', textTransform: 'none', letterSpacing: 0 }}>· not signed in</span>}
              </div>
              {g.models.map(d => {
                const on = d.key === value;
                const n = g.runnable ? ++shortcut : 0;
                const starred = fav.has(d.key);
                return (
                  <button key={d.key} disabled={!g.runnable} title={g.runnable ? undefined : g.reason}
                    onClick={() => { if (g.runnable) { onChange(d.key); setOpen(false); } }}
                    className="mp-row" style={{
                      display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 8px', borderRadius: 9, textAlign: 'left',
                      cursor: g.runnable ? 'pointer' : 'default', opacity: g.runnable ? 1 : 0.42,
                      background: on ? 'color-mix(in srgb, var(--blue) 12%, transparent)' : 'transparent',
                    }}>
                    <span style={{ width: 22, display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--ink)' }}>{glyph(d.provider, 17)}</span>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ font: `${on ? 600 : 500} var(--fs-subhead)/1.15 var(--font-text)`, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
                      {d.badge === 'NEW' && <span style={{ flexShrink: 0, font: '700 9px/1 var(--font-text)', letterSpacing: '0.04em', color: 'var(--purple)', background: 'color-mix(in srgb, var(--purple) 16%, transparent)', padding: '2px 5px', borderRadius: 5 }}>NEW</span>}
                      {d.external && <span aria-hidden style={{ flexShrink: 0, font: '600 11px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>↗</span>}
                    </span>
                    {on && <Icon name="check" size={15} stroke={2.6} style={{ color: 'var(--blue)', flexShrink: 0 }} />}
                    {onToggleFavorite && g.runnable && (
                      <span role="button" title={starred ? 'Unfavorite' : 'Favorite'} onClick={e => { e.stopPropagation(); onToggleFavorite(d.key); }}
                        style={{ width: 18, height: 18, display: 'grid', placeItems: 'center', flexShrink: 0, color: starred ? 'var(--yellow, #e6b800)' : 'var(--ink-tertiary)', opacity: starred ? 1 : 0.55 }}>
                        <Icon name={starred ? 'bookmark' : 'bookmark'} size={12} />
                      </span>
                    )}
                    {n > 0 && n <= 9 && <span style={{ flexShrink: 0, width: 16, textAlign: 'right', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{n}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {allowOff && (
            <button onClick={() => { onChange(OFF_KEY); setOpen(false); }} className="mp-row" style={{
              display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 8px', borderRadius: 9, textAlign: 'left', marginTop: 2,
              borderTop: '0.5px solid var(--separator)', background: isOff ? 'color-mix(in srgb, var(--blue) 12%, transparent)' : 'transparent',
            }}>
              <span style={{ width: 22, display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--ink-tertiary)' }}><Icon name="shield" size={16} /></span>
              <span style={{ flex: 1, font: `${isOff ? 600 : 500} var(--fs-subhead)/1.15 var(--font-text)`, color: 'var(--ink)' }}>Off — no reviewer</span>
              {isOff && <Icon name="check" size={15} stroke={2.6} style={{ color: 'var(--blue)', flexShrink: 0 }} />}
            </button>
          )}
        </div>
      )}
    </span>
  );
}
