import React from 'react';
import { GroupedList, Row } from './ui';
import { Icon } from './icons';

/**
 * ScreenSourceCard — Phase 3D1 (M-A) host-side EXPLICIT display confirmation for the
 * Controllers pane. The operator MUST pick a display before any remote can view this
 * Mac's screen: nothing is selected by default (no auto-pick), only DISPLAYS are listed
 * (never window titles or app names), and the choice is persisted host-local by the brain
 * and revalidated on boot. Until a display is confirmed, a remote "View screen" returns a
 * truthful "no display chosen" state and this card shows the picker.
 *
 * The display LIST comes from the native ScreenCaptureKit bridge (`screenCaptureListSources`,
 * displays only); the SELECTION is read/written through the brain loopback so the host
 * authority + persistence stay the source of truth. Renders nothing on web/phone remotes
 * (no `window.maestro`).
 */
interface NativeSource { id: string; label: string; width: number; height: number }
interface NativeMaestro {
  call(method: string, params: Record<string, unknown>): Promise<{ ok: boolean; selected?: { sourcePolicyId: string; label: string; width: number; height: number } | null }>;
  screenCaptureListSources?: () => Promise<{ ok: boolean; sources?: NativeSource[] }>;
}

function nativeBridge(): NativeMaestro | null {
  const m = (window as unknown as { maestro?: NativeMaestro }).maestro;
  return m && typeof m.call === 'function' && typeof m.screenCaptureListSources === 'function' ? m : null;
}

const btn: React.CSSProperties = { minHeight: 34, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--accent)', font: '600 var(--fs-footnote)/1 var(--font-text)', border: 'none', cursor: 'pointer' };

export function ScreenSourceCard() {
  const bridge = React.useMemo(nativeBridge, []);
  const [sources, setSources] = React.useState<NativeSource[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!bridge) return;
    try {
      const list = await bridge.screenCaptureListSources?.();
      const srcs = (list?.sources ?? []).map((s) => ({ id: s.id, label: s.label, width: s.width, height: s.height }));
      setSources(srcs);
      const state = await bridge.call('screenSourceState', {});
      setSelectedId(state?.selected?.sourcePolicyId ?? null);
    } catch { setSources([]); }
  }, [bridge]);

  React.useEffect(() => { void load(); }, [load]);

  if (!bridge) return null; // web / phone remote — no native capture surface

  const choose = (s: NativeSource) => {
    setBusy(true);
    Promise.resolve(bridge.call('screenConfigureSource', { sourcePolicyId: s.id, width: s.width, height: s.height, label: s.label }))
      .then(() => setSelectedId(s.id)).finally(() => setBusy(false));
  };
  const clear = () => {
    setBusy(true);
    Promise.resolve(bridge.call('screenClearSource', {})).then(() => setSelectedId(null)).finally(() => setBusy(false));
  };

  return (
    <GroupedList header="Screen sharing" footer={selectedId ? 'Approved devices may request view-only access to this display. Selecting it does not start sharing; a stream begins only after an authorized request is accepted.' : 'Choose a display for approved view requests. Selecting it does not start sharing.'}>
      {(sources ?? []).map((s, i) => {
        const on = s.id === selectedId;
        return (
          <Row key={s.id} last={i === (sources?.length ?? 0) - 1 && !selectedId}>
            <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: on ? 'color-mix(in srgb, var(--green) 16%, transparent)' : 'var(--fill-secondary)', color: on ? 'var(--green)' : 'var(--ink-secondary)' }}>
              <Icon name="eye" size={17} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{s.label}</span>
              <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', marginTop: 2 }}>{on ? 'Selected for view requests' : `${s.width}×${s.height}`}</span>
            </span>
            {on ? (
              <button onClick={clear} disabled={busy} aria-label="Clear selected display" style={{ ...btn, color: 'var(--red)' }}>Clear selection</button>
            ) : (
              <button onClick={() => choose(s)} disabled={busy} aria-label={`Use ${s.label} for screen viewing`} style={btn}>Use this display</button>
            )}
          </Row>
        );
      })}
      {sources && sources.length === 0 ? (
        <Row last><span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>No displays available.</span></Row>
      ) : null}
    </GroupedList>
  );
}
