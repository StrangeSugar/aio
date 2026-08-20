/**
 * /api/v1/agent-overview/bootstrap
 *
 * 聚合团队资产总览 + 各 agent 挂载计数。
 * 数据源：skill/chat_memory 走 MemoryProxy asset/list，
 * code_graph/wiki 走 KS list 端点。
 */

import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import {
  buildCtx,
  readJson,
  str,
  okEnvelope,
  ASSET_TYPE_WIKI,
  ASSET_TYPE_CODE_GRAPH,
} from './knowledge/common.js';

/** 从 MemoryProxy asset/list 拉取指定类型资产 */
async function fetchAssetsFromCore(
  deps: PanelDeps,
  ctx: ReturnType<typeof buildCtx>,
  teamId: string,
  assetType: string,
): Promise<Array<{ asset_id: string; name: string; status: string; owner_user_id: string; asset_type: string }>> {
  try {
    const env = await deps.metaKernel.invoke(
      'asset/list',
      { team_id: teamId, asset_type: assetType, limit: 1000, offset: 0 },
      ctx,
    );
    const d = env.data as { items?: Array<{ asset_id: string; name: string; status: string; owner_user_id: string; asset_type: string }> } | null;
    return d?.items ?? [];
  } catch {
    return [];
  }
}

/** 从 KS 拉取团队资产 */
async function fetchKsAssets(
  deps: PanelDeps,
  ctx: ReturnType<typeof buildCtx>,
  teamId: string,
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<Array<{ id: string; name: string; status: string; owner_user_id: string }>> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  try {
    if (assetType === ASSET_TYPE_WIKI) {
      const res = await kc.wikiList(teamId);
      return res.items.map((w) => ({
        id: w.wiki_id,
        name: w.name,
        status: w.status,
        owner_user_id: w.owner_user_id ?? '',
      }));
    }
    const res = await kc.codeGraphList(teamId);
    return res.items.map((cg) => ({
      id: cg.code_graph_id,
      name: cg.repo_name || cg.repo_url || cg.code_graph_id,
      status: cg.status,
      owner_user_id: cg.owner_user_id ?? '',
    }));
  } catch {
    return [];
  }
}

/** 从 KS 拉取各 agent 的挂载计数 */
async function fetchAgentMountedCounts(
  deps: PanelDeps,
  ctx: ReturnType<typeof buildCtx>,
  agentIds: string[],
): Promise<Record<string, { skills: number; code_graph: number; llm_wiki: number; chat_memory: number }>> {
  const counts: Record<string, { skills: number; code_graph: number; llm_wiki: number; chat_memory: number }> = {};
  const kc = deps.knowledgeClientFactory(ctx.instanceId);

  for (const agentId of agentIds) {
    counts[agentId] = { skills: 0, code_graph: 0, llm_wiki: 0, chat_memory: 0 };
    try {
      const result = await kc.agentFixed(agentId);
      const items = Array.isArray(result) ? result : (result as any)?.items ?? [];
      for (const item of items) {
        if (item.asset_type === 'code_graph') counts[agentId].code_graph++;
        else if (item.asset_type === 'llm_wiki') counts[agentId].llm_wiki++;
      }
    } catch {
      // 忽略
    }
  }
  return counts;
}

export function registerAgentOverviewRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  api.post('/agent-overview/bootstrap', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    const agentIds = (body.agent_ids as string[]) ?? [];

    // 并行拉取所有资产
    const [skills, chatMemories, wikis, codeGraphs] = await Promise.all([
      fetchAssetsFromCore(deps, ctx, teamId, 'skill'),
      fetchAssetsFromCore(deps, ctx, teamId, 'chat_memory'),
      fetchKsAssets(deps, ctx, teamId, ASSET_TYPE_WIKI),
      fetchKsAssets(deps, ctx, teamId, ASSET_TYPE_CODE_GRAPH),
    ]);

    // 拉取各 agent 挂载计数
    const counts = await fetchAgentMountedCounts(deps, ctx, agentIds);

    // 补充 skill / chat_memory 计数（从 asset/list 按 owner_agent_id 统计）
    for (const agentId of agentIds) {
      if (!counts[agentId]) counts[agentId] = { skills: 0, code_graph: 0, llm_wiki: 0, chat_memory: 0 };
    }
    // skill 计数：从 skill 资产中按 owner_agent_id 统计
    for (const s of skills) {
      // skill 的 owner_agent_id 存储在 owner_user_id 字段（兼容旧数据）
      const agentId = s.owner_user_id;
      if (agentId && counts[agentId]) {
        counts[agentId].skills++;
      }
    }
    // chat_memory 计数：从 chat_memory 资产中按 owner_agent_id 统计
    for (const cm of chatMemories) {
      const agentId = cm.owner_user_id;
      if (agentId && counts[agentId]) {
        counts[agentId].chat_memory++;
      }
    }

    const payload = {
      assets: {
        skills: skills.map((s) => ({
          key: s.asset_id,
          title: s.name,
          group: 'skill',
          slug: s.asset_id,
          status: s.status,
        })),
        codeGraphs: codeGraphs.map((cg) => ({
          key: cg.id,
          title: cg.name,
          group: 'code_graph',
          slug: cg.id,
          status: cg.status,
        })),
        wikis: wikis.map((w) => ({
          key: w.id,
          title: w.name,
          group: 'llm_wiki',
          slug: w.id,
          status: w.status,
        })),
        chatMemories: chatMemories.map((cm) => ({
          key: cm.asset_id,
          title: cm.name,
          group: 'chat_memory',
          slug: cm.asset_id,
          status: cm.status,
        })),
      },
      counts,
    };

    return respondEnvelope(c, okEnvelope(c, payload));
  });
}
