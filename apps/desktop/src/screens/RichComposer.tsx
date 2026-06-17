/* RichComposer — a contenteditable chat input that supports INLINE capsule chips
   anywhere in the text (an @mention, or a dropped file/folder), while exposing a
   plain serialized string to the parent so all the existing send/queue/slash logic
   keeps working unchanged.

   Chips are contentEditable=false inline spans the browser treats as atomic (one
   backspace deletes the whole capsule). Each chip carries `data-text` — what it
   serializes to in the outgoing message (a file → `path`; a mention → "", since it
   is a mode flag surfaced via onChips). The editor is UNCONTROLLED: we never set its
   content from React state (that would fight the caret) — only imperatively via the
   ref. Pattern ported from the extension's proven mochi-modal.js hint editor. */
import React from 'react';
import { type IconName } from '../lib/icons';
import { fileIconHtml } from '../lib/fileIcons';

export type ComposerChip =
  | { kind: 'mention'; id: string; label: string; icon: IconName }
  | { kind: 'file'; name: string; path: string; isDir: boolean };

export interface RichComposerHandle {
  focus(): void;
  clear(): void;
  setText(plain: string): void;
  /** Replace the `@token` currently being typed at the caret with a chip. */
  applyMention(spec: ComposerChip): void;
  /** Insert chips at the caret (used by drag-drop). */
  insertChips(specs: ComposerChip[]): void;
  getText(): string;
}

