# 05｜RC1 API → RuoYi API 映射

> 状态：路由映射与身份边界草案。目标 AI 路由尚未实现；官方 RuoYi 路由依据 vendored `platform/ruoyi` 与 `platform/plus-ui` 源码，执行服务路由保留为内部协议。

## 1. API 总原则

1. RuoYi Backend 是唯一业务 API 和身份权威。浏览器使用 RuoYi + Sa-Token 登录；旧 `/api/auth/*`、Better Auth cookie 和旧 bearer 不得与其并存。
2. `userId`、`roleId`、`departmentId`、`ownerUserId` 等浏览器传入值一律不作为当前身份。当前 actor 从服务端 Sa-Token session 取得；管理接口中的目标 ID 只能作为被操作对象，仍须通过 RuoYi Permission/Data Scope 和 owner/ACL 检查。
3. RuoYi 原生 user/department/role/menu ID 在 JSON 中序列化为字符串；AI resource/session/run/message/file/approval/event ID 尽量保持 UUID。详见 [04-data-migration.md](./04-data-migration.md)。
4. Employee Frontend 只消费 RuoYi 定义的 AI response/event protocol，不直接消费 Harness native event。写 API 必须接收并持久化 `requestId`、`idempotencyKey`、`eventSequence`、`configVersion` 和 `protocolVersion`，重复请求不能重复执行工具、扣 usage 或创建 approval。

## 2. 身份与系统 API

| RC1 现有接口 | 源码证据 | 规划目标接口 | 目标 owner/身份规则 |
|---|---|---|---|
| `POST /api/auth/sign-in/email` | `apps/server/src/auth-routes.ts:L46-L61` | `POST /auth/login` | 官方 `platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/controller/AuthController.java:L53-L107`；RuoYi 校验 BCrypt、client/grantType 并由 `LoginHelper.login` 建 Sa-Token。响应改为 RuoYi token contract，旧 cookie 不继续使用。 |
| `POST /api/auth/sign-out` | `apps/server/src/auth-routes.ts:L63-L71` | `POST /auth/logout` | 官方 `platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/controller/AuthController.java:L165-L172`；由当前 Sa-Token token 注销，不接收任意 userId。 |
| `POST /api/auth/change-password` | `apps/server/src/auth-routes.ts:L73-L88` | `PUT /system/user/profile/updatePwd` | 官方 `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/system/SysProfileController.java:L32-L89`；当前登录用户由 Sa-Token 解析，旧 `currentPassword/newPassword` 语义映射到 RuoYi password body。 |
| `GET /api/me` | `apps/server/src/main.ts:L74-L79` | `GET /system/user/getInfo` | 官方 `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/system/SysUserController.java:L116-L133`；只返回当前 token 的 user/role/permission，不信任 query/body owner。 |
| `GET /api/brand` | `apps/server/src/main.ts:L65-L73` | 规划 `GET /ai/brand`（公开读取） | RuoYi AI branding service 读取已发布配置；不把管理用 `/system/config` 直接当公开品牌 API。版本和资产引用由服务端校验。 |
| `GET /api/brand/assets/:id` | `apps/server/src/admin.ts:L9` | 规划 `GET /ai/brand/assets/:id` | AI branding/OSS adapter 只返回被配置引用且 scan clean 的对象；资源 ID 仍按 UUID 校验。 |

## 3. RuoYi 原生 User / Department / Role / Menu

