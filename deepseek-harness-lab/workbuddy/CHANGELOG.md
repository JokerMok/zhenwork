# Changelog

## 1.0.0-rc.1 — 候选准备，未发布

- 增加员工工作台、管理后台、身份与权限、品牌、知识与文件、审批导出、审计和用量。Local Bridge 按安全 Gate 进入 V1.1。
- 增加单企业 Compose 部署、加密备份/恢复、schema 校验升级与回滚、双架构构建及仅统一入口的远程验收路径。
- 加入镜像依赖裁剪、安全修补锁、整镜像 SBOM/漏洞扫描和第三方源码材料。
- 双架构最终镜像与原生模块检查、ARM64 真实业务/安全/运维和公网 Chrome 回归通过；双架构本地私有验收包已生成并完成哈希、镜像 blob 与架构校验，源码固定 5d797eb。真实 Linux AMD64、独立设备和目标容量 Gate 未通过，不是 Production Ready，未创建正式发布 tag。

## Unreleased

- 建立独立产品 Git，冻结 Alpha 源码/测试/报告与证据哈希；不修改官方 Harness。
- 保存 V1 初版九份规划及五份 ADR。
- 增加 R0 开源复用审计、R1 实际集成 Spike、R2 Foundation Decision 前置；暂停自建认证和聊天界面方案。
- 版本与所有实现/验证尚未达到 RC 或生产 Gate。

### Reuse R0
- 固定核心、知识、桌面和受限候选源码/许可证，形成五份复用决策文件与第三方锁。
- 官方 dashboard cleanup 已在隔离副本执行；认证改为 Better Auth 候选，不自建密码协议。
- R1 Spike 正在实现，尚未声称运行通过。

### Reuse R1
- 实际验证 assistant-ui/BFF/Harness、Better Auth/PostgreSQL、Admin/Brand 三个 Spike。
- 12 项认证、11 项浏览器生命周期、7 项投影回归通过；保留初始限流与内部提示投影失败证据。
- Next 更新至 16.3.5；当前依赖漏洞 0。Alpha 历史 174 份证据未变。

## 0.2.0-dev.1 — 2026-09-18

- P1: Node 24 / TypeScript workspaces, PostgreSQL 17 migrations and restricted application role.
- Better Auth schema integration, strict secret file configuration, idempotent enterprise bootstrap.
- Production UI shell source promotion with maintained license attribution; foundation CI and SBOM scans.
- Local foundation checks passed; no claim of product RC, remote CI or production acceptance.

### P2 identity and authorization

- Better Auth HTTP-only sessions with no token response body; persistent login limits and bounded password work.
- Server-side users/departments/roles, least-privilege delegation, last-admin guard, reset/revoke and first-login password change.
- Per-user transaction ordering prevents in-flight old-password login after reset. Identity events append to audit chain.
- 24 real HTTP positive/negative checks passed; product runtime and UI remain in progress.

### P3 employee workspace and runtime

- Formal assistant-ui adapter, persisted sessions/runs/approvals and safe WebSocket projection.
- Trusted isolated runtime manager, credential-isolated model gateway, tool approval and generated-file delivery.
- Real browser streaming/resume/cancel/retry and owner-bound tool workflows passed; preserved initial startup/protocol/cancel/cache failures.
- File uploads and dynamic knowledge remain P5; local four-runtime capacity is not a 20-user production claim.

### P4 administration and branding

- Separate admin shell with user, department, role, assistant, model and reviewed capability forms.
- Versioned full BrandConfig, safe re-encoded image assets, live branding and light/dark themes.
- Real browser password-change and revoked-account cache isolation checks; admin cannot read employee private files.
- 11 API groups and 13 browser checks passed; knowledge, usage/audit and backup pages remain staged work.

### P5
- 复用 multipart/拖拽/附件和 PDF/Office 解析库，增加持久文件任务、知识索引、来源版本与动态 ACL。
- 管理与员工知识界面、审批导出和关联文件撤权保护。修复恶意上传文件名导致服务退出及 MCP 实例令牌传递。
- 真实上传、浏览器、Harness 工作法/目录 MCP 与在途撤权本机验收通过；保留初次失败证据。