// Imperative chips can't use the React <Icon>, so inline the few SVGs we need
// (same paths as lib/icons.tsx).
const SVG: Record<string, string> = {
  globe: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const MENTION_RE = /(^|\s)@([\w./-]*)$/;

interface Props {
  placeholder: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  onTextChange: (text: string) => void;
  onChips?: (info: { hasBrowser: boolean; files: { name: string; path: string; isDir: boolean }[] }) => void;
  onMention?: (query: string | null) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void;
}

export const RichComposer = React.forwardRef<RichComposerHandle, Props>(function RichComposer(props, ref) {
  const elRef = React.useRef<HTMLDivElement>(null);
  const composing = React.useRef(false);
  const [empty, setEmpty] = React.useState(true);

  const serialize = React.useCallback((): string => {
    const root = elRef.current; if (!root) return '';
    let out = '';
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue ?? ''; return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const e = n as HTMLElement;
      if (e.dataset.chip) { out += e.dataset.text ?? ''; return; }
      if (e.tagName === 'BR') { out += '\n'; return; }
      for (const c of Array.from(e.childNodes)) walk(c);
      if (/^(DIV|P)$/.test(e.tagName)) out += '\n';
    };
    for (const c of Array.from(root.childNodes)) walk(c);
    return out.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').replace(/[ \t\n]+$/, '');
  }, []);

  const emit = React.useCallback(() => {
    const root = elRef.current; if (!root) return;
    props.onTextChange(serialize());
    setEmpty(!root.textContent && !root.querySelector('[data-chip]'));
    if (props.onChips) {
      const chips = Array.from(root.querySelectorAll('[data-chip]')) as HTMLElement[];
      const hasBrowser = chips.some(c => c.dataset.chip === 'mention' && c.dataset.id === 'browser');
      const files = chips.filter(c => c.dataset.chip === 'file').map(c => ({ name: c.dataset.name ?? '', path: c.dataset.path ?? '', isDir: c.dataset.dir === '1' }));
      props.onChips({ hasBrowser, files });
    }
  }, [serialize, props]);

  const buildChip = (chip: ComposerChip): HTMLElement => {
    const span = document.createElement('span');
    span.contentEditable = 'false';
    span.dataset.chip = chip.kind;
    const accent = chip.kind === 'mention' ? 'var(--green)' : (chip.isDir ? 'var(--purple)' : 'var(--blue)');
    span.setAttribute('style', `display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;margin:0 1px;padding:1px 3px 1px 7px;border-radius:6px;font:600 12px/1.45 var(--font-text);background:color-mix(in srgb, ${accent} 14%, transparent);border:1px solid color-mix(in srgb, ${accent} 38%, transparent);color:${accent};user-select:none;white-space:nowrap;max-width:240px;`);
    let icon: string, label: string;
    if (chip.kind === 'mention') { icon = SVG[chip.icon] ?? ''; label = chip.label; span.dataset.id = chip.id; span.dataset.text = ''; }
    else { icon = chip.isDir ? SVG.folder : fileIconHtml(chip.name, 15); label = chip.name; span.dataset.name = chip.name; span.dataset.path = chip.path; span.dataset.dir = chip.isDir ? '1' : '0'; span.dataset.text = '`' + chip.path + '`'; }
    span.innerHTML = `${icon}<span style="overflow:hidden;text-overflow:ellipsis;">${esc(label)}</span><button type="button" tabindex="-1" data-rm="1" aria-label="Remove" style="display:inline-flex;align-items:center;border:none;background:transparent;color:inherit;cursor:pointer;padding:0 1px;opacity:.6;">${SVG.x}</button>`;
    return span;
  };

  /** Insert nodes at the caret (or end), optionally followed by a space. Caret ends after. */
  const insertNodes = (nodes: Node[], trailingSpace: boolean) => {
    const root = elRef.current; if (!root) return;
    root.focus();
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount && root.contains(sel.anchorNode)) range = sel.getRangeAt(0);
    else { range = document.createRange(); range.selectNodeContents(root); range.collapse(false); }
    range.deleteContents();
    const frag = document.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    let tail: Node | null = null;
    if (trailingSpace) { tail = document.createTextNode(' '); frag.appendChild(tail); }
    range.insertNode(frag);
    const last = tail ?? nodes[nodes.length - 1];
    if (last) { const nr = document.createRange(); nr.setStartAfter(last); nr.collapse(true); sel?.removeAllRanges(); sel?.addRange(nr); }
    emit();
  };

  const placeCaretEnd = () => {
    const root = elRef.current; if (!root) return;
    root.focus();
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(root); r.collapse(false);
    sel?.removeAllRanges(); sel?.addRange(r);
  };

  // Detect an `@word` token immediately before the caret (anywhere in the text).
  const checkMention = React.useCallback(() => {
    if (!props.onMention) return;
    const root = elRef.current; const sel = window.getSelection();
    if (!root || !sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE || !root.contains(sel.anchorNode)) { props.onMention(null); return; }
    const before = (sel.anchorNode.nodeValue ?? '').slice(0, sel.anchorOffset);
    const m = before.match(MENTION_RE);
    props.onMention(m ? m[2].toLowerCase() : null);
  }, [props]);

  React.useImperativeHandle(ref, (): RichComposerHandle => ({
    focus: () => elRef.current?.focus(),
    clear: () => { const root = elRef.current; if (root) { root.innerHTML = ''; emit(); } },
    setText: (plain: string) => { const root = elRef.current; if (root) { root.textContent = plain; placeCaretEnd(); emit(); } },
    insertChips: (specs: ComposerChip[]) => insertNodes(specs.map(buildChip), true),
    getText: () => serialize(),
    applyMention: (spec: ComposerChip) => {
      const root = elRef.current; const sel = window.getSelection();
      if (!root || !sel || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) { insertNodes([buildChip(spec)], true); return; }
      const node = sel.anchorNode as Text; const off = sel.anchorOffset;
      const before = (node.nodeValue ?? '').slice(0, off);
      const m = before.match(MENTION_RE);
      if (!m) { insertNodes([buildChip(spec)], true); return; }
      const start = off - m[2].length - 1; // delete "@word" (the leading space, if any, stays)
      const r = document.createRange();
      r.setStart(node, Math.max(0, start)); r.setEnd(node, off); r.deleteContents();
      sel.removeAllRanges(); sel.addRange(r);
      insertNodes([buildChip(spec)], true);
    },
  }), [emit, serialize, checkMention]);

  // Remove a chip when its ✕ is clicked.
  const onClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('[data-rm]');
    if (btn) { e.preventDefault(); btn.closest('[data-chip]')?.remove(); emit(); elRef.current?.focus(); }
  };

  // Let the parent claim the paste (images → vision, long text → attachment); if it
  // didn't, insert plain text so the editor never accumulates pasted rich HTML.
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    props.onPaste?.(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) insertNodes([document.createTextNode(text)], false);
  };

  return (
    <div style={{ position: 'relative', flex: '1 1 140px', minWidth: 120 }}>
      {empty && (
        <div aria-hidden style={{ position: 'absolute', left: 0, top: 6, right: 0, pointerEvents: 'none', color: 'var(--ink-tertiary)', font: '400 var(--fs-body)/1.5 var(--font-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.placeholder}</div>
      )}
      <div
        ref={elRef}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        spellCheck
        onInput={() => { emit(); checkMention(); }}
        onKeyUp={checkMention}
        onMouseUp={checkMention}
        onClick={onClick}
        onKeyDown={props.onKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; emit(); }}
        style={{ outline: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink)', font: '400 var(--fs-body)/1.5 var(--font-text)', padding: '6px 0', minHeight: 24, maxHeight: 150, overflowY: 'auto', ...props.style }}
      />
    </div>
  );
});
