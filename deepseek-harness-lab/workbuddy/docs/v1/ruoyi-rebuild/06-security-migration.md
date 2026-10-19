# RC2 安全迁移边界（源码审计草案）

状态：**下文矩阵保留初始源码审计快照；当前新增 R3/R4 实测结果见末节，不代表完整安全回归通过**。审计范围是当前导入的 RuoYi 后端源码、RC1 安全契约与现存历史证据；未启动服务、未检查 `.state`、未用真实账号或数据执行攻击。本文件不把上游默认行为认定为已在 RC2 产品路径暴露，也不把 RC1 PASS 继承为 RC2 PASS。

## 唯一权威与迁移边界

RuoYi + Sa-Token 是 Employee Workspace 和 Admin Console 唯一用户身份、会话、组织、角色、菜单权限和业务数据权威。AI Resource ACL、所有权、版本、会话和 Run 元数据落 RuoYi 控制面。旧 `apps/server/src/auth.ts`、`apps/server/src/iam.ts`、`apps/server/src/conversations.ts`、`apps/server/src/knowledge.ts`、`apps/server/src/files.ts` 是迁移参考；旧 Node 业务服务、Better Auth、旧 bearer/session 和旧 RBAC 不得保留为正式双权威。DeepSeekHarnessAdapter 只接受 RuoYi 授权后的执行请求，不接受浏览器直达 Runtime、客户端自报 `userId`/`ownerUserId`/`departmentId`/角色、工作目录、Provider 凭据或授权范围。

每个 AI 资源动作均经独立于 RuoYi 超管快捷路径的 `AiResourceGuard`：从服务端当前 Sa-Token 会话取主体；先检查账号、会话、客户端类型与 RBAC 动作资格，再检查资源 owner、明确 ACL、资源/分享版本、enabled 状态和动作 `VIEW/USE/EDIT/SHARE/PUBLISH/DELETE/GOVERN`。`PRIVATE/SHARED/ENTERPRISE_PUBLIC` 只是可见范围，不能推出编辑、执行或治理权。守卫在控制器及服务层复用，列表查询要带行级约束，按 ID 读取、修改、删除、搜索、预览、下载、引用、导出、会话恢复、流订阅和内部能力调用仍逐项判权；外人和不存在对象使用一致的拒绝语义。系统管理员只管理系统规则与资源元数据，**不能**凭超级管理员身份读取员工私有对话正文、知识正文、文件、MCP Secret、Provider Secret。确有特殊内容访问时另立 break-glass 权限、限时理由、操作者与访问对象审计，并重新授权，不调用通用超管 bypass。

## 上游源码中的具体迁移陷阱

