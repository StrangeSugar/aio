/**
 * /api/v1/knowledge/agent-fixed
 *
 * 查询 Agent 绑定的知识资产（wiki + code-graph）。
 * 直接调用 KS 侧 /v3/knowledge/agent-fixed 端点。
 */

import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { buildCtx, readJson, str, okEnvelope, ASSET_TYPE_WIKI, ASSET_TYPE_CODE_GRAPH } from './common.js';

export function registerKnowledgeAgentFixedRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  api.post('/knowledge/agent-fixed', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    try {
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      const result = await kc.agentFixed(agentId);
      // KS 返回 { items: [...] }，直接透传
      const items = Array.isArray(result) ? result : (result as any)?.items ?? [];
      return respondEnvelope(c, okEnvelope(c, { items }));
    } catch (err) {
      return respondControlError(c, 502, 'UPSTREAM_ERROR');
    }
  });
}
