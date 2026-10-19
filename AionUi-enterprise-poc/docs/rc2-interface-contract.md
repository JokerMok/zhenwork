# RC2 企业身份接口契约

核对日期：2026-09-24。旧仓库 `workbuddy` HEAD 为 `0e300edc6b8986bb94efbe0f56375c7a2a7dd753`。W01–W04 初检时，原 3580 运行 JAR 与当时本地制品的 SHA-256 一致；随后本地重新编译了 W05/W06 接口并在独立 3589 进程运行，因此当前 `target` JAR 不代表原 3580 的运行制品。原 3580 未重启；测试后台曾暂时停用并恢复员工 A。

## 当前代码已确认

| 动作 | 契约 | 依据 |
| --- | --- | --- |
| 发现客户端 | `GET /ai/bootstrap` 返回 `data.clientId` | `WorkspaceBrandController.bootstrap` |
| 密码登录 | `POST /auth/login` JSON 含 `clientId`、`grantType=password`、`username`、`password`；若开启验证码另含 `code`、`uuid` | `AuthController.login`、`PasswordAuthStrategy.login` |
| 写请求来源 | RC2 拦截器要求登录、退出等非 GET 请求的 `Origin` 精确等于运行配置的 `workspace.public-origin` | `WorkspaceWebSecurity.preHandle` |
| 登录响应 | 服务端真实 Sa-Token 只放在 `__Host-workspace-rc2` Cookie；`HttpOnly; Secure; SameSite=Strict; Path=/`；JSON `access_token="cookie-session"` 是非凭据标记 | `WorkspaceAuthResponse.beforeBodyWrite` |
| 读取会话 | 当前 RC2 配置从 Cookie 读 Sa-Token，不从 header/body 读；后续请求还须发送 `clientid` 头并与令牌内客户端 ID 一致。桌面主进程回送 Cookie 和 `clientid` 后调用 `GET /ai/me` | 运行配置、`SecurityConfig.addInterceptors` 与 `LoginHelper.CLIENT_KEY`、`WorkspacePrincipal.current` |
| 稳定身份 | `/ai/me` 的 `data.userId` 是字符串形式的 `sys_user.user_id`，不是用户名或前端会话键 | `WorkspaceConversationController.me` |
| 停用与撤权 | `WorkspacePrincipal.load` 每次联查 `sys_user.status='0'`、未删除标记和 `ai_principal_state.auth_version`；不匹配抛 401 `SessionRevoked` | `WorkspacePrincipal.load/current` |
| 退出 | `POST /auth/logout` 调用 `StpUtil.logout()`，响应清 Cookie；样机同步结束当前 worker/Core | `SysLoginService.logout`、`WorkspaceAuthResponse` |

源码：[登录控制器](../../deepseek-harness-lab/workbuddy/platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/controller/AuthController.java)、[密码策略](../../deepseek-harness-lab/workbuddy/platform/ruoyi/ruoyi-admin/src/main/java/org/dromara/web/service/impl/PasswordAuthStrategy.java)、[来源拦截器](../../deepseek-harness-lab/workbuddy/platform/ruoyi/ruoyi-modules/ruoyi-ai/src/main/java/org/dromara/ai/workspace/WorkspaceWebSecurity.java)、[Cookie 响应](../../deepseek-harness-lab/workbuddy/platform/ruoyi/ruoyi-modules/ruoyi-ai/src/main/java/org/dromara/ai/workspace/WorkspaceAuthResponse.java)、[主体复核](../../deepseek-harness-lab/workbuddy/platform/ruoyi/ruoyi-modules/ruoyi-ai/src/main/java/org/dromara/ai/workspace/WorkspacePrincipal.java)。

当前运行配置关闭验证码和 API 请求体加密；这只是当前 RC2 配置，不是 RuoYi 永久契约。若部署时开启任一项，桌面登录表单及加密适配必须先扩展。RC2 业务错误可能以 HTTP 200 加 JSON `code` 表示；客户端同时检查 HTTP 与 JSON `code`。匿名读取 `/ai/me` 实测返回 JSON `code=401`，HTTP 状态为 200。

## 本轮设计决定

样机在主进程内存中只保存服务器设置的 Cookie 值，不向 React、AionCore 或本地文件下发；不会把 `cookie-session` 当令牌。用显式 `serverId` 与 `sys_user.user_id` 计算 profile。当前 Sa-Token、状态校验和退出语义足以支撑首阶段桌面身份，故不新增设备会话表。远程部署应使用 HTTPS RC2 入口，并把 `AION_ENTERPRISE_ORIGIN` 设置为服务器实际 `workspace.public-origin`；当前本地运行值会变化，不写入样机源码。

## 2026-09-24 真实联测

- 从本地受保护凭据文件读取员工 A/B 和测试管理员账号；A/B 均完成 `/auth/login`、带 Cookie 与 `clientid` 的 `/ai/me`、`/auth/logout`。会话标记未作为令牌使用。
- 测试管理员调用现有 RuoYi `PUT /system/user/changeStatus` 暂时停用员工 A。其已登录会话的下一次 `/ai/me` 被拒，停用期间再次登录被拒；桌面监督进程发现失效并停止该用户 Core。最后将状态恢复为启用，恢复请求成功。
- 此流程验证当前本地 RC2 配置和代码路径。远程 HTTPS 反向代理、证书、验证码与请求体加密开启后的行为仍需另测。

