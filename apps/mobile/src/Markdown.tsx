import React, { useEffect, useRef, useState } from 'react';
import { Linking, Text, TextStyle, View } from 'react-native';
import { useTheme } from './theme';

/* Dependency-free Markdown renderer for chat bodies — the mobile counterpart
   to the desktop's renderChatBody (ProjectDetail.tsx). The agent replies in
   Markdown (**bold**, *italic*, `code`, [links](url), ~~strike~~, `- ` bullets,
   `1.` lists, `>` quotes, `---` rules, headings, ```fences```), and rendering
   it raw was making mobile show literal asterisks/backticks. This parses the
   same subset the desktop does so the two match.

   Also exports `StreamingMarkdown` — a typewriter wrapper that reveals new
   chars at a steady, adaptive cadence (mirrors desktop's `StreamingBody`),
   so streamed chunks feel like a stream instead of stuttery half-second
   blocks. Mount it for the ONE live, growing text block; everything settled
   should render with the cheap `Markdown` directly. */

/* ── Inline parser (bold / italic / code / strike / link) ──────────────── */

type InlineKind = 'text' | 'bold' | 'italic' | 'code' | 'strike' | 'link';
interface Inline { t: InlineKind; v: string; href?: string }

// Order matters in the alternation: bigger/stronger markers FIRST so that a
// `**bold**` doesn't get mis-tokenized as two `*italic*` halves, and a
// `[text](url)` link beats a stray `*` inside its label. We deliberately
// SKIP `_underscore_` italics — snake_case identifiers (CONSTANT_NAME, etc.)
// are common in chat about code, and pretending each one is an emphasis run
// makes prose fragment in ugly ways. `*italic*` is enough.
const INLINE_RE = new RegExp(
  [
    '(`[^`\\n]+`)',                                 // `inline code`
    '(\\[[^\\[\\]\\n]+\\]\\([^\\s()]+\\))',         // [text](url)
    '(\\*\\*[^*\\n]+\\*\\*)',                       // **bold**
    '(~~[^~\\n]+~~)',                               // ~~strikethrough~~
    '(\\*[^*\\s][^*\\n]*[^*\\s]\\*|\\*[^*\\s]\\*)', // *italic*
  ].join('|'),
  'g',
);

function tokenizeInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    const seg = m[0];
    if (m[1]) {
      out.push({ t: 'code', v: seg.slice(1, -1) });
    } else if (m[2]) {
      const close = seg.indexOf('](');
      out.push({ t: 'link', v: seg.slice(1, close), href: seg.slice(close + 2, -1) });
    } else if (m[3]) {
      out.push({ t: 'bold', v: seg.slice(2, -2) });
    } else if (m[4]) {
      out.push({ t: 'strike', v: seg.slice(2, -2) });
    } else if (m[5]) {
      out.push({ t: 'italic', v: seg.slice(1, -1) });
    }
    last = INLINE_RE.lastIndex;
    if (m.index === INLINE_RE.lastIndex) INLINE_RE.lastIndex++; // zero-width safety
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** Inline tokens → nested <Text> children. Renders inside a parent <Text>. */
function InlineText({ text, base }: { text: string; base: string }) {
  const { theme } = useTheme();
  return (
    <>
      {tokenizeInline(text).map((tok, i) => {
        const k = `${base}-${i}`;
        if (tok.t === 'bold') return <Text key={k} style={{ fontWeight: '700' }}>{tok.v}</Text>;
        if (tok.t === 'italic') return <Text key={k} style={{ fontStyle: 'italic' }}>{tok.v}</Text>;
        if (tok.t === 'strike') return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{tok.v}</Text>;
        if (tok.t === 'code') {
          return (
            <Text
              key={k}
              style={{ fontFamily: theme.fontFamily.mono, fontSize: 14, backgroundColor: theme.color.fillTertiary }}
            >
              {tok.v}
            </Text>
          );
        }
        if (tok.t === 'link') {
          const href = tok.href || '';
          return (
            <Text
              key={k}
              onPress={href ? () => { void Linking.openURL(href).catch(() => {}); } : undefined}
              style={{ color: theme.color.blue, textDecorationLine: 'underline' }}
            >
              {tok.v}
            </Text>
          );
        }
        return <Text key={k}>{tok.v}</Text>;
      })}
    </>
  );
}

/* ── Block parser (headings, lists, quotes, hr, fenced code, paragraphs) ─ */

interface MarkdownProps {
  text: string;
  color?: string;
  /** Base font size for prose; everything else scales from this. */
  size?: number;
  /** Optional caret rendered at the very end (live streaming indicator). */
  caret?: boolean;
}

/** Render a Markdown chat body as React Native views. `color` sets prose color
    (defaults to primary ink); pass a dimmer color for thinking blocks. */