| RC1 现有接口 | 源码证据 | 规划目标接口 | 迁移与身份规则 |
|---|---|---|---|
| `GET /api/admin/permissions` | `apps/server/src/iam.ts:L38-L41` | `GET /system/menu/list` + 规划 `GET /ai/permissions` | 基础菜单/权限由 RuoYi `SysMenuController`（`/system/menu/list`）负责；AI resource permission code 由 RuoYi PermissionService/扩展 registry 返回，不能保留旧 RBAC 查询。 |
| `GET /api/admin/user-options` | `apps/server/src/iam.ts:L43-L46` | 官方 `GET /system/dept/list`、`GET /system/role/list`，必要时规划 `GET /ai/admin/options` | 仅返回当前管理员 Data Scope 内可选对象；前端值不能改变 actor。 |
| `GET /api/admin/users` | `apps/server/src/iam.ts:L48-L54` | `GET /system/user/list` | 官方 plus-ui `platform/plus-ui/src/api/system/user/index.ts:L5-L12`；RuoYi `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/system/SysUserController.java:L63-L74`。 |
| `POST /api/admin/users` | `apps/server/src/iam.ts:L56-L76` | `POST /system/user` | 官方 `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/system/SysUserController.java:L166-L176`；密码由 RuoYi 生成 BCrypt，角色/部门由服务端检查。 |
| `PATCH /api/admin/users/:id` | `apps/server/src/iam.ts:L78-L116` | `PUT /system/user` | 官方 plus-ui `platform/plus-ui/src/api/system/user/index.ts:L46-L56`；`userId` 是目标 Long 的字符串表示，不能指定当前 actor。权限/部门变更触发 Sa-Token 会话失效和 ACL/version 更新。 |
| `POST /api/admin/users/:id/reset-password` | `apps/server/src/iam.ts:L122-L129` | `PUT /system/user/resetPwd` | 官方 plus-ui `platform/plus-ui/src/api/system/user/index.ts:L69-L84`；目标 ID 经 Data Scope 校验，重置后强制改密并注销目标 token。 |
| `POST /api/admin/users/:id/revoke-sessions` | `apps/server/src/iam.ts:L117-L120` | 规划 `POST /system/user/revokeSessions` | RuoYi 扩展 service 调 Sa-Token logout/kickout；官方 `/monitor/online` 删除单 token 不等价于按用户撤销，不能直接假设已有同名接口。 |
| `GET/POST/PATCH/DELETE /api/admin/departments[/:id]` | `apps/server/src/iam.ts:L133-L169` | `GET/POST/PUT/DELETE /system/dept[/:deptId]` | 官方 controller `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/system/SysDeptController.java:L30-L154`，plus-ui `platform/plus-ui/src/api/system/dept/index.ts:L5-L64`；dept ID BIGINT 字符串，parent/数据范围由 RuoYi 校验。 |
| `GET/POST/PATCH/DELETE /api/admin/roles[/:id]` | `apps/server/src/iam.ts:L171-L220` | `GET/POST/PUT/DELETE /system/role[/:roleIds]`、`PUT /system/role/permission` | 官方 controller `platform/ruoyi/ruoyi-modules/ruoyi-system/src/main/java/org/dromara/system/controller/system/SysRoleController.java:L40-L182`，plus-ui `platform/plus-ui/src/api/system/role/index.ts:L7-L92`；系统角色、菜单权限和 Data Scope 由 RuoYi 维护。 |
| （旧无独立菜单 CRUD） | RuoYi 目标需承接旧 permission code | `GET/POST/PUT/DELETE /system/menu...` | plus-ui `platform/plus-ui/src/api/system/menu/index.ts:L5-L69`；AI 权限另外纳入 RuoYi 扩展 registry，不能让旧 `role_permissions` 继续做 authority。 |

## 4. AI 资源和运行 API

下表的 `/ai/...` 是规划中的 RuoYi controller/service 路径，当前 vendored RuoYi 尚无这些业务接口；实现前应将路径、权限标识、DTO 和 event schema 固化在 07/08 及代码中。

