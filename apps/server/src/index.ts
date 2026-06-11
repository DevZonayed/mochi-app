import { buildServer } from './server.js';

const app = buildServer();
const port = Number(process.env.PORT || 8080);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`maestro-relay listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
