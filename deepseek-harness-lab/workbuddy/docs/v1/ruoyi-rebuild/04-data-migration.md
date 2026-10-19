# 04｜RC1 → RuoYi 数据迁移设计

> 状态：R13 已在独立 `workspace_rc2_rehearsal` 完成真实数据迁移演练、重复执行、API/Chrome 与核心集成回归。当前 RC2 业务库尚未导入 RC1 数据，未 Cutover。下文为原设计；实际实现差异与边界以末节为准。
>
> 数据源基线：`baseline/rc1-technical`（`addff08`）。业务写入权最终只属于 RuoYi Backend；Runtime Manager、Model Gateway 和 Harness 只保存执行所需状态及 recovery log。

## 1. ID 规则

### 1.1 RuoYi 原生身份使用 BIGINT

官方 PostgreSQL schema 将 `sys_dept.dept_id`、`sys_user.user_id`、`sys_role.role_id`、`sys_menu.menu_id` 和关联表 ID 定义为 `int8`/BIGINT（`platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql:L70-L89,L128-L150,L239-L257,L289-L314,L481-L509`；Java domain 亦使用 `Long`，如 `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/domain/SysUser.java:L20-L78`、`platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/domain/SysDept.java:L21-L38`、`platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/domain/SysRole.java:L17-L47`）。

因此按以下规则迁移：

- `auth_users.id/users.id`（RC1 TEXT）→ `sys_user.user_id`（RuoYi BIGINT）。
- RC1 `departments.id`（UUID）→ `sys_dept.dept_id`（BIGINT），按 parent 拓扑导入。
- RC1 `roles.id`（UUID）→ `sys_role.role_id`（BIGINT）；`user_roles`→`sys_user_role`。
- RC1 permission code → RuoYi `sys_menu.perms` 或 AI permission registry；不能把 UUID 角色直接塞进 RuoYi Long 字段。
- API 的 BIGINT 统一序列化为字符串，避免 JavaScript 精度问题；前端可继续使用 `string | number` 类型，但传输规范按 string。

映射不得按“UUID 数值化”或截断字符串实现。首选顺序是源 ID 的既有映射、经过确认的唯一业务键（规范化 email/username），最后才允许生成新的 RuoYi BIGINT。email/username 冲突、停用用户冲突或多条候选均进入 quarantine，不自动合并。

### 1.2 AI 资源尽量保留 UUID

不把所有 ID 强行改成 BIGINT。Assistant、Model、Knowledge Base、Document、Document Version、File、Session、Run、Message、Event、Approval、Usage Event、Request 和 Idempotency Key 等 AI 域实体继续使用 UUID（目标自定义 RuoYi AI 表可使用 UUID）。

同一旧 UUID 只有同时满足以下条件才可复用：

1. 目标表中不存在不同来源的同 ID；
2. 该实体的每个外键已有映射，且目标行存在；
3. owner 已映射到目标 RuoYi `user_id`，ACL 主体和作用域校验通过；
4. `source_system + entity_type + old_id` 的源快照 hash 与本次迁移一致。

若 UUID 冲突，生成新的 UUID，并在映射表中记录 old/new；不能静默覆盖。owner 字段从 RC1 TEXT 改为映射后的 BIGINT，资源自身的 UUID 不因此改变。

### 1.3 计划中的映射表

实现时建立版本化的 `rc2_legacy_id_map`（名称可在 schema review 时调整），至少包含：

```text
source_system, source_snapshot, entity_type, old_id,
new_id, target_table, old_owner_id, new_owner_id,
old_fingerprint, migration_run_id, status, error_code,
created_at, updated_at
```

约束：`(source_system, entity_type, old_id)` 唯一；`(target_table, new_id)` 在同一来源内唯一；`status` 至少区分 `mapped`、`quarantined`、`reconciled`。映射表是迁移控制数据，不是第二个业务权限系统。

`session_events` 目前以 `(session_id, seq)` 识别事件，没有独立的 message 表（`migrations/0002_enterprise.sql` 的 session/event 定义，`apps/server/src/conversations.ts:L18-L22`）。因此：

- 若快照/event data 中有合法旧 `messageId/eventId`，按 UUID 复用并登记映射。
- 只有 `(old_session_id, seq)` 的事件，为目标事件生成 `eventId`；若目标要规范化 message，则按事件类型生成 `messageId`，保留 `old_session_id + seq` 作为来源定位。
- 不把 event sequence 当成 UUID，也不把一次迁移误算成新用户消息或新模型调用。

## 2. 源表到目标域

