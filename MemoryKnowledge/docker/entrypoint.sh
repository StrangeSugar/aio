#!/usr/bin/env bash
# Knowledge Service Docker entrypoint
set -euo pipefail

# Create data directory if it doesn't exist
mkdir -p "${KNOWLEDGE_DATA_DIR:-/app/data}"

# Execute CMD if provided, otherwise start server
if [ $# -gt 0 ]; then
  exec "$@"
else
  exec node /app/dist/server.mjs
fi
