/**
 * /api/v1/knowledge/unbind
 *
 * 将 Wiki / CodeGraph 资产从 Agent 解绑。
 * 直接调用 KS 侧端点。
 */

import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { buildCtx, readJson, str, okEnvelope } from './common.js';

export function registerKnowledgeUnbindRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  api.post('/knowledge/unbind', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');

    try {
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      // 先尝试作为 wiki 解绑
      try {
        await kc.wikiUnbind(knowledgeId);
        return respondEnvelope(c, okEnvelope(c, { ok: true }));
      } catch {
        // 不是 wiki，尝试 code-graph
      }
      // 尝试作为 code-graph 解绑
      await kc.codeGraphUnbind(knowledgeId);
      return respondEnvelope(c, okEnvelope(c, { ok: true }));
    } catch (err) {
      return respondControlError(c, 502, 'UPSTREAM_ERROR');
    }
  });
}
