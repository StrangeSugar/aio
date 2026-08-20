/**
 * /api/v1/knowledge/allocate
 *
 * 将 Wiki / CodeGraph 资产绑定到 Agent。
 * 直接调用 KS 侧端点。
 */

import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { buildCtx, readJson, str, okEnvelope } from './common.js';

export function registerKnowledgeAllocateRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  api.post('/knowledge/allocate', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const knowledgeId = str(body, 'knowledge_id');
    const agentId = str(body, 'agent_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    try {
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      // 先尝试作为 wiki 绑定
      try {
        await kc.wikiAllocate(teamId, knowledgeId, agentId);
        return respondEnvelope(c, okEnvelope(c, { ok: true }));
      } catch {
        // 不是 wiki，尝试 code-graph
      }
      // 尝试作为 code-graph 绑定
      await kc.codeGraphAllocate(teamId, knowledgeId, agentId);
      return respondEnvelope(c, okEnvelope(c, { ok: true }));
    } catch (err) {
      return respondControlError(c, 502, 'UPSTREAM_ERROR');
    }
  });
}
