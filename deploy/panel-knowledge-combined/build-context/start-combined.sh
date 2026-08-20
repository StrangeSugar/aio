#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/panel/config "${KNOWLEDGE_DATA_DIR:-/data/knowledge}" "$(dirname "${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}")" /app/panel/web/dist

PANEL_PORT="${PANEL_PORT:-8125}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"

# ── 启动 Panel（后台）
echo "[start-combined] starting panel on :${PANEL_PORT}..."
cd /app/panel
PORT=$PANEL_PORT node dist/index.js &
PANEL_PID=$!

# ── 启动 Knowledge（后台）
echo "[start-combined] starting knowledge on :${KNOWLEDGE_PORT}..."
cd /app/knowledge
PORT=$KNOWLEDGE_PORT node dist/server.mjs &
KNOWLEDGE_PID=$!

# ── 等待任一子进程退出
wait -n $PANEL_PID $KNOWLEDGE_PID
EXIT_CODE=$?

echo "[start-combined] one process exited (code=$EXIT_CODE), shutting down..."
kill $PANEL_PID $KNOWLEDGE_PID 2>/dev/null || true
wait
exit $EXIT_CODE
