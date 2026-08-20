/**
 * Knowledge Panel 路由聚合注册。
 *
 * 挂载：
 *   - /api/v1/knowledge/wiki/*        （wiki-routes）
 *   - /api/v1/knowledge/code-graph/*  （code-graph-routes）
 *   - /api/v1/knowledge/{type}/team-assets （list-routes）
 *
 * 注意：status-callback 和 allocate 路由已移除（依赖 MemoryProxy）。
 * 知识服务通过 MCP 协议接入，不再通过 proxy 转发。
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { registerKnowledgeWikiRoutes } from './wiki-routes.js';
import { registerKnowledgeCodeGraphRoutes } from './code-graph-routes.js';
import { registerKnowledgeListRoutes } from './list-routes.js';

export function registerKnowledgeRoutes(api: Hono, deps: PanelDeps): void {
  registerKnowledgeWikiRoutes(api, deps);
  registerKnowledgeCodeGraphRoutes(api, deps);
  registerKnowledgeListRoutes(api, deps);
}
