# 第一次把这个模板上传到 GitHub

> 如果你要走“方式 B：生成自己的房子”，先看 `HOUSE_GENERATION_PROMPT.md`。  
> 本文只负责把这个模板仓库上传。



> 你不需要会 Git。下面有三种方式，选一种即可。

## 上传前先做一次隐私检查

确认项目目录里**没有**：

- `config.json`
- `state/`
- `audio/`
- `assets/` 里的私人图片
- `public/room/assets/models/*.glb`
- 任何 `*.log`、`*.bak`、`*.zip`
- `node_modules/`

模板自带的 `.gitignore` 已经排除了这些。仍建议手动看一眼。

---

# 方式 A：GitHub Desktop（最推荐给新手）

## 1. 创建 GitHub 账号

打开 <https://github.com>，注册并登录。

## 2. 安装 GitHub Desktop

<https://desktop.github.com/>  
安装后登录你的 GitHub 账号。

## 3. 新建仓库

GitHub Desktop → **File** → **New repository**

- Name：`dsh-room-template`
- Description：`A sanitized DSH + SnowLuma room template`
- Local path：选择一个空文件夹的**上一级**，例如 `D:\GitHub`
- 不要勾选 “Initialize this repository with a README”（你已经有 README）
- License：可以稍后加；模板已带 MIT

创建后，把本模板目录里的**所有内容**复制到这个新仓库目录里（不是把模板文件夹再套一层）。

## 4. 提交并发布

GitHub Desktop 会列出变更：

1. 左下角 Summary 填 `Initial room template`
2. 点 **Commit to main**
3. 点顶部 **Publish repository**
4. 选择 Public（公开模板）或 Private（只给朋友）
5. 不要勾选 “Keep this code private” 如果想让别人复刻

## 5. 检查网页

打开你的 GitHub 仓库地址，确认：
- README 显示正常；
- 没有 `config.json` / `state/` / `audio/`；
- `public/room/assets/models` 里只有 README，没有 GLB。

---

# 方式 B：网页上传（文件不多时）

1. GitHub 右上角 **+** → **New repository**；
2. 填名字，选择 Public/Private；
3. **不要**勾选初始化 README（因为模板已有 README）；
4. 创建后点 **uploading an existing file**；
5. 把模板目录里的文件和文件夹拖进去；
6. Commit changes。

注意：

- 网页上传一次文件数量有限；本模板有几十个文件，建议分两三次上传；
- 不要拖整个外层文件夹，否则 GitHub 会多一层目录；
- 如果文件太多，改用 GitHub Desktop。

---

# 方式 C：命令行（会 Git 的人）

```bash
cd dsh-room-template
git init
git add .
git commit -m "Initial room template"
git branch -M main
git remote add origin https://github.com/sh2234113/feiyu-room-template.git
git push -u origin main
```

如果 GitHub 要求 token，用 **Personal Access Token** 或 GitHub CLI 登录；不要把 token 写进仓库。

---

# 上传后要改的地方

1. README 里的 `<你的仓库地址>` 改成真实地址；
2. 如果公开，保留 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`INSPIRATION.md`；
3. 如果你 fork 了别人的代码，保留原署名和许可证；
4. 如果仓库是 Public，**不要**把 `config.json`、`state/`、语音、模型和私人角色卡提交进去。

---

# 公开仓库前最后检查

```bash
git status
git ls-files | grep -E 'config\.json|state/|audio/|\.log$|\.glb$'
```

有输出就停下来，把对应文件从 Git 跟踪中移除：

```bash
git rm --cached <文件>
```

如果密钥曾经提交过，**删除文件不够**；Git 历史仍然有。应当：
1. 立刻作废/轮换该密钥；
2. 用新仓库重新提交干净内容，或按 GitHub 文档清理历史。

---

# 需要 Release 吗

不需要。别人 `git clone` 或下载 ZIP 就能按 `SETUP.md` 安装。  
如果你以后想发“一键包”，可以再打 Release，但不要在里面放 `config.json` 和 `state/`。
