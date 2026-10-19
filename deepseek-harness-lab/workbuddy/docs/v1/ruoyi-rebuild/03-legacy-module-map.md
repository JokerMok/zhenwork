# 03｜RC1 旧后端模块盘点

> 状态：基于 RC1 技术基线的源码盘点与迁移设计草案。未实现迁移、未切换路由、未运行数据库/API/build 验证。
>
> 基线：`baseline/rc1-technical`（`addff08`）；上游版本以 `ruoyi-upstream.lock.json` 锁定 RuoYi-Vue-Plus `v6.0.0`、plus-ui `v6.0.0-Vue`。

## 判定边界

RC2 的业务权威统一放在 RuoYi Backend。RuoYi + Sa-Token 负责身份、User、Department、Role、Menu、Permission 和 Data Scope；AI 资源 ACL 在 RuoYi 之上实现。旧 Node BFF、Better Auth 和旧 bearer 身份不能继续与它们并列。

Runtime Manager、Model Gateway 和 Harness bridge 可以继续作为执行基础设施，但只能接收 RuoYi 签发且绑定 user/session/run/resource scope、有效期和 authorization version 的服务凭证。它们不持有业务 RBAC、资源 ownership、Knowledge ACL 或 Model Permission。

分类含义：

- `MIGRATE`：迁移业务数据和历史事实，迁移后由 RuoYi 承担写入权。
- `REPLACE`：旧实现退出业务入口，改由 RuoYi 原生能力或 RuoYi 扩展服务实现。
- `KEEP_AS_EXECUTION_SERVICE`：保留进程或协议，只负责运行时执行、解析或模型调用。
- `REMOVE`：从 RC2 业务路径移除；旧源码和证据仍按基线留存，不能作为新的写入源。

## 模块映射

