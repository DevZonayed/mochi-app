import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['renderer/**/*.test.ts'] },
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
});
