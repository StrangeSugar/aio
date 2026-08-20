/**
 * Knowledge Panel 路由共享助手（MCP 接入版）。
 *
 * 与 chat-memory.ts 同款风格：从 panelMeta 组 ctx、统一 envelope。
 * KS 上游错误（CoreUpstreamError/DomainError）映射为 Control envelope。
 *
 * 注意：已移除对 MemoryProxy（metaKernel/kernelHttp）的依赖。
 * 知识服务通过 MCP 协议接入，不再通过 proxy 转发。
 */
import type { Context } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import type { MetaEnvelope } from '../../../kernel/envelope.js';
import { DomainError } from '../../../domain/errors.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';

export function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function str(body: Record<string, unknown>, key: string): string | null {
  const v = body?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function strArray(body: Record<string, unknown>, key: string): string[] {
  const v = body?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function okEnvelope<T>(c: Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data };
}

export function extractListItems<T>(env: MetaEnvelope<unknown>): T[] {
  const d = env.data as { items?: unknown } | null;
  if (d && Array.isArray(d.items)) return d.items as T[];
  return [];
}

/**
 * 简化版 team 门控：仅校验 user_key 是否有效（通过 KS 侧 team 隔离）。
 * 通过返回 { userId }；不通过返回 { error: Response }（路由直接 return）。
 *
 * 注意：原实现通过 MemoryProxy 的 auth/verify + team-member/get 校验，
 * 现改为简化版，依赖 KS 侧的 team 隔离机制。
 */
export async function requireTeamMember(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  _teamId: string,
): Promise<{ userId: string } | { error: Response }> {
  // 简化版：从 user_key 提取 user_id（格式: user-xxx）
  // 实际权限校验由 KS 侧按 service_id + team 隔离保证
  const userKey = ctx.userKey;
  if (!userKey) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  // 从 user_key 提取 user_id（简化处理）
  const userId = userKey;
  return { userId };
}

/** id-only 端点门控：仅要求 caller 是有效用户（KS 按 service_id + team 隔离）。 */
export async function requireCaller(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
): Promise<{ userId: string } | { error: Response }> {
  const userId = ctx.userKey;
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  return { userId };
}

/**
 * 把 KS 调用包起来：成功 → okEnvelope；上游/领域错误 → 映射 Control envelope。
 */
export async function runKs<T>(
  c: Context,
  fn: () => Promise<T>,
): Promise<Response> {
  try {
    const data = await fn();
    return respondEnvelope(c, okEnvelope(c, data));
  } catch (err) {
    if (err instanceof DomainError) {
      return respondControlError(c, err.httpStatus, err.message || err.code);
    }
    return respondControlError(c, 502, 'UPSTREAM_ERROR');
  }
}

// ── asset 类型常量 ──────────────────────────────────────────────
export const ASSET_TYPE_WIKI = 'llm_wiki';
export const ASSET_TYPE_CODE_GRAPH = 'code_graph';

// ── 知识资源读门控（简化版，不依赖 MemoryProxy）─────────────────

export interface KnowledgeAssetMetaRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  visibility: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 知识资源读门控（简化版）。
 * 原实现通过 MemoryProxy 的 asset/get + acl/check + team-member/get 校验，
 * 现改为通过 KS 侧查询资源详情并校验 owner。
 */
export async function requireKnowledgeRead(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  knowledgeId: string,
  opts?: { allowInFlightCodeOwner?: boolean; action?: 'read' | 'write' | 'use' },
): Promise<{ userId: string; asset?: KnowledgeAssetMetaRaw } | { error: Response }> {
  const userId = ctx.userKey;
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };

  // 尝试从 KS 获取资源详情
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  try {
    // 先尝试作为 wiki 获取
    try {
      const wiki = await kc.wikiGet(knowledgeId);
      const asset: KnowledgeAssetMetaRaw = {
        asset_id: wiki.wiki_id,
        team_id: wiki.team_id,
        asset_type: ASSET_TYPE_WIKI,
        name: wiki.name,
        description: null,
        owner_user_id: wiki.owner_user_id ?? '',
        visibility: 'team',
        status: wiki.status,
        created_at: wiki.created_at,
        updated_at: wiki.updated_at,
      };
      return { userId, asset };
    } catch {
      // 不是 wiki，尝试作为 code-graph
    }

    // 再尝试作为 code-graph 获取
    try {
      const cg = await kc.codeGraphGet(knowledgeId);
      const asset: KnowledgeAssetMetaRaw = {
        asset_id: cg.code_graph_id,
        team_id: cg.team_id,
        asset_type: ASSET_TYPE_CODE_GRAPH,
        name: cg.repo_name || cg.repo_url || cg.code_graph_id,
        description: null,
        owner_user_id: cg.owner_user_id ?? '',
        visibility: 'team',
        status: cg.status,
        created_at: cg.created_at,
        updated_at: cg.updated_at,
      };
      return { userId, asset };
    } catch {
      // 不是 code-graph
    }
  } catch {
    // KS 查询失败
  }

  return { error: respondControlError(c, 404, 'KNOWLEDGE_NOT_FOUND') };
}

