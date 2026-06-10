// Web-only Vite config — serves the desktop RENDERER in a browser (no Electron),
// for previewing / design-QA. Production uses vite.config.ts (with electron).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
});
