# dsh-room-template

[安装指南](SETUP.md) · [生成自己的房子](HOUSE_GENERATION_PROMPT.md) · [GitHub 上传教程](GITHUB_UPLOAD.md) · [问题反馈](https://github.com/你的用户名/dsh-room-template/issues)

一个**公开、脱敏、可复刻**的 DeepSeek Harness + SnowLuma 房间模板：3D 大平层、家具、屋后菜园、电视投屏陪伴、QQ 桥接和网页私聊都在里面。

当前模板版本：`v0.1.0`。目标 DSH：`0.2.1-rc.2`；Node.js：`>= 22.13.0`。

> [!IMPORTANT]
> **这是一个模板，不是作者本人的运行存档，也不隶属于 SnowLuma、DeepSeek 或腾讯 / QQ。**
> 仓库不包含作者的角色卡、QQ 号、群号、聊天记录、记忆、语音、照片、私人 3D 模型、API Key、Cookie 或 `state/`。
> 2D 立绘来自第三方项目 dsh-pet，按 **CC BY-NC-SA 4.0** 使用；代码按 MIT 使用。两者授权不同，详见[素材与许可](#素材与许可)。

```text
浏览器 /room/  ──>  qq-bridge（本项目 Node 进程）──>  DSH Web API
       │                                      │
       ├── Three.js 房间 / 菜园 / 电视          ├── SnowLuma（可选，QQ）
       └── 本地房间 API                        └── MCP / agent presets
```

## 能做什么

| 场景 | 功能 |
| --- | --- |
| 3D 房间 | 客厅、厨房、餐厅、卧室、卫生间、阳台、玄关、走廊、屋后菜园；家具、灯光、昼夜、相机与第一视角 |
| 角色互动 | 点击移动、长按抓取、摸头/喂食/倒水/陪玩/叫醒、气泡、立绘/3D 模式切换 |
| 房间私聊 | 网页内和同一个角色聊天，不经过 QQ；聊天记录只存在浏览器 localStorage |
| 电视投屏 | 用 `getDisplayMedia` 把浏览器标签页共享到房间电视；50% / 80% / 全屏 |
| 跟随一起看 | 左下角立绘陪伴层，可调大小、开关气泡、截取电视画面说观后感 |
| 菜园 | 8 畦菜地、12 种作物、翻土/播种/浇水/施肥/采收/出售/买种子/买堆肥、自主照料 |
| QQ 桥接 | 文本、图片、表情、引用、合并转发；两代群聊仿真、角色卡、记忆与白名单 |
| 本地控制台 | 切换模式、管理白名单、查看日志和 token 用量 |

## 两种使用方式

### 方式 A：直接复刻这套房子

适合想快速看到效果的人。按 [SETUP.md](SETUP.md) 安装，得到和模板一致的户型、菜园、电视、陪伴层和 QQ 桥接。

### 方式 B：让 DSH 生成你自己的房子

适合想要不同风格、不同户型的人。不复制现有房子，只把需求告诉 DSH，让它从零搭自己的版本。

入口：[HOUSE_GENERATION_PROMPT.md](HOUSE_GENERATION_PROMPT.md)。  
里面有需求访谈、分阶段提示词、五套风格方向和一份可直接复制的设计 brief。

> 方式 A 是“代码/界面接近 1:1”；方式 B 是“生成你自己的版本”，两者不要混着用。

## 快速开始

准备：

- **Node.js >= 22.13**；
- **DeepSeek Harness**（目标 `0.2.1-rc.2`）；
- **SnowLuma**（可选，只影响 QQ；单独安装）；
- Chrome / Edge（投屏需要 `getDisplayMedia`）。

### 1. 获取项目

```bash
git clone https://github.com/你的用户名/dsh-room-template.git
cd dsh-room-template
npm ci
```

没有 Git 就下载 ZIP，解压后进入目录。

### 2. 创建配置

```bash
cp config.example.json config.json
```

Windows PowerShell：

```powershell
Copy-Item config.example.json config.json
```

### 3. 填写配置

编辑 `config.json`，至少核对这些字段：

| 字段 | 填写内容 |
| --- | --- |
| `ownerQQ` | 你的管理员 QQ；只填自己的 |
| `allow.private` / `allow.groups` | 允许接入的 QQ / 群；空白名单不响应任何会话 |
| `consoleToken` | 自己生成的一长串随机字符；不要发到群里 |
| `snowluma.wsUrl` / `httpUrl` | OneBot WS/HTTP 地址，默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| `snowluma.accessToken` | 如果 SnowLuma 配了 token 才填 |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` | 必须是当前 DSH 真实可用的 provider/model |
| `room.access` | 默认 `loopback`；房间只允许本机回环访问 |

### 4. 安装 DSH preset / MCP

```bash
node scripts/setup-dsh.mjs
```

这一步会注册 `qq-chat` / `qq-chat-v2` preset、三个 MCP server 和两个 DSH 插件。  
完成后**重启 DSH Web**，否则 preset 和工具不会生效。

### 5. 启动

```bash
npm start
```

打开：

```text
http://127.0.0.1:13100/room/
```

必须带结尾 `/`；`/room` 会 302，相对路径可能解析错。

Windows 也可以双击 `scripts/start.bat`；Linux/macOS 可运行 `./scripts/start.sh`。

### 6. 验收

```bash
npm run test:room
npm run test:home
npm run test:garden
npm run test:mcp-servers
```

浏览器检查：

- 进入菜园 / 返回小屋正常；
- 8 块菜畦、12 种作物、自主照料按钮存在；
- 电视投屏能选标签页；
- 「跟随一起看」左下角出现陪伴层，大小滑块、气泡、截屏按钮可用；
- 刷新页面无 500、无未捕获 JS 异常。

## 目录

```text
src/                桥接、DSH 客户端、MCP、记忆卡、花园、房间状态
public/room/        房间前端（Three.js / 菜园 / 电视 / 陪伴层）
public/console.html 控制台页面
plugins/            DSH 插件：qq-agent-presets / qq-mode-console
dsh/                qq-chat / qq-chat-v2 preset 源
roles/              示例角色卡（example.md）
scripts/            安装、预览、截图、测试
assets/             你自己的贴纸/图片目录（默认不提交）
```

运行后会自动生成 `config.json`、`state/`、`audio/`、`assets/` 等本地数据，均已被 `.gitignore` 排除。

## 文档与开发

| 我想…… | 入口 |
| --- | --- |
| 从零安装、配置、排查 | [SETUP.md](SETUP.md) |
| 让另一个 DSH 接手安装 | [AI_SETUP_PROMPT.md](AI_SETUP_PROMPT.md) |
| 生成自己的房子 | [HOUSE_GENERATION_PROMPT.md](HOUSE_GENERATION_PROMPT.md) |
| 上传到 GitHub | [GITHUB_UPLOAD.md](GITHUB_UPLOAD.md) |
| 查看隐私与素材边界 | [PRIVACY_AND_ASSETS.md](PRIVACY_AND_ASSETS.md) |
| 查看灵感来源 / 署名 | [INSPIRATION.md](INSPIRATION.md) |
| 查看第三方许可证 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## 素材与许可

- **代码**：MIT，见 [LICENSE](LICENSE)。
- **2D 立绘/动画/点击音效**：来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，**CC BY-NC-SA 4.0**（署名、非商业、相同方式共享），详见 [CREDITS](public/room/assets/pet/CREDITS.md)。
- **Three.js**：MIT，见 [LICENSE-three](public/room/vendor/LICENSE-three.txt)。
- **3D 模型**：模板不包含，需自行提供有授权的 GLB。
- **SnowLuma**：独立专有软件，不在本仓库内，也不随本仓库分发。
- **房间灵感来源**：见 [INSPIRATION.md](INSPIRATION.md)，只参考氛围，不复制原博主的视频/图片/文字。

## 使用边界

- 仅在自己知情并获准的 QQ 会话中使用，遵守平台规则；非官方 QQ 后端可能导致账号受限。
- 聊天内容会经 DSH 发送给你配置的模型服务；电视截屏观后感会把截图发送给支持图片输入的模型。
- `config.json`、`state/`、`audio/`、`assets/`、私人模型不要提交到公开仓库。
- 本模板不实现 QQ 登录或 OneBot 协议，不安装/打包/启停 SnowLuma。
- 电视投屏是浏览器标签页镜像，声音仍在原标签页；投屏控制扩展不随本仓库分发。
- 模板不包含作者的角色人格、私人记忆、语音和 3D 模型，所以**代码/界面接近 1:1，私人身份不 1:1**。
