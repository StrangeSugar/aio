# CODEBUDDY.md

This file provides guidance to CodeBuddy when working with code in this repository.

## What this repository is

TencentDB Agent Memory is a monorepo of services that turn agent work into reusable memory assets: four-layer Chat Memory (L0 raw conversation → L1 atoms → L2 scenarios → L3 persona), Skills, Wiki, and CodeGraph.

| Path | Service | Default port | Responsibility |
| --- | --- | --- | --- |
| `MemoryCore/` | Memory kernel Gateway | 8420 | L0–L3 memory pipeline, Skill extraction, Team/User/Agent/Task metadata; SQLite + local files |
| `MemoryProxy/` | LLM request proxy | 8096 | Protocol-transparent forwarding for coding agents (OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`) + sessionInit / injection / write-back / rate limit / billing |
| `MemoryKnowledge/` | Knowledge Service (KS) | 8421 source, 8424 in hub image | Wiki (FTS5 + link graph) and CodeGraph engines, `/v3` tools API, MCP server |
| `MemoryPanel/` | Control plane + web console | 8123 source, 8125 image, 80 nginx | Team/User/Agent/asset management; thin reverse-proxying layer over Core and KS |
| `mcp-server/`, `deploy/mcp-server/` | Standalone MCP server | — | stdio MCP (12 read-only tools) that HTTP-forwards to KS `/v3` |
| `sdk/memory-core/{typescript,python}/` | Official SDKs | — | `/v3` data plane + `/v3/skill/*` + `/v3/meta/*` clients |

All Node code is ESM TypeScript on Node >= 22.16. Each module has its own `package.json`, lockfile (`npm` and/or `pnpm`) and `pnpm-workspace.yaml`; there is no root package.json — install inside the module you touch.

## Commands

### Whole stack (Docker)

```bash
cd deploy/global-images
cp .env.example .env      # fill MEMORY_LLM_* (core+hub) and PROXY_UPSTREAM_* (proxy) — independent LLM configs
./verify.sh               # dry-run, validates both LLM paths before starting
./start-all.sh            # memory-core + memory-hub (panel + knowledge) + proxy
./stop-all.sh [--purge]   # stop; --purge also deletes volumes
```

Also: `start-memory-core.sh` / `start-memory-hub.sh` / `start-proxy.sh` for single components; `docker compose -f deploy/docker-compose.prod.yml up -d` for the five-service prod compose; `./run-aio.sh -d` for the single-container AIO build (`Dockerfile.aio`, volume `tdai-aio-data`).

### MemoryCore

```bash
cd MemoryCore
npm install && npm run build     # tsdown (plugin → dist/index.mjs) + tsc (scripts → bin/*.mjs)
export TDAI_GATEWAY_CONFIG="$PWD/tdai-gateway.standalone.yaml"
export TDAI_LLM_API_KEY=... TDAI_LLM_BASE_URL=... TDAI_LLM_MODEL=...
node --import tsx src/gateway/server.ts        # Gateway on 127.0.0.1:8420
npm test                                        # vitest run
npx vitest run src/core/record/extractor.test.ts   # single file
npx vitest run -t "extracts preference"            # single test by name
npm run test:watch / npm run test:coverage
npm run read-local-memory / npm run seed-v2        # local data inspection / seeding
```

### MemoryProxy

```bash
cd MemoryProxy
npm install
cp config.example.yaml config.yaml    # config.yaml is gitignored; CLI args > YAML > built-in defaults
npm run start:config                  # node --import tsx/esm src/index.ts --config config.yaml
npm run dev:config                    # watch mode
npm test / npm run typecheck
./scripts/proxy.sh start|stop|restart|status|log|daemon   # background launcher, logs/YYYY-MM-DD.log
```

For local development without Redis set `redis.enabled: false` and `storage.enabled: true` with `storage.backend: sqlite`, otherwise startups spam `ECONNREFUSED 127.0.0.1:6379`.

### MemoryKnowledge

```bash
cd MemoryKnowledge
pnpm install --ignore-workspace
cp .env.example .env
pnpm dev          # HTTP API on :8421, Swagger at /docs
pnpm dev:mcp      # stdio MCP (requires the HTTP server to be running)
pnpm build / pnpm typecheck / pnpm test
pnpm db:generate / pnpm db:migrate   # drizzle-kit
```

### MemoryPanel

```bash
cd MemoryPanel
pnpm install && (cd web && npm install)
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json   # holds real keys, gitignored
pnpm dev                 # backend on 127.0.0.1:8123
cd web && npm run dev    # console on 5173; proxies /api/v1 + /health → 8123, /v3 → 8420
cd web && npm run lint / lint:check / format / format:check / build / mock
pnpm build / pnpm typecheck / pnpm test / pnpm mock-kernel
pnpm test:panel:e2e / pnpm test:knowledge:e2e[:full]
bash scripts/secret-scan.sh --strict    # required before committing panel/knowledge changes
bash scripts/install-git-hooks.sh       # wires the secret scan into .git/hooks/pre-commit
```

### Test layout note

Vitest configs and scripts exist in every module (`MemoryCore/vitest.config.ts` includes both co-located `src/**/*.test.ts` and `__tests__/**/*.test.ts` while excluding `**/*.e2e.test.ts`; `MemoryProxy` expects `src/**/__tests__/`; `MemoryPanel` expects `tests/**/*.test.ts`). The current checkout ships no `*.test.ts` files, so `npm test` can report "no test files found" — do not treat that as a broken command.

## Architecture

### Request path across services

A coding agent points its base URL at MemoryProxy (`:8096`). Proxy forwards verbatim to the upstream LLM, and in parallel talks to MemoryCore Gateway (`:8420`) for auth/meta/memory/skill and to KS for Wiki/CodeGraph. Panel is the human control plane: browser → nginx/`web` → Panel backend `/api/v1/*` → MemoryCore (forwarded via the proxy's `/v3/meta/*`) and KS (`/v3/wiki/*`, `/v3/code-graph/*`). MemoryCore stores metadata only; KS stores parsed knowledge content. Every business call carries the isolation dimensions `service_id` (memory instance) × `team_id` × `agent_id` × `user_id`, either in the body or as `x-tdai-*` headers.

### MemoryCore (`src/`)

- `src/gateway/server.ts` is the HTTP daemon (`TdaiGateway`) that mounts the v2 compatibility router and the v3 routers (memory data plane, skill, meta, knowledge) and embeds the L1/L2/L3 task executors. `src/gateway/generated/` is produced by `kubb.config.ts` from the OpenAPI spec.
- `src/core/tdai-core.ts` is the host-agnostic engine. Layer implementations sit beside it: `conversation/` (L0 recorder → JSONL), `record/` (L1 extract/dedupe/read), `scene/` (L2), `persona/` + `profile/` (L3), `skill/` (extraction, queue, store), `store/` (sqlite-vec locality vs Tencent VDB; `embedding.ts`, `store-pool.ts`), `storage/` (local/COS file backends), `prompts/`, `hooks/` (auto-capture, auto-recall), `tools/`, `quota/`.
- The asynchronous cascade lives in `src/services/pipeline-worker.ts` plus `src/utils/pipeline-manager.ts`, `stateful-pipeline-manager.ts` and `serial-queue.ts`: turns accumulate as L0 until a threshold; L1 extraction runs per session; L2 builds scenarios on an idle timer; L3 refreshes the profile. Locks are per-session for L1/L2 and per-instance for L3; thresholds are configured in `src/config.ts`.
- `src/adapters/` covers integration shapes: an in-process OpenClaw adapter (root `index.ts` is the OpenClaw plugin shell referenced by `openclaw.extensions`), a standalone adapter, plus out-of-process clients — `openclaw-plugin/` (thin TS client to a Gateway) and `hermes-plugin/` (Python provider supervising a Gateway sidecar).
- Config precedence: `TDAI_GATEWAY_CONFIG` → `./tdai-gateway.{yaml,json}` → `<dataDir>/tdai-gateway.{yaml,json}` → `TDAI_*` env → defaults. Templates are `tdai-gateway.standalone.yaml` and `tdai-gateway.yaml`; default data dir is `~/.memory-tencentdb/memory-tdai`. Redis/Mongo/Kafka/ClickHouse/COS/Opik are optional dependencies — standalone must run with an LLM API as the only external service.

### MemoryProxy (`src/`)

- The stage machine is in `handler.ts` (OpenAI), `anthropicHandler.ts`, plus `codexHandler.ts`, `workbuddyHandler.ts`, `auxiliaryHandler.ts`: auth → system-user short circuit → sessionInit → injection → rate limit → forward → extract → report. Routes are registered in `server.ts` (`/v1/messages`, `/v1/chat/completions`, `/:agent/:spaceId/v1/*`, `codex/...`, `workbuddy/...`, `dsh/...`, plus a catch-all POST).
- `injection/` is a pipeline of injectors (`skill`, `knowledge-tools`, `tdai-*` memory, `asset-reflection`, …) with per-protocol adapters (`adapters/anthropic.ts`, `adapters/openai.ts`). Injection only rewrites system prompt / messages and falls back to the untouched body on failure; client detection lives in `agent-adapters/`.
- `session/` holds per-client session-init forms (claude-code, codebuddy, codex, dsh, workbuddy); `db/` persists `inj:*` / `sk:*` / `vpin:*` state through `storage/`, a ProxyStorage abstraction with a `cos → sqlite → fs → memory` degradation chain. `/health` exposes `storage.effective`, the anchor for diagnosing degraded storage.
- `tdai/`, `skill/`, `memory/`, `meta/`, `knowledge/` are MemoryCore clients; `skill-bridge` and `memory-bridge` reverse-proxy Core's HTTP tools so credentials never appear in an LLM-visible prompt.
- ClickHouse / Langfuse / Opik reporting and credit billing are fire-and-forget side channels; a failure in any of them must not affect the business path.

### MemoryKnowledge (`src/`)

- `module.ts` wires the whole service: `SqliteKnowledgeStore` (drizzle + better-sqlite3, `src/db/schema.ts`, idempotent raw-SQL migrations in `db/client.ts`), one shared serial `BuildQueue` for both engines, a code-graph instance pool, `AutoSyncScheduler`, and restart recovery.
- `engines/wiki/` runs the ingest pipeline (chunk → LLM extract/commit → frontmatter/merge → index build) and writes a per-wiki `index.db` with FTS5 tables (`wiki_fts`, `page_meta`, `graph_edge`, `source`); `graph-search.ts` answers link-graph queries.
- `engines/code/` wraps the `@colbymchenry/codegraph` library in `bridge.ts` (`init/indexAll/sync` plus tool execution) and exposes `indexProject` / `syncIndex` / `executeTool` from `index.ts`; repositories are cloned by `source-fetcher/`.
- Everything is served under `/v3` (Swagger `/docs` reads `openapi.yaml`). The agent-facing surface is two endpoints — `POST /v3/tools/list` and `POST /v3/tools/call`, whitelisted read-only wiki/code tools — with per-resource REST routes in `routes/wiki.ts` and `routes/code-graph.ts`. Build completion is reported back to Panel by `callback.ts` (`TMC_CALLBACK_URL`).
- MCP: `src/mcp/tools.ts` declares the tools, `http-client.ts` posts each tool call to `${KNOWLEDGE_API_URL}/v3<endpoint>`; `mcp/server.ts` is stdio (single client, `TDAI_*` env mapped to auth headers), while `mcp/http-server.ts` is streamable HTTP on 8426 with one Server + transport per `Mcp-Session-Id` and a per-session auth header snapshot (nginx must set `proxy_buffering off`).

### MemoryPanel (`src/panel/`, `web/`)

- The backend is deliberately stateless. `config/instance-registry.ts` reads `config/metadata-instances.json` (instance id, gateway endpoint, api key); `kernel/` defines ports plus adapters that forward to Core (`fetch-meta-kernel-adapter.ts` → proxy `/v3/meta/*`) and to KS (`http-knowledge-client.ts`). `http/app.ts` registers every public route under `/api/v1` (meta, skill, chat-memory, knowledge, agent-overview, agent); middleware validates the caller while user keys stay header-only and are never logged or persisted server-side.
- Web console: React 18 + Vite + Zustand + Tailwind + tea-component. Hash router in `web/src/routes/index.tsx`, pages in `web/src/pages/{wiki,code,team,ResourcePage}`, state in `web/src/stores/`, i18n in `web/src/i18n/{zh-CN,en-US}.ts`, API clients in `web/src/lib/` (`base.ts` for `/api/v1/meta/*`, `knowledge-api.ts`, `teamApi.ts`). `VITE_ENTRY=mock` (`npm run mock`) runs the console without a backend.

### Deployment shapes

- `deploy/global-images/` orchestrates the three published images (`agentmemory/memory-core`, `agentmemory/memory-hub` = Panel + KS combined, `agentmemory/memory-proxy`).
- `deploy/docker-compose.prod.yml` is the five-service compose (web / panel / knowledge / core / proxy) with named volumes; `deploy/panel-knowledge-combined/` builds the hub image; `Dockerfile.aio` + `run-aio.sh` build the single-container variant exposing 80 / 8096 / 8125 / 8420 / 8424 with one `tdai-aio-data` volume.
- Image builds on restricted networks need `--build-arg APT_MIRROR=mirrors.aliyun.com`.

### Conventions

- Build tooling: `tsdown` for services (ESM, external dependencies, `.mjs` output — note `fixedExtension`), `tsc` for MemoryCore's `bin/` scripts.
- Commits follow Conventional Commits with a module scope (`memory-core`, `panel`, `knowledge`, `proxy`, `sdk-ts`, `sdk-py`, `deploy`, `docs`) and require a DCO sign-off (`git commit -s`); branch off `master` or the latest `develop_*`, PR back to `develop_server_team` or `master`.
- Never commit `.env`, `config.yaml`, real `config/metadata-instances.json`, generated data or logs. `bash scripts/secret-scan.sh --strict` must pass for panel/knowledge changes, and `scripts/install-git-hooks.sh` wires it into a pre-commit hook.
- New integrations should use the v3 data plane (`/v3/*` with team/agent/user isolation); `/capture`, `/recall`, `/search/*` and `/v2/*` are compatibility surfaces.
- `MemoryCore/index.ts` is both the OpenClaw plugin entry and the `TdaiCore` composition root; `dist/index.mjs` is its tsdown output, so build before exercising OpenClaw integration.
