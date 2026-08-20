/**
 * MCP stdio server — exposes knowledge query tools to LLM agents.
 *
 * Runs as a separate process with stdio transport. When an agent calls a tool,
 * the server forwards the request to the Hono HTTP API via callApi().
 *
 * Usage:
 *   KNOWLEDGE_API_URL=http://localhost:8421 node dist/mcp/server.js
 *
 * The agent connects via stdio; the server translates tool calls to HTTP
 * requests against the knowledge service.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MCP_TOOLS, type McpToolDef } from "./tools.js";
import { callApi, type HttpClientOptions } from "./http-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-server");

export function createMcpServer(httpOpts: HttpClientOptions): Server {
  const toolMap = new Map<string, McpToolDef>();
  for (const tool of MCP_TOOLS) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "knowledge-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      log.warn(`Unknown tool requested: "${name}"`);
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const body = (args ?? {}) as Record<string, unknown>;
    // list_assets 需要 team_id（KS 列表端点用它过滤团队）
    if (name === "list_assets" && process.env.TDAI_TEAM_ID && typeof body.team_id !== "string") {
      body.team_id = process.env.TDAI_TEAM_ID;
    }
    try {
      const data = await callApi(httpOpts, tool.endpoint, body);

      // The code-graph query endpoints return {text, isError} — pass through directly
      if (data && typeof data === "object" && "text" in data && "isError" in data) {
        const result = data as { text: string; isError: boolean };
        return {
          content: [{ type: "text", text: result.text || "(empty result)" }],
          isError: result.isError,
        };
      }

      // Other endpoints return structured data — serialize as JSON
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tool ${name} failed: ${msg}`);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.KNOWLEDGE_API_URL || "http://localhost:8421";
  const token = process.env.KNOWLEDGE_API_TOKEN;

  // 上下文环境变量（由客户端 agent 配置 MCP 时注入）
  // TDAI_SERVICE_ID: 实例 ID（如 default），对应 x-tdai-service-id header
  // TDAI_TEAM_ID: 团队 ID，传请求 body 的 team_id 字段
  // TDAI_USER_KEY: 用户密钥，对应 x-tdai-user-key header（认证）
  // TDAI_AGENT_ID: Agent ID，对应 x-tdai-agent-id header（可选，按 agent 过滤知识）
  const teamHeaders: Record<string, string> = {};
  if (process.env.TDAI_SERVICE_ID) teamHeaders["x-tdai-service-id"] = process.env.TDAI_SERVICE_ID;
  if (process.env.TDAI_USER_KEY) teamHeaders["x-tdai-user-key"] = process.env.TDAI_USER_KEY;
  if (process.env.TDAI_AGENT_ID) teamHeaders["x-tdai-agent-id"] = process.env.TDAI_AGENT_ID;

  log.info(`MCP server starting, API URL: ${baseUrl}, serviceId: ${process.env.TDAI_SERVICE_ID || "(none)"}, teamId: ${process.env.TDAI_TEAM_ID || "(none)"}, agentId: ${process.env.TDAI_AGENT_ID || "(none)"}`);

  const server = createMcpServer({ baseUrl, token, headers: teamHeaders });
  const transport = new StdioServerTransport();

  server.connect(transport).then(() => {
    log.info("MCP server connected via stdio");
  }).catch((err) => {
    log.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
