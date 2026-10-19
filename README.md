# ZhenWork · 臻作

可私有部署、按需使用的企业 AI 工作台。

ZhenWork 面向中小企业，把模型、员工工作空间、企业共享资料、Skill 和 MCP 工具放在一个工作入口中。员工可处理文档、表格与资料任务，企业通过管理后台配置身份、模型和资源权限，并按实际需要接入业务系统。

本仓库是开发预览源码，包含桌面端、企业网页入口、管理后台及当前使用的 Rust 执行核心。它尚未完成正式 Linux 环境、异机访问、完整业务任务和签名升级的交付验收。

## 产品方向

- 通用办公 Agent：文件读取、任务执行、产物预览和会话续聊。
- 企业管理：员工身份、共享资源、模型配置与授权。
- 扩展能力：Skill、MCP、助手和后台任务。
- 按需运行：员工 Core 空闲时可回收，后台任务按授权运行。
- 部署选择：企业服务器或专有环境；是否使用外部模型由部署方决定。

“按需使用”描述产品方向，不表示服务器、运维或模型调用免费。当前代码记录模型用量，尚未提供完整商业结算系统。

## 源码结构

| 路径 | 内容 |
| --- | --- |
| `AionUi-enterprise-poc/packages/desktop` | Electron 桌面端与界面 |
| `AionUi-enterprise-poc/packages/web-host` | 企业网页网关、员工 Core 生命周期与授权代理 |
| `AionUi-enterprise-poc/packages/web-cli` | 企业网页启动程序 |
| `AionUi-enterprise-poc/upstream-core` | 已应用企业补丁的 AionCore 源码 |
| `AionUi-enterprise-poc/upstream-aionrs` | 已应用企业补丁的 aionrs Agent 执行源码 |
| `deepseek-harness-lab/workbuddy/platform/ruoyi` | Java / RuoYi 管理控制面 |
| `deepseek-harness-lab/workbuddy/platform/plus-ui` | 管理后台前端 |
| `deepseek-harness-lab/workbuddy/migrations/rc2` | RC2 数据库迁移定义 |

保留现有目录、包名和 `AION_*` 配置键以维持构建及接口兼容。产品名称使用 ZhenWork；这些内部名称不表示本项目与 Tencent WorkBuddy 有关联。

## 开发入口

需要 Node.js、Bun、Java 21、PostgreSQL、Redis，以及与源码要求相符的 Rust / Docker 工具链。具体版本以各组件锁文件和 Dockerfile 为准。

```sh
git clone https://github.com/JokerMok/zhenwork.git
cd zhenwork/AionUi-enterprise-poc
bun install --frozen-lockfile
bash scripts/setup-enterprise-core.sh
bun run package
bun run --cwd packages/web-cli build
```

本仓库直接包含当前已打补丁的 Core 与 aionrs 源码；准备脚本检测到公开快照标记后直接使用这些源码。桌面应用的本地 Core 二进制和 managed resources 仍须按构建脚本生成，不能用未配置企业鉴权的上游二进制替换。

服务端部署和配置见 [部署说明](docs/deployment.md)。管理后台沿用 `platform/ruoyi/pom.xml` 与 `platform/plus-ui/package.json` 的构建入口。迁移脚本须由部署方在自己的测试数据库评审后应用。

## 来源与许可

本项目基于 AionUi、AionCore、aionrs、RuoYi-Vue-Plus 等组件构建。现有上游版权及许可证保留在对应目录，详见 [许可与来源](NOTICE.md) 和 [源码快照记录](SOURCE_PROVENANCE.json)。

公开仓库不额外改变各组件或此前未授权原创代码的许可范围。

## 发布范围

此公开快照包含源码、锁文件、构建脚本、测试和必要文档。试点账户、公司资料、运行日志、数据库、私有配置、凭据、安装件、上游宣传演示视频及历史 Git 提交未纳入公开仓库。配置样例中的凭据字段需要由部署方另行提供。