| 边界 | 当前源码事实与风险 | RC2 必须实现的控制 | RC2 验证 |
|---|---|---|---|
| Sa-Token 路由 | `ruoyi-common-security/.../SecurityConfig.java` 的路由拦截器从 `AllUrlHandler` 收集的 MVC 映射执行 `checkLogin`，依赖 excludes；同处以请求 header **或 query 参数** 的 `clientid` 与 Token extra 比对。`AllUrlHandler.java` 只枚举 MVC 映射。新增 `/api`、SSE/异步、原生 WSS、静态文件及导出路径不能默认认为都被此规则覆盖。 | 明确列出所有 AI/API/流路由与允许匿名表；启动时断言受保护路由覆盖率；服务层再次要求会话与权限；客户端类型/来源只从服务端可校验绑定取得，不把客户端传入的 `clientid` 当授权。 | NOT_RUN |
| 超管与数据范围 | `ruoyi-common-mybatis/.../PlusDataPermissionHandler.java:getSqlSegment` 对 `LoginHelper.isSuperAdmin()` 直接返回原条件；`ruoyi-system/.../SysPermissionServiceImpl.java` 对超管发放通用权限。`DataPermissionHelper.ignore()` 又能显式跳过过滤。 | AI 内容/文件/知识/会话/Run 表绝不依赖 RuoYi 通用 DataScope 作为唯一边界；`AiResourceGuard` 在 SQL 行过滤与逐 ID 服务方法均强制运行，不接受 `isSuperAdmin()`、`ignore()` 或 `ALL` 角色作为私有内容放行条件。代码审查禁止在 AI repository 上复用泛化的忽略注解。 | NOT_RUN |
| OSS 与文件 | `ruoyi-system/.../SysOssController.java` 的 `/list`、`/listByIds`、`/download/{ossId}` 只标通用 `system:oss:*` 权限，上传响应直接回传 `url`；`SysOssServiceImpl.java:download` 按 ID 取对象后即下载，`matchingUrl` 对 private bucket 发 120 秒预签 URL，其他配置保留原 URL。通用权限或获 URL 均不等同 AI 文件 ACL。 | 私有 AI 文件采用独立元数据 owner/resourceId/ACL 与短时取用接口；统一在签发下载或 URL **之前** 校验文件及其父资源授权，默认私有桶，禁止永久匿名公共 URL；禁止把 AI 文件开放到通用 OSS 列表、批量查询、删除、管理导出路径。预签 URL 生命周期视为撤权例外，需短 TTL、可撤销代理或明确残余窗口。 | NOT_RUN |
| 日志与导出 | `ruoyi-common-log/.../annotation/Log.java` 默认保存请求与响应；`LogAspect.java` 可写 `operParam` 和 `jsonResult`；`ruoyi-system/.../SysOperLogController.java` 具有列表和导出权限。默认 `@Log` 用于 AI 正文/Secret 接口将形成后台旁路。 | AI 接口不记录 prompt、response、检索段落、文件内容、Token、密钥和预签 URL；仅记录资源 ID、动作、主体、结果、时间、追踪 ID、字节/用量等必要元数据。既有通用操作日志、错误栈、SSE/WS 日志、导出和备份按敏感字段逐条审查；私人正文不得进入通用后台列表/导出。审计日志独立授权并保留违规访问记录。 | NOT_RUN |
| Redis 会话与撤销 | `SaTokenConfig.java` 采用 `StpLogicJwtForSimple`，`PlusSaTokenDao.java` 以 Caffeine+Redis 读写，Caffeine `expireAfterWrite(5s)`，本实例写删仅使本实例缓存失效。不能据此推定多实例禁用或踢出即时传播。 | 账号停用、改密、角色/ACL/分享撤销必须提升持久 `authVersion`/资源授权版本并撤销相关会话；每次敏感操作与流帧/心跳校验当前会话及版本，跨实例失效通知或强制短上限，失败时拒绝。实测多节点 Redis 断连、缓存窗口、重连旧 Token 与并发撤销，不承诺未经实测的“即时”。 | NOT_RUN |
| 原生 WSS | `ruoyi-common-push/.../MessageWebSocketConfiguration.java` 用配置 `allowedOrigins`；`MessageProperties.java` 默认 `*`，`application.yml` 当前 transport 为 `sse` 且 `allowedOrigins: '*'`。`PlusWebSocketInterceptor.java` 将 `LoginUser`/Token 复制到握手属性；`PlusWebSocketHandler.java` 建连和自定义消息沿用该属性，未见每消息重新校验资源及撤销版本。 | `/ws` 或 SSE 的握手显式 Sa-Token 校验、固定 Origin allowlist、CSRF/跨站 WS 风险防护；订阅 `sessionId/runId` 时逐对象授权，消息不允许客户端覆盖用户或路由；重连、每次敏感消息、推送前或短心跳重新校验会话/`authVersion`，撤销时关连接。反代只开放统一 HTTPS/WSS 入口。 | NOT_RUN |
| 执行服务 | 旧 `packages/runtime-contract/src/index.ts` 的请求 schema 带 `userId`/`sessionId`，是旧链路契约，不可单独作为 RC2 身份证明。 | RuoYi 签发面向唯一 DeepSeekHarnessAdapter 的短时服务能力令牌，至少绑定 `user`、`session`、`run`、精确资源 scopes、到期、`authVersion`，并绑定 audience、请求来源/重放标识；Adapter 校验签名、范围、运行状态与最新版本，不能仅凭 Docker 内网、请求体 userId 或旧 Runtime contract 放行。Gateway/Secret Service 仅执行，Provider/Model 配置及使用权仍以 RuoYi 为准。 | NOT_RUN |

源码路径以上均以 `platform/ruoyi/` 为根；应用源码均以仓库根为准。导入上游版本见 `ruoyi-upstream.lock.json`，迁移实现需在代码评审中把实际接入路径逐一映射到此表。

## 撤权、在途 Run 与不可变版本

`Run` 启动时保存所解析的 Assistant/Skill/Tool/MCP/Knowledge/Model 的不可变版本及授权版本快照；不可变版本仅固定“执行的是哪个内容”，**不是**持续授权。每次模型请求、Knowledge Search/Source/Citation/Preview、Tool 执行、MCP 调用、文件下载、会话恢复和 Context Build 前，控制面或受约束的 Adapter 复核当前用户会话、资源 enabled、分享/ACL 与授权版本。停用、禁用、撤权或用户禁用提升版本并发出取消事件；未完成 Run 采用 **CANCEL** 策略，停止后续模型与工具步骤，拒绝旧 capability，关闭相关流并记录取消原因。若外部写操作已经完成，审计标记为“已发生副作用”，不得声称取消能回滚。超时、控制面不可达或版本不一致时 fail closed。恢复旧知识会话不得重注入已撤权片段；不能靠启动时一次 ACL 判断。

