/* ChatHeader topbar wiring — locks in that the chat header surface (shared by
   ProjectDetail + Workspace via ChatThread) actually mounts <GitOpsDock /> as
   the SINGLE source of truth for git state. Without this, a refactor could
   silently revert to the pre-PR-#66 "scattered git surfaces" architecture
   and the operator's "No changes" pill complaint would reappear.

   We can't render React in the existing electron-only vitest config (renderer
   tests aren't wired — see project memory `desktop-renderer-tests-not-wired`).
   So this file does a source-level assertion: ChatHeader's JSX must include
   <GitOpsDock /> with sessionId, and the Archive button must remain a
   sibling. Tight, hermetic, no DOM. */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.resolve(__dirname, './ProjectDetail.tsx'), 'utf8');

describe('ChatHeader topbar wiring (source-level)', () => {
  test('ChatHeader imports GitOpsDock from ../components/GitOpsDock', () => {
    expect(SRC).toMatch(/import\s+\{\s*GitOpsDock\s*\}\s+from\s+['"]\.\.\/components\/GitOpsDock['"]/);
  });

  test('ChatHeader renders <GitOpsDock sessionId={sessionId} … />', () => {
    // Pattern: inside the ChatHeader function body, find the GitOpsDock
    // JSX with the sessionId prop. This is the single source of truth for
    // git state in the chat header.
    const start = SRC.indexOf('function ChatHeader(');
    expect(start, 'function ChatHeader is defined in ProjectDetail.tsx').toBeGreaterThan(-1);
    // Look from ChatHeader's start to the next `function ` declaration.
    const after = SRC.slice(start);
    const end = after.indexOf('\nfunction ', 50); // skip the header itself
    const body = end > 0 ? after.slice(0, end) : after;
    expect(body).toMatch(/<GitOpsDock\b[^/]*\bsessionId=\{sessionId\}/);
  });

  test('ChatHeader keeps an Archive button alongside the dock (NOT removed)', () => {
    // The operator's screenshot showed "No changes" pill + "Archive" button.
    // The dock is the git surface; Archive is a session-lifecycle action and
    // belongs in the header (it's NOT the old git pill). Lock both in.
    const start = SRC.indexOf('function ChatHeader(');
    const after = SRC.slice(start);
    const end = after.indexOf('\nfunction ', 50);
    const body = end > 0 ? after.slice(0, end) : after;
    // Both signals: a title attribute mentioning Archive AND the "archive"
    // icon's name. Catches a removal or icon-rename in one shot.
    expect(body).toMatch(/title=\{[^}]*[Aa]rchive/);
    expect(body).toMatch(/Icon name=\{?['"]archive['"]/);
  });

  test('GitStatusBar is NOT imported anywhere — the dock is the only git surface', () => {
    // After PR #66, GitStatusBar was removed and the dock became the single
    // surface. If anyone reintroduces the old chip-style bar (e.g. as a
    // copy-paste from history), this test fails loudly.
    expect(SRC).not.toMatch(/import\s+\{\s*GitStatusBar\s*\}/);
    expect(SRC).not.toMatch(/<GitStatusBar\b/);
  });
});
