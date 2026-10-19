---
name: xiaohongshu-recruiter
description: 用于在小红书上发布高质量的 AI 相关岗位招聘帖子。包含自动生成极客风格的招聘封面图和详情图，并提供自动化发布脚本。当用户需要发布招聘信息、寻找 Agent 设计师或其他 AI 领域人才时使用。
---

> **⚠️ Platform note — read before running any command.** The command examples here are written for **macOS / Linux**. On **Windows**: run `python` (or `py`) instead of `python3`, use `$env:USERPROFILE\…` and backslashes instead of `~/…`, and translate any shell pipes/redirects (`|`, `>`, `&&`) to their PowerShell equivalents before running. The scripts themselves are cross-platform; only the way you invoke them differs.

# Xiaohongshu Recruiter (小红书招聘助手)

网页端 Core 可以生成文案和图片，但不能展示此技能使用的有界面登录浏览器。
在网页端交付待审核发布包，由用户在自己的浏览器中登录、检查并发布；
不要在员工容器中安装 Playwright 或运行 `publish_xiaohongshu.py`。

本技能旨在帮助用户快速、专业地在小红书发布 AI 岗位的招聘信息。通过 "Systemic Flux" 设计理念生成符合极客审美的视觉素材，并提供 Playwright 脚本实现半自动化发布。

## 核心工作流

### 简化模式（默认）

当用户仅给出一句话指令（如“发布一个前端开发工程师的招聘信息到小红书”）时：

1. 不再向用户追问细节，由模型自行补全招聘信息与文案。
2. 不要求用户提供邮箱或投递方式，模型自动补一个“私信联系/评论联系”的默认投递方式。
3. 自动生成封面图与详情图，连同文案交付待审核发布包。
4. 仅在有可见的用户浏览器且用户明确授权发布时进入发布流程。

### 1. 信息收集

向用户确认（仅在用户明确要求或关键信息冲突时才询问）：

- **岗位名称** (如：Agent Designer)
- **核心职责 & 要求**
- **投递邮箱**

### 2. 生成视觉素材 (Visual Generation)

先写入 `job.json`：`role`、`description`、`apply` 为非空字符串，
`responsibilities`、`requirements` 为字符串数组；可选 `coverLine1`、
`coverLine2`、`slogan1`、`slogan2`。未提供投递方式时使用“私信联系”，
不要虚构邮箱、公司或岗位要求。再用本地脚本生成图片。

- **操作**：
  ```bash
  node scripts/generate_images.js job.json ./output
  ```
- **产出**：`output/cover.png`, `output/jd_details.png`

### 3. 生成文案 (Content Generation)

生成符合小红书调性的文案，保存为 `post_content.txt`。

- **规则**：参考 `assets/rules.md`。
- **标题**：<20 字。
- **正文**：包含话题标签。

### 4. 自动化发布 (Auto Publishing)

使用 `scripts/publish_xiaohongshu.py` 启动浏览器进行发布。

**桌面端前置要求**（网页端跳过此节）：

- 使用已配置 Playwright 和可见 Chromium 的桌面环境；若不可用，交付待审核发布包。

**执行命令**：

```bash
python3 scripts/publish_xiaohongshu.py "你的标题" "post_content.txt" "cover.png" "jd_details.png"
```

**交互流程（简化一键发布）**：

1. 观察浏览器窗口：脚本已打开小红书创作者中心。
2. 若出现登录页，请扫码登录。
3. 登录完成后，脚本自动上传图片并填写标题与正文。
4. 脚本自动点击“发布”完成发布；浏览器保持打开供用户确认。

## 资源文件

- **assets/design_philosophy.md**: 视觉设计哲学。
- **assets/rules.md**: 详细的操作规范和平台限制。
- **scripts/generate_images.js**: 图片生成脚本。
- **scripts/publish_xiaohongshu.py**: 发布自动化脚本。
