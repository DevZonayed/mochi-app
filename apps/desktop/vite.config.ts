import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // External = loaded from node_modules at runtime (all dynamically
        // imported), never bundled: the Claude Agent SDK (ESM, spawns `claude`),
        // playwright-core (drives system Chrome), and Baileys (large, dynamic-
        // require WhatsApp lib, lazy-imported in the provider's connect()).
        vite: { build: { rollupOptions: { external: ['@anthropic-ai/claude-agent-sdk', 'ws', 'playwright-core', '@whiskeysockets/baileys'] } } },
      },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
});
