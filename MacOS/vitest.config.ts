import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

// Resolve react/react-dom to ONE physical copy so RTL DOM tests and the renderer share a
// single React instance (RTL ships a nested copy; without this the hooks dispatcher is null).
const req = createRequire(import.meta.url);
// Resolve react/react-dom from RTL's OWN context so the renderer and RTL's render share
// the exact same physical copies (RTL ships nested ones; pinning to RTL's copies collapses
// the two-instance split that makes the hooks dispatcher null).
let single: (p: string) => string;
try {
  const rtlReq = createRequire(req.resolve('@testing-library/react/package.json'));
  single = (p: string) => rtlReq.resolve(p);
} catch {
  single = (p: string) => req.resolve(p);
}

// The brain sources import each other with `.js` specifiers (NodeNext style)
// while the files are `.ts`. extensionAlias makes Vite/Vitest resolve `./x.js`
// to `x.ts`, so tests can import exactly like the source does.
export default defineConfig({
  test: {
    environment: 'node',
    // Renderer *.test.ts are pure-logic modules and run fine under node. Renderer
    // *.dom.test.tsx are React-Testing-Library DOM tests (e.g. the ControllersPane
    // enrollment UI); they run under happy-dom via the per-glob environment below so
    // `pnpm test` covers the DOM behavior too. (The distinct `.dom.test.tsx` suffix
    // avoids collecting an unrelated pre-existing broken *.truthful-ui.test.tsx.)
    environmentMatchGlobs: [['**/*.test.tsx', 'happy-dom']],
    include: ['brain/**/*.test.ts', 'renderer/**/*.test.ts', 'renderer/**/*.dom.test.tsx', 'sidecar/**/*.test.ts', 'webview-app/**/*.test.ts'],
    // Inline RTL + react-dom so vite's react/react-dom aliases below apply to THEIR
    // imports too (collapsing RTL's nested react-dom onto the single app copy).
    server: { deps: { inline: [/@testing-library\//, /^react-dom/, /^react$/] } },
  },
  resolve: {
    extensionAlias: { '.js': ['.ts', '.js'] },
    // RTL ships a nested react/react-dom copy; pin every react/react-dom import (app AND
    // RTL) to a single physical copy so the DOM tests render with one React instance
    // (otherwise the hooks dispatcher is null → "Cannot read properties of null (useState)").
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: single('react') },
      { find: /^react\/jsx-runtime$/, replacement: single('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: single('react/jsx-dev-runtime') },
      { find: /^react-dom$/, replacement: single('react-dom') },
      { find: /^react-dom\/client$/, replacement: single('react-dom/client') },
      { find: /^react-dom\/test-utils$/, replacement: single('react-dom/test-utils') },
    ],
  },
});
