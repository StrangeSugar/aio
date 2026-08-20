import { serve } from '@hono/node-server';
import { loadPanelConfig } from './config/panel-config.js';
import { buildPanelApp } from './http/app.js';
import { buildPanelDeps } from './panel-deps.js';

export function main(): void {
  const config = loadPanelConfig();
  const deps = buildPanelDeps(config);
  const app = buildPanelApp(deps);

  serve(
    { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
    (info) => {
      deps.logger.info('panel listening', {
        url: `http://${config.server.host}:${info.port}`,
        mode: 'stateless',
        instancesConfig: config.metadataInstancesConfig,
      });
    },
  );

  const shutdown = (): void => {
    deps.logger.info('panel shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
