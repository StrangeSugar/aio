#!/usr/bin/env bash
# AIO 单体容器 — 一键启动脚本
# 用法：
#   ./run-aio.sh              # 前台启动
#   ./run-aio.sh -d           # 后台启动
#   ./run-aio.sh --stop       # 停止
#   ./run-aio.sh --logs       # 查看日志
#
# 环境变量：
#   ENV_FILE           环境变量文件（默认 .env.aio）
#   PANEL_CONFIG_DIR   含 metadata-instances.json 的目录（默认 <仓库>/MemoryPanel/config）

set -euo pipefail

IMAGE="agentmemory/aio:latest"
CONTAINER="tdai-aio"
ENV_FILE="${ENV_FILE:-.env.aio}"

# Panel 实例注册表：镜像内不含该文件，必须由宿主机挂载到 /opt/panel/config，否则 Panel 启动即崩
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_CONFIG_DIR="${PANEL_CONFIG_DIR:-${SCRIPT_DIR}/MemoryPanel/config}"

# 转成 docker 能识别的主机路径（Git Bash 用 cygpath，WSL 用 wslpath，Linux/原生 docker 原样）
HOST_PANEL_CONFIG_DIR="${PANEL_CONFIG_DIR}"
if command -v cygpath >/dev/null 2>&1; then
  HOST_PANEL_CONFIG_DIR="$(cygpath -m "${PANEL_CONFIG_DIR}")"
elif command -v wslpath >/dev/null 2>&1; then
  HOST_PANEL_CONFIG_DIR="$(wslpath -w "${PANEL_CONFIG_DIR}")"
fi

# 解析参数
DAEMON=false
case "${1:-}" in
  -d|--daemon) DAEMON=true; shift ;;
  --stop)
    echo "Stopping ${CONTAINER}..."
    docker stop "${CONTAINER}" 2>/dev/null || true
    docker rm -f "${CONTAINER}" 2>/dev/null || true
    echo "Done."
    exit 0
    ;;
  --logs)
    docker logs -f "${CONTAINER}" 2>/dev/null || echo "Container not running"
    exit 0
    ;;
esac

# 检查 .env.aio
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Copy .env.aio.example to ${ENV_FILE} and edit."
  exit 1
fi

# 检查 Panel 实例注册表
if [ ! -f "${PANEL_CONFIG_DIR}/metadata-instances.json" ]; then
  echo "ERROR: ${PANEL_CONFIG_DIR}/metadata-instances.json not found."
  echo "  hint: cp MemoryPanel/config/metadata-instances.example.json MemoryPanel/config/metadata-instances.json"
  echo "        and fill in gateway_endpoint / api_key, or set PANEL_CONFIG_DIR to the dir containing it."
  exit 1
fi

# 读取环境变量
ENV_ARGS=()
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  ENV_ARGS+=("-e" "${key}=${value}")
done < "$ENV_FILE"

PORTS=(
  -p 80:80
  -p 8420:8420
  -p 8424:8424
  -p 8125:8125
  -p 8096:8096
)

VOLUMES=(
  -v tdai-aio-data:/data
  -v "${HOST_PANEL_CONFIG_DIR}:/opt/panel/config:ro"
)

echo "═══════════════════════════════════════════════════"
echo "  Agent Memory AIO — 单体容器"
echo "═══════════════════════════════════════════════════"
echo ""

# 停止已有容器
docker rm -f "${CONTAINER}" 2>/dev/null || true

if $DAEMON; then
  echo "Starting in background..."
  docker run -d \
    --name "${CONTAINER}" \
    "${PORTS[@]}" \
    "${VOLUMES[@]}" \
    "${ENV_ARGS[@]}" \
    --restart unless-stopped \
    "${IMAGE}"
  echo "Container started: ${CONTAINER}"
  echo "Logs: docker logs -f ${CONTAINER}"
else
  echo "Starting in foreground (Ctrl+C to stop)..."
  docker run --rm \
    --name "${CONTAINER}" \
    "${PORTS[@]}" \
    "${VOLUMES[@]}" \
    "${ENV_ARGS[@]}" \
    "${IMAGE}"
fi
