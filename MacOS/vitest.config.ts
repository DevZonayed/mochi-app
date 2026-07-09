import { defineConfig } from 'vitest/config';

// The brain sources import each other with `.js` specifiers (NodeNext style)
// while the files are `.ts`. extensionAlias makes Vite/Vitest resolve `./x.js`
// to `x.ts`, so tests can import exactly like the source does.
export default defineConfig({
  test: {
    environment: 'node',
    // Renderer unit tests (renderer/**) are pure-logic modules and run fine
    // under node — keeping them here means `pnpm test` covers the whole app.
    include: ['brain/**/*.test.ts', 'renderer/**/*.test.ts', 'sidecar/**/*.test.ts'],
  },
  resolve: {
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
});