| 能力 | 判定 | RC1 实际证据 | RC2 归属与处理 |
|---|---|---|---|
| Auth | `REPLACE` | `apps/server/src/auth.ts:L9-L24,L42-L49` 使用 Better Auth、`/api/auth`、12 小时 `auth_sessions`；`apps/server/src/auth-routes.ts:L31-L103` 由 Better Auth 管 cookie；表结构在 `migrations/0001_auth.sql:L1-L9`。 | 登录、注销、改密改到官方 `/auth/login`、`/auth/logout` 和 RuoYi 用户资料接口。RuoYi `platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/controller/AuthController.java:L53-L107,L165-L172`、`platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/service/impl/PasswordAuthStrategy.java:L56-L83`、`platform/ruoyi/ruoyi-common/ruoyi-common-satoken/src/main/java/org/dromara/common/satoken/utils/LoginHelper.java:L54-L65` 是唯一身份入口。旧 auth 表和旧 session 不进入新授权体系。 |
| RBAC | `REPLACE` | `apps/server/src/auth.ts:L31-L52` 从旧 `users/roles/role_permissions` 计算 Principal；`apps/server/src/iam.ts:L12-L37,L171-L220` 自己维护角色与权限。 | `sys_user/sys_dept/sys_role/sys_menu` 和 RuoYi Permission/Data Scope 为基础权威；AI ACL 作为扩展域。旧 permission code 只做映射输入，不保留第二套鉴权。官方表定义在 `platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql:L70-L89,L128-L150,L239-L257,L289-L314,L481-L509`。 |
| User | `MIGRATE` | `migrations/0002_enterprise.sql:L1-L7` 的 `users.id` 为 TEXT 且引用 `auth_users`；`apps/server/src/iam.ts:L48-L127` 读写用户、启用状态、部门、角色和 `must_change_password`。 | 用户资料、启用状态、部门归属、角色关联迁到 `sys_user` 等原生表。RuoYi `user_id` 是 BIGINT；映射和密码处理见 [04-data-migration.md](./04-data-migration.md)。客户端把 BIGINT 作为字符串传输。 |
| Session Ownership | `MIGRATE` | `apps/server/src/conversations.ts:L14-L22,L55-L90` 对 `sessions.owner_id`、ACL 版本、运行状态、事件游标和 WebSocket 连接做 owner 检查；`conversations.recover()` 会把运行中任务标为 interrupted。 | 迁移会保留 session 元数据、历史快照、事件和 owner 关系，但 owner 改为映射后的 RuoYi `sys_user.user_id`。活动中的 RC1 runtime/session 不导入为新活动授权；按恢复规则封存为 interrupted，再由 RuoYi 创建新 run。 |
| Knowledge | `MIGRATE` | `apps/server/src/knowledge.ts:L5-L24,L26-L54` 实现 Knowledge ACL、搜索、来源和管理员路由；`apps/server/src/jobs.ts:L5-L23` 负责解析、版本和索引；表在 `migrations/0002_enterprise.sql:L23-L31`、`migrations/0006_knowledge_files.sql:L1-L10`。 | Knowledge Base、Document、Version、Index、Job、Citation 和 ACL 迁到 RuoYi AI 域。RuoYi 读取当前身份后再做 ACL；旧索引只能作为可重建数据，迁移后必须完成目标索引重建和权限抽查。 |
| Model | `MIGRATE` | `apps/server/src/admin.ts:L23-L25` 管理 `models`；`apps/gateway/src/main.ts:L7-L15,L29-L45` 按 runtime token 校验 model 并调用 provider；旧 schema 的 `provider_code` 目前只允许 `ark`（`migrations/0002_enterprise.sql` 中 models 定义）。 | 模型配置、启用状态、上限、价格和审计事实迁到 RuoYi AI Model 配置；provider secret 留在 Gateway/Secret Service。Gateway 仍执行调用，RuoYi 决定用户能否使用模型。现有 provider 只有 Ark 的事实不能扩展成已支持更多 provider。 |
| Assistant | `MIGRATE` | `apps/server/src/admin.ts:L29-L38` 读写 assistant、model、tools、roles、knowledge bases；`apps/server/src/conversations.ts:L56-L60` 按 assistant role 和 model enabled 决定可用项。 | Assistant 配置、版本、Model 引用、Skill/MCP/Tool 引用、Knowledge 引用和分享关系迁到 RuoYi AI 域。RC1 `assistants` 表没有 owner 字段；按 00-decision 的迁移策略归为 ENTERPRISE，保留角色授权；不猜测具体员工 owner，冲突记录进入 quarantine。 |
| Skill | `MIGRATE` | RC1 将 skill 作为 `capabilities.kind`（`migrations/0002_enterprise.sql` 的 capabilities 定义）；管理员开关在 `apps/server/src/admin.ts:L26-L28`；实际 bridge 只把 `proposal_skill` 映射到 `proposal-workflow`（`runtime/v1/bridge.mjs:L9-L22,L40-L44`）。 | Skill manifest、版本、启用状态、资源 ACL 和 Assistant 绑定迁到 RuoYi。运行时仍由 bridge 执行；迁移不得把数据库中的 capability 行当成已经支持的完整 Skill。实际支持范围以 manifest、bridge 和验收为准。 |
| MCP | `MIGRATE` | `runtime/v1/catalog-mcp.mjs` 通过 capability 调用目录搜索；`runtime/v1/bridge.mjs:L9-L22,L36-L39` 暴露 `catalog_search`，并由 `capabilities` policy 控制。 | MCP Template、连接配置、transport/auth 元数据和 ACL 迁到 RuoYi；MCP 进程仍是执行服务。RC1 现有证据只证明 catalog search 路径，不能推导个人凭据、全部 transport 或任意外部 MCP 已实现。 |
| Tool | `KEEP_AS_EXECUTION_SERVICE` | `runtime/v1/bridge.mjs:L17-L39` 注册 read/write/search/export 工具，导出需要 approval；`apps/server/src/capabilities.ts:L1-L23` 在 BFF 侧做 capability、owner、run、ACL 和 approval 校验。 | Tool catalog、类型、启用策略和 Assistant 绑定迁入 RuoYi；read/write/MCP/tool call 仍在 bridge/执行服务运行。执行服务不接受客户端自报身份；每次调用由 RuoYi capability service 授权。 |
| Audit | `MIGRATE` | `apps/server/src/audit.ts:L4-L29` 用 HMAC 链写 `audit_events`；`apps/server/src/operations.ts:L17-L46` 提供查询和链校验。 | RC1 Audit 原始签名载荷及 hash 链原样封存到 RuoYi 的 AI audit 扩展表，actor/resource 映射另列，禁止改写原载荷破坏旧链；RuoYi 原生登录/操作日志承接系统行为（官方 `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/monitor/SysOperlogController.java:L30-L83`）。AI Call、Tool/MCP Call、Knowledge/File Access、Approval、Share 和 Security Event 不能因迁 RuoYi 而丢失。 |
| Usage | `MIGRATE` | `apps/server/src/operations.ts:L48-L53` 按 user/department/model 聚合 `usage_events`；Gateway 在 `apps/gateway/src/main.ts:L53-L58` 写 token、latency、result 和 usage 状态。 | Usage events、quota、reservation 和历史聚合迁到 RuoYi AI usage 域；`user_id/department_id` 指向映射后的 BIGINT。重复迁移不得重复计费、扣额或统计；当前 `cost:null/costStatus:unavailable` 只能原样标为成本不可用。 |
| Branding | `MIGRATE` | `apps/server/src/main.ts:L65-L73` 公共读取 `/api/brand`；`apps/server/src/admin.ts:L14-L22` 做版本校验、图片检查和品牌配置写入；品牌文件仍落到旧 local file store。 | 品牌配置迁到 RuoYi 配置/AI branding 域，资产迁到 RuoYi OSS/File infrastructure；公共读取不应绕过资产扫描和授权后的公开引用。并发更新继续使用版本或等价条件写。 |
| File | `MIGRATE` | `apps/server/src/files.ts:L12-L27` 使用 UUID、owner、sha256、scan/parse 状态和本地 `dataDir/files`；`apps/server/src/jobs.ts:L9-L20` 解析并建索引。 | 文件元数据、owner、session 关联、扫描/解析结果和 ACL 迁到 RuoYi；内容搬到 OSS/File infrastructure，迁移以 sha256 和源对象键核对。运行时工作区中的临时副本不是业务文件权威。文件 UUID 尽量保留，owner 改成 RuoYi BIGINT。 |
| Approval | `MIGRATE` | `apps/server/src/conversations.ts:L27-L33,L62-L72` 生成 pending approval、args hash、过期时间并持久化；`runtime/v1/bridge.mjs:L23-L33,L58-L60` 只允许一次性导出批准；`apps/server/src/capabilities.ts:L10-L23` 校验 consumed approval。 | Approval 请求、决定、过期、args hash、actor 和 run 关系迁到 RuoYi AI approval 域。RuoYi 是唯一写入者；执行服务只消费带签名/绑定的决定，不能自行批准或重放。 |
| Gateway | `KEEP_AS_EXECUTION_SERVICE` | `apps/gateway/src/main.ts:L10-L15,L23-L45,L53-L58` 用 runtime token、auth_version、ACL 和 model 校验后调用 Ark，并写 usage。 | 保留为内部 Model Gateway。模型/用户授权和配置来自 RuoYi；Gateway 只执行 provider call、redaction、quota reservation/usage 回传，不提供浏览器身份或业务 RBAC。 |
| Runtime Manager | `KEEP_AS_EXECUTION_SERVICE` | `apps/manager/src/main.ts:L34-L46,L48-L69` 创建/回收 Docker runtime，`/command` 校验 session/user 后转发，`/parse` 做解析，`/events` 使用内部 bearer。 | 保留为 execution infrastructure。RuoYi 通过受认证的 AgentRuntimeClient 调它；Manager 不能持有 Business RBAC、Resource Ownership、Knowledge ACL 或 Model Permission。RC1 runtime 容器、token 和活动进程不作为业务数据迁移。 |

