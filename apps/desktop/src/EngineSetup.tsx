/* Engine runtimes — download / status panel.

   The native engine binaries (Codex, Claude) are no longer bundled; they're
   fetched on demand into userData (electron/engines.ts). This panel surfaces
   their install state and drives the download with live progress. It's reused
   on first run (Onboarding → Connect step, auto-installing Claude) and in
   Settings (manage both at any time). */

import React from 'react';
import { api, type EngineKind, type EngineState, type EngineDownloadProgress } from './lib/api';
import { Icon, AnthropicGlyph, OpenAIGlyph } from './lib/icons';
import { GroupedList, Row, PillButton, Spinner } from './lib/ui';

interface EngineMeta { id: EngineKind; name: string; meta: string; glyph: React.ReactNode; brand: string }
const ENGINES: EngineMeta[] = [
  { id: 'claude', name: 'Claude engine', meta: 'Claude Code runtime · required to run jobs', glyph: <AnthropicGlyph size={22} />, brand: '#D97757' },
  { id: 'codex', name: 'Codex engine', meta: 'OpenAI Codex runtime · optional', glyph: <OpenAIGlyph size={20} />, brand: 'var(--ink)' },
];

const PHASE_LABEL: Record<EngineDownloadProgress['phase'], string> = {
  resolve: 'Preparing…', download: 'Downloading…', verify: 'Verifying…',
  extract: 'Extracting…', install: 'Installing…', done: 'Done', error: 'Failed',
};

function fmtMB(n?: number): string { return n ? `${(n / 1_000_000).toFixed(1)} MB` : ''; }

/** Status + progress + install actions for the engine binaries. */
export function useEngines() {
  const [status, setStatus] = React.useState<Record<EngineKind, EngineState> | null>(null);
  const [progress, setProgress] = React.useState<Partial<Record<EngineKind, EngineDownloadProgress>>>({});
  const [error, setError] = React.useState<Partial<Record<EngineKind, string>>>({});

  const refresh = React.useCallback(() => {
    api.enginesStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  // Live download progress streams over the same event channel as jobs.
  React.useEffect(() => api.subscribe({
    onEngineDownload: (p) => {
      setProgress(prev => (p.phase === 'done' ? { ...prev, [p.engine]: undefined } : { ...prev, [p.engine]: p }));
      if (p.phase === 'done' || p.phase === 'error') refresh();
    },
  }), [refresh]);

  const install = React.useCallback(async (id: EngineKind) => {
    setError(e => ({ ...e, [id]: undefined }));
    setProgress(prev => ({ ...prev, [id]: { engine: id, phase: 'resolve' } }));
    try {
      await api.installEngine(id);
      setProgress(prev => ({ ...prev, [id]: undefined }));
      refresh();
    } catch (e) {
      setProgress(prev => ({ ...prev, [id]: undefined }));
      setError(prev => ({ ...prev, [id]: e instanceof Error ? e.message : 'Download failed' }));
    }
  }, [refresh]);

  return { status, progress, error, install, refresh };
}

interface EngineSetupProps {
  /** Engines to auto-start downloading on mount if missing (e.g. ['claude']). */
  autoInstall?: EngineKind[];
  /** Called whenever an engine becomes installed (for gating "Continue"). */
  onChange?: (status: Record<EngineKind, EngineState>) => void;
}

export function EngineSetup({ autoInstall = [], onChange }: EngineSetupProps) {
  const { status, progress, error, install } = useEngines();
  const autoDone = React.useRef<Set<EngineKind>>(new Set());

  React.useEffect(() => { if (status) onChange?.(status); }, [status, onChange]);

  // Auto-install the engines the caller marks required (once each).
  React.useEffect(() => {
    if (!status) return;
    for (const id of autoInstall) {
      if (!status[id]?.installed && !autoDone.current.has(id) && !progress[id] && !error[id]) {
        autoDone.current.add(id);
        void install(id);
      }
    }
  }, [status, autoInstall, install, progress, error]);

  return (
    <GroupedList
      header="Engine runtimes"
      footer={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Icon name="cpu" size={13} style={{ flexShrink: 0, marginTop: 1, opacity: 0.7 }} />
          <span>Downloaded once to this Mac (not bundled, so the app installs small) and reused across updates. An existing system install is detected automatically.</span>
        </span>
      }
    >
      {ENGINES.map((e, idx) => {
        const st = status?.[e.id];
        const prog = progress[e.id];
        const err = error[e.id];
        const busy = !!prog;
        return (
          <Row key={e.id} last={idx === ENGINES.length - 1}>
            <span style={{
              width: 38, height: 38, borderRadius: 9, flexShrink: 0,
              display: 'grid', placeItems: 'center', color: e.brand,
              background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)',
            }}>{e.glyph}</span>
            <span style={{ flexShrink: 0, width: 132 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{e.name}</span>
              <span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: err ? 'var(--red)' : 'var(--ink-secondary)', marginTop: 2 }}>
                {err || e.meta}
              </span>
            </span>
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', minWidth: 0 }}>
              {busy ? (
                <ProgressInline prog={prog!} />
              ) : st?.installed ? (
                <InstalledPill source={st.source} version={st.version} />
              ) : !st?.supported ? (
                <span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>Unsupported platform</span>
              ) : (
                <PillButton kind="plain" onClick={() => install(e.id)}
                  style={{ height: 34, padding: '0 14px', fontSize: 14, background: err ? 'rgba(255,59,48,0.12)' : 'var(--fill-secondary)', color: err ? 'var(--red)' : 'var(--blue)' }}>
                  {err ? 'Retry' : 'Download'}
                </PillButton>
              )}
            </span>
          </Row>
        );
      })}
    </GroupedList>
  );
}

function InstalledPill({ source, version }: { source: EngineState['source']; version: string | null }) {
  const label = source === 'system' ? 'System install' : `Installed${version ? ` · ${version}` : ''}`;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px',
      borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.16)', color: 'var(--green)',
      font: '600 var(--fs-footnote)/1 var(--font-text)', whiteSpace: 'nowrap',
    }}>
      <Icon name="check" size={13} stroke={2.6} />
      {label}
    </span>
  );
}

function ProgressInline({ prog }: { prog: EngineDownloadProgress }) {
  const pct = prog.phase === 'download' && typeof prog.pct === 'number' ? prog.pct : null;
  const detail = prog.phase === 'download' && prog.received
    ? `${fmtMB(prog.received)}${prog.total ? ` / ${fmtMB(prog.total)}` : ''}`
    : PHASE_LABEL[prog.phase];
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, maxWidth: 220, justifyContent: 'flex-end' }}>
      <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{detail}</span>
      <span style={{ position: 'relative', width: 96, height: 6, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden', flexShrink: 0 }}>
        {pct === null ? (
          <span style={{ position: 'absolute', inset: 0, background: 'var(--blue)', opacity: 0.5, animation: 'eng-indet 1.1s ease-in-out infinite' }} />
        ) : (
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: 'var(--blue)', transition: 'width 180ms ease' }} />
        )}
      </span>
      <Spinner size={13} />
      <style>{`@keyframes eng-indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }`}</style>
    </span>
  );
}
