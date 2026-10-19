# V1.0 数据模型

设计：PostgreSQL 17，SQL migration + node-postgres 参数化 SQL；不增加 ORM。PostgreSQL 是业务权威，JSONB 仅保存有版本且经过校验的配置。业务主键 UUID；Better Auth 字段类型按库的已锁定 schema，auth user ID 使用库支持的 UUID 生成，时间 timestamptz，金额 numeric，token bigint，外键明确删除行为。企业隔离列 organization_id 由服务端赋值，不相信请求值。

| 表/模型 | 核心字段与约束 |
|---|---|
| organizations | id、name；V1 bootstrap 只允许一个组织，保留组织 FK |
| departments | id、organization_id、name、parent_id；禁止跨组织父节点/环 |
| users | id（关联 auth_users）、organization_id、department_id、enabled、auth_version、must_change_password；密码与邮箱身份由 Better Auth 管理 |
| roles / permissions | role code、组织、系统角色标识；permission code 全局受代码允许列表约束 |
| user_roles / role_permissions | 复合唯一键、外键；授权不能越组织或超出委派范围 |
| auth_users / auth_accounts / auth_sessions / auth_verifications | Better Auth 1.7.5 生成 schema；账号、密码 scrypt、Cookie Session、重置验证。会话库可能存可用 token，不假称默认只存 hash；最小 DB 权限/加密备份保护 |
| rate_limit / security_events | 库支持的持久限流与业务安全事件；密码重置使用库协议，不并建 reset token 系统 |
| runtimes | user_id unique、instance_id、state、version、harness_sha、image_digest、last_active、error_code；运行目录不由客户端提供 |
| sessions | id、owner_id、assistant_id、title、state、runtime_version、knowledge_acl_version、created/updated/deleted_at；与 auth_sessions 区分 |
| runs | id、session_id、owner_id、idempotency_key、status、event_cursor、request_id、error_code；活动 run 条件唯一，防并发写同会话 |
| files | id、owner_id、storage_key、original_name、mime、size、sha256、scan_status、lifecycle、expires/deleted_at；storage_key 服务端随机 |
| knowledge_bases | id、organization_id、name、state、acl_version、created_by |
| documents / document_versions | KB、版本、原文件 ID、text/index状态、checksum、deleted_at；原件和索引版本一致才能提供 |
| knowledge_acl / document_acl | resource_id、subject_type(user/department/role/organization)、subject_id、action(read/manage)、effect；唯一约束；无规则默认拒绝 |
| knowledge_index / index_jobs | document/version、分块内容/全文索引、状态 pending/processing/ready/failed/invalidated；索引不是权限权威 |
| assistants | 名称、描述、配置版本、enabled、允许模型、系统指令（只管理端可配） |
| skills / connectors / tools | 受审查能力 code、版本、配置 schema、enabled；不接受任意脚本 |
| assistant_assignments | assistant + knowledge/skill/connector/tool/model；含角色/用户授权；执行时查当前版本 |
| providers / models | type、受控 endpoint identifier、secret_ref、model id、compatibility status/evidence、prices nullable/currency/source/effective_at |
| approvals | id、owner/session/run、tool、args_hash、status、expires/decided_at；条件更新保证单次消费 |
| audit_events / audit_heads | seq、actor、action、resource、result、source、request_id、timestamp、prev_hash、hash；append-only + 外部锚点 |
| usage_events | request_id unique、用户/当时部门/助手/模型/provider、输入输出 token、latency、result/error、tool names；价格快照可空 |
| quotas / quota_reservations | scope user/department/model、period、limit、reserved/used、expires；事务原子预留，防并发超额 |
| brand_config | organization_id unique、schema_version、version、productName/companyName/asset IDs/color/login/copyright/support |
| bridge_devices / bridge_grants / bridge_operations | user、device key、pairing hash/expiry、rotation/revocation、目录 grants、只读/写、nonce/seq/expiry/approval/result；flag 关闭时不可调用 |
| system_settings / schema_migrations | key/schema_version/value；migration version/name/checksum/applied_at |

## 数据访问原则

每个 Repository 方法需要明确 principal；禁止仅凭 UUID 查询私人对象。SQL 参数化，权限查询使用当前角色与部门。DB 外键/唯一约束保护并发一致性；重要多行事务原子。选择应用鉴权为主，表/role 最小数据库权限为辅；不假称使用 owner 连接的 RLS 能防所有绕过。

Provider API Key 不写普通业务表；认证密码、session/reset 按 Better Auth 约定；业务设备配对 token 仅存 hash。用户输入配置均有 JSON schema/version，不接受未知字段。删除用户先禁用/撤销/停止实例，不级联静默删除所有文件或审计；生产硬删除须单独授权。

## 迁移与初始化

`migrations/NNNN_name.sql` append-only。迁移 runner 获取 advisory lock，验证既有 checksum 和版本顺序；每个迁移事务执行，失败回滚。已应用 migration 不得编辑，修复用新 migration。应用启动拒绝不支持的 DB/config schema，不自动 destructive migrate。bootstrap 通过专用 CLI 读取管理员凭据，事务创建组织/基础角色/管理员/默认品牌，重复执行不重置账号。

正常升级只 forward；应用回滚仅在兼容 schema 范围内。破坏性迁移遵循 expand → backfill → verify → contract 跨版本完成。必须 schema 回退时恢复升级前完整备份到新卷，检验后切换；禁止通用 down 脚本自动丢列。空库、已有数据升级、重复/并发执行、checksum 篡改和失败回滚全部测试。

## 备份一致性与保留

备份包括 DB 全量、上传/生成文件、品牌资产、Knowledge 原件、每用户 Harness Session/home/workspace、系统非秘密配置、版本清单和审计锚点；临时 `/tmp` 不含。维护模式禁止写入、等待执行停止/flush，再统一快照，避免 dump 和文件不一致。Secret 由运维独立加密备份/注入，备份清单不打印值。备份默认加密，保留策略由管理员明确设置，清理不得静默删真实数据。

PostgreSQL 备份与迁移锁语义参考 [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) 和 [Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html)。

## R2 认证 schema 纠偏

初版自建 auth_sessions/token_hash/csrf_hash 不再实施。Better Auth migration 必须固定库版本生成并纳入 checksummed SQL；用户业务权限在 profiles/users 侧独立关联。cookieCache 关闭；每个 API、WS 和执行时查询 enabled 与当前角色；禁用同时撤销库会话。bootstrap 不开放公开注册，不从 Alpha 导入测试账号。

P5 已应用前向迁移 `0006_knowledge_files.sql`：files 增加解析状态、提取文字、解析器版本与错误码，file_jobs 保存租约/重试；session_citations 绑定 run 与 document_version。索引只接收当前文档版本，旧版本 metadata 保留但不通过当前来源下载接口访问。不得修改已应用迁移。
