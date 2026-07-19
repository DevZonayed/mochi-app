import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Isolated vitest config for the Phase 3A2a cross-tier enrollment E2E. It wires
 * the REAL server (Fastify + PostgreSQL), the REAL desktop host runtime, and the
 * REAL Expo mobile runtime + ExpoSQLiteShadowStore (over a Node 24 node:sqlite
 * adapter). `expo-sqlite` is aliased to a throwing stub so the mobile module
 * resolves in Node without the native module — the store is driven by node:sqlite.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Each file stands up its OWN listening Fastify server and shares the single
    // disposable PostgreSQL DB, so files run sequentially (no parallel DB load).
    fileParallelism: false,
  },
  resolve: {
    // This harness is not a workspace member, so `@maestro/realtime` has no managed
    // node_modules link here. Resolve it (and its subpath exports) directly to the REAL
    // workspace package source — the exact same modules every workspace consumer uses,
    // mirroring the package's `exports` map (`.` → index.ts, `./x` → src/x.ts).
    alias: [
      { find: 'expo-sqlite', replacement: fileURLToPath(new URL('./expo-sqlite-stub.ts', import.meta.url)) },
      { find: /^@maestro\/realtime$/, replacement: fileURLToPath(new URL('../../packages/realtime/index.ts', import.meta.url)) },
      { find: /^@maestro\/realtime\/(.*)$/, replacement: fileURLToPath(new URL('../../packages/realtime/src/', import.meta.url)) + '$1.ts' },
    ],
  },
});
