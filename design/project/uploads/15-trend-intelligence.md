# Desktop · Page 15 — Trend & Research Intelligence

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Genre/trend research that produces **content briefs** feeding the studio: trending audio, best-time-to-post, hooks/titles/thumbnail concepts. Indigo accent zone.

## Layout
- **Header:** "Trends", genre/topic context picker (chip with chevron, e.g. "Tech explainers · YouTube"), refresh timestamp, and a "Run research now" pill (it's an agent job).
- **Top row — signal cards (4 across):** Trending topics (ranked list with momentum arrows ▲▼ in green/red), Trending audio (rows with play buttons + "used in 12k posts"), Best times to post (mini week-heatmap, blue intensity), Competitor pulse (sparkline card).
- **Main — Brief feed:** generated content briefs as rich cards: brief title (Headline), hook line in quotes (display treatment, slightly larger, the one expressive type moment on this page), 3 suggested titles as selectable rows, thumbnail concepts as small AI-sketch placeholders, target platform chips, confidence chip, and two pills: **Send to Studio** (teal, hands off to Page 13 pre-filled) and **Schedule series** (creates jobs).
- **Right rail:** research run history (each row links to its session transcript), source health rows ("Official APIs ✓", scraper source flagged with amber "Risk-flagged · isolated").

## States
Research running: brief feed shows a live card with streaming bullet points appearing. Stale data (>24h): grey timestamp turns amber with a quiet refresh nudge. Empty: "Hand Maestro a genre. It returns briefs, not links."

## Micro-interactions
Momentum arrows tick on refresh. "Send to Studio" performs a card fly-out toward the sidebar Studio item.
