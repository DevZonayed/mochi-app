import { openDb } from './db.js';
import { Repositories } from './repositories.js';
import { EchoEngine } from './engine.js';
import { seedIfEmpty } from './seed.js';
import { buildServer } from './server.js';

const db = openDb();
const repos = new Repositories(db);
const engine = new EchoEngine();
seedIfEmpty(repos);

const app = buildServer(repos, engine);
const port = Number(process.env.PORT || 8080);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`maestro-server listening on :${port} (engine=${engine.id})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
