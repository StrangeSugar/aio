import { createApp } from './dist/server.mjs';
import { serve } from '@hono/node-server';
import { createLogger } from './dist/logger.js';

const log = createLogger('runner');

const { app, config, knowledgeTelemetry } = createApp();
await knowledgeTelemetry.initialize();

log.info(`Starting knowledge service on port ${config.port}`);
log.info(`Data dir: ${config.dataDir}`);
log.info(`DB path: ${config.dbPath}`);
log.info(`API prefix: ${config.apiPrefix}`);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(`Knowledge service listening on http://localhost:${info.port}`);
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down`);
  await knowledgeTelemetry.shutdown();
  server.close(() => process.exit(0));
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
