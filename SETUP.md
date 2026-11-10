# 安装与验收（从零开始）

> 目标：在一台自己的电脑/云主机上，把房间、DSH、桥接和（可选）QQ 跑起来。  
> 下面的命令默认在**项目根目录**执行。Windows PowerShell 与 Linux/macOS 的路径写法略有不同，见文末。

---

## 选择路径

- **直接复刻模板**：继续按本文安装；
- **让 DSH 生成自己的房子**：不要按本文装，去看 [HOUSE_GENERATION_PROMPT.md](HOUSE_GENERATION_PROMPT.md)。

## 0. 先确认你要装的是哪一层

```text
浏览器 /room/  ──>  qq-bridge（本项目 Node 进程）──>  DSH Web API
       │                                      │
       └──────── 静态房间 / Three.js            ├── SnowLuma（可选，接 QQ）
                                                └── MCP servers / presets
```

- 只玩房间：需要 Node + 本项目 + DSH；SnowLuma 可以先不接；
- 接 QQ：额外需要 SnowLuma、QQ 账号、OneBot v11 配置；
- 房间私聊/电视观后感：需要 DSH 模型可调用；
- 3D 模型：模板附带作者授权的优化版 GLB；语音库/贴纸默认不带。

---

## 1. 安装 Node.js

要求 **Node >= 22.13.0**。

```bash
node -v
npm -v
```

如果版本低，去 <https://nodejs.org/> 安装 LTS/当前版；或用 nvm/fnm 管理。

---

## 2. 安装 DeepSeek Harness（DSH）

本项目按 **DSH 0.2.1-rc.2** 的 API/preset 机制编写。请先在你自己的环境安装并启动 DSH Web：

```bash
dsh --version
```

如果你还没有 DSH，请先按 DeepSeek Harness 官方安装说明完成安装，并确保它监听：

```text
http://127.0.0.1:3080
```

`config.example.json` 默认就是 3080。若你的端口不同，改 `config.json` 的 `dsh.baseUrl`。

> 本项目不附带 DSH 本体，也不替你安装/升级 DSH。

---

## 3. 安装 SnowLuma（只有接 QQ 才需要）

SnowLuma 是 QQ → OneBot v11 的网关，**专有软件，不在本仓库内**。你需要自己安装并：

1. 登录机器人 QQ；
2. 开启 OneBot v11 WebSocket，默认 `ws://127.0.0.1:3001`；
3. 开启 OneBot HTTP API，默认 `http://127.0.0.1:3000`；
4. 如果设置了 access token，填到 `config.json` 的 `snowluma.accessToken`。

只玩房间可以跳过；桥接启动时 SnowLuma 连不上会重试，不影响 `/room/`。

如果要使用 **NapCat** 而不是 SnowLuma，把 `config.json` 的 `"gateway"` 改成 `"napcat"`，并把 `snowluma.wsUrl/httpUrl/accessToken` 指向 NapCat 的 OneBot 11 服务；详见 [NapCat 接入](docs/guides/NAPCAT.md)。

---

## 4. 下载本模板

### 下载方式 1：Git

```bash
git clone <你的仓库地址> dsh-room-template
cd dsh-room-template
```

### 下载方式 2：下载 ZIP

GitHub 仓库页 → **Code** → **Download ZIP** → 解压 → 进入目录。

---

## 5. 安装依赖

```bash
npm ci
```

如果没有 `package-lock.json`，用：

```bash
npm install
```

`postinstall` 会执行 `scripts/patch-snowluma-sdk.mjs`；这是给 `@snowluma/sdk` 打的兼容补丁，属于本项目的一部分。

如果安装失败：

```bash
node -v          # 必须 >= 22.13
npm config get registry
npm ci --foreground-scripts
```

---

## 6. 创建本地配置

```bash
cp config.example.json config.json
```

Windows PowerShell：

```powershell
Copy-Item config.example.json config.json
```

然后编辑 `config.json`。**这个文件永远不要提交到 GitHub。**

最低限度要改：

### 6.1 管理员 QQ

```json
"ownerQQ": 123456789
```

### 6.2 白名单

```json
"allow": {
  "private": [123456789],
  "groups": [123456789]
}
```

只填你自己的 QQ / 群。不要 `allowAllWhenEmpty: true` 上公网。

### 6.3 控制台 token

```json
"consoleToken": "换成一长串随机字符"
```

生成一个：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

这个 token 只放本地 `config.json`，不要发群里。

### 6.4 SnowLuma

```json
"snowluma": {
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": ""
}
```

如果 SnowLuma 没设 token，保持空字符串。

### 6.5 DSH 模型

`config.example.json` 的 `dsh.provider/model` 是示例值。请改成**你自己的 DSH 里真实可用的 provider/model**。  
如果模型不支持图片，电视截图观后感会失败，但房间和文字聊天仍可用。

---

## 7. 把 preset / MCP 挂到 DSH

```bash
node scripts/setup-dsh.mjs
```

它会把：

- `qq-chat` / `qq-chat-v2` preset；
- `mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe`；
- 两个 DSH 插件 bundle

注册到当前 DSH profile（默认 `web`）。

如果提示找不到 DSH/profile：

```bash
node scripts/setup-dsh.mjs web
# 或指定 DSH_HOME
DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs web
```

完成后**重启 DSH Web**（不是在浏览器里刷新）：

```bash
# 如果你用 systemd
sudo systemctl restart dsh-web
```

> 不重启，preset 和 MCP 新工具不会生效。

---

## 8. 启动桥接

```bash
npm start
```

看到类似：

```text
本地控制台已启动：http://127.0.0.1:13100
DSH 已就绪
```

