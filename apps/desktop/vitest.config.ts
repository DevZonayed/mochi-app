import { defineConfig } from 'vitest/config';

// The electron sources import each other with `.js` specifiers (NodeNext style)
// while the files are `.ts`. extensionAlias makes Vite/Vitest resolve `./x.js`
// to `x.ts`, so tests can import exactly like the source does.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts'],
  },
  resolve: {
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
});
