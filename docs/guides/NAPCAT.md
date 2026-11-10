# 用 NapCat 替代 SnowLuma 接 QQ

桥接现在支持两种 OneBot 11 网关：

```text
gateway: "snowluma"  默认，保持原来的 SnowLuma 链路
gateway: "napcat"    NapCat / OneBot 11 兼容链路
```

NapCat 与 SnowLuma 共用 `config.json` 里的 `snowluma.*` 端点字段——字段名是历史原因，实际指向哪个网关由 `gateway` 决定。

## 1. 安装 NapCat

NapCat 是独立项目，不在本仓库内：

- 项目：<https://github.com/NapNeko/NapCatQQ>
- 自行安装、登录 QQ，并开启 **OneBot 11**；
- 需要开启 **HTTP API** 和 **WebSocket 服务端**；
- 默认端口通常为：

```text
WebSocket: ws://127.0.0.1:3001
HTTP API:  http://127.0.0.1:3000
```

如果 NapCat 的 WS/HTTP 都设置了 access token，填到 `snowluma.accessToken`。

## 2. 修改 config.json

```json
{
  "gateway": "napcat",
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "NapCat 的 token，没有就留空"
  }
}
```

注意：

- NapCat 不需要 `snowluma.homeDir` / `launcherPath`；
- `gateway: "napcat"` 时桥接不会去 SnowLuma 的 config 目录做 token 自愈；
- 不建议把 `accessToken` 提交到 GitHub；
- `ownerQQ`、`allow.private`、`allow.groups` 仍然照常填写。

## 3. 重启桥接

```bash
systemctl restart qq-bridge
```

日志应该看到类似：

```text
[bridge] NapCat 已连接：ws://127.0.0.1:3001
[bridge] 机器人昵称: ...
```

如果看到 `SnowLuma` 字样，说明 `gateway` 还是 `snowluma`，或者配置文件没有保存成功。

## 4. 测试

先私聊机器人：

```text
在吗
```

再在允许的群里 @ 它。

如果连接成功但收不到消息，检查：

- NapCat 的 WS 是否真的在监听 3001；
- WS 是否要求 token；
- NapCat 是否登录了目标 QQ；
- `allow` 是否包含当前 QQ/群；
- 防火墙是否拦了本机端口。

## 5. 常见错误

| 现象 | 检查 |
|---|---|
| 401 / 403 | `snowluma.accessToken` 与 NapCat 的 token 不一致 |
| `HTTP 426` | `httpUrl` 误填成了 WS 端口，应填 HTTP API 端口 |
| WS 连不上 | `wsUrl` 端口、路径、NapCat WS 服务端是否打开 |
| 能发不能收 | NapCat 事件/OneBot 版本、`self_id`、白名单 |
| 表情/贴纸工具失败 | NapCat 不一定实现 SnowLuma 扩展 action，核心聊天不受影响 |

## 6. 安全边界

NapCat 和 SnowLuma 一样是第三方非官方 QQ 接入方案：

- 有账号被限制/冻结的风险，建议用小号；
- 不要把 QQ 密码、二维码、token 发到公开仓库或群里；
- 不要在公开仓库提交 `config.json`、`state/`、`audio/`；
- 本项目不安装、不打包、不启停 NapCat，也不对账号风险作保证。

## 7. 切回 SnowLuma

把：

```json
"gateway": "napcat"
```

改回：

```json
"gateway": "snowluma"
```

再确认 `snowluma.wsUrl/httpUrl/accessToken/homeDir` 是 SnowLuma 的配置，重启桥接即可。
