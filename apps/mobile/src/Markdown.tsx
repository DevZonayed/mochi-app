import React from 'react';
import { View, Text, TextStyle } from 'react-native';
import { useTheme } from './theme';

/* A small, dependency-free Markdown renderer for chat bodies — the mobile
   counterpart to the desktop's renderChatBody (ProjectDetail.tsx). The agent
   replies in Markdown (**bold** labels, `- ` bullets, `1.` lists, headings,
   ```fences```), and rendering it raw was making mobile show literal asterisks
   and dashes. This parses the same subset the desktop does so the two match. */

type Inline = { t: 'text' | 'bold' | 'code'; v: string };

/** Tokenize one line of inline Markdown: **bold** and `code`; rest is plain. */
function tokenizeInline(text: string): Inline[] {
  const out: Inline[] = [];
  // Split on `code` or **bold**, keeping the delimiters via a capture group.
  for (const seg of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!seg) continue;
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      out.push({ t: 'code', v: seg.slice(1, -1) });
    } else if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
      out.push({ t: 'bold', v: seg.slice(2, -2) });
    } else {
      out.push({ t: 'text', v: seg });
    }
  }
  return out;
}

/** Inline tokens → nested <Text> children. Renders inside a parent <Text>. */
function InlineText({ text, base }: { text: string; base: string }) {
  const { theme } = useTheme();
  return (
    <>
      {tokenizeInline(text).map((tok, i) => {
        if (tok.t === 'bold') {
          return (
            <Text key={`${base}-${i}`} style={{ fontWeight: '700' }}>
              {tok.v}
            </Text>
          );
        }
        if (tok.t === 'code') {
          return (
            <Text
              key={`${base}-${i}`}
              style={{ fontFamily: theme.fontFamily.mono, fontSize: 14, backgroundColor: theme.color.fillTertiary }}
            >
              {tok.v}
            </Text>
          );
        }
        return <Text key={`${base}-${i}`}>{tok.v}</Text>;
      })}
    </>
  );
}

/** Render a Markdown chat body as React Native views. `color` sets prose color
    (defaults to primary ink); pass a dimmer color for thinking blocks. */
export function Markdown({ text, color, size = 16 }: { text: string; color?: string; size?: number }) {
  const { theme } = useTheme();
  const ink = color ?? theme.color.ink;
  const lineHeight = Math.round(size * 1.5);
  const blocks: React.ReactNode[] = [];
  let key = 0;

  // Split off ``` fenced code blocks first; everything else is prose.
  const parts = text.split(/```[a-zA-Z0-9_+-]*\n?/g);
  // Even indices are prose, odd indices are code (a fence toggles the mode).
  parts.forEach((part, pi) => {
    const isCode = pi % 2 === 1;
    if (!part.trim()) return;
    if (isCode) {
      blocks.push(
        <View
          key={`code-${key++}`}
          style={{ marginVertical: 6, padding: 12, borderRadius: 10, backgroundColor: theme.color.fillTertiary }}
        >
          <Text style={{ fontFamily: theme.fontFamily.mono, fontSize: 13, lineHeight: 19, color: ink }}>
            {part.replace(/\n$/, '')}
          </Text>
        </View>,
      );
      return;
    }
    renderProse(part).forEach((b) => blocks.push(b));
  });

  function renderProse(prose: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    const lines = prose.split('\n');
    let para: string[] = [];
    const flush = () => {
      if (!para.length) return;
      const joined = para.join('\n');
      out.push(
        <Text key={`p-${key++}`} style={{ fontSize: size, lineHeight, color: ink }}>
          <InlineText text={joined} base={`p${key}`} />
        </Text>,
      );
      para = [];
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const ol = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (h) {
        flush();
        const lvl = h[1].length;
        const fs = lvl <= 2 ? size + 2 : size + 1;
        out.push(
          <Text
            key={`h-${key++}`}
            style={{ fontSize: fs, lineHeight: Math.round(fs * 1.3), fontWeight: '700', color: theme.color.ink, marginTop: 8, marginBottom: 2 }}
          >
            <InlineText text={h[2]} base={`h${key}`} />
          </Text>,
        );
      } else if (ol) {
        flush();
        out.push(
          <ListRow key={`ol-${key++}`} marker={`${ol[1]}.`} text={ol[2]} ink={ink} size={size} lineHeight={lineHeight} mono base={`ol${key}`} />,
        );
      } else if (li) {
        flush();
        out.push(
          <ListRow key={`li-${key++}`} marker="•" text={li[1]} ink={ink} size={size} lineHeight={lineHeight} base={`li${key}`} />,
        );
      } else if (!line.trim()) {
        flush();
      } else {
        para.push(line);
      }
    }
    flush();
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
