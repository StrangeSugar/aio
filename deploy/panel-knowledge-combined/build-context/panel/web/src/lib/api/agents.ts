/**
 * api/agents.ts — Agent 管理（meta/agent/* + meta/agent-fixed-asset/*）。
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Agent, AssetType, AssetStatus, FixedAssetBinding } from './types';

export const agentsApi = {
  /**
   * 列出 team 下的 agents。
   *
   * @param teamId team ID
   * @param params.owner_user_id 可选：只返该 user owner 的 agent（"agent 私有可见性"场景，
   *   如 Skill 面板固定资产 tab）；不传则返 team 全量。`agent/list` 支持
   *   `team_id + owner_user_id` 组合过滤。
   */
  list: (teamId: string, params?: { owner_user_id?: string }) =>
    metaListAll<Agent>('agent/list', {
      team_id: teamId,
      status: 'active',
      owner_user_id: params?.owner_user_id,
    }),

  /** agent 详情 */
  get: (agentId: string) => metaPost<Agent>('agent/get', { agent_id: agentId }),

  /** 创建 agent */
  create: async (
    teamId: string,
    data: { name: string; description?: string; prompt?: string; visibility?: string }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Agent>('agent/create', {
      team_id: teamId,
      owner_user_id: me.user_id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      visibility: data.visibility ?? 'team',
    });
  },

  /**
   * 更新 agent。
   *
   * `metadata_json` 是给前端自定义关系的兜底通道：后端 schema 未落地的展示字段
   * （如 icon / accent / 关联 user 等 UI-only 字段）可以序列化进这里的自定义 namespace。
   */
  update: (
    agentId: string,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      visibility?: string;
      status?: string;
      metadata_json?: string;
    }
  ) => metaPost<Agent>('agent/update', { agent_id: agentId, ...data }),

  /**
   * 删除 agent：直接调 meta/agent/archive（MCP 版不再级联清理 skill）。
   *
   * 注意：已移除 agent-delete-cascade 路由（依赖 MemoryProxy）。
   */
  delete: async (agentId: string) => {
    return metaPost<{ archived: boolean; agent_id: string }>('agent/archive', { agent_id: agentId });
  },

  /** 获取 agent 的资产聚合视图（binding + asset 详情）。
   *  用 metaListAll 翻页拉全量（list-with-detail 默认 limit 20，绑定资产一多会被截断）。
   *
   *  applyVisibilityFilter：默认 true（屏蔽已私密的绑定，用于普通展示）。
   *  owner 视角管理自己的资产时应传 false —— 否则自己 owner 的 private 资产
   *  会被接口过滤掉，导致 fixed tab 拿不到它的 visibility、共享/私密切换按钮消失。 */
  getAssets: async (agentId: string, applyVisibilityFilter = true) => {
    const items = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      name: string;
      description?: string;
      status: AssetStatus;
      visibility: string;
      injection_mode: FixedAssetBinding['injection_mode'];
      priority: number;
      created_at: string;
    }>('agent-fixed-asset/list-with-detail', {
      agent_id: agentId,
      apply_visibility_filter: applyVisibilityFilter,
      touch_usage: false,
    });
    return items.map((item) => ({
      asset_id: item.asset_id,
      asset_type: item.asset_type,
      name: item.name,
      description: item.description,
      status: item.status,
      visibility: item.visibility,
      injection_mode: item.injection_mode ?? 'direct',
      priority: item.priority,
      created_at: item.created_at,
    }));
  },

  /** 获取 agent 固定资产 binding（仅 binding 字段） */
  getFixedAssets: async (agentId: string) => {
    const rows = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      injection_mode?: FixedAssetBinding['injection_mode'];
      priority: number;
    }>('agent-fixed-asset/list', { agent_id: agentId });
    return rows.map((r) => ({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      injection_mode: r.injection_mode,
      priority: r.priority,
    }));
  },

  /** 全量设置 agent 固定资产 */
  setFixedAssets: async (agentId: string, bindings: FixedAssetBinding[]) => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('agent-fixed-asset/set', {
      agent_id: agentId,
      bindings: bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 0,
        created_by: me.user_id,
      })),
    });
  },
};
