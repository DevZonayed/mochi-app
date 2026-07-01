import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import path from 'node:path';

/* Renderer DOM tests: components that render React to a DOM and want to assert
   on `render(<X />)` output / click handlers. Uses happy-dom (lighter than
   jsdom, fully W3C-spec compliant for what we test) and the existing
   `.js` → `.ts` extension alias so NodeNext-style imports work.

   React-version alias: this monorepo spans React 18 (desktop) and React 19
   (mobile, Expo SDK 54). With pnpm `node-linker=hoisted` the ROOT hoist is
   React 19 (mobile won), so `import React from 'react'` from a vitest worker
   would otherwise pick up React 19 hooks while @testing-library/react@14
   renders with its OWN nested React 18 — they don't share state and every
   `useState` call returns null. We resolve both `react` and `react-dom` to
   the React 18 copy testing-library shipped so the dialog and the renderer
   use the SAME React module.

   Why this lives next to vitest.config.ts (electron) and
   vitest.renderer.config.mjs (renderer pure modules) instead of merging:
   each suite needs a different environment + file glob; three configs keep
   the boundaries explicit + let any single suite run in isolation.

   Run: pnpm --filter desktop test:dom */
const require = createRequire(import.meta.url);
const react18Root = path.dirname(require.resolve('@testing-library/react/package.json'));
const react18 = path.join(react18Root, 'node_modules', 'react');
const reactDom18 = path.join(react18Root, 'node_modules', 'react-dom');

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['renderer/**/*.test.tsx'],
  },
  resolve: {
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    alias: [
      { find: /^react$/, replacement: react18 },
      { find: /^react\/jsx-runtime$/, replacement: path.join(react18, 'jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(react18, 'jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: reactDom18 },
      { find: /^react-dom\/client$/, replacement: path.join(reactDom18, 'client.js') },
      { find: /^react-dom\/test-utils$/, replacement: path.join(reactDom18, 'test-utils.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
});