| RC1 现有接口 | 源码证据 | 规划目标接口 | 目标 owner/身份规则 |
|---|---|---|---|
| `GET /api/assistants` | `apps/server/src/conversations.ts:L55-L56` | `GET /ai/assistants/available` | RuoYi 从 Sa-Token actor、Assistant share/ACL、Model enabled 计算可用项；不能按 body 的 userId 查询。 |
| `GET /api/sessions`、`POST /api/sessions` | `apps/server/src/conversations.ts:L57-L60` | `GET/POST /ai/sessions` | Session owner 强制取当前 RuoYi user；assistant/model/ACL/version 在同一事务检查。新 session UUID 可保留。 |
| `GET/PATCH/DELETE /api/sessions/:id` | `apps/server/src/conversations.ts:L63-L66` | `GET/PATCH/DELETE /ai/sessions/:sessionId` | `sessionId` 是资源定位，不是身份；服务端做 owner/ACL/version 和 active run 检查。 |
| `POST /api/sessions/:id/prompt` | `apps/server/src/conversations.ts:L67-L72` | `POST /ai/sessions/:sessionId/runs` | 创建 run 时生成/校验 `idempotencyKey`、input hash，actor 来自 Sa-Token；RuoYi 持久化 message/run 后调用 Manager。 |
| `POST /api/sessions/:id/resume` | `apps/server/src/conversations.ts:L63-L72` | `POST /ai/sessions/:sessionId/resume` | 只恢复目标 owner 的已持久化快照；旧 active runtime 不复活，目标 runtime 由 Manager 按新 service credential 创建。 |
| `POST /api/sessions/:id/cancel` | `apps/server/src/conversations.ts:L63-L72` | `POST /ai/sessions/:sessionId/cancel` | RuoYi 先写 cancelling/cancelled，再向 Manager 发幂等 cancel；重试不能产生第二个 run。 |
| `GET /api/approvals` | `apps/server/src/conversations.ts:L62-L62` | `GET /ai/approvals` | 只返回当前 actor 有权看到的 Approval；决定人从 Sa-Token session 得到。 |
| `POST /api/sessions/:id/approval` | `apps/server/src/conversations.ts:L27-L33,L63-L72` | `POST /ai/sessions/:sessionId/approvals/:approvalId` | RuoYi 校验 run/session/owner、过期时间、tool 和 args hash；一次性决定后向执行服务发送不可重放结果。 |
| `WS /ws?sessionId=...` | `apps/server/src/conversations.ts:L91` | 规划统一 `WS /ws?sessionId=...&lastEventSequence=...` | 连接握手从 Sa-Token 认证、再做 session owner/ACL；前端只接收自有 event protocol（session/run/message/tool/approval），不接 Harness native event。 |
| `GET /api/knowledge/bases`、`POST /api/knowledge/search` | `apps/server/src/knowledge.ts:L26-L30` | `GET /ai/knowledge-bases`、`POST /ai/knowledge/search` | 当前 actor、AI ACL、assistant binding 和 knowledge version 均在 RuoYi service 检查；query 中的 owner 不生效。 |
| `GET /api/knowledge/bases/:id/documents` | `apps/server/src/knowledge.ts:L31-L34` | `GET /ai/knowledge-bases/:knowledgeBaseId/documents` | Knowledge UUID 可保留；主体和 ACL 由 RuoYi BIGINT identity 解析。 |
| `GET /api/knowledge/sources/:versionId`、`/download` | `apps/server/src/knowledge.ts:L36-L38` | `GET /ai/knowledge/sources/:versionId`、`GET /ai/knowledge/sources/:versionId/download` | 下载前重新校验当前 ACL/version；不能用旧 session snapshot 绕过撤权。 |
| `/api/admin/knowledge-bases...`（base/document/version/ACL/reindex） | `apps/server/src/knowledge.ts:L33-L54` | `/ai/admin/knowledge-bases...` 同语义扩展路由 | RuoYi 负责 ACL、异步 job 和审计；reindex 是幂等 job，不重复写 document version 或 citation。 |
| `POST/GET /api/files`、`GET/DELETE /api/files/:id`、`GET /api/files/:id/download` | `apps/server/src/files.ts:L12-L27` | `POST/GET /ai/files`、`GET/DELETE /ai/files/:fileId`、`GET /ai/files/:fileId/download` | 元数据和 ACL 在 RuoYi；内容由 OSS adapter 存取。`fileId` 可为 UUID，owner 从 Sa-Token 取得，下载再次核对 scan/parse/ACL。 |
| `GET/PUT /api/admin/brand`、`POST /api/admin/brand/assets` | `apps/server/src/admin.ts:L14-L22` | `GET/PUT /ai/brand`、`POST /ai/brand/assets` | RuoYi 负责版本条件写、branding 权限和资产引用；OSS 只存对象，不决定公开/管理身份。 |
| `GET/PATCH /api/admin/models` | `apps/server/src/admin.ts:L23-L25` | `GET/PATCH /ai/models` | RuoYi 承担 Model config/permission/version；Gateway 仅执行调用。 |
| `GET/PATCH /api/admin/capabilities` | `apps/server/src/admin.ts:L26-L28` | `GET/PATCH /ai/resources/capabilities` | code/kind/version/manifest 由 RuoYi registry 管理；执行是否可用还要通过 bridge/runtime 真实验收。 |
| `GET/POST/PATCH /api/admin/assistants`、`GET /api/admin/assistant-options` | `apps/server/src/admin.ts:L29-L38` | `GET/POST/PUT/DELETE /ai/assistants`、`GET /ai/assistant-options` | Assistant owner/share/role/Model/Skill/MCP/Tool/Knowledge 绑定一次性在 RuoYi 事务中写；不保留旧 BFF 写入。 |

