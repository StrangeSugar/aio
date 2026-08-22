import type { Hono } from 'hono';
import type { MetaAction } from '../../../api/meta-actions.js';
import {
  ALLOWED_PANEL_ACTIONS,
  isNotInScopeAction,
} from '../../../api/meta-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import { DomainError } from '../../../domain/errors.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import type { MetaEnvelope } from '../../../kernel/envelope.js';

/**
 * 从请求路径中解析 meta action。
 */
function readAction(path: string): string {
  const marker = '/meta/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

// ── 路由注册 ──

export function registerMetaProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/meta/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    if (isNotInScopeAction(action)) {
      return respondControlError(c, 501, 'NOT_IN_SCOPE');
    }

    if (!ALLOWED_PANEL_ACTIONS.has(action as MetaAction)) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    let envelope: MetaEnvelope<unknown>;
    try {
      envelope = await deps.metaKernel.invoke(action, body, ctx);
    } catch (err) {
      // 下游错误（如无效 user_key → 401）须原样透传，否则全局 onError 会吞成 500。
      if (err instanceof DomainError) {
        return respondControlError(c, err.httpStatus, err.message || err.code);
      }
      throw err;
    }
    return respondEnvelope(c, envelope);
  });
}
