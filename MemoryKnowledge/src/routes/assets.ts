/**
 * Assets Routes — 列出团队下所有可用的知识资产（wiki + code-graph）。
 *
 * POST /assets/list
 *   header: x-tdai-service-id
 *   body: { kind?: "wiki" | "code_graph" | "all", limit?: number }
 *   response: { items: Array<{ id, name, type, status }> }
 */

import { Hono } from "hono";
import type { WikiService } from "../store/index.js";
import type { CodeGraphService } from "../store/index.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";

export interface AssetsRoutesArgs {
  wikiService: WikiService;
  cgService: CodeGraphService;
}

export function createAssetsRoutes({ wikiService, cgService }: AssetsRoutesArgs) {
  const app = new Hono();

  app.post("/assets/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }

    const kind = typeof body.kind === "string" ? body.kind : "all";
    const limit = typeof body.limit === "number" ? body.limit : 50;
    // team_id 从 body 获取；未传入时回落到 serviceId（兼容旧行为）
    const teamId = typeof body.team_id === "string" && body.team_id ? body.team_id : serviceId;

    const items: Array<{ id: string; name: string; type: string; status: string }> = [];

    // 列出 wiki
    if (kind === "all" || kind === "wiki") {
      try {
        const wikis = wikiService.list(serviceId!, teamId, { limit, offset: 0 });
        for (const w of wikis) {
          items.push({
            id: w.wiki_id,
            name: w.name,
            type: "wiki",
            status: w.status,
          });
        }
      } catch {
        // 忽略
      }
    }

    // 列出 code-graph
    if (kind === "all" || kind === "code_graph") {
      try {
        const cgs = cgService.list(serviceId!, teamId, { limit, offset: 0 });
        for (const cg of cgs) {
          items.push({
            id: cg.code_graph_id,
            name: cg.repo_name || cg.repo_url || cg.code_graph_id,
            type: "code_graph",
            status: cg.status,
          });
        }
      } catch {
        // 忽略
      }
    }

    return c.json(wrapOk({ items, total: items.length }));
  });

  return app;
}


