#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22||(v[0]===22&&v[1]<13)){console.error('Node >= 22.13.0 required, current '+process.version);process.exit(1)}"
echo "[1/4] npm ci"
npm ci
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "[2/4] 已创建 config.json，请先编辑 ownerQQ / allow / consoleToken / snowluma"
else
  echo "[2/4] config.json 已存在，保留不覆盖"
fi
echo "[3/4] 注册 DSH preset / MCP"
node scripts/setup-dsh.mjs "${1:-web}"
echo "[4/4] 完成。请重启 DSH Web，然后运行 ./scripts/start.sh"
