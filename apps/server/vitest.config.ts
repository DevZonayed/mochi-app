import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB-backed suites share one Postgres; run files sequentially so concurrent
    // migrations don't race on DDL (Postgres errors on concurrent CREATE INDEX
    // IF NOT EXISTS for the same table).
    fileParallelism: false,
  },
});
