#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f config.json ]; then
  echo "缺少 config.json：先运行 ./scripts/install-template.sh，并编辑 config.json"
  exit 1
fi
exec npm start
