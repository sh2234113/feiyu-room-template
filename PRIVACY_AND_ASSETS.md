# 隐私与素材边界

## 这个模板刻意不包含

- 作者/你的角色卡、私人记忆、聊天记录；
- QQ 号、群号、B 站 UID、账号昵称；
- `config.json`、`state/`、`audio/`、`assets/` 私人素材；
- 日志、备份、浏览器 localStorage；
- API Key、Cookie、扫码令牌、SnowLuma token、DSH token；
- 私人 3D 模型（`*.glb`）；
- 用户的照片、截图、二维码、语音。

## 这个模板包含

- 代码：桥接、MCP、房间、菜园、测试、安装脚本；
- `public/room/assets/pet/` 的 2D 立绘/动画；
- 示例角色 `roles/example.md`；
- 示例配置 `config.example.json`。

## 角色卡

模板的 `roles/example.md` 是**示例**，不是作者本人角色。  
你可以复制它并改成自己的角色，但**不要把私人角色卡提交到公开仓库**：

```bash
cp roles/example.md roles/我的角色.md
```

`.gitignore` 只保留 `roles/README.md` 和 `roles/example.md`。

## 2D 立绘

`public/room/assets/pet/` 来自 **dsh-pet**：

- 项目：<https://github.com/PC2005-cloud/dsh-pet>
- 形象：蓝毛小女仆
- 授权：**CC BY-NC-SA 4.0**（署名、非商业、相同方式共享）
- 代码 MIT，素材不是 MIT

公开仓库必须保留：

- `public/room/assets/pet/CREDITS.md`
- 页面底部的 dsh-pet 署名
- 本文件与 `THIRD_PARTY_NOTICES.md`

**不能**把立绘拿去做商业售卖、付费服务或商业宣传；如果改动素材，要按 CC BY-NC-SA 相同方式共享。

## 3D 模型

模板不包含作者的 `da-feiyu.glb`。  
`public/room/assets/models/` 只有说明文件；请放你自己有权分发的 GLB。  
没有模型时使用 2D 立绘，3D 按钮会失败，这是预期行为。

## 语音与贴纸

模板不包含任何人的声音或私人贴纸。  
`audio/` 和 `assets/` 默认被 `.gitignore` 排除。

## 房间灵感来源

见 `INSPIRATION.md`。只做公开署名，不复制原作者的视频、图片或文字。