| RC1 来源 | 目标 RuoYi 域 | ID/owner 处理 | 迁移结果与检查 |
|---|---|---|---|
| `auth_users`, `users` | `sys_user`、RuoYi profile | 源 TEXT → BIGINT；保留 `rc1_user_id` 映射；`must_change_password` 转为重置/首次登录状态 | name/email 唯一；enabled、department、角色完整；重复 email 不自动合并 |
| `departments` | `sys_dept` | UUID → BIGINT，parent 先行；单企业组织映射到 RuoYi 根部门/组织约定 | 无断链、无环、用户 dept 都可解析 |
| `roles`, `user_roles`, `role_permissions` | `sys_role`, `sys_user_role`, `sys_role_menu` + AI permission registry | role UUID → BIGINT；用户先映射；权限 code 去重 | 超出迁移者权限、未知 code、系统角色冲突隔离；至少保留一个可登录管理员 |
| `organizations` | RuoYi 单企业根配置/根部门 | RC1 singleton UUID 只做来源映射，不作为用户/部门 ID | 不能在单企业目标中复制出多个业务 authority |
| `brand_config`, brand `files` | RuoYi branding 配置 + OSS/File | 配置引用通过 file UUID map；对象以 sha256 校验 | logo/logoDark/favicon 均有干净对象和公开引用检查 |
| `models` | RuoYi AI Model 配置 | UUID 尽量复用；provider secret 不迁入业务表 | `code/name/enabled/max_output_tokens/price` 一致；Ark 之外标为待验证 |
| `capabilities` | Skill/MCP/Tool registry | code 是稳定业务键；若目标实体使用 UUID，另建 code→UUID 映射 | kind、version、enabled、manifest/transport 逐项核对；未被 bridge 证明的能力不标为可用 |
| `assistants`, `assistant_roles`, `assistant_knowledge` | Assistant、分享/ACL、绑定表 | assistant UUID 尽量复用；role/model/KB 先完成映射 | owner 缺失必须由策略补齐；model、role、resource FK 和 version 可解析 |
| `knowledge_bases`, `documents`, `document_versions`, `knowledge_acl`, `document_acl` | Knowledge Base、Document、Version、ACL | UUID 尽量复用；created_by/subject user 改 BIGINT | ACL 主体、action、effect 无悬空；迁移后重建索引并复核引用 |
| `knowledge_index`, `index_jobs` | AI Index/Job | chunk/version UUID 可复用；processing job 不恢复执行 | 只迁成功历史和可重建输入；过期 processing 标为待重建，不重复调用外部模型 |
| `sessions`, `session_events`, `session_files` | Session、Message/Event、附件关联 | session/run/file UUID 尽量复用；owner BIGINT；旧 `(session,seq)` 留来源键 | 完成态历史可读；活动/starting/running/cancelling 不作为新活动导入，标 interrupted/recovery-required |
| `runs` | Run | run UUID 尽量复用；owner BIGINT；`idempotency_key/input_hash` 保留 | 不重新触发 provider/tool；唯一键和 session/owner FK 通过 |
| `approvals` | Approval | approval/runtime approval UUID 分开映射；owner BIGINT | pending 在迁移快照时过期/取消；已决定记录 args hash、actor 和时间 |
| `files`, `file_jobs` | RuoYi OSS/File metadata、扫描/解析状态 | file UUID 尽量复用；owner BIGINT；`storage_key` 重新绑定 OSS 对象 | 内容 byte/size/sha256/扫描状态一致；缺对象不能只迁 metadata |
| `audit_heads`, `audit_events` | RuoYi AI audit chain；系统日志走 native log | 原始签名载荷中的 actor/resource 保留；另加 mapped_actor_id/resource 关联 | seq、prev_hash、hash、requestId 和原始载荷原样保存，独立验证旧链；不能改写后沿用旧签名 |
| `usage_events`, `quotas`, `quota_reservations` | RuoYi AI usage/quota | user/department BIGINT；session/run/model UUID/code | 已结算事件只导入一次；reservation 未完成则释放/标记，不能重复扣额 |
| `runtimes`, runtime tokens, container IDs | 不迁活动容器；仅保留必要 recovery/审计摘要 | runtime instance 可作来源事实，不复用 token | 目标 Manager 按新身份/版本重新创建；旧 token/session 不可用 |

## 3. 密码和登录会话

### 3.1 已核对的算法不兼容

RC1 不是 BCrypt。`apps/server/package.json` 使用 Better Auth `1.7.5`，真实实现位于 `node_modules/@better-auth/utils/dist/password.node.mjs:L1-L44`：Node 路径用 `crypto.scrypt`，参数为 `N=16384,r=16,p=1,dkLen=64`，保存格式是 `hexSalt:hexDerivedKey`；`migrations/0001_auth.sql:L4` 的 `auth_accounts.password` 只是 TEXT 字段。