## 待验证

- 没有验证部署证书、反向代理转发 Cookie 和 Origin 的行为。
- 停用后桌面 Core 在本地观察窗口 10 秒内退出；没有精确计时或验证并发请求中的撤权竞态。
- 当前没有 RC2 刷新接口契约；样机不实现自动刷新。Cookie 到期或 `/ai/me` 失败时结束 worker 并回到登录。

## W05 模型转发增量（独立 RC2 测试构建）

2026-09-24 在保留原 3580 服务的前提下，模型接口先在 3586 测试构建验证，随后在 3587 和 3589 独立测试进程复核。`GET /ai/models/available` 对有权使用的模型增加非敏感 `code` 字段。`POST /ai/model-relay/{modelId}/chat/completions` 要求当前 Sa-Token、`clientid`、Origin、`ai:model:use`、`ai:session:use` 以及模型策略授权；请求必须为选定模型的流式 Chat Completions，初版输出 token 上限 256，当前代码已收紧到 64。当前只允许既有 ARK Provider 的固定目的地；RC2 从现有 `ai_provider.secret_cipher` 取密钥，逐块复核账号和模型权限。接口不使用旧 Harness Run grant，也不新建模型表。

匿名请求实际返回 HTTP 200、JSON `code=401`；模型名不匹配返回 HTTP 400、JSON `code=400`。员工 A 停用后测试构建返回 401，恢复启用后原状态恢复。桌面本地代理必须同时检查 HTTP 状态和 JSON `code`。一次真实上游短请求收到上游 HTTP 200，但旧的通配返回类型使 Spring 报 `HttpMessageNotWritableException`；已改为 `ResponseEntity<StreamingResponseBody>`，定向 Spring MVC 固定 SSE 测试 2/2 通过。该段记录 3586 阶段断点；后续真实短请求见下方。

2026-09-24 后续构建在独立 3587 进程复核：输出上限收紧为 64 token，并向 ARK 请求 `stream_options.include_usage=true`。原始 SSE 字节不改写；RC2 在既有 `ai_security_event` 中按调用 ID 记录 `model.relay.started/finished`，元数据仅含员工关联、模型、完成状态、供应商输入/输出 token 与 `costStatus=UNKNOWN`，不含提示词、Cookie 或密钥。管理员可通过 `/ai/admin/audit?category=model-relay` 查看安全投影。一次真实短请求的结束状态为 `COMPLETED`，供应商返回输入 3452、输出 3 token；因该模型 `cost_config={}` 且无账单，金额未知。首次自动化误读 Shadow DOM；获授权后第二次短请求直接确认 Renderer 显示“你好呀！”，Core `finish`，供应商返回输入 3456、输出 4 token。两次费用金额均未知，详见实施检查记录。


## W06 Skill 与 MCP 增量（独立 3589 测试构建）

Skill 仍走 `/ai/resources/{id}` 的已发布版本和 VIEW/USE 动作；样机仅取得无脚本 `enterprise-succinct` 源文并导入 AionCore 原生 Skill。RC2 资源与 ACL 是授权来源，Core 的导入记录是当前员工本地执行副本，不是第二套企业资源主数据。