## 明确移除的旧业务入口

1. Better Auth `/api/auth/*`、`auth_users/auth_accounts/auth_sessions` 和旧 cookie session 在切换后退出业务路径；`auth_sessions` 只做审计/注销前置，不转成 Sa-Token 会话。
2. 旧 `/api/*` BFF 只在迁移演练或只读核对阶段存在；每个实体切换后由 RuoYi 单独写入，不能保留“旧写一份、新写一份”的同步方案。
3. `packages/runtime-contract` 若继续存在，只能作为 RuoYi→Manager 的内部协议；不能继续作为浏览器业务 API 或身份来源。
4. `bridge_*`/Local Bridge 等未纳入 RC2 目标的旧业务入口不应作为迁移前提。保留与否须由 cutover 文档依据真实安装和安全验收决定。

## 已发现的迁移不确定性

- RC1 `assistants` 没有 owner 字段，不推断个人 owner；按 00-decision 的全局资源迁移策略归为 ENTERPRISE，冲突进入 quarantine。
- RC1 `session_events` 以 `(session_id, seq)` 为主键，当前没有独立 message 表；message/event ID 需要按 [04-data-migration.md](./04-data-migration.md) 生成并留映射。
- RC1 文件内容依赖本地 `dataDir/files`；只迁数据库行会产生悬空对象，必须做对象级 sha256 校验。
- 当前 Gateway/Model 证据只覆盖 Ark；provider 扩展、个人 MCP 凭据和完整 Skill transport 均待真实 RC2 验收。
- `platform/ruoyi/.../application-dev.yml` 默认仍是 MySQL，PostgreSQL 适配在 `ruoyi-upstream.lock.json` 标为 compatibility test pending；这影响迁移演练，不能在本盘点中宣称兼容已验收。
