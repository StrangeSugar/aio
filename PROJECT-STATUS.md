# Agent Memory（TencentDB-Agent-Memory）项目情况与部署说明

> 更新时间：2026-08-22（含 MCP 接入指引改造 + AIO 镜像重建部署）

## 一、项目定位

Agent 记忆系统 monorepo，为 LLM Agent 提供记忆与知识服务。包含 5 个服务 + 1 个 MCP 服务端。

| 服务 | 端口 | 职责 |
|---|---|---|
| **MemoryCore** | 8420 | 内核网关，SQLite 元数据（team/user/agent/key） |
| **MemoryProxy** | 8096 | LLM 代理网关（协议不变、改 base URL 即接入，不走 MCP） |
| **MemoryKnowledge (KS)** | 8421/8424 | Wiki（FTS5 + 知识图谱）+ Code-Graph（符号/调用索引） |
| **MemoryPanel** | 8125 | 管控面后端 + Web 前端（nginx 托管，80 端口） |
| **MCP Server** | — | stdio 知识查询工具，HTTP 转发到 KS `/v3` |

### MCP 源码（MemoryKnowledge/src/mcp/）

- `tools.ts`：12 个只读查询工具（`list_assets` + 8 个 code-* + 4 个 wiki-*），管理操作不暴露
- `http-client.ts`：`callApi()` 把工具参数 POST 到 `${baseUrl}/v3${endpoint}`
- `server.ts`：`@modelcontextprotocol/sdk` 的 `Server` + `StdioServerTransport`，处理 `ListTools` / `CallTool`

认证/租户（环境变量注入 header）：

| 变量 | 作用 |
|---|---|
| `KNOWLEDGE_API_URL` | KS HTTP 地址（如 `http://<host>:8424` 或经 nginx 的 80 端口） |
| `TDAI_SERVICE_ID` | → `x-tdai-service-id`（实例隔离，AIO 下为 `default`） |
| `TDAI_TEAM_ID` | → `list_assets` 的 body.team_id（**填当前团队 team-xxx**，不是 instance id） |
| `TDAI_USER_KEY` | → `x-tdai-user-key`（用户认证，本页创建的 User_Key） |
| `TDAI_AGENT_ID` | → `x-tdai-agent-id`（可选，按 agent 过滤） |

### 并行机制（非 MCP）

KS 另有 `POST /v3/tools/list` + `/v3/tools/call` 裸 HTTP 工具自发现（同语义工具集，供不走 MCP 的 Agent/Kernel 使用）。

## 二、部署形态（AIO 单体容器）

本机运行 **`tdai-aio`** 容器（镜像 `agentmemory/aio:latest`），一个容器跑全部 5 个服务 + nginx，由仓库根 **`Dockerfile.aio`**（git 未跟踪）构建。

### 容器配置（2026-08-22 重建）

- **端口**：80 / 8096 / 8125 / 8420 / 8424
- **挂载**：
  - `C:\Users\Administrator\Desktop\aio-config` → `/opt/panel/config`（`metadata-instances.json`）
  - 卷 `tdai-aio-data` → `/data`（全部业务数据）
- **LLM 环境变量**：`LLM_MODE=custom`、`LLM_PROTOCOL=openai`、`LLM_PROVIDER=custom`、`LLM_API_KEY`、`LLM_BASE_URL=https://api.longcat.chat/openai`、`LLM_MODEL=LongCat-2.0`、`LLM_MAX_TOKENS=32768`、`LLM_TIMEOUT_MS=1200000`
- **重启策略**：`unless-stopped`

### 容器内 nginx（/etc/nginx/conf.d/app.conf）

```nginx
location /api/ { proxy_pass http://127.0.0.1:8125; }   # Panel
location /v3/  { proxy_pass http://127.0.0.1:8424; }   # KS
location /mcp/ { alias /usr/share/nginx/html/mcp/; add_header Content-Type application/javascript; }  # MCP 单文件下载
```

### MCP 分发链路（已端到端验证）

**方式一：远程 HTTP MCP（streamable HTTP，推荐，无需下载）**

容器内 `MCP HTTP Server`（`/opt/knowledge/dist/mcp/http-server.mjs`，端口 8426，仅容器内监听）由 nginx 转发到 `http://<host>/mcp-http`。客户端配置 URL 直连即可，无需下载、无需本地 node。多会话架构（每个会话独立 Server+transport，按 `Mcp-Session-Id` 路由），认证头（`x-tdai-service-id` / `x-tdai-team-id` / `x-tdai-user-key` / `x-tdai-agent-id`）按会话捕获并透传到 KS `/v3`。

```json
{
  "mcpServers": {
    "tdai-knowledge": {
      "type": "http",
      "url": "http://<host>/mcp-http",
      "headers": { "x-tdai-service-id": "<instance-id>", "x-tdai-team-id": "<team-id>", "x-tdai-user-key": "<user-key>", "x-tdai-agent-id": "<agent-id>" }
    }
  }
}
```

**方式二：curl 单文件 + node 本地运行（备选，兼容不支持 HTTP MCP 的客户端）**

