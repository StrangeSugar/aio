/**
 * MCP HTTP server — exposes knowledge query tools over Streamable HTTP transport.
 *
 * Multi-session: each MCP client session gets its own Server + transport
 * (the SDK Server/transport are single-client by design), routed by the
 * `Mcp-Session-Id` header. Many agents can connect to one URL concurrently.
 *
 * Auth & tenancy: clients send x-tdai-* headers (x-tdai-service-id, x-tdai-team-id,
 * x-tdai-user-key, x-tdai-agent-id). Captured per session and injected into the
 * upstream Knowledge Service calls via callApi().
 *
 * Usage:
 *   MCP_HTTP_PORT=8426 KNOWLEDGE_API_URL=http://localhost:8421 node dist/mcp/http-server.mjs
 *
 * nginx (container):
 *   location /mcp-http/ {
 *       proxy_pass http://127.0.0.1:8426;
 *       proxy_http_version 1.1;
 *       proxy_buffering off;       # SSE streaming required
 *       proxy_read_timeout 3600s;
 *   }
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MCP_TOOLS, type McpToolDef } from "./tools.js";
import { callApi, type HttpClientOptions } from "./http-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-http-server");

/** x-tdai-* headers forwarded to the Knowledge Service. */
const TD_HEADERS = [
  "x-tdai-service-id",
  "x-tdai-team-id",
  "x-tdai-user-key",
  "x-tdai-agent-id",
  "x-tdai-agent-source",
] as const;

function pickTdHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TD_HEADERS) {
    const v = req.headers[name];
    if (typeof v === "string" && v.trim()) out[name] = v.trim();
  }
  return out;
}

export interface McpHttpServerOptions {
  port: number;
  http: HttpClientOptions;
}

export async function startMcpHttpServer(opts: McpHttpServerOptions): Promise<void> {
  const { port, http } = opts;

  const toolMap = new Map<string, McpToolDef>();
  for (const tool of MCP_TOOLS) toolMap.set(tool.name, tool);

  // One Server + transport per MCP session.
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  // Per-session tdai auth headers (keyed by sessionId).
  const sessionHeaders = new Map<string, Record<string, string>>();

  /** Execute an MCP tool call against the Knowledge Service. */
  async function executeTool(
    name: string,
    tool: McpToolDef,
    args: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
    const body = { ...args };
    const tdHeaders = (sessionId && sessionHeaders.get(sessionId)) || {};
    // list_assets 需要 team_id（KS 列表端点用它过滤团队）
    const teamId = tdHeaders["x-tdai-team-id"];
    if (name === "list_assets" && typeof teamId === "string" && teamId && typeof body.team_id !== "string") {
      body.team_id = teamId;
    }
    try {
      const data = await callApi({ ...http, headers: { ...http.headers, ...tdHeaders } }, tool.endpoint, body);
      if (data && typeof data === "object" && "text" in data && "isError" in data) {
        const result = data as { text: string; isError: boolean };
        return { content: [{ type: "text", text: result.text || "(empty result)" }], isError: result.isError };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tool ${name} failed: ${msg}`);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }

  /** Build a fresh MCP Server for one session. sessionId resolved live from transport. */
  function createSessionServer(transport: StreamableHTTPServerTransport): Server {
    const server = new Server(
      { name: "knowledge-mcp-http", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const tool = toolMap.get(name);
      if (!tool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      // 会话初始化后 transport.sessionId 为真实值；未初始化时（理论上不会走到）退化为 undefined
      return executeTool(name, tool, (request.params.arguments ?? {}) as Record<string, unknown>, transport.sessionId);
    });
    return server;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const incomingSession =
      typeof req.headers["mcp-session-id"] === "string" ? (req.headers["mcp-session-id"] as string) : undefined;
    const td = pickTdHeaders(req);

    if (incomingSession) {
      const session = sessions.get(incomingSession);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      // Refresh this session's auth headers (e.g. client rotates user key).
      sessionHeaders.set(incomingSession, td);
      await session.transport.handleRequest(req, res);
      return;
    }

    // Brand-new session: create Server + transport, register on initialize.
    let session: { server: Server; transport: StreamableHTTPServerTransport } | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: async (sid) => {
        const s = session;
        if (s) {
          sessions.set(sid, s);
          sessionHeaders.set(sid, td);
          log.info(`MCP HTTP session initialized: ${sid}`);
        }
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        sessionHeaders.delete(sid);
        log.info(`MCP HTTP session closed: ${sid}`);
      },
    });
    session = { server: createSessionServer(transport), transport };
    await session.server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "DELETE") {
      const sid = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      if (sid) {
        const s = sessions.get(sid);
        if (s) {
          await s.transport.close();
          sessions.delete(sid);
          sessionHeaders.delete(sid);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    try {
      await handleRequest(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`MCP HTTP request failed: ${msg}`);
      if (!res.writableEnded) {
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: msg }, id: null }));
        } catch { /* ignore */ }
      }
    }
  });

  httpServer.on("connection", (socket) => socket.setTimeout(0));

  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  log.info(`MCP HTTP server listening on :${port}, KS: ${http.baseUrl}`);
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MCP_HTTP_PORT || 8426);
  const baseUrl = process.env.KNOWLEDGE_API_URL || "http://localhost:8421";
  const token = process.env.KNOWLEDGE_API_TOKEN;

  const teamHeaders: Record<string, string> = {};
  if (process.env.TDAI_SERVICE_ID) teamHeaders["x-tdai-service-id"] = process.env.TDAI_SERVICE_ID;
  if (process.env.TDAI_USER_KEY) teamHeaders["x-tdai-user-key"] = process.env.TDAI_USER_KEY;
  if (process.env.TDAI_AGENT_ID) teamHeaders["x-tdai-agent-id"] = process.env.TDAI_AGENT_ID;

  log.info(`MCP HTTP server starting, port=${port}, API URL: ${baseUrl}`);

  startMcpHttpServer({ port, http: { baseUrl, token, headers: teamHeaders } }).catch((err) => {
    log.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
