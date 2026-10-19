# 核心前端与认证候选源码审查

日期：2026-09-18；R0 只读审计，尚未作为 Spike 成功或 Production 通过。最新分支用于发现，实际安装必须锁定稳定包版本与源码 tag，不自动跟随 main。

## Better Auth

审查主线 `41b7dc15de41a8726422c392a4857d8764828891`；稳定候选 `v1.7.5 / 5468e6bfcdff799848537cf5ad06ebab15aad9dd`，已 fetch 并切到稳定 tag 检查。根 `LICENSE.md` MIT。`packages/better-auth/package.json` 导出 Node、React、db/migration、cookies、crypto，允许保留现有 Node BFF，无需迁移到特定框架。

实际读取 `src/integrations/node.ts`、`api/routes/session.ts`、`sign-out.ts`、`sign-in.ts`、`crypto/password.ts`、`api/middlewares/origin-check.ts`、`db/get-migration.ts`、admin plugin hooks/schema；password 转发官方 utils 的 scrypt 实现。数据库迁移支持 PostgreSQL/Kysely，有 schema、migration、session、origin、rate-limit 测试。根 docker-compose 是上游多数据库开发夹具，不能直接采用为产品生产 Compose。SECURITY.md 明确仅支持最新版本，必须持续跟踪漏洞与升级。

初步决定 ADOPT 包（待 Spike B）：认证/密码/Cookie/session/重置由库承担；不引入 organization/SaaS/billing。企业 RBAC 独立。关闭 cookie session cache，BFF 每次调用 getSession 并查员工 enabled/权限；禁用既删除会话也拒绝新会话。原始 admin plugin 有 impersonation 等多余 API，不能直接全量公开。服务器 handler 必须允许列表，仅暴露产品需要的认证路由；创建/重置通过受控服务端能力。必须测试 sign-out DB 失败与 revoke 效果：当前源码对部分删除异常捕获后仍清 Cookie，不能仅凭客户端显示注销证明服务端撤销。

原初版自建密码与 token 协议暂停。此库自身会话数据结构是兼容性约束，不在没有必要和测试时自定义改写其协议。Secret/token 不进入日志；若库默认保存可用 token，需最小数据库权限和备份加密，不假称默认只存 hash。

## Kiranism Dashboard Starter

审查 `7705dfc0d13889e45c26a55ad5908da6a7a9a605`，commit date 2026-08-25；最新 release `v2.0.0 / 06e83c0b0e937f98184b343b92756ae0cadd7c92`。根 LICENSE MIT / Copyright 2023 Kiranism。当前项目原本没有 React/Vite 前端，不存在迁移成熟前端的沉没成本，但仍需比较模板清理量。

源码：`src/components/layout/app-sidebar.tsx`、dashboard layout、`src/components/ui/table/data-table.tsx`、`src/hooks/use-data-table.ts`、`src/lib/form.ts`、query-provider、api-client、file-uploader；分别封装布局、TanStack 表格/分页/URL query、表单字段、React Query、react-dropzone。布局/鉴权依赖 Clerk，默认 org/billing 路由不适用。

`package.json` 提供 `cleanup`；实际读取脚本的 FEATURES、删除/模板替换/依赖清理/Git 安全检查。它可移除 clerk（含组织/Billing）、chat、ai-chat、notifications、kanban、examples、themes、sentry。`cleanup-templates/clerk` 去掉 Clerk 后的 use-nav 返回所有菜单，是无鉴权占位，必须被产品 RBAC 替换。可执行 cleanup 只在隔离 Spike 副本运行，不能对 Alpha 目录使用。

Dockerfile 有多阶段 standalone/non-root 思路，但构建参数仍含 Clerk；当前无测试脚本/专门测试目录和可采用业务迁移。初步 ADAPT 其清理后的 shell/基础组件/TanStack pattern，不采用 scripted AI chat、faker 后端、Clerk/SaaS/Billing、外部 Sentry、远程样例图源。需 Spike C 真实登录→员工表→品牌 API 才决策，不把模板 UI 当企业功能。

## assistant-ui/tool-ui

审查 `49a870286facdbf28160cd647f0d337ebdc9b275`，2026-08-31；根 LICENSE.md MIT / Copyright 2025 AgentbaseAI Inc.。没有 GitHub release，存在旧日期 tag；采用时锁定上述源码 SHA 和每个移植文件 hash。

实际读取 `apps/www/components/tool-ui/approval-card/{approval-card,schema,index}.tsx/ts`、shared/schema、safe-navigation 测试、package、组件注册表。它是 shadcn copy/paste 组件集，不是把整个 tool-ui Next demo 作为运行服务。ApprovalCard 有 approved/denied 收据、async 回调、Zod serializable schema，可直接适配服务端审批。组件不提供授权、幂等或审批 ID 归属保证；前端 choice 不是服务器结果。

初步 ADAPT 精选审批卡/状态/数据表，保留许可证与 upstream 文件来源；不要引入其 agent 包和样例模型服务形成第二 Runtime。数据先 schema 校验再渲染，URL/图片来自受控产品 API；安全链接测试有 javascript/data/protocol-relative 负例，可复用验证思路。根无产品 DB migrations/部署 Docker，属于组件候选而非完整平台。具体移植范围由 Spike A/C 决定。

## assistant-ui

审查主线 `5c5522271e67eade40482a555c836b9bf7301429`，commit date 2026-09-17（UTC 为 18 日），LICENSE MIT / Copyright 2025 AgentbaseAI Inc.。包候选 @assistant-ui/react 0.15.20 与 @assistant-ui/react-markdown 0.14.15，稳定 tag/source 在安装前再固定，不直接拿主线源码打包。

实际读取 packages/react/package.json、packages/react-markdown/package.json、core 的 external-store-adapter/thread-runtime-core/useExternalStoreRuntime、attachment/thread-history、RemoteThreadList 以及 example。ExternalStoreAdapter 提供 onNew/onCancel/onReload/onResume/onRespondToToolApproval、message converter 和 attachments；UI Runtime 只是视图状态，不替代 Harness Agent。`unstable_enableToolInvocations` 默认 false，保持关闭，避免浏览器重复执行服务端工具。

ThreadList 的旧 external-store 回调明确标为不稳定，持久历史采用服务端 owner 列表与绑定 Session 的 runtime，建立版本契约测试；无 cloud credentials/no cloud adapter，不调用其可选 assistant-cloud。包依赖含 cloud SDK 本身不等于网络调用，需浏览器网络证据确认没有云服务请求。AttachmentAdapter 只处理界面和上传回调，文件 ACL/扫描仍由 BFF。MessageStatus 可映射 incomplete/error/cancelled；不能用 isRunning=false 自动判完成，adapter 必须依据 terminal event。审批卡回调转为 BFF owner-bound approval，禁用客户端 tool result 写入能力。

候选有 external-store lifecycle、thread switch/history、attachments、tool approval 和 Markdown 测试及 SECURITY.md；没有可直接采用的企业 DB migration/生产 Compose，这不影响组件包复用。初步 ADOPT packages + INTEGRATE 一个 Harness/BFF WebSocket adapter；不引入 Vercel AI SDK/其他 Agent 作为主链。R1 Spike A 必须真实 chat/stream/cancel/resume/tool/approval 和失败状态。

证据：`evidence/v1/reuse-r0/core-repos-initial.json`、`core-tags.json`、候选 `.research` 固定 checkout。源码可由 `https://github.com/<owner>/<repo>/blob/<sha>/<path>` 对应复核。