镜像内置 560KB standalone 单文件（与仓库根 `mcp-server/dist/mcp-server.standalone.mjs` MD5 一致 `7a00ade48dad4528334a4c9bd83909b4`）→ 用户 `curl http://<host>/mcp/server.mjs` 下载 → 本地 `node server.mjs` 以 **stdio** 拉起 → HTTP 回连 KS `/v3`。实测 stdio 握手 + 12 工具全部正常。

## 三、MCP 接入指引改造（2026-08-22）

### 背景问题

Panel UI「API Key → MCP 接入」卡片原引导用户 `npx -y @tdai/memory-hub-mcp`，但**该 npm 包不存在（404）**，照抄必失败；且实际分发方式是 curl 下载单文件。用户需求：无需手动下载的接入方式。

### 改动内容

| 文件 | 改动 |
|---|---|
| `MemoryKnowledge/src/mcp/http-server.ts`（**新增**） | streamable HTTP MCP 服务（端口 8426），多会话架构，`x-tdai-*` 认证头按会话透传 |
| `MemoryKnowledge/tsdown.config.ts` | entry 增加 `./src/mcp/http-server.ts` |
| `Dockerfile.aio` | start.sh 启动 MCP HTTP 进程（`node dist/mcp/http-server.mjs`）；nginx 增加 `location /mcp-http/`（proxy_buffering off 支持 SSE）；健康检查/清理含 mcp-http |
| `MemoryPanel/web/src/pages/team/ApiKeysPage/components/ApiKeyPanel.tsx` | 新增「方式一：HTTP 远程接入（无需下载）」配置段 + 复制按钮；curl 下载保留为「方式二（备选）」；`TDAI_TEAM_ID` 用 `useTeams().activeTeamId` |
| `MemoryPanel/web/src/i18n/zh-CN.ts` / `en-US.ts` | 新增 `httpLabel`/`httpHint`，更新 desc 描述两种方式 |

### 关键修正说明

- `TDAI_SERVICE_ID` 用 instance_id（AIO 下为 `default`）——正确（与 Panel→KS 的 `x-tdai-service-id` 一致）
- `TDAI_TEAM_ID` **必须**用当前团队（真实 team 为 `team-ckjgfho9gh`/`team-ckos4851m1`/`team-do86av7rid` 等），否则 `list_assets` 按错误 team 过滤返回空
- 查询类 MCP 工具（wiki_search 等）按 wiki_id 内部解析 team，不需要 body 传 team_id；只有 `list_assets` 需要
- **多会话**：SDK 的 `Server`/transport 是单客户端设计，必须每个会话一个 Server+transport 实例，按 `Mcp-Session-Id` 头分发（首次实现单 transport 导致第二客户端报 "Server already initialized"，已修正）
- **构建注意**：tsdown `fixedExtension: true` 输出 `.mjs`（start.sh 曾误写 `.js` 导致 MODULE_NOT_FOUND，已修正）；本机 apt 源 `deb.debian.org` 不可达，构建需 `--build-arg APT_MIRROR=mirrors.aliyun.com`

### 构建与部署步骤（已执行）

```bash
# 1. 改源码后本地验证（MemoryPanel/web）
npm install && npm run build        # tsc + vite，通过

# 2. 重建 AIO 镜像（仓库根）
docker build -t agentmemory/aio:latest -f Dockerfile.aio .

# 3. 重新部署（沿用原配置）
docker rm -f tdai-aio
docker run -d --name tdai-aio \
  -p 80:80 -p 8096:8096 -p 8125:8125 -p 8420:8420 -p 8424:8424 \
  -v "C:\Users\Administrator\Desktop\aio-config:/opt/panel/config" \
  -v tdai-aio-data:/data \
  -e LLM_MODE=custom -e LLM_PROTOCOL=openai -e LLM_PROVIDER=custom \
  -e LLM_API_KEY=<your-key> \
  -e LLM_BASE_URL=https://api.longcat.chat/openai \
  -e LLM_MODEL=LongCat-2.0 \
  -e LLM_MAX_TOKENS=32768 -e LLM_TIMEOUT_MS=1200000 \
  --restart unless-stopped agentmemory/aio:latest
```

### 部署验证结果（全部通过）

- 容器 `Up (healthy)`，健康检查在容器内全通
- 对外服务：80 / 8125 / 8424 / 8096 宿主机可访问
- `/mcp/server.mjs`：HTTP 200，560526 字节，MD5 未变
- 新 bundle `main-D_24Sk0b.js` 已部署，新文案「第 1 步：下载 MCP 服务端」已在产物中

## 四、已知注意事项

1. **8420（MemoryCore）宿主机不可达**：容器内只监听 `127.0.0.1:8420`，发布端口对外无效（原有行为，非本次引入）；容器内健康检查正常。
2. **git 未跟踪的部署文件**（丢失无法从仓库恢复，注意备份）：`Dockerfile.aio`、`deploy/README.md`、`deploy/docker-compose.prod.yml`、`deploy/mcp-server/`、`mcp-server/`、`opencode.json`。
3. **AIO 数据**全部在卷 `tdai-aio-data` 中（`/data`：knowledge SQLite + wiki + code-graph、MemoryCore metadata.db、proxy db、日志）。
4. 仓库根 `opencode.json` 是本地开发用 MCP 配置（指向 `D:/self/TencentDB-Agent-Memory/mcp-server`，`KNOWLEDGE_API_URL=http://localhost:8424`）。
