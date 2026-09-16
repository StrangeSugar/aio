# aio

基于 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 改造的单体容器版本：

**去掉 Chat Memory 与 Skill，只保留 Wiki 与 CodeGraph 两类知识资产，通过 MCP 把能力交给 Agent。**

一个容器跑起全部服务（MemoryCore + MemoryProxy + Knowledge Service + Panel + Web + MCP），面板里把文档和代码库喂进去，Agent 侧用 MCP 直接查。

## 与上游的差异

| | 上游 | 本仓库 |
|---|---|---|
| 资产类型 | Chat Memory / Skill / Wiki / CodeGraph | **Wiki / CodeGraph**（+ Agent 固定绑定） |
| 记忆分层 | L0–L3 记忆与提炼流水线 | 已移除 |
| MCP | 仅 stdio 单文件分发 | 新增 **streamable HTTP**（`/mcp-http`，客户端 URL 直连、无需下载），单文件 stdio 仍保留 |
| 部署 | 三个独立镜像（core / hub / proxy） | 新增 **AIO 单体镜像**（`Dockerfile.aio` + `run-aio.sh`）与生产 compose |

`MemoryCore` 与 `MemoryProxy` 未改动，仍与上游一致；改动集中在 `MemoryPanel`（移除 skill / chat-memory 的路由、页面与内核适配器）、`MemoryKnowledge`（新增 `assets` / `agent-fixed` 路由与 MCP HTTP 服务）以及部署脚本。

## 快速开始

前置：Docker（>= 24）；一个 OpenAI 兼容的 LLM 端点。

### 1. 构建镜像

```bash
docker build -t agentmemory/aio:latest -f Dockerfile.aio .
```

### 2. 准备环境变量

```bash
cat > .env.aio <<'EOF'
LLM_MODE=custom
LLM_PROTOCOL=openai
LLM_PROVIDER=custom
LLM_API_KEY=sk-your-key-here
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_MAX_TOKENS=32768
LLM_TIMEOUT_MS=1200000
EOF
```

`LLM_*` 供 Knowledge Service 生成 Wiki 使用（Wiki ingest、页面总结）；`LLM_PROTOCOL` 可选 `openai` / `anthropic`。

### 3. 准备面板实例注册表

面板不保存状态，实例信息由 `/opt/panel/config/metadata-instances.json` 提供（**未打进镜像，需要挂载**）：

```json
{
  "instances": [
    {
      "id": "default",
      "name": "本地默认实例",
      "gateway_endpoint": "http://127.0.0.1:8420",
      "api_key": "local"
    }
  ]
}
```

`id` 即实例 ID（对应请求头 `x-tdai-service-id`，AIO 下为 `default`）；`api_key` 是内核网关的 Bearer，需与 MemoryCore 的 `TDAI_GATEWAY_API_KEY` 一致 —— AIO 默认没有设置它（即网关未开鉴权），填 `local` 即可，但请勿把 8420 直接暴露到公网。

### 4. 启动

```bash
./run-aio.sh -d       # 后台启动；--logs 看日志，--stop 停止
```

`run-aio.sh` 只挂载数据卷，若需要面板可用（面板的 `/opt/panel/config`），用等价的 `docker run` 自行加上挂载目录：

```bash
docker run -d --name tdai-aio \
  -p 80:80 -p 8096:8096 -p 8125:8125 -p 8420:8420 -p 8424:8424 \
  -v tdai-aio-data:/data \
  -v "$PWD/aio-config:/opt/panel/config:ro" \
  --env-file .env.aio \
  --restart unless-stopped \
  agentmemory/aio:latest
```

### 入口与端口