export function Markdown({ text, color, size = 16, caret }: MarkdownProps) {
  const { theme } = useTheme();
  const ink = color ?? theme.color.ink;
  const lineHeight = Math.round(size * 1.5);
  const blocks: React.ReactNode[] = [];
  let key = 0;

  // Split off ``` fenced code blocks first; everything else is prose.
  // Capture the language tag so `lang` chips render the right hint.
  const segments: { code: boolean; lang: string; body: string }[] = [];
  {
    const fenceRe = /```([a-zA-Z0-9_+-]*)\n?/g;
    let idx = 0;
    let inCode = false;
    let lang = '';
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text))) {
      const chunk = text.slice(idx, m.index);
      segments.push({ code: inCode, lang, body: chunk });
      if (!inCode) lang = m[1] || '';
      inCode = !inCode;
      idx = m.index + m[0].length;
    }
    segments.push({ code: inCode, lang, body: text.slice(idx) });
  }

  segments.forEach((seg) => {
    if (!seg.body) return;
    if (seg.code) {
      // Don't trim leading/trailing newlines inside fences — they're meaningful.
      const code = seg.body.replace(/\n$/, '');
      if (!code) return;
      blocks.push(
        <View
          key={`code-${key++}`}
          style={{ marginVertical: 6, padding: 12, borderRadius: 10, backgroundColor: theme.color.fillTertiary }}
        >
          {seg.lang ? (
            <Text
              style={{ fontSize: 10, fontFamily: theme.fontFamily.mono, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: theme.color.inkTertiary, marginBottom: 6 }}
            >
              {seg.lang}
            </Text>
          ) : null}
          <Text style={{ fontFamily: theme.fontFamily.mono, fontSize: 13, lineHeight: 19, color: ink }}>
            {code}
          </Text>
        </View>,
      );
      return;
    }
    if (!seg.body.trim()) return;
    renderProse(seg.body).forEach((b) => blocks.push(b));
  });

  // Tack the caret onto the last block so it sits flush with the streaming text
  // instead of jumping to its own row.
  if (caret) blocks.push(<Caret key="caret" color={theme.color.purple} />);

  function renderProse(prose: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    const lines = prose.split('\n');
    let para: string[] = [];
    let quote: string[] = [];

    const flushPara = () => {
      if (!para.length) return;
      const joined = para.join('\n');
      out.push(
        <Text key={`p-${key++}`} style={{ fontSize: size, lineHeight, color: ink }}>
          <InlineText text={joined} base={`p${key}`} />
        </Text>,
      );
      para = [];
    };
    const flushQuote = () => {
      if (!quote.length) return;
      const joined = quote.join('\n');
      out.push(
        <View key={`q-${key++}`} style={{ flexDirection: 'row', paddingVertical: 2 }}>
          <View style={{ width: 3, borderRadius: 2, backgroundColor: theme.color.purple + '66', marginRight: 10 }} />
          <Text style={{ flex: 1, fontSize: size, lineHeight, fontStyle: 'italic', color: theme.color.inkSecondary }}>
            <InlineText text={joined} base={`q${key}`} />
          </Text>
        </View>,
      );
      quote = [];
    };
    const flushAll = () => { flushPara(); flushQuote(); };

    for (const rawLine of lines) {
      const line = rawLine;
      const isHr = /^\s{0,3}([-*_])\1{2,}\s*$/.test(line);
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const ol = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      const bq = line.match(/^\s*>\s?(.*)$/);

      if (isHr) {
        flushAll();
        out.push(
          <View
            key={`hr-${key++}`}
            style={{ height: 1, marginVertical: 10, backgroundColor: theme.color.separator }}
          />,
        );
        continue;
      }
      if (bq) {
        flushPara();
        quote.push(bq[1]);
        continue;
      }
      if (h) {
        flushAll();
        const lvl = h[1].length;
        const fs = lvl <= 1 ? size + 4 : lvl === 2 ? size + 2 : size + 1;
        out.push(
          <Text
            key={`h-${key++}`}
            style={{ fontSize: fs, lineHeight: Math.round(fs * 1.3), fontWeight: '700', color: theme.color.ink, marginTop: 8, marginBottom: 2 }}
          >
            <InlineText text={h[2]} base={`h${key}`} />
          </Text>,
        );
        continue;
      }
      if (ol) {
        flushAll();
        out.push(
          <ListRow key={`ol-${key++}`} marker={`${ol[1]}.`} text={ol[2]} ink={ink} size={size} lineHeight={lineHeight} mono base={`ol${key}`} />,
        );
        continue;
      }
      if (li) {
        flushAll();
        out.push(
          <ListRow key={`li-${key++}`} marker="•" text={li[1]} ink={ink} size={size} lineHeight={lineHeight} base={`li${key}`} />,
        );
        continue;
      }
      if (!line.trim()) {
        flushAll();
        continue;
      }
      // Switching mid-paragraph from quote → prose flushes the quote first.
      if (quote.length) flushQuote();
      para.push(line);
    }
    flushAll();
    return out;
  }

  return <View style={{ gap: 5 }}>{blocks}</View>;
}

function ListRow({
  marker,
  text,
  ink,
  size,
  lineHeight,
  mono,
  base,
}: {
  marker: string;
  text: string;
  ink: string;
  size: number;
  lineHeight: number;
  mono?: boolean;
  base: string;
}) {
  const { theme } = useTheme();
  const markerStyle: TextStyle = {
    color: theme.color.inkTertiary,
    fontSize: mono ? size - 2 : size,
    lineHeight,
    minWidth: mono ? 18 : undefined,
    textAlign: mono ? 'right' : undefined,
    fontFamily: mono ? theme.fontFamily.mono : undefined,
  };
  return (
    <View style={{ flexDirection: 'row', gap: 8, paddingLeft: 2 }}>
      <Text style={markerStyle}>{marker}</Text>
      <Text style={{ flex: 1, fontSize: size, lineHeight, color: ink }}>
        <InlineText text={text} base={base} />
      </Text>
    </View>
  );
}

/* ── Live streaming wrapper ───────────────────────────────────────────────
   Mirrors apps/desktop/src/screens/ProjectDetail.tsx's `StreamingBody`. The
   Claude Agent SDK (and Codex more so) hands us text in coarse ~70-char
   bursts every 0.4–0.7 s, not token-by-token — so a faithful render steps
   in half-second jumps that read as "updates every second", not a stream.
   This types the buffered text out at a steady, adaptive cadence: each frame
   we reveal a few more chars, draining the current backlog over ~0.45 s,
   with a lively floor and a bound on how far we ever fall behind. Settled
   turns render with `Markdown` directly. */

const STREAM_MIN_CPS = 60;     // chars/sec floor — keep it alive on a trickle
const STREAM_MAX_CPS = 900;    // ceiling so big blocks don't machine-gun the phone
const STREAM_DRAIN_S = 0.45;   // aim to empty the current backlog this fast
const STREAM_MAX_LAG = 1500;   // never trail the buffer by more than this (chars)

export function StreamingMarkdown({
  text,
  live,
  color,
  size,
}: { text: string; live: boolean; color?: string; size?: number }) {
  // Start at the current text length so a remount (navigating back into a
  // chat that's mid-stream) doesn't re-type from zero — only NEW chars animate.
  const [shownLen, setShownLen] = useState<number>(text.length);
  const shownRef = useRef(text.length);
  const targetRef = useRef(text.length);
  targetRef.current = text.length; // refreshed every render → no rAF re-subscribe

  useEffect(() => {
    // Settled: snap to full, no rAF needed.
    if (!live) {
      shownRef.current = targetRef.current;
      setShownLen(targetRef.current);
      return;
    }
    let raf: number | null = null;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(64, now - last);
      last = now;
      const target = targetRef.current;
      let cur = shownRef.current;
      // text shrank (re-render with a fresh, shorter string) — resync.
      if (cur > target) cur = target;
      if (cur < target) {
        let backlog = target - cur;
        if (backlog > STREAM_MAX_LAG) { cur = target - STREAM_MAX_LAG; backlog = STREAM_MAX_LAG; }
        const cps = Math.min(STREAM_MAX_CPS, Math.max(STREAM_MIN_CPS, backlog / STREAM_DRAIN_S));
        const add = Math.max(1, Math.ceil((cps * dt) / 1000));
        cur = Math.min(target, cur + add);
        shownRef.current = cur;
        setShownLen(cur);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf != null) cancelAnimationFrame(raf); };
  }, [live]);

  // While live AND still catching up, show the caret. Once fully drained the
  // caret hides on its own — the answer feels finished instead of "still going".
  const showCaret = live && shownLen < text.length;
  return <Markdown text={text.slice(0, shownLen)} color={color} size={size} caret={showCaret} />;
}

/* Small blinking block caret rendered inline with the streaming text. Uses a
   loop of setIntervals (not Animated) so it remains visible on Android low-end
   devices where reanimated isn't installed in this app. */
function Caret({ color }: { color: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 520);
    return () => clearInterval(id);
  }, []);
  return (
    <View
      style={{
        marginTop: 2,
        width: 8,
        height: 14,
        borderRadius: 1.5,
        backgroundColor: color,
        opacity: on ? 0.85 : 0.15,
      }}
    />
  );
}