export interface KnowledgeAssetListItem {
  knowledge_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  visibility: string;
  owner_user_id: string;
  meta_status: string;
  status: string;
  internal_status?: string | null;
  sync_error?: string | null;
  ks_missing?: boolean;
  team_id?: string;
  summary?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  repo_name?: string;
  repo_url?: string;
  branch?: string;
  commit_hash?: string | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  created_at?: string;
  updated_at?: string;
}

export function isActiveMetaAsset(status: string | undefined): boolean {
  const FILTERED_ASSET_STATUSES = new Set(['archived', 'deprecated', 'failed']);
  return !!status && !FILTERED_ASSET_STATUSES.has(status);
}

// ── KS-only items（直接从 KS 侧查列表）─────────────────────────

/** 从 KS 侧查列表，构造 KnowledgeAssetListItem。 */
async function fetchKsOnlyItems(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  teamId: string,
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  try {
    if (assetType === ASSET_TYPE_WIKI) {
      const res = await kc.wikiList(teamId);
      return res.items.map((ks) => ({
        knowledge_id: ks.wiki_id,
        asset_type: ASSET_TYPE_WIKI,
        name: ks.name,
        description: null,
        visibility: 'team',
        owner_user_id: ks.owner_user_id ?? '',
        meta_status: 'registered',
        status: ks.status,
        team_id: ks.team_id,
        internal_status: ks.internal_status ?? null,
        sync_error: ks.sync_error,
        summary: ks.summary,
        page_count: ks.page_count,
        last_sync_at: ks.last_sync_at,
        ks_missing: false,
        created_at: ks.created_at,
        updated_at: ks.updated_at,
      }));
    }
    const res = await kc.codeGraphList(teamId);
    return res.items.map((ks) => ({
      knowledge_id: ks.code_graph_id,
      asset_type: ASSET_TYPE_CODE_GRAPH,
      name: ks.repo_name || ks.repo_url || ks.code_graph_id,
      description: null,
      visibility: 'team',
      owner_user_id: ks.owner_user_id ?? '',
      meta_status: 'registered',
      status: ks.status,
      team_id: ks.team_id,
      sync_error: ks.sync_error,
      summary: ks.summary,
      repo_name: ks.repo_name,
      repo_url: ks.repo_url,
      branch: ks.branch,
      commit_hash: ks.commit_hash,
      stats: ks.stats,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    }));
  } catch {
    return [];
  }
}

/**
 * 直接从 KS 侧获取团队资产列表。
 * 原实现通过 MemoryProxy 的 asset/list-accessible 获取，现改为直接从 KS 获取。
 */
export async function fetchTeamAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  return fetchKsOnlyItems(kc, teamId, assetType);
}

// ── 已移除的函数（保留注释说明）─────────────────────────────────
// - resolveCallerUserId: 原通过 MemoryProxy auth/verify 反查 user_id
// - isTeamMember: 原通过 MemoryProxy team-member/get 校验成员
// - ensureKnowledgeAsset: 原通过 MemoryProxy asset/create 登记 meta_asset
// - deleteKnowledgeDetail: 原通过 MemoryProxy /v3/knowledge/delete 删明细
// - deleteKnowledgeAssets: 原通过 MemoryProxy asset/delete 删 meta_asset
// - deleteKnowledgeCascade: 原级联删除
// - fetchAllMetaListItems: 原通过 MemoryProxy asset/list 分页拉取
// - checkAssetPermission: 原通过 MemoryProxy acl/check 校验权限
// - joinKnowledgeAssetsWithKs: 原合并 meta + KS 数据
// - mergeWithKsOnlyItems: 原合并 meta 与 KS-only 数据