## RC1 基线保留与 RC2 门禁

RC1 是 **Technical Baseline**，不是 RC2 安全通过。`docs/v1/security-regression-map.md` 与 `evidence/v1/p6/security-regression.json` 记录旧路径的 98 条攻击回归及限定结论；`evidence/v1/local-remote-acceptance/` 和 `.codex/PROJECT_STATE.md` 记录本地/公网试验边界。迁移矩阵如下；**每个 RC2 单元均为 NOT_RUN**，实施者需在 RuoYi 新入口、两个员工、管理员和真实反代路径复测，并存新证据，不能复制 RC1 PASS。

| RC1 需保留的性质 | RC2 攻击/验收重点 | RC2 状态 |
|---|---|---|
| Session IDOR、Workspace/Resource/File 隔离 | 互换 ID，猜测不存在 ID，伪造 owner/部门/角色，逐条覆盖读、改、删、列表、下载、导出与 WSS 订阅 | NOT_RUN |
| Knowledge 撤权与旧会话 | Search、Citation、Preview、Download、Source、Context Build、Resume 与在途 Run 撤权后拒绝 | NOT_RUN |
| Resume、Cancel、Approval | 越权恢复/取消/审批；审批绑定 user/session/run/tool/参数摘要/时效；取消后无后续执行，副作用如实记录 | NOT_RUN |
| Credential/Provider Secret 隔离 | Browser、日志、后台、OSS、Tool/MCP、Runtime 读文件和 Gateway 泄露路径 | NOT_RUN |
| 旧 WSS Auth | 无认证、跨用户、Token 伪造、Origin 绕过、撤权后长连接、Quick Tunnel/反代行为；RC1 公网越权曾出现 403/500 差异，均未成功连接但原因未确认，保留原始失败 | NOT_RUN |
| RuoYi 新增专项 | Sa-Token exclude 绕过、超管/ALL/DataPermission ignore、角色升级、菜单权限、OSS IDOR、日志/导出、Redis 多实例失效、WSS Token spoof | NOT_RUN |
| 交付与环境门禁 | Runtime 镜像 HIGH 与 PostgreSQL/gosu 的既有记录及限定缓解继续保留；权限/镜像变化需重审。真实 Linux AMD64 Production Gate 尚未完成 | NOT_RUN |

通过标准：在 **RC2 新实现** 上，API 与 WSS 负例均拒绝且状态/错误不泄露对象存在性，已撤权会话和 Run 无后续私有内容访问或工具动作，日志/OSS/导出不存在旁路；本地回归、实际反代、真实 Linux AMD64 分开记录证据。未完成任何一项时不得称安全全面通过或 Production Ready。

## R3/R4 实测增量（2026-09-20）

evidence/v1/rc2/r3 与 r4 保留当前真实本地结果：安全 Cookie、bearer/header/query 拒绝、Origin、首次改密与旧会话失效、账号停用、原生角色策略失效、员工及超级管理员私人 Session IDOR、内部服务认证、WSS 匿名/跨用户/伪造请求、持久游标回放和运行中模型撤权。模型撤权在真实流进行中执行，旧 WSS 关闭且 Run 转失败；恢复授权后才继续测试。

以上只覆盖当前文本核心链。AI Resource、Knowledge、文件、MCP/Tool、Provider 管理、导出、完整日志审计、多节点 Redis、迁移与公网安全尚未通过，不能将初始 NOT_RUN 表整表改绿。R14 才执行完整新架构回归。

## R5/R6 增量实测

R5 真实资源版本固定、引用分享撤回、在途取消与 WSS 关闭、超管私人内容负例已通过；在线设备列表改为操作者绑定下线句柄，原生令牌不再回显。R6 管理 API 员工越权、密钥密文/不回显、四种模型授权撤回和真实浏览器链通过。另修复了资源共享者读取草稿名称的问题：名称与描述和配置一样取授权版本；超大 subject ID 返回受控错误。

这些仅为对应阶段子集。原生 OSS、全量权限/角色提升、完整知识/工具/MCP/文件链仍在 R10/R14 Gate，不宣称全部安全通过。

## R11 增量证据

公开发布不扩大依赖权限；危险文本生成工具不能直接 activate 为公开。用户不能调用管理员审核，私人普通接口不授予超管豁免。审核内容访问以显式提交为边界，固定资源与知识版本，访问留审计；撤回待审后拒绝读取审核内容。公共知识不泄露待审/驳回草稿。完整安全矩阵仍属于 R14。见 `evidence/v1/rc2/r11/verification.json`。
