import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // The Claude Agent SDK is ESM + spawns the `claude` binary — keep it
        // external so it loads from node_modules at runtime (dynamic import).
        // Baileys is a large, dynamic-require WhatsApp lib (lazy-imported inside
        // the provider's connect()) — keep it external too, loaded at runtime.
        vite: { build: { rollupOptions: { external: ['@anthropic-ai/claude-agent-sdk', 'ws', '@whiskeysockets/baileys'] } } },
      },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
});
