# 隐私与素材边界

## 这个模板刻意不包含

- 作者/你的角色卡、私人记忆、聊天记录；
- QQ 号、群号、B 站 UID、账号昵称；
- `config.json`、`state/`、`audio/`、`assets/` 私人素材；
- 日志、备份、浏览器 localStorage；
- API Key、Cookie、扫码令牌、SnowLuma token、DSH token；
- 原始 3D 工程文件已随模板附带（`da-feiyu.glb`，58.9 MB；页面不加载）；
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

模板附带作者提供的优化版展示模型和原始工程备份：

```text
public/room/assets/models/da-feiyu.opt.glb   6.7 MB，页面加载
public/room/assets/models/da-feiyu.glb       58.9 MB，原始工程，页面不加载
```

- 原始工程文件也包含在仓库中，因此仓库约 85 MB；
- 模型版权归作者，仅随模板用于个人非商业展示；
- 不可单独提取、转售、商用或批量再分发；
- 商用/二次创作需作者书面许可；
- 如果你不是作者，请先确认你有权公开这个模型。

没有模型时仍可使用 2D 立绘。

## 语音与贴纸

模板不包含任何人的声音或私人贴纸。  
`audio/` 和 `assets/` 默认被 `.gitignore` 排除。

## 房间灵感来源

见 `INSPIRATION.md`。只做公开署名，不复制原作者的视频、图片或文字。
