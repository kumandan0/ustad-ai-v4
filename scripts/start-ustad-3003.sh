#!/bin/zsh

set -euo pipefail

PROJECT_DIR="/Users/ihu/Documents/New project"
NPM_BIN="/usr/local/bin/npm"
PORT="3003"
HOST="127.0.0.1"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$PROJECT_DIR"

if [ ! -f ".next/BUILD_ID" ]; then
  "$NPM_BIN" run build
fi

exec "$NPM_BIN" run start -- --hostname "$HOST" --port "$PORT"
