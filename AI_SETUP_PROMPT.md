# 给 DSH 安装助手的提示词（复制给对方）

你是我的安装助手。请在一个**已有的 DSH + SnowLuma 环境**中，帮我把这个公开模板跑起来，并完成验收。

## 背景

这是一个已经脱敏的房间模板，包含：
- Node 桥接 `src/`；
- 3D 房间/菜园前端 `public/room/`；
- DSH preset 与 MCP 配置 `dsh/`、`plugins/`；
- 安装/测试脚本 `scripts/`；
- 示例角色 `roles/example.md`。

模板不包含我的角色卡、QQ号、群号、聊天记录、记忆、语音、私人 3D 模型、API Key、Cookie 或 `state/`。不要向我要这些私人数据。

## 先做环境检查，不要直接改文件

1. 确认项目根目录存在 `package.json`、`src/bridge.js`、`public/room/index.html`；
2. 运行 `node -v`，要求 >= 22.13.0；
3. 确认 `dsh --version` 可用；
4. 确认 DSH Web 的地址（默认 `http://127.0.0.1:3080`）；
5. 如果接 QQ，确认 SnowLuma WS/HTTP（默认 `ws://127.0.0.1:3001`、`http://127.0.0.1:3000`）；
6. 检查 `config.json` 是否已存在。**存在就备份，不要覆盖**；不存在才从 `config.example.json` 复制。

如果缺少 DSH/SnowLuma，不要假装成功；先告诉我缺什么，以及需要我提供哪些非敏感信息（例如 DSH profile 名、端口、是否已登录 QQ）。不要索要 Cookie、密码、API Key 或扫码令牌。

## 安装步骤

在项目根目录执行：

```bash
npm ci
```

如果失败，按顺序检查 Node 版本、npm registry、`node_modules` 权限，然后重试；不要删除 `package-lock.json`。

创建配置：

```bash
cp config.example.json config.json
```

然后让我填写这些字段（由我本人填，不要把密钥发到聊天里）：

- `ownerQQ`：我自己的 QQ；
- `allow.private`：只放我自己的 QQ；
- `allow.groups`：只放我允许的群；
- `consoleToken`：随机长字符串；
- `snowluma.accessToken`：如果 SnowLuma 配置了才填；
- `dsh.provider` / `dsh.model`：必须是当前 DSH 真实可用的 provider/model；
- `dsh.baseUrl`：如果不是 3080 要改。

完成后，运行：

```bash
node scripts/setup-dsh.mjs
```

如果脚本提示 profile 不存在，先确认 DSH 的 profile 名，再运行 `node scripts/setup-dsh.mjs <profile>`。  
**不要直接改 DSH 全局安装目录**，也不要覆盖别人已有的 preset；只合并本模板的 bundle/MCP。

setup 完成后，提醒我重启 DSH Web，让 preset 和 MCP 生效；不要在 DSH 未重启时下结论。

## 启动与验收

启动桥接：

```bash
npm start
```

然后检查：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13100/room/
```

用浏览器打开 `http://127.0.0.1:13100/room/`，检查：

1. 页面能加载，无 500/未捕获 JS 异常；
2. 进入菜园/返回小屋正常；
3. 8 块菜畦、12 种作物、自主照料按钮存在；
4. 电视投屏能弹出共享选择器；
5. 「跟随一起看」左下角出现陪伴层，大小滑块、气泡、截屏按钮存在；
6. 房间私聊能收到一句回复；
7. 刷新页面不丢配置。

运行：

```bash
npm run test:room
npm run test:home
npm run test:garden
npm run test:mcp-servers
```

## 接 QQ（如果我要接）

1. 确认 SnowLuma 已登录、OneBot WS/HTTP 正常；
2. 把 ownerQQ/allow 写对；
3. 用我的 QQ 私聊机器人；
4. 查看桥接日志是否出现 `preset qq-chat-v2` 和“新会话”；
5. 如果出现 `preset 不在 DSH 可用清单`，回到 setup/重启 DSH，不要回退到 standard 把本地工具暴露给 QQ。

## 隐私和素材

- 不要提交/上传 `config.json`、`state/`、`audio/`、`assets/`、`*.log`、`public/room/assets/models/*.glb`；
- 模板只有 2D 立绘（dsh-pet，CC BY-NC-SA 4.0），3D 模型目录是空的；
- 不要把我私人的角色卡、语音、照片、聊天记录复制进公开目录；
- 不要把 API Key、Cookie、QQ号、群号写进 README 或截图。

## 出问题时

优先看：

```bash
tail -n 100 state/bridge.log
```

以及浏览器 Console、DSH 日志、`chrome://extensions`（如果用到电视控制扩展）。  
报告时只贴**脱敏后的错误**，不要贴 token、Cookie、完整 URL 查询参数或私人聊天内容。

完成后给我一份清单：实际目录、版本、启动方式、端口、测试结果、尚未验证的项。不要把“改文件成功”当成“已经跑通”。