## 5. Audit、Usage 和服务内部 API

| RC1 现有接口 | 源码证据 | 规划目标接口 | 目标 owner/边界 |
|---|---|---|---|
| `GET /api/admin/audit` | `apps/server/src/operations.ts:L17-L26` | `GET /ai/admin/audit` | RuoYi AI audit service 分页查询；actor 用 RuoYi BIGINT，resource/session/run UUID 按映射返回；禁止返回 prompt、credential 或 message 内容。 |
| `GET /api/admin/audit/verify` | `apps/server/src/operations.ts:L27-L46` | `GET /ai/admin/audit/verify` | 在 RuoYi 侧校验迁移后的 hash chain；系统登录/操作日志另由 `/monitor/loginInfo`、`/monitor/operlog` 承接。 |
| `GET /api/admin/usage` | `apps/server/src/operations.ts:L48-L54` | `GET /ai/admin/usage` | 按 user/department/model 查询目标 usage event；目标 API 保留 usageComplete/costStatus 等不确定状态，不能用历史 null 冒充成本。 |
| `GET/PUT /api/admin/quotas[/:id]` | `apps/server/src/operations.ts:L55-L65` | `GET/PUT /ai/admin/quotas[/:userId]` | `userId` 仅作为管理员选定的目标且必须在 Data Scope 内；额度和 reservation 写入单一 RuoYi usage authority。 |
| `POST /internal/capability` | `apps/server/src/main.ts:L42-L42`、`apps/server/src/capabilities.ts:L1-L23` | 规划私有 `POST /internal/ai/capability` | 仅由 Gateway/Manager 通过服务认证调用；请求中的 user/session/run 必须由 RuoYi 根据服务 token 绑定/重查，不能成为客户端身份注入点。 |
| Manager `POST /command`、`POST /parse`、WS `/events` | `apps/manager/src/main.ts:L48-L69` | 内部 Manager protocol 保留；RuoYi 通过受认证 AgentRuntimeClient 调用 | `command` 的 user/session/run 只作 RuoYi 已授权上下文的绑定校验；Manager 不公开给浏览器，不持有业务 ACL。 |
| Gateway `POST /v1/chat/completions`、`POST /v1/capability` | `apps/gateway/src/main.ts:L23-L45` | 内部 Gateway protocol 保留 | 只接受绑定 runtime token；RuoYi 决定 model/permission，Gateway 调 provider、做 secret redaction、quota/usage 回写。 |

## 6. 迁移期路由和身份门禁

- 同一业务实体只有一个 write route。切换前可由旧 BFF 提供 read-only reference；一旦 RuoYi 接管写入，旧 route 返回迁移完成/只读状态，不做隐式双写。
- 旧 route 的 `ownerId`、`userId`、`departmentId`、`roleIds` 不能改变当前 actor。RuoYi controller 应从 `LoginHelper.getUserId()`/Sa-Token 取身份，目标资源再经 Permission/Data Scope/AI ACL 检查。
- AI route 的 service credential 至少绑定 user、session、run、resource scope、expiration、authorization version；Manager/Gateway 即使处于 Docker network 也必须验证。
- `requestId` 贯穿 RuoYi API、Audit、Manager、Gateway 和 Usage；写 API 以 `Idempotency-Key` 或等价字段去重。网络重试、刷新、WebSocket 重连、Backend/Runtime restart 不能创建第二个 message/run/tool call/approval/usage。
- 统一错误响应由 RuoYi API contract 定义；内部 Manager/Gateway 错误只映射为带 `requestId` 的公开错误，不把 provider secret、runtime token 或原始内部事件返回浏览器。
- 关闭 legacy BFF 前，必须完成数据迁移演练、Core Business E2E、安全回归、性能验收、backup、rollback rehearsal 和 legacy-off test；本文件只完成路由盘点，不能视为这些 gate 已通过。
