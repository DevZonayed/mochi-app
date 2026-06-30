import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  // Dev-only: the account server (api.nexalance.cloud) returns CORS headers on
  // the OPTIONS preflight but NOT on the actual response, so a real browser
  // origin (http://localhost:5173) gets "Failed to fetch" on sign-in. The
  // packaged app is unaffected (file:// → no Origin → not a CORS request).
  // Proxy /api through the dev server so the renderer fetches same-origin and
  // the browser never does a CORS check. Pair with VITE_API_BASE in .env.
  server: {
    proxy: {
      '/api': {
        target: 'https://api.nexalance.cloud',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // The Claude Agent SDK is ESM + spawns the `claude` binary — keep it
        // external so it loads from node_modules at runtime (dynamically imported).
        vite: { build: { rollupOptions: { external: ['@anthropic-ai/claude-agent-sdk', 'ws', 'electron-updater'] } } },
      },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
});
