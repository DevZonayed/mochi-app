import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Isolated vitest config for the Phase 3D1 cross-tier screen-view E2E. It wires the
 * REAL account/shadow server (Fastify + PostgreSQL) + the REAL ephemeral screen
 * relay (`/ws/host/screen`, `/ws/remote/screen`) + the REAL host stream coordinator
 * (MacOS/brain/shadow-screen-host.ts) + the REAL mobile stream client
 * (apps/mobile/src/shadowScreenClient.ts) over REAL WebSockets, with production
 * node:crypto X25519/HKDF/AES-GCM. A deterministic synthetic JPEG capture adapter
 * enters at the production capture-coordinator boundary. `@maestro/realtime` is
 * resolved to the workspace source exactly like every consumer.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 120_000,
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: /^@maestro\/realtime$/, replacement: fileURLToPath(new URL('../../packages/realtime/index.ts', import.meta.url)) },
      { find: /^@maestro\/realtime\/(.*)$/, replacement: fileURLToPath(new URL('../../packages/realtime/src/', import.meta.url)) + '$1.ts' },
    ],
  },
});
