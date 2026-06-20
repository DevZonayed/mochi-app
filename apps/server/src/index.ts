/* Production entrypoint — the account multi-tenant server (Better Auth + Postgres
   + Redis). Runs migrations (device table + Better Auth schema, both idempotent)
   before listening. Requires DATABASE_URL + REDIS_URL + BETTER_AUTH_SECRET. */
import { buildAccountServer, migrateAll } from './accountServer.js';

const port = Number(process.env.PORT || 8080);

async function main(): Promise<void> {
  await migrateAll();
  const app = buildAccountServer();
  await app.listen({ port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`maestro account server listening on :${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('maestro account server failed to start:', err);
  process.exit(1);
});
