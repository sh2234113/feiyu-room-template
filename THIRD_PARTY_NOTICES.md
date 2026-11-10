# 第三方素材与依赖

## 代码

本项目代码：MIT，见 `LICENSE`。

## 2D 立绘 / 动画

- 来源：**dsh-pet** <https://github.com/PC2005-cloud/dsh-pet>
- 内容：`public/room/assets/pet/*.webm`、`*.png`、`public/room/assets/sound/click-duck.wav`
- 授权：**CC BY-NC-SA 4.0**
- 约束：署名、非商业、相同方式共享
- 详细署名：`public/room/assets/pet/CREDITS.md`

## 作者提供的 3D 模型

- 文件：`public/room/assets/models/da-feiyu.opt.glb`
- 来源：项目作者提供（Tripo 生成后减面/优化）
- 授权：版权归作者；随本模板用于个人、非商业展示
- 限制：不可单独提取、转售、商用或批量再分发；商用/二次创作需作者书面许可
- 文件：`public/room/assets/models/da-feiyu.glb`（58.9 MB，原始工程）和 `da-feiyu.opt.glb`（6.7 MB，运行时）

## Three.js

- `public/room/vendor/three.module.js`
- 授权：MIT
- 许可证文本：`public/room/vendor/LICENSE-three.txt`

## 运行依赖

见 `package.json`：

- `@deepseek-ai/dsh-host-apiproxy`
- `@deepseek-ai/schemastery`
- `@modelcontextprotocol/sdk`
- `@snowluma/mcp`
- `@snowluma/sdk`
- `js-yaml`
- `zod`

各自遵循其上游许可证。`@snowluma/*` 是第三方 SDK，本仓库不重新授权它。

## SnowLuma

SnowLuma 是独立软件，**不在本仓库内，也不随本仓库分发**。  
使用前请自行确认其许可证和 QQ 平台规则。

## 未包含

- 作者角色卡、语音、照片、聊天记录；
- 任何 API Key、Cookie、token。
