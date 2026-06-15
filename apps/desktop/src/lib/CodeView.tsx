/* Read-only code/file viewer with syntax highlighting.

   Uses highlight.js (the ~40-language `common` build — synchronous, no WASM, no
   Vite config) and themes the tokens with the app's own CSS variables so it
   follows light/dark via [data-theme]. FileViewer reads a file over the
   renderer-only IPC (api.readFile, path-confined to the project on the main
   side) and renders it with line numbers, like a VS Code tab. */

import React from 'react';
import hljs from 'highlight.js/lib/common';
import { Icon } from './icons';
import { api } from './api';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'toml',
  md: 'markdown', markdown: 'markdown', html: 'xml', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', dockerfile: 'dockerfile',
};
export function extOf(name: string): string {
  const b = (name.split('/').pop() ?? name).toLowerCase();
  if (b === 'dockerfile') return 'dockerfile';
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1) : '';
}

/* highlight.js token colors mapped onto the app palette; light is the default,
   dark overrides only what needs to shift. Background stays transparent so the
   card/pane behind shows through. */
const HLJS_CSS = `
  .hljs { background: transparent; color: var(--ink); }
  .hljs-comment, .hljs-quote { color: var(--ink-tertiary); font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-name, .hljs-meta-keyword { color: var(--purple); }
  .hljs-string, .hljs-attr, .hljs-symbol, .hljs-bullet, .hljs-addition { color: var(--green); }
  .hljs-number, .hljs-literal, .hljs-deletion { color: var(--orange); }
  .hljs-title, .hljs-title.function_, .hljs-section { color: var(--blue); }
  .hljs-type, .hljs-title.class_, .hljs-class .hljs-title { color: var(--teal); }
  .hljs-attribute, .hljs-variable, .hljs-template-variable { color: var(--ink); }
  .hljs-meta, .hljs-tag { color: var(--ink-secondary); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 700; }
  [data-theme="dark"] .hljs-keyword, [data-theme="dark"] .hljs-built_in, [data-theme="dark"] .hljs-name { color: #ff7b72; }
  [data-theme="dark"] .hljs-string, [data-theme="dark"] .hljs-attr { color: #7ee787; }
  [data-theme="dark"] .hljs-title, [data-theme="dark"] .hljs-section { color: #79c0ff; }
  [data-theme="dark"] .hljs-number, [data-theme="dark"] .hljs-literal { color: #ffa657; }
  [data-theme="dark"] .hljs-type { color: #56d4bc; }
`;
let themeInjected = false;
function ensureTheme() {
  if (themeInjected || typeof document === 'undefined') return;
  themeInjected = true;
  const s = document.createElement('style');
  s.id = 'hljs-theme';
  s.textContent = HLJS_CSS;
  document.head.appendChild(s);
}

export function CodeView({ code, filename }: { code: string; filename: string }) {
  ensureTheme();
  const lang = EXT_LANG[extOf(filename)];
  const html = React.useMemo(() => {
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
    } catch { return null; }
  }, [code, lang]);
  const lineCount = React.useMemo(() => code.split('\n').length, [code]);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', font: '400 12.5px/1.65 var(--font-mono)', minHeight: '100%' }}>
      <div aria-hidden style={{ flexShrink: 0, textAlign: 'right', padding: '12px 12px 12px 16px', color: 'var(--ink-tertiary)', userSelect: 'none',
        position: 'sticky', left: 0, background: 'var(--bg-elevated)' }}>
        {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <pre style={{ margin: 0, padding: '12px 18px 12px 4px', flex: 1, minWidth: 0 }}>
        {html != null
          ? <code className={`hljs language-${lang ?? 'plaintext'}`} dangerouslySetInnerHTML={{ __html: html }} />
          : <code className="hljs">{code}</code>}
      </pre>
    </div>
  );
}

/* A file opened as a Workspace tab. */
export function FileViewer({ projectId, filePath }: { projectId: string; filePath: string }) {
  const [st, setSt] = React.useState<{ loading: boolean; text?: string; truncated?: boolean; error?: string }>({ loading: true });
  React.useEffect(() => {
    let alive = true;
    setSt({ loading: true });
    api.readFile(projectId, filePath)
      .then(r => { if (alive) setSt({ loading: false, text: r?.text ?? '', truncated: r?.truncated }); })
      .catch(e => { if (alive) setSt({ loading: false, error: e instanceof Error ? e.message : 'Could not open file' }); });
    return () => { alive = false; };
  }, [projectId, filePath]);
  const name = filePath.split('/').pop() ?? filePath;
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '0.5px solid var(--separator)', flexShrink: 0 }}>
        <Icon name="file" size={14} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', flexShrink: 0 }}>{name}</span>
        <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filePath}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => void api.revealPath(filePath)} title="Reveal in Finder" className="ws-newbtn"
          style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
          <Icon name="folder" size={14} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {st.loading ? <div style={{ padding: 26, font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Loading…</div>
          : st.error ? <div style={{ padding: 26, font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--red)' }}>{st.error}</div>
          : (
            <>
              <CodeView code={st.text ?? ''} filename={name} />
              {st.truncated && <div style={{ padding: '8px 18px', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--orange)' }}>Large file — showing the first part only.</div>}
            </>
          )}
      </div>
    </div>
  );
}

/** Read-only image viewer tab — loads the bytes on-device by Asset id and shows
    the picture fit-to-window (click to toggle actual size). Mirrors FileViewer so
    a generated/attached image opens like any other VS Code-style tab. */
export function ImageViewer({ assetId, name, imagePath }: { assetId?: string; name: string; imagePath?: string }) {
  const [src, setSrc] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [actual, setActual] = React.useState(false);
  React.useEffect(() => {
    let alive = true; setSrc(null); setErr(false);
    if (assetId) api.assetImage(assetId).then(d => { if (alive) (d ? setSrc(d) : setErr(true)); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [assetId]);
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '0.5px solid var(--separator)', flexShrink: 0 }}>
        <Icon name="image" size={14} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ flex: 1 }} />
        {src && <button onClick={() => setActual(a => !a)} title={actual ? 'Fit to window' : 'Actual size'}
          style={{ height: 26, padding: '0 11px', borderRadius: 7, border: '0.5px solid var(--separator)', background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer', flexShrink: 0 }}>{actual ? 'Fit' : '1:1'}</button>}
        {imagePath && <button onClick={() => void api.revealPath(imagePath)} title="Reveal in Finder"
          style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', border: 'none', color: 'var(--ink-tertiary)', cursor: 'pointer', flexShrink: 0 }}><Icon name="folder" size={14} /></button>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'center', background: 'var(--bg-grouped)', padding: 24 }}>
        {src
          ? <img src={src} alt={name} onClick={() => setActual(a => !a)}
              style={actual
                ? { maxWidth: 'none', cursor: 'zoom-out' }
                : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'zoom-in', borderRadius: 8, boxShadow: '0 10px 34px rgba(0,0,0,0.28)' }} />
          : err ? <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)', textAlign: 'center' }}>Couldn’t load this image.</div>
          : <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Loading…</div>}
      </div>
    </div>
  );
}