| 入口 | 地址 | 说明 |
|---|---|---|
| 面板 UI | http://localhost/ | Web 控制台（nginx 托管） |
| 面板 API | http://localhost:8125 | `/api/v1/*`，nginx 以 `/api/` 反代 |
| Knowledge Service | http://localhost:8424/v3 | Wiki / CodeGraph，Swagger 在 `/docs` |
| MCP（远程） | http://localhost/mcp-http | Agent 直连，无需下载 |
| MCP（单文件） | http://localhost/mcp/server.mjs | 下载后 `node server.mjs` 以 stdio 启动 |
| MemoryCore | http://localhost:8420 | 内核网关（元数据 / 鉴权） |
| MemoryProxy | http://localhost:8096 | LLM 请求代理 |

所有数据都在卷 `tdai-aio-data`（容器内 `/data`：`knowledge/` 的 knowledge.db + wiki 文件 + code-graph、`tdai-memory/` 内核数据、`tdai-memory-proxy/` 代理状态、`log/` 日志）。

### 面板首次使用

创建团队（会自动生成默认 Agent）→ 在团队页给 Agent 绑定 Wiki / CodeGraph 资产 → 到 API Key 页拿 `user_key`（`sk-mem-…`）。API Key 页同时给出 MCP 接入配置（方式一 / 方式二），复制到客户端即可。

## 接入 Agent（MCP）

**方式一：远程 HTTP（推荐，无需下载）**

```json
{
  "mcpServers": {
    "tdai-knowledge": {
      "type": "http",
      "url": "http://<host>/mcp-http",
      "headers": {
        "x-tdai-service-id": "default",
        "x-tdai-team-id": "<team-id>",
        "x-tdai-user-key": "<user-key>",
        "x-tdai-agent-id": "<agent-id>"
      }
    }
  }
}
```

**方式二：单文件 stdio（兼容不支持 HTTP MCP 的客户端）**

```bash
curl -O http://<host>/mcp/server.mjs
node server.mjs      # 同样的值通过客户端配置的环境变量注入
```

可用工具共 14 个，全部只读：

- `list_assets`
- `code_search` / `code_explore` / `code_callers` / `code_callees` / `code_impact` / `code_node` / `code_status` / `code_files`
- `wiki_search` / `wiki_read` / `wiki_list` / `wiki_graph`

> `x-tdai-service-id` 填实例 ID（AIO 下为 `default`）；`x-tdai-team-id` **必须**填当前团队 ID，`list_assets` 会按团队过滤，填错会返回空列表；`x-tdai-agent-id` 可选，用于限制只访问该 Agent 挂载的资产。

## 从源码开发

各模块可独立运行，完整命令与架构说明见 [CODEBUDDY.md](./CODEBUDDY.md)。

| 模块 | 开发启动 | 端口 |
|---|---|---|
| `MemoryCore` | `npm install && npm run build`，再 `node --import tsx src/gateway/server.ts` | 8420 |
| `MemoryKnowledge` | `pnpm install --ignore-workspace`，`cp .env.example .env`，`pnpm dev` | 8421 |
| `MemoryPanel` | 后端 `pnpm dev`；前端 `cd web && npm run dev` | 8123 / 5173 |
| `MemoryProxy` | `cp config.example.yaml config.yaml`，`npm run start:config` | 8096 |

## 与上游同步

`origin` 是本仓库，`upstream` 指向上游 TencentCloud 仓库，可用 cherry-pick 按需取改动：

```bash
git fetch upstream
git cherry-pick <upstream-sha>
```

> 本仓库历史在 2026-09-16 做过一次重写（清理误提交的本地数据库与凭证），与上游共有提交的 SHA 因此发生变化、公共祖先回退到上游 `v2.0.0-beta.1`。直接 `git merge upstream/feat/server_team` 会把 2.0.0 之后的改动重新合并一遍，改造过的 Panel 等文件必然冲突，因此优先用 cherry-pick。

## 许可与致谢

MIT，见 [LICENSE](./LICENSE)。

- 基于 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 改造
- CodeGraph 能力来自 [@colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
- Wiki 的设计参考了 [Karpathy 的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