RuoYi 登录源码明确调用 `BCrypt.checkpw(password, user.getPassword())`（`platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/service/impl/PasswordAuthStrategy.java:L56-L77`），官方 SQL 的 seed password 也是 `$2a$10$...`（`platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql:L184-L186`）。两种格式和验证算法不兼容，不能把 RC1 hash 直接复制到 `sys_user.password`，也不能声称 Sa-Token 会自动兼容。

### 3.2 默认迁移策略

当前设计采用安全重置：

1. 迁移只复制账号资料和“需要改密”事实，不复制 scrypt 字符串到 BCrypt 字段。
2. 为目标用户走 RuoYi 管理员重置或一次性邀请流程，由 RuoYi 生成 BCrypt hash，并把 `must_change_password`/等价状态置为 true。明文临时密码不得写入迁移日志、文档或代码。
3. 首次登录改密成功后才解除限制；失败、停用和冲突账号保持不可登录并进入人工处理队列。
4. 若以后设计“登录时兼容旧 scrypt、成功后升级 BCrypt”的过渡桥，必须单独评审源代码、限时、审计、限速和删除条件；本 RC2 盘点不把它视为已实现。

RC1 `auth_sessions` 的结构和 cookie 生命周期见 `migrations/0001_auth.sql:L2-L6`、`apps/server/src/auth.ts:L11-L16`、`apps/server/src/auth-routes.ts:L63-L71,L99-L102`。这些活动会话不导入 Sa-Token。切换前让旧会话失效，用户在 `/auth/login` 重新建立 RuoYi token；RuoYi `LoginHelper` 将 Long user/dept 放入 token session（`platform/ruoyi/ruoyi-common/ruoyi-common-satoken/src/main/java/org/dromara/common/satoken/utils/LoginHelper.java:L54-L65,L102-L176`）。

## 4. 可重复、可校验的迁移流程

### 4.1 阶段顺序

1. **冻结源快照**：记录 RC1 tag/commit、schema migration 版本、导出时间、行计数和每个实体的规范化 hash；先完成 backup 和恢复演练。
2. **建立身份映射**：用户、根组织、部门、角色和权限先完成映射。任何 owner 无法解析的资源停止在 quarantine，不写目标业务表。
3. **写入 RuoYi 原生身份**：按 dept parent、role/user 依赖顺序写入，并用唯一键避免重复；验证管理员、禁用状态和 Data Scope。
4. **迁移 AI 配置**：Model、Skill/MCP/Tool registry、Assistant、Knowledge ACL 按外键拓扑写入；缺失 manifest、model 或 ACL 主体的记录不标为 enabled。
5. **迁移历史业务**：File metadata/object、Knowledge document/version、Session/Run/Event/Message、Approval、Audit、Usage 按映射写入。活动 runtime 不恢复执行。
6. **重建派生数据**：目标索引、聚合、缓存和 Sa-Token session 均从目标事实生成；禁止把 RC1 cache、token 或 processing lease 当成事实导入。
7. **对账和门禁**：通过下列检查后才允许进入 cutover rehearsal；检查失败保留 quarantine 和错误码，修正源映射或策略后从同一 run 续作。

### 4.2 幂等和写入约束

计划中的 migration runner 以 `migration_run_id + source_snapshot + target_schema_version` 作为运行身份；每个批次保存输入 hash、范围、状态、错误和重试次数。重复执行必须满足：

- 相同源实体命中唯一映射后只更新允许的迁移字段，不重复创建用户、资源、session、run、message、approval、audit 或 usage。
- 相同文件以 `source_file_id + sha256 + size` 去重；对象复制失败不得先提交一条“已完成”的 metadata。
- 相同 run 的 `idempotency_key/input_hash` 不再次调用 Gateway、Tool、MCP 或外部 API；迁移本身没有执行副作用。
- 已完成的审计事件和 usage 以来源主键/hash 去重；quota reservation 只恢复确定的结算事实，未结算 reservation 释放或标为 cancelled。
- 重试、断点和 worker 重启都从映射表/批次状态继续；不能依赖“上次应该已经写过”。

### 4.3 对账清单

迁移工具和评审记录至少输出：

- 用户、部门、角色、关联表的源/目标/映射/quarantine 计数；目标所有 owner/dept/role FK 可解析。
- Assistant→Model/Role/Knowledge、Knowledge→ACL/Document/Version、Session→Owner/Assistant/File、Run→Session/Owner、Approval→Run 的 FK 完整性。
- 文件对象数量、字节数、size、sha256、扫描/解析状态和 OSS key 一致；无 dangling metadata。
- Session event sequence 无重复/断号；旧活动 run 全部是明确的 interrupted/recovery-required，不存在隐式重跑。
- Audit 原始 seq、prev_hash、hash、requestId、actor/resource 载荷与旧密钥版本可独立验证，映射字段不参与旧链；RC2 新链以迁移清单摘要引用旧链；Usage 原始事件、聚合和成本不可用标志可对回。
- 目标 `sys_user.user_id/sys_dept.dept_id/sys_role.role_id` 均为 BIGINT 且 API 序列化为字符串；AI UUID 映射无跨来源冲突。
- RC1 行数和目标事实的差异都有原因码：过滤、合并（仅经批准）、quarantine、已删除、重复或不支持格式。

