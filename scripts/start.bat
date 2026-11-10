@echo off
cd /d "%~dp0\.."
if not exist config.json (
  echo 缺少 config.json：先复制 config.example.json 为 config.json 并编辑。
  pause
  exit /b 1
)
npm start
pause
