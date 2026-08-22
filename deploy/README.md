# Agent Memory — 生产环境部署指南

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     用户 / AI 客户端                      │
│  (Claude Code / Cursor / VS Code / OpenCode / Web 浏览器) │
└──────────────┬────────────────────────────┬──────────────┘
               │                            │
               │ stdio                      │ HTTP
               ▼                            ▼
┌──────────────────┐              ┌──────────────────────┐
│   MCP Server     │              │   Web 前端 (nginx)    │
│   (内网独立部署)  │              │   :80                 │
│   stdio transport │              └──────────┬───────────┘
└────────┬─────────┘                          │
         │ HTTP                               │ reverse proxy
         ▼                                    ▼
┌──────────────────┐              ┌──────────────────────┐
│ Knowledge Service│              │  Panel 后端           │
│ :8424            │◄────────────►│  :8125                │
│ (Wiki + Code-Graph)│             │  (team/user/agent)    │
└────────┬─────────┘              └──────────┬───────────┘
         │                                   │
         │ HTTP                              │ HTTP
         ▼                                   ▼
┌──────────────────┐              ┌──────────────────────┐
│  Memory Proxy    │              │  Memory Core          │
│  :8096           │              │  :8420                 │
│  (LLM 代理)      │              │  (SQLite 元数据)       │
└──────────────────┘              └──────────────────────┘
```

## 端口分配

| 服务 | 端口 | 说明 |
|------|------|------|
| Web 前端 | 80 | nginx 托管 SPA，反向代理 API |
| Panel 后端 | 8125 | team/user/agent API |
| Knowledge Service | 8424 | Wiki + Code-Graph + MCP HTTP |
| Memory Core | 8420 | 内核网关 |
| Memory Proxy | 8096 | LLM 代理网关 |

## 前置条件

- Docker Engine >= 24
- Docker Compose >= 2.20
- 至少 4GB 可用内存
- 至少 10GB 可用磁盘（数据库 + 代码索引）

## 快速部署

### 1. 配置环境变量

```bash
# 复制模板
cp deploy/.env.example deploy/.env

# 编辑 .env，填入 LLM 端点等信息
vi deploy/.env
```

关键配置项：

```env
# LLM 端点（wiki ingest 必须）
LLM_API_KEY=sk-your-key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# Knowledge Service 公网地址（Agent 回调用）
KNOWLEDGE_PUBLIC_BASE_URL=http://your-server-ip:8424/v3
```

### 2. 启动全部服务

```bash
docker compose -f deploy/docker-compose.prod.yml up -d
```

### 3. 验证

```bash
# 全部服务健康检查
docker compose -f deploy/docker-compose.prod.yml ps

# 单独验证
curl http://localhost:80              # Web 前端
curl http://localhost:8125/health     # Panel 后端
curl http://localhost:8424/health     # Knowledge Service
curl http://localhost:8420/health     # Memory Core
curl http://localhost:8096/health     # Memory Proxy
```

## 生产镜像构建

修改源码后需重新构建对应镜像：

```bash
# Knowledge Service（最频繁）
cd MemoryKnowledge
docker build -t agentmemory/memory-hub:prod \
  --build-arg APT_MIRROR=mirrors.aliyun.com .

# Panel 后端
cd MemoryPanel
docker build -t agentmemory/memory-panel:latest -f Dockerfile.prod .

# Web 前端
cd MemoryPanel/web
docker build -t agentmemory/memory-web:latest -f Dockerfile.prod .
```

## 数据备份

所有数据通过 Docker Volume 持久化：

```bash
# 备份 Knowledge 数据（SQLite + wiki + code-graph）
docker run --rm -v tdai-knowledge-data:/data \
  -v $(pwd):/backup alpine tar czf /backup/knowledge-backup.tar.gz -C /data .

# 备份 Memory Core 数据
docker run --rm -v tdai-memory-core-data:/data \
  -v $(pwd):/backup alpine tar czf /backup/core-backup.tar.gz -C /data .

# 恢复
docker run --rm -v tdai-knowledge-data:/data \
  -v $(pwd):/backup alpine tar xzf /backup/knowledge-backup.tar.gz -C /data
```

| Volume | 内容 | 说明 |
|--------|------|------|
| `tdai-knowledge-data` | knowledge.db + wiki + code-graph | Wiki 和代码图数据 |
| `tdai-memory-core-data` | core.db | team/user/agent 元数据 |
| `tdai-proxy-data` | proxy 状态 | Memory Proxy |

## 运维命令

```bash
# 查看日志
docker compose -f deploy/docker-compose.prod.yml logs -f [service]

# 重启单服务
docker compose -f deploy/docker-compose.prod.yml restart knowledge

# 更新单服务镜像
docker compose -f deploy/docker-compose.prod.yml up -d --build knowledge

# 完全停止
docker compose -f deploy/docker-compose.prod.yml down

# 停止并删除数据（危险！）
docker compose -f deploy/docker-compose.prod.yml down -v
```

## MCP 内网分发

`deploy/mcp-server/` 目录是独立的 MCP 服务端包，可分发给团队成员：

```bash
# 打包
tar czf mcp-server.tar.gz -C deploy mcp-server

# 分发给用户后：
tar xzf mcp-server.tar.gz
# 在各 IDE 的 MCP 配置中指向 mcp-server/dist/mcp/server.mjs
```

详见 `deploy/mcp-server/README.md`。

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| ingest 报 "LLM apiKey 未配置" | LLM 环境变量未注入 | 检查 deploy/.env 和容器 env |
| ingest 报 "Unsupported model" | 模型名不对 | 确认 LLM_MODEL 与提供商匹配 |
| ingest 报 "Not Found" | base URL 路径不对 | 确认 LLM_BASE_URL 包含正确路径 |
| 前端 502 | Panel 后端未启动 | 检查 panel-backend 容器状态 |
| list_assets 返回空 | service_id 不对 | 确认 TDAI_SERVICE_ID 与数据库一致 |

## 从开发环境迁移

```bash
# 1. 停止开发环境
docker compose -f deploy/docker-compose.dev.yml down

# 2. 确保数据卷名一致（开发用 tdai-knowledge-data，生产同名）
docker volume ls

# 3. 启动生产环境
docker compose -f deploy/docker-compose.prod.yml up -d
```

> 注意：开发环境和生产环境共享同名 Docker Volume，启动生产前务必先停开发环境，避免数据损坏。