## 5. Single Write Authority 与回滚边界

迁移期按实体分配唯一写入者：

- Identity、RBAC、Branding、AI config、ACL、Session/Run/Message、Approval、File metadata、Audit、Usage：RuoYi 写；RC1 只读引用。
- Runtime state、runtime recovery log、provider call 和工具执行结果：相应 execution service 写；它们不能反向成为业务配置或权限权威。
- Strangler route 必须在路由表中逐实体标明 owner；禁止旧 BFF 和 RuoYi 同时写同一实体，再靠同步补偿。

若 cutover 后需要回滚，必须采用预先演练的 write freeze、forward fix 或反向迁移策略，明确新产生的 User/Resource/Session/Message/ACL 如何处理。仅重启旧容器不构成回滚，也不能恢复已被 RuoYi 改变的身份和授权事实。

## 6. R13 实际演练结果与决定

证据入口：`evidence/v1/rc2/r13/verification.json`。来自真实 RC1 的 7 用户、7 角色、4 助手、5 知识库/文档/版本、26 会话、35 Run、22 文件、513 审计、68 用量；源 Department 为 0，组织映射为原生根部门。完整快照含 1,831 条原记录。

`scripts/rc2/legacy-snapshot.mjs` 在 PostgreSQL REPEATABLE READ 只读事务中导出，逐对象验证 size/SHA256，核对原审计 HMAC 链和末端锚点；AES-256-GCM 加密快照和密钥放在 owner-only 私有目录，不进入 Git。旧认证 Session、Token 和 scrypt 密码不进入迁移载荷。RC1 全量加密备份仍保留。

`legacy-migrate.mjs` 仅接受独立演练数据库，事务和 advisory lock 控制导入；`rc2_legacy_record` 保存原始行与哈希且禁止更新/删除，`rc2_legacy_map` 保存 old/new ID、源哈希、目标表与状态。原生身份采用 BIGINT 序列，AI 域尽量保留 UUID；冲突不覆盖。模型使用 `migrations/rc2/legacy-model-map.json` 显式映射，并验证当前 Provider 类型、精确 code、启用与 VERIFIED 状态，不按多个同 code 模型任意合并。

原生角色按明确权限映射，Data Scope 为本人，不授予原生 super-admin 角色。5 个启用账号完成原生首次改密验证，2 个禁用账号仍拒绝登录；旧 Cookie 不能继承登录，临时密码仅写私有交付文件。重复迁移不重置已修改的密码。

知识 ACL 按快照中用户/角色/部门计算实际权限，deny 优先，生成逐用户动作授权；原 ACL 完整归档。此迁移不把源角色变化自动延伸为将来授权，新增成员需显式分享。实际源无文档级 ACL，每文档仅一个版本；遇到其它结构工具拒绝导入，不能默默扩大权限。所有文件原字节复制；22 个对象及 5 个文档文本哈希核对，索引由新系统重建。

4 个旧助手保留为停用草稿：旧固定 `read/write/proposal_skill/catalog_search/export_document` 不能直接成为 RC2 的新授权。原配置与角色绑定保留，管理员需在新模型下重新绑定资源再启用。既有 RC2 新资源能力及实际综合 UAT 已通过，不将这些旧草稿冒充迁移后可执行。

旧会话以 Owner 映射保留只读快照，当前授权通过时显示原消息；不继承旧 Runtime 上下文或重放工具。会话绑定来源知识库、被引用文档版本、附件，恢复查阅时检查当前授权；无从确认知识来源时拒绝。旧 Run 全部为结束态；审批、原始事件与 reservation 原样归档，不创建可执行待审项。

旧审计保留原签名载荷/哈希，管理员页面仅投影元数据。历史用量另存 `rc2_legacy_usage`，`usage_reported=false` 显示未知，避免把旧默认零当作实测。Branding 的名称、颜色、Logo、Favicon 已在演练双端展示；dark logo 原件保留归档，当前 UI 不使用。

重复导入在完成索引和首次改密后验证了 22 张相关表的整行哈希/数量不变。API 验证 22 个当前可查历史会话（17 个含正文）、源 deny、后续禁用、超管/B 越权、文件与品牌。Chrome 完成迁移账号历史/文件、管理员迁移审计/用量。当前 RC2 另完成真实对话/WSS/浏览器续聊、A/B 综合资源、知识撤权与工具审批的集成回归。所有结论仅限当前实际源与本地演练，不替代 R14/R15/R16 或 Cutover。