就成功了。浏览器打开：

```text
http://127.0.0.1:13100/room/
```

> 必须带结尾斜杠 `/room/`；`/room` 会 302，相对路径可能解析错。

---

## 9. 只玩房间（不接 QQ）

不需要改 `ownerQQ`，也不需要 SnowLuma。直接：

1. `config.json` 里 `ownerQQ` 可以先留 null；
2. 启动桥接；
3. 打开 `/room/`；
4. 用鼠标拖动、点击、抓取、聊天、看电视、种菜。

房间自己的 API 默认只允许本机回环访问；如果要从别的机器访问，见第 13 节。

---

## 10. 接 QQ

1. SnowLuma 登录 QQ；
2. `config.json` 填 `ownerQQ`、`allow.private`、`allow.groups`；
3. 启动桥接；
4. 在 QQ 私聊机器人，或在白名单群 @ 她；
5. 第一次会创建 DSH 会话；日志出现“新会话 … preset qq-chat-v2”即成功。

如果日志出现：

```text
preset "qq-chat-v2" 不在 DSH 可用清单
```

说明 `scripts/setup-dsh.mjs` 后没有重启 DSH，或 DSH profile 选错。

---

## 11. 设置角色

模板只带示例角色：

```text
roles/example.md
```

复制一份，改文件名和内容：

```bash
cp roles/example.md roles/我的角色.md
```

然后在控制台人格页选择它，或在 QQ 里让管理员切换。  
**角色卡属于个人创作，默认不要提交到你自己的公开仓库。**

---

## 12. 可选：3D 模型、语音、贴纸

### 12.1 3D 模型

模板已经附带作者授权的优化版模型和原始工程备份：

```text
public/room/assets/models/da-feiyu.opt.glb   6.7 MB，页面加载
public/room/assets/models/da-feiyu.glb       58.9 MB，原始备份，页面不加载
```

页面默认仍使用 2D 立绘；切到 3D 时加载 6.7 MB 优化版。
3D 模式下点右上「画质」可切换到 58.9 MB 原始工程模型；首次加载较慢，切回标准会释放源模型显存。  
模型版权归作者，仅随模板用于个人非商业展示；不要单独转售、商用或批量再分发。  
要换模型：保持 Y 轴向上、脚底 y=0、正面朝 +Z，并修改 `public/room/model-actor.js` 的 `MODEL_URL`。

### 12.2 语音

把音频放 `audio/`（默认被 gitignore），在控制台开启语音发送。  
模板不包含任何人的声音素材。

### 12.3 贴纸/图片

放 `assets/`（默认被 gitignore）。公开仓库不要放别人的照片、聊天截图和二维码。

---

## 13. 从另一台机器访问房间

默认 `room.access=loopback`，只允许本机回环。  
如果房间跑在云主机，建议用 SSH 隧道，而不是把端口裸奔到公网：

```bash
ssh -L 13100:127.0.0.1:13100 user@your-server
```

然后本机浏览器打开 `http://127.0.0.1:13100/room/`。  
这样房间 API 仍然走回环，不需要把 token 暴露到公网。

如果一定要反向代理，请自己配置 HTTPS、访问控制和 `config.json` 的 `room.access`，并阅读 `docs`/代码里的安全注释。

---

## 14. 自检

```bash
npm run test:room
npm run test:home
npm run test:garden
npm run test:mcp-servers
```

浏览器检查：

- `/room/` 能打开；
- 点「进入菜园」/「返回小屋」正常；
- 电视投屏能选标签页；
- 「跟随一起看」左下角出现陪伴层，大小滑块、气泡、截屏按钮可用；
- 刷新页面后没有 500/JS 报错。

---

## 15. 常见问题

### `EADDRINUSE :13100`

已经有一个桥接进程。不要重复 `npm start`：

```bash
ps aux | grep 'src/bridge.js'
# 只保留一个；用 systemd/nohup 管理时先停旧进程
```

### DSH 连不上

```bash
curl -I http://127.0.0.1:3080
```

检查 `config.json` 的 `dsh.baseUrl`、DSH 是否启动、是否需要 auth token。

### SnowLuma 连不上

只影响 QQ，不影响房间。检查 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` 和 access token。

### 房间打开但黑屏

- 用 Chrome/Edge，不要用不支持 WebGL 的内置浏览器；
- 更新显卡驱动；
- 先不要点 3D，确认 `public/room/assets/models/da-feiyu.opt.glb` 已下载（约 6.7 MB；旁边 58.9 MB 的 `da-feiyu.glb` 只是原始备份，不需要加载）。

### 电视观后感失败

模型必须支持图片输入。查看桥接日志里的 `[电视]` 错误；如果模型只支持文字，这个功能不可用，但房间正常。

---

## 16. 安全底线

- 不把 `config.json`、`state/`、`audio/`、`assets/`、`*.log` 提交到 GitHub；
- 不在公开仓库放 QQ 号、群号、Cookie、API Key、DeepSeek token、SnowLuma token；
- 不要给陌生人你的控制台 token；
- 不要在群里让机器人执行“读文件/执行命令/改配置”；
- `qq-chat-v2` preset 的设计前提就是 agent 没有本地工具；
- 升级 DSH/SnowLuma 前先备份 `config.json` 和 `state/`。

---

## 17. 目录与版本

- 目标 DSH：`0.2.1-rc.2`
- Node：`>=22.13.0`
- 本项目代码：MIT
- 2D 素材：dsh-pet CC BY-NC-SA 4.0（见 `public/room/assets/pet/CREDITS.md`）
- 灵感署名：见 `INSPIRATION.md`
