/**
 * Agent-Fixed Routes — 查询 Agent 绑定的知识资产（wiki + code-graph）。
 *
 * POST /agent-fixed
 *   body: { agent_id: string }
 *   header: x-tdai-service-id
 *   response: { items: Array<{ knowledge_id, asset_type, name, ... }> }
 */

import { Hono } from "hono";
import type { WikiService } from "../store/index.js";
import type { CodeGraphService } from "../store/index.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";

export interface AgentFixedRoutesArgs {
  wikiService: WikiService;
  cgService: CodeGraphService;
}

export function createAgentFixedRoutes({ wikiService, cgService }: AgentFixedRoutesArgs) {
  const app = new Hono();

  app.post("/agent-fixed", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    if (!agentId) {
      return c.json(wrapError(400, "agent_id is required"), 400);
    }

    const items: Array<{
      knowledge_id: string;
      asset_type: "llm_wiki" | "code_graph";
      name: string;
      description: string | null;
      status: string;
      visibility: string;
      agent_id: string;
      team_id: string;
      owner_user_id: string;
      internal_status: string | null;
      created_at: string;
      updated_at: string;
    }> = [];

    // 查询 wiki 绑定
    try {
      const wikis = wikiService.listWikisByAgent(serviceId, agentId);
      for (const w of wikis) {
        items.push({
          knowledge_id: w.wiki_id,
          asset_type: "llm_wiki",
          name: w.name,
          description: w.description ?? null,
          status: w.status,
          visibility: "team",
          agent_id: agentId,
          team_id: w.team_id,
          owner_user_id: w.owner_user_id ?? "",
          internal_status: w.internal_status ?? null,
          created_at: w.created_at,
          updated_at: w.updated_at,
        });
      }
    } catch {
      // 忽略查询错误
    }

    // 查询 code-graph 绑定
    try {
      const cgs = cgService.listCodeGraphsByAgent(serviceId, agentId);
      for (const cg of cgs) {
        items.push({
          knowledge_id: cg.code_graph_id,
          asset_type: "code_graph",
          name: cg.repo_name || cg.repo_url || cg.code_graph_id,
          description: null,
          status: cg.status,
          visibility: "team",
          agent_id: agentId,
          team_id: cg.team_id,
          owner_user_id: cg.owner_user_id ?? "",
          internal_status: cg.internal_status ?? null,
          created_at: cg.created_at,
          updated_at: cg.updated_at,
        });
      }
    } catch {
      // 忽略查询错误
    }

    return c.json(wrapOk({ items, total: items.length }));
  });

  return app;
}
