/**
 * stores/backend.ts — 全局后端数据 store（zustand）。
 *
 * 取代 backendStore.ts 里的模块级变量（_cachedTeams / _cachedAgentsMap / _inflightTeams …）。
 *
 * 核心设计：
 *   - teamsLoaded / agentsLoadedTeamIds：标记"已加载过"，
 *     避免每个组件挂载都重复 fetch。
 *   - invalidate()：写操作后调，清所有缓存 + 广播 BACKEND_REFRESH_EVENT。
 *   - invalidateTeam(teamId)：切 team 时只清当前 team 的 agents 缓存。
 *   - useTeams / useAgents：从 store 读数据 + 触发 fetch，多组件共享同一份状态。
 */

import { create } from 'zustand';
import { useEffect, useState } from 'react';
import {
  teamsApi,
  membersApi,
  agentsApi,
  type TeamMember as BackendMember,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import i18n from '@/i18n';
import { seedDisplayNameCache } from '@/services/user-profile-store';

// 从 backendStore.ts re-import 纯函数（adapters / types），避免循环依赖
import {
  type Team,
  type Agent,
  adaptTeam,
  adaptMember,
  adaptAgent,
  readActiveTeamId,
  writeActiveTeamId,
  ensureValidActiveTeamId,
} from '@/services/backendStore';

// ========================= 事件常量 =========================

const BACKEND_REFRESH_EVENT = 'tdai-memory.backend-refresh';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

function emitBackendRefresh() {
  try { window.dispatchEvent(new Event(BACKEND_REFRESH_EVENT)); } catch { /* ignore */ }
}

// ========================= Store 类型 =========================

interface BackendState {
  // 数据
  teams: Team[];
  activeTeamId: string | null;
  agentsByTeam: Record<string, Agent[]>;
  // loaded 标记（避免重复 fetch）
  teamsLoaded: boolean;
  teamsLoading: boolean;
  agentsLoadedTeamIds: Set<string>;
  // in-flight 去重
  inflightTeams: Promise<void> | null;
  inflightAgents: Record<string, Promise<Agent[]>>;

  // actions
  fetchTeams: () => Promise<void>;
  /** 强制重新拉取 team 列表（忽略 teamsLoaded 缓存，保留 in-flight 去重） */
  refreshTeams: () => Promise<void>;
  fetchAgents: (teamId: string) => Promise<Agent[]>;
  setActiveTeamId: (teamId: string | null) => void;
  invalidate: () => void;
  invalidateTeam: (teamId: string) => void;
  clearAll: () => void;
}

// ========================= Store 实现 =========================

export const useBackendStore = create<BackendState>((set, get) => ({
  teams: [],
  activeTeamId: readActiveTeamId(),
  agentsByTeam: {},
  teamsLoaded: false,
  teamsLoading: false,
  agentsLoadedTeamIds: new Set(),
  inflightTeams: null,
  inflightAgents: {},

  fetchTeams: async () => {
    const state = get();
    // 已加载过 → 不重复 fetch（只有 invalidate / clearAll 后才会重新拉）
    if (state.teamsLoaded) return;
    await get().refreshTeams();
  },

  refreshTeams: async () => {
    const state = get();
    // in-flight 去重：多个组件同时挂载时只发一次
    if (state.inflightTeams) { await state.inflightTeams; return; }

    const promise = (async () => {
      set({ teamsLoading: true });
      try {
        const backendTeams = await teamsApi.list();
        // 批量拉 members（N+1 → N，但这是后端 API 限制，无批量接口）
        const memberResults = await Promise.all(
          backendTeams.map((t) => membersApi.list(t.team_id).catch(() => [] as BackendMember[]))
        );
        const adapted = backendTeams.map((bt, i) =>
          adaptTeam(bt, memberResults[i].map(adaptMember))
        );
        seedDisplayNameCache(adapted.flatMap((t) => t.members));
        ensureValidActiveTeamId(adapted);
        set({
          teams: adapted,
          teamsLoaded: true,
          teamsLoading: false,
          activeTeamId: readActiveTeamId(),
        });
      } catch (err) {
        console.error('[backend store] refreshTeams failed:', err);
        set({ teamsLoading: false });
        tea.notify.error(i18n.t('backend.loadTeamsFailed'));
      } finally {
        set({ inflightTeams: null });
      }
    })();

    set({ inflightTeams: promise });
    await promise;
  },

  fetchAgents: async (teamId: string) => {
    const state = get();
    // 已加载过 → 直接返回缓存
    if (state.agentsLoadedTeamIds.has(teamId)) {
      return state.agentsByTeam[teamId] ?? [];
    }
    // in-flight 去重
    if (state.inflightAgents[teamId] != null) {
      return state.inflightAgents[teamId];
    }

    const promise = (async () => {
      try {
        const backendAgents = await agentsApi.list(teamId);
        const adapted = backendAgents.map((ba, i) => adaptAgent(ba, i));
        set((s) => ({
          agentsByTeam: { ...s.agentsByTeam, [teamId]: adapted },
          agentsLoadedTeamIds: new Set(s.agentsLoadedTeamIds).add(teamId),
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchAgents failed:', err);
        set((s) => ({
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadAgentsFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightAgents: { ...s.inflightAgents, [teamId]: promise } }));
    return promise;
  },

  setActiveTeamId: (teamId) => {
    writeActiveTeamId(teamId);
    set({ activeTeamId: teamId });
  },

  // 写操作后调：清所有缓存 + 广播刷新
  invalidate: () => {
    set({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
    });
    emitBackendRefresh();
  },

  // 切 team 时调：只清当前 team 的 agents 缓存
  invalidateTeam: (teamId) => {
    set((s) => {
      const agentsLoadedTeamIds = new Set(s.agentsLoadedTeamIds);
      agentsLoadedTeamIds.delete(teamId);
      const agentsByTeam = { ...s.agentsByTeam };
      delete agentsByTeam[teamId];
      return { agentsLoadedTeamIds, agentsByTeam };
    });
    emitBackendRefresh();
  },

  // 登出 / 401 时调：清所有缓存但不广播事件
  clearAll: () => {
    set({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
    });
  },
}));

// ========================= React Hooks =========================

/**
 * useTeams — 从 store 读 team 列表 + activeTeamId。
 *
 * 多个组件调 useTeams() 只会触发一次 fetchTeams（teamsLoaded 标记 + in-flight 去重）。
 * 写操作后调 invalidate() → teamsLoaded=false → 下次组件挂载/渲染时重新 fetch。
 * 切 team 通过 setActiveTeamId → 写 localStorage + 更新 state。
 */
export function useTeams(): {
  teams: Team[];
  activeTeamId: string | null;
  activeTeam: Team | null;
  loading: boolean;
} {
  const teams = useBackendStore((s) => s.teams);
  const teamsLoaded = useBackendStore((s) => s.teamsLoaded);
  const teamsLoading = useBackendStore((s) => s.teamsLoading);
  const activeTeamId = useBackendStore((s) => s.activeTeamId);
  const fetchTeams = useBackendStore((s) => s.fetchTeams);

  useEffect(() => {
    if (!teamsLoaded && !teamsLoading) {
      void fetchTeams();
    }
  }, [teamsLoaded, teamsLoading, fetchTeams]);

  // 监听 localStorage 变化（TeamSwitcher 写 activeTeamId 时触发）
  const [, force] = useState(0);
  useEffect(() => {
    const onLocalChange = () => {
      useBackendStore.setState({ activeTeamId: readActiveTeamId() });
      force((n) => n + 1);
    };
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    return () => window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  }, []);

  const activeTeam = teams.find((t) => t.team_id === activeTeamId) ?? null;
  return { teams, activeTeamId, activeTeam, loading: teamsLoading };
}

const EMPTY_AGENTS: Agent[] = [];

/**
 * useAgents — 从 store 读指定 team 的 agent 列表。
 *
 * 同一 teamId 多个组件调用只触发一次 fetch。
 * invalidate() 或 invalidateTeam(teamId) 后才会重新拉。
 */
export function useAgents(teamId: string | null | undefined): {
  agents: Agent[];
  loading: boolean;
} {
  // 用 ref 缓存上次的 teamId，避免 selector 每次返回不同引用
  const agents = useBackendStore((s) =>
    teamId ? (s.agentsByTeam[teamId] ?? EMPTY_AGENTS) : EMPTY_AGENTS
  );
  const loaded = useBackendStore((s) => (teamId ? s.agentsLoadedTeamIds.has(teamId) : true));
  const fetchAgents = useBackendStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!teamId) return;
    if (!loaded) {
      void fetchAgents(teamId);
    }
  }, [teamId, loaded, fetchAgents]);

  return { agents, loading: !!teamId && !loaded };
}

/**
 * readActiveTeamAgents — 同步读缓存的 agent 列表（不触发请求）。
 * 供 SkillsPanel 等仅需"引用列表"的场景使用。
 */
export function readActiveTeamAgents(teamId: string | null): Array<{ id: string; name: string }> {
  if (!teamId) return [];
  const cached = useBackendStore.getState().agentsByTeam[teamId];
  if (cached) return cached.map((a) => ({ id: a.agent_id, name: a.name }));
  // 缓存未命中：触发后台拉取
  void useBackendStore.getState().fetchAgents(teamId);
  return [];
}

// ========================= 导出 invalidate / clearAll（供 mutations 调用） =========================

export function invalidateBackendCache(): void {
  useBackendStore.getState().invalidate();
}

export function clearBackendCache(): void {
  useBackendStore.getState().clearAll();
}

export function invalidateTeamCache(teamId: string): void {
  useBackendStore.getState().invalidateTeam(teamId);
}
