import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { requestLogger } from './middleware/request-logger.js';
import type { PanelDeps } from '../panel-deps.js';
import { registerHealthRoutes, registerMetaInstanceRoutes } from './routes/meta/instances.js';
import { registerMetaProxyRoutes } from './routes/meta/proxy.js';
import { registerKnowledgeRoutes } from './routes/knowledge/index.js';
import { registerAgentOverviewRoutes } from './routes/agent-overview-routes.js';

const API_PREFIX = '/api/v1';

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  registerHealthRoutes(app);

  const api = new Hono();
  registerMetaInstanceRoutes(api, deps);
  // Meta 代理路由：team/user/agent 元数据管理（直连 MemoryProxy）
  registerMetaProxyRoutes(api, deps);
  // Knowledge 路由：wiki + code-graph（文档 + 代码库能力）
  registerKnowledgeRoutes(api, deps);
  // Agent 总览路由：团队资产聚合 + 各 agent 挂载计数
  registerAgentOverviewRoutes(api, deps);
  app.route(API_PREFIX, api);

  app.onError((err, c) => {
    deps.logger.error('panel unhandled error', {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      { code: 500, message: 'INTERNAL', request_id: c.get('reqId') ?? '', data: null },
      500,
    );
  });

  const distDir = deps.config.ui.distDir;
  app.use('/*', serveStatic({ root: distDir }));
  app.get('*', (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/') || p === '/health') return next();
    return serveStatic({ path: path.join(distDir, 'index.html') })(c, next);
  });

  return app;
}
