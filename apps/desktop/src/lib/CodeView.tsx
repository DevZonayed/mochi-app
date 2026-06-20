/* Read-only code/file viewer with syntax highlighting + an in-place editor.

   Uses highlight.js (the ~40-language `common` build — synchronous, no WASM, no
   Vite config) and themes the tokens with the app's own CSS variables so it
   follows light/dark via [data-theme]. FileViewer reads a file over the
   renderer-only IPC (api.readFile, path-confined to the project on the main
   side) and renders it with line numbers, like a VS Code tab.

   For .md / .markdown files it also offers a rendered preview, an Edit mode
   (textarea + Save via api.writeFile), and a one-click Copy of the source — so
   a markdown link clicked in a chat opens here ready to read, tweak, or grab. */

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
const isMarkdown = (name: string): boolean => {
  const e = extOf(name);
  return e === 'md' || e === 'markdown' || e === 'mdx';
};

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

/* ───────────────── Minimal Markdown preview ─────────────────
   Just enough GitHub-Flavored Markdown to make a chat-handoff .md file read
   nicely: ATX headings, paragraphs, bullet/numbered lists, fenced code blocks
   (highlighted), inline `code`, **bold**, *italic*, [text](url) links, --- HR,
   and > blockquotes. Pipe tables are recognized as a header row directly
   followed by a |---|:--:|---| separator. */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;'
  ));
}
function renderInline(raw: string, k: string): React.ReactNode[] {
  // links first so we can recurse for inline emphasis inside the label
  const out: React.ReactNode[] = [];
  const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, i = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK.exec(raw))) {
    if (m.index > last) out.push(...renderEmphasis(raw.slice(last, m.index), `${k}-t${i++}`));
    out.push(
      <a key={`${k}-a${i++}`} href={m[2]} target="_blank" rel="noreferrer"
        style={{ color: 'var(--blue)', textDecorationLine: 'underline', textUnderlineOffset: 2 }}>
        {renderEmphasis(m[1], `${k}-l${i}`)}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push(...renderEmphasis(raw.slice(last), `${k}-t${i++}`));
  return out;
}
function renderEmphasis(raw: string, k: string): React.ReactNode[] {
  // `code`, **bold**, *italic* (cheap split — good enough for previews)
  return raw.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).flatMap((seg, i): React.ReactNode[] => {
    if (seg.startsWith('`') && seg.endsWith('`')) return [<code key={`${k}-c${i}`} style={{ padding: '1px 5px', borderRadius: 5, background: 'var(--fill-tertiary)', font: '500 0.92em var(--font-mono)' }}>{seg.slice(1, -1)}</code>];
    if (seg.startsWith('**') && seg.endsWith('**')) return [<strong key={`${k}-b${i}`} style={{ fontWeight: 650 }}>{seg.slice(2, -2)}</strong>];
    if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) return [<em key={`${k}-i${i}`}>{seg.slice(1, -1)}</em>];
    return seg ? [seg] : [];
  });
}
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  ensureTheme();
  const html = React.useMemo(() => {
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
    } catch { return null; }
  }, [code, lang]);
  return (
    <pre style={{ margin: '10px 0', padding: '11px 13px', overflowX: 'auto', borderRadius: 10, border: '0.5px solid var(--separator)', background: 'var(--bg-grouped)', font: '400 12.5px/1.6 var(--font-mono)' }}>
      {html != null
        ? <code className={`hljs language-${lang ?? 'plaintext'}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <code className="hljs">{escapeHtml(code)}</code>}
    </pre>
  );
}
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}
function isTableSep(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')));
}
function colAligns(line: string): ('left' | 'center' | 'right')[] {
  return splitRow(line).map(c => { const t = c.replace(/\s/g, ''); const l = t.startsWith(':'), r = t.endsWith(':'); return l && r ? 'center' : r ? 'right' : 'left'; });
}
export function Markdown({ text }: { text: string }) {
  const blocks = React.useMemo<React.ReactNode[]>(() => {
    const out: React.ReactNode[] = [];
    const lines = text.split('\n');
    let i = 0, k = 0;
    let para: string[] = [];
    const flushPara = () => {
      if (!para.length) return;
      out.push(<p key={`p${k++}`} style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderInline(para.join('\n'), `p${k}`)}</p>);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      // fenced code
      const fence = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
      if (fence) {
        flushPara();
        const lang = fence[1] || '';
        const code: string[] = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        if (i < lines.length) i++; // consume closing ```
        out.push(<CodeBlock key={`c${k++}`} code={code.join('\n')} lang={lang} />);
        continue;
      }
      // table
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara();
        const header = splitRow(line);
        const aligns = colAligns(lines[i + 1]);
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].includes('|') && lines[j].trim() && !isTableSep(lines[j])) { rows.push(splitRow(lines[j])); j++; }
        out.push(
          <div key={`t${k++}`} style={{ margin: '10px 0 12px', overflowX: 'auto', borderRadius: 10, border: '0.5px solid var(--separator)' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', font: '400 13px/1.5 var(--font-text)' }}>
              <thead><tr>{header.map((c, ci) => (
                <th key={ci} style={{ textAlign: aligns[ci] ?? 'left', padding: '7px 12px', background: 'var(--fill-tertiary)', color: 'var(--ink)',
                  font: '650 12.5px/1.4 var(--font-text)', borderBottom: '0.5px solid var(--separator-strong)', whiteSpace: 'nowrap', ...(ci ? { borderLeft: '0.5px solid var(--separator)' } : {}) }}>
                  {renderInline(c, `th${ci}`)}
                </th>
              ))}</tr></thead>
              <tbody>{rows.map((r, ri) => (
                <tr key={ri} style={{ background: ri % 2 ? 'color-mix(in srgb, var(--fill-tertiary) 35%, transparent)' : 'transparent' }}>
                  {Array.from({ length: header.length }, (_, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] ?? 'left', padding: '6px 12px', color: 'var(--ink-secondary)', verticalAlign: 'top',
                      borderTop: '0.5px solid var(--separator)', ...(ci ? { borderLeft: '0.5px solid var(--separator)' } : {}) }}>
                      {renderInline(r[ci] ?? '', `td${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          </div>
        );
        i = j;
        continue;
      }
      // hr
      if (/^[-*_]{3,}\s*$/.test(line)) { flushPara(); out.push(<hr key={`h${k++}`} style={{ border: 'none', borderTop: '0.5px solid var(--separator)', margin: '14px 0' }} />); i++; continue; }
      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const lvl = h[1].length;
        const fs = lvl === 1 ? 22 : lvl === 2 ? 18 : lvl === 3 ? 15.5 : lvl === 4 ? 14 : 13;
        out.push(
          <div key={`h${k++}`} style={{ margin: lvl <= 2 ? '18px 0 8px' : '14px 0 6px', font: `700 ${fs}px/1.3 var(--font-display)`, letterSpacing: '-0.01em', color: 'var(--ink)', borderBottom: lvl <= 2 ? '0.5px solid var(--separator)' : undefined, paddingBottom: lvl <= 2 ? 4 : undefined }}>
            {renderInline(h[2], `h${k}`)}
          </div>
        );
        i++; continue;
      }
      // blockquote
      if (/^>\s?/.test(line)) {
        flushPara();
        const quote: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push(
          <blockquote key={`q${k++}`} style={{ margin: '0 0 10px', padding: '4px 12px', borderLeft: '3px solid var(--separator-strong)', color: 'var(--ink-secondary)' }}>
            {renderInline(quote.join('\n'), `q${k}`)}
          </blockquote>
        );
        continue;
      }
      // ordered list
      const ol = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
      const li = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ol) {
        flushPara();
        out.push(
          <div key={`o${k++}`} style={{ display: 'flex', gap: 8, margin: '0 0 5px', paddingLeft: 4 }}>
            <span style={{ color: 'var(--ink-tertiary)', flexShrink: 0, minWidth: 17, textAlign: 'right', font: '600 13px/1.55 var(--font-mono)' }}>{ol[1]}.</span>
            <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderInline(ol[2], `o${k}`)}</span>
          </div>
        );
        i++; continue;
      }
      if (li) {
        flushPara();
        out.push(
          <div key={`l${k++}`} style={{ display: 'flex', gap: 8, margin: '0 0 5px', paddingLeft: 4 }}>
            <span style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }}>•</span>
            <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderInline(li[1], `l${k}`)}</span>
          </div>
        );
        i++; continue;
      }
      if (!line.trim()) { flushPara(); i++; continue; }
      para.push(line);
      i++;
    }
    flushPara();
    return out;
  }, [text]);
  return (
    <div style={{ padding: '20px 28px 28px', maxWidth: 820, margin: '0 auto', font: '400 14.5px/1.6 var(--font-text)', color: 'var(--ink)' }}>
      {blocks}
    </div>
  );
}

/* A file opened as a Workspace tab. For markdown files we offer Preview / Code
   tabs + an Edit mode (textarea + Save) + Copy of the source. */
export function FileViewer({ projectId, filePath }: { projectId: string; filePath: string }) {
  const [st, setSt] = React.useState<{ loading: boolean; text?: string; truncated?: boolean; error?: string }>({ loading: true });
  // load lifecycle: bump this to re-read from disk after a save discards an edit
  const [reloadKey, setReloadKey] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    setSt({ loading: true });
    api.readFile(projectId, filePath)
      .then(r => { if (alive) setSt({ loading: false, text: r?.text ?? '', truncated: r?.truncated }); })
      .catch(e => { if (alive) setSt({ loading: false, error: e instanceof Error ? e.message : 'Could not open file' }); });
    return () => { alive = false; };
  }, [projectId, filePath, reloadKey]);

  const name = filePath.split('/').pop() ?? filePath;
  const md = isMarkdown(name);
  // markdown defaults to Preview; everything else opens straight to source
  const [mode, setMode] = React.useState<'preview' | 'code' | 'edit'>(md ? 'preview' : 'code');
  // resync mode if the file in this tab changes identity
  React.useEffect(() => { setMode(isMarkdown(name) ? 'preview' : 'code'); }, [name]);
  // edit buffer + dirty flag. Initialized from `st.text` whenever we enter
  // edit mode (or whenever a fresh read lands) so we never overwrite with
  // stale bytes after a successful save.
  const [draft, setDraft] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toast, setToast] = React.useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  React.useEffect(() => { if (!dirty) setDraft(st.text ?? ''); }, [st.text, dirty]);
  const showToast = (kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    window.setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 1800);
  };
  const enterEdit = () => { setDraft(st.text ?? ''); setDirty(false); setMode('edit'); };
  const exitEdit = (mode: 'preview' | 'code') => {
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes?');
      if (!ok) return;
    }
    setDirty(false); setMode(mode);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(mode === 'edit' ? draft : (st.text ?? '')); showToast('ok', 'Copied'); }
    catch { showToast('err', 'Copy blocked'); }
  };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.writeFile(projectId, filePath, draft);
      setSt(prev => ({ ...prev, text: draft, truncated: false }));
      setDirty(false);
      showToast('ok', 'Saved');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  // ⌘S / Ctrl-S inside the textarea triggers Save.
  const onEditorKey: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  };

  const Tab = ({ k, label, icon }: { k: 'preview' | 'code' | 'edit'; label: string; icon: 'bookmark' | 'terminal' | 'brush' }) => {
    const on = mode === k;
    const go = () => { if (k === 'edit') enterEdit(); else exitEdit(k); };
    return (
      <button onClick={go} title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 7,
        background: on ? 'var(--fill-secondary)' : 'transparent', border: '0.5px solid', borderColor: on ? 'var(--separator-strong)' : 'transparent',
        color: on ? 'var(--ink)' : 'var(--ink-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer', flexShrink: 0 }}>
        <Icon name={icon} size={12} /> {label}
      </button>
    );
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '0.5px solid var(--separator)', flexShrink: 0 }}>
        <Icon name="file" size={14} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', flexShrink: 0 }}>{name}</span>
        {dirty && <span title="Unsaved changes" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)', flexShrink: 0 }} />}
        <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filePath}</span>
        <span style={{ flex: 1 }} />
        {/* view-mode segmented control — markdown gets a Preview; everything has Code + Edit */}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 9, background: 'var(--fill-tertiary)' }}>
          {md && <Tab k="preview" label="Preview" icon="bookmark" />}
          <Tab k="code" label="Source" icon="terminal" />
          <Tab k="edit" label="Edit" icon="brush" />
        </div>
        <button onClick={() => void copy()} title="Copy file contents" className="ws-newbtn"
          style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
          <Icon name="command" size={14} />
        </button>
        {mode === 'edit' && (
          <button onClick={() => void save()} disabled={!dirty || saving} title={dirty ? 'Save (⌘S)' : 'No changes to save'}
            style={{ height: 28, padding: '0 12px', borderRadius: 7, display: 'inline-flex', alignItems: 'center', gap: 6, background: dirty ? 'var(--blue)' : 'var(--fill-tertiary)', color: dirty ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: dirty && !saving ? 'pointer' : 'default', flexShrink: 0, border: 'none' }}>
            <Icon name={saving ? 'refresh' : 'check'} size={12} /> {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        <button onClick={() => void api.revealPath(filePath)} title="Reveal in Finder" className="ws-newbtn"
          style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
          <Icon name="folder" size={14} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
        {st.loading ? <div style={{ padding: 26, font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Loading…</div>
          : st.error ? (
            <div style={{ padding: 26, font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--red)' }}>
              {st.error}
              <div><button onClick={() => setReloadKey(k => k + 1)} style={{ marginTop: 10, height: 28, padding: '0 12px', borderRadius: 7, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer', border: '0.5px solid var(--separator)' }}>Retry</button></div>
            </div>
          )
          : mode === 'preview' ? <Markdown text={st.text ?? ''} />
          : mode === 'edit' ? (
            <textarea value={draft} onChange={e => { setDraft(e.target.value); setDirty(e.target.value !== (st.text ?? '')); }} onKeyDown={onEditorKey}
              spellCheck={false}
              style={{ width: '100%', height: '100%', minHeight: '100%', boxSizing: 'border-box', padding: '12px 16px', border: 'none', outline: 'none', resize: 'none', background: 'var(--bg-elevated)', color: 'var(--ink)', font: '400 13px/1.65 var(--font-mono)', whiteSpace: 'pre', overflow: 'auto' }} />
          )
          : <CodeView code={st.text ?? ''} filename={name} />}
        {st.truncated && mode !== 'edit' && <div style={{ padding: '8px 18px', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--orange)' }}>Large file — showing the first part only.</div>}
        {st.truncated && mode === 'edit' && <div style={{ padding: '8px 18px', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--orange)' }}>Truncated — saving would overwrite with this slice. Reveal in Finder to edit safely.</div>}
        {toast && (
          <div style={{ position: 'absolute', right: 16, bottom: 16, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator-strong)', color: toast.kind === 'ok' ? 'var(--green)' : 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)', boxShadow: 'var(--card-shadow)' }}>
            {toast.msg}
          </div>
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