新增 `POST /ai/mcp/connections/{id}/relay`。每次请求以现有 Sa-Token Cookie、`clientid`、Origin 与 `ai:mcp:use` 识别员工；`WorkspaceMcpAccess.owned/secretPlan` 再验证资源 USE、连接启用/READY 与授权版本。当前仅允许 `acceptance-catalog` 管理配置，目的地由 3589 启动参数固定为 `127.0.0.1:3588/mcp`；允许的 JSON-RPC 方法为 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`，`tools/call` 再按 RC2 `allowedTools` 白名单检查。请求与响应各限 1 MiB，不跟随上游重定向；企业连接密钥在 RC2 解密并只发给受信目的地。AionCore 仅连接员工监督进程的带随机能力 loopback 代理。该接口不使用旧 `ai_run` grant。

RC2 既有 `ai_security_event` 记录 `mcp.relay`，管理员通过 `/ai/admin/audit?category=mcp-relay` 查看员工、资源、连接、方法、工具名与状态的安全投影；没有记录工具参数、结果、Cookie 或密钥。员工 A 的真实 Agent 调用留下 `tools/list` 和 `tools/call(search)` HTTP 200。无本地能力时代理返回 401，RC2 不允许的工具返回 JSON 403，退出后 RC2 返回 JSON 401。Streamable HTTP 合成目录已通过；stdio 子进程不存在，远程外部 MCP、并发撤权竞态与生产网络配置未验收。

## 2026-09-24 安装试点增量

独立 3589 测试构建将 `WorkspaceModelRelayController` 的单次 `max_tokens` 上限从 64 调整为 512，并新增定向测试验证钳制值。64 token 曾使短办公任务的工具回合以 `MaxTokens` 结束；512 是当前短任务的有界测试值，不是生产配额或费用保证。RC2 定向 Spring 测试 4/4 通过，管理端重新打包；原 3580 进程仍运行旧制品，未获得此变更。调用按现有模型权限判定，真实密钥仍在 RC2；短任务的 RC2 用量审计有员工、模型和 token 数据，费用金额未知。

桌面安装版首次登录需要与当前服务 `workspace.public-origin` 一致的 Origin。3589 与本机 3588 合成 MCP 桥接只适用于本机试点；要供其他员工安装，先把含 W05/W06 接口的 RC2 构建部署在员工可访问的 HTTPS 地址，并验证反向代理下的 Sa-Token Cookie、`clientid`、Origin 和撤权。当前测试部署关闭验证码和请求体加密，部署若启用其中任一项，需先扩展登录适配。包内资源文件只含测试环境的资源 ID 指针，不能当作跨环境配置或授权凭据。

## 2026-09-25 HTTPS 试点契约增量

独立 3589 构建的 `/ai/bootstrap` 增加 `protocolVersion=2` 与配置项 `workspace.server-id`，保留 `clientId`。桌面端要求这两个新增字段有效；原 3580 仍返回旧契约，因此客户端明确提示版本不匹配。稳定 server ID 只由当前 RC2 试点实例配置，不随临时 HTTPS 域名改变；登录后以该 ID 和 `sys_user.user_id` 定位 profile。旧的 URL 哈希 profile 不自动迁移。

临时 Cloudflare Tunnel 将 HTTPS 请求转给仅监听 `127.0.0.1:3589` 的新构建；服务器写请求 Origin 与当前临时地址一致。经公网域名核对：系统信任链 TLS、登录和 Secure/HttpOnly/SameSite Cookie、`clientid` 会话、错误 Origin 拒绝、企业模型/Skill/MCP 列表、一次 MCP `initialize` 中继、授权 40 字节资料下载、退出后撤权、测试账号停用后的 `/ai/me` 拒绝以及无 Cookie WebSocket Upgrade 拒绝。没有在此阶段运行模型任务。停用后的远程文件下载检查因 TLS 握手超时中断；有权 WebSocket、另一台设备和独立网络尚未验收。详见 [HTTPS 试点记录](https-pilot-rc2.md)。

## 2026-09-25 管理校验与当前连接状态

独立 3589 新构建增加 `GET /ai/resources/{id}/publication-check?version=N`（当前有权发布者，返回 `ready` 和 `issues`），助手提交及审核通过时复查所关联模型是否启用/支持流式，Skill/MCP/知识是否已发布/启用，MCP 是否有与发布版本一致的 READY 企业连接。模型验证改用 RC2 自身固定 Provider 的非流式短请求，不依赖旧 3585 Harness Manager；MCP 连接验证改经当前 RC2 中继的 `initialize`、`notifications/initialized`、`tools/list`。外部 HTTPS MCP 需显式 `workspace.mcp.allowed-hosts`，默认不放行；合成目录仍由 `workspace.mcp.acceptance-catalog-url` 指向本机 3588。当前模型中继支持 RC2 已配置的固定 ARK、OPENAI、DEEPSEEK Provider 目的地，真实外部 Provider 本轮未逐个验收。

本机接口操作创建了助手并为员工 A 授权企业 MCP 与知识文档；员工 A 的助手/Skill/MCP/知识授权读取成功，员工 B 同项被拒，退出后 `/ai/me` 被拒。当前 3589 bootstrap 200 且 server ID 稳定，原 3580 保持运行。先前 Quick Tunnel 域名现已无法解析，新 Tunnel 请求超时，**当前 HTTPS 外测入口不可用**；过去的公网检查仅为历史阶段证据，不能当成当前可用性证明。

随后通过 Cloudflare API 取得新 Tunnel，但到 Edge 7844 的 TLS 握手仍超时；3589 已恢复为 `http://127.0.0.1:3589` 的本机同源 Origin，固定 server ID 保持不变。员工 A 的本机登录与退出在此配置下再次通过；稳定 HTTPS 上线时须把 `workspace.public-origin` 改为实际域名并重启独立试点服务。

## 2026-09-25 登录 Origin 自发现增量

截图显示旧安装版的本机服务器地址为 `http://127.0.0.1:3589`，但保留了过期 Quick Tunnel Origin，登录失败。独立 RC2 的 `/ai/bootstrap` 现额外返回非敏感 `requiredOrigin`，值来自当前 `workspace.public-origin`；`protocolVersion` 仍为 2，`serverId` 不变。客户端校验该 Origin 后，在发送 `/auth/login` 前采用服务端要求值，并在成功后保存；登录页异步把尚未手工改动的旧 Origin 替换为服务端当前值。无该字段的旧协议 2 服务仍沿用原设置。校验拒绝不安全的远程 HTTP Origin。真实员工 A 用旧保存值连接新 3589，客户端自动改为本机 Origin 后登录与退出通过；这属于接口检查，更新后的安装版显示和登录仍需界面验收。
