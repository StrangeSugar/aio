/**
 * /api/v1/knowledge/wiki/team-assets
 * /api/v1/knowledge/code-graph/team-assets
 *
 * 团队池：直接从 KS 侧获取资产列表（不再通过 MemoryProxy）。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import {
  buildCtx,
  readJson,
  str,
  okEnvelope,
  requireTeamMember,
  fetchTeamAssets,
  ASSET_TYPE_WIKI,
  ASSET_TYPE_CODE_GRAPH,
} from './common.js';

function registerTeamAssets(
  api: Hono,
  deps: PanelDeps,
  path: string,
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): void {
  const mw = validatePanelMetaHeaders(deps);
  api.post(path, mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;

    const items = await fetchTeamAssets(deps, ctx, teamId, assetType);
    return respondEnvelope(c, okEnvelope(c, { items, total: items.length }));
  });
}

export function registerKnowledgeListRoutes(api: Hono, deps: PanelDeps): void {
  registerTeamAssets(api, deps, '/knowledge/wiki/team-assets', ASSET_TYPE_WIKI);
  registerTeamAssets(api, deps, '/knowledge/code-graph/team-assets', ASSET_TYPE_CODE_GRAPH);
}
