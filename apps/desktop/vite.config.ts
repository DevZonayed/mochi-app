import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // The Claude Agent SDK is ESM + spawns the `claude` binary, and
        // playwright-core drives the system Chrome — keep them external so they
        // load from node_modules at runtime (both are dynamically imported).
        vite: { build: { rollupOptions: { external: ['@anthropic-ai/claude-agent-sdk', 'ws', 'playwright-core', 'electron-updater'] } } },
      },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
});
