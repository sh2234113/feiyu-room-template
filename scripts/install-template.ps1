$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$v = [int](node -p "process.versions.node.split('.')[0]")
if ($v -lt 22) { throw "Node >= 22.13.0 required" }
npm ci
if (-not (Test-Path config.json)) {
  Copy-Item config.example.json config.json
  Write-Host "已创建 config.json，请先编辑 ownerQQ / allow / consoleToken / snowluma"
} else {
  Write-Host "config.json 已存在，保留不覆盖"
}
node scripts/setup-dsh.mjs web
Write-Host "完成。请重启 DSH Web，然后运行 npm start"
