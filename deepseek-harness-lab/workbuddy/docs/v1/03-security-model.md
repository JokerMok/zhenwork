# V1.0 安全模型

威胁主体：未认证访问者、普通员工、恶意上传/模型输出/文档、恶意工具输入、权限较低管理员、被窃取的 Runtime 内部凭据。信任域：宿主 OS/Docker、受控发布产物、Manager、BFF、Gateway、DB 运维。容器隔离不是内核逃逸安全认证；宿主 root 能读取宿主数据不在员工隔离保证内。

## 必须保持的不变量

主体由服务端登录会话确定；每次资源操作校验 owner；未知与外人资源同为 404；员工不能覆盖 userId/runtimeId/workspacePath/sessionPath/knowledgePath/credential/owner/provider key。禁止前端直连 Runtime，禁止 Runtime 公网端口、宿主 HOME/socket/Secret/其他用户卷，默认无公网出口。模型和文档指令不能改变授权。

## IAM 与 Web

R2 已采用 Better Auth 1.7.5，替代初版自建密码与会话协议。密码散列、Cookie/session 到期、撤销和重置使用已锁定库实现；不复制原方案的自建 scrypt 参数或 token hash 协议。用户业务 enabled/权限由 BFF 每次查询；cookieCache=false，流发帧前及心跳复核。重置/禁用撤销既有会话；不公开注册或库的完整 admin/impersonation API。

生产 Cookie 使用 Secure、HttpOnly、SameSite=Lax、Path=/，无 Domain，可配置 `__Host-` 名称。仅明确 local 模式允许 loopback HTTP。库会话表可能保存可用 token，数据库最小权限与备份加密必须覆盖；不得在文档中误称仅 hash。持久限流、统一错误、登录/注销/密码变更审计在产品层验证，不用 UI 状态代替实际 revoke。

库内 Origin 防护与 BFF 固定 PUBLIC_ORIGIN 校验共同保护状态变更。包括登录在内的写请求要求精确 Origin，业务 JSON 路由拒绝其他 Content-Type；不用请求 Host 推导合法 Origin，不开放 CORS/任意 redirect。只信受控反向代理来源，不能直接相信任意 X-Forwarded-For。请求 schema/体积/重复参数限制、CSP、富文本禁 HTML、下载 attachment+nosniff 分别验证。

## RBAC 与知识

deny by default；权限可委派范围受约束，员工不可访问 admin，Knowledge Admin 不能变成系统管理员，Auditor 无写权限。管理员角色本身不授予私人文件/会话读取能力。角色/部门变更与 authVersion、aclVersion 更新同一事务。

知识每次检索读取用户当前 enabled/organization/department/roles，以及 KnowledgeBase ACL 和 Document ACL；KB 与文档限制交集生效。索引仅提供候选 ID，返回文本前再次检查当前版本和授权。修改、删除、失效、权限撤回提交后发起的下一次查询立即按新权限执行。并发在途请求在发送结果前检查 aclVersion，变化则重查或拒绝。全文原件不挂到 Runtime，不能绕过检索函数直读旧物理资料。缓存 key 包含权限版本且不能将缓存作为授权依据。

已展示/已下载内容不能被远程收回。历史会话可能含过去授权内容，必须告知此限制；关联知识版本/ACL 发生变化时，新任务/恢复不得将已撤权检索片段重新注入模型。V1 可保守阻止相关旧任务继续并要求新建，避免假装能够可靠删掉所有模型派生内容。既有员工个人历史的查看策略须与知识撤回事件关联，禁止用历史引用接口绕开当前下载 ACL。

## 文件与工具

存储采用服务端生成 UUID 对象名，用户文件名仅元数据。限制单文件大小（初始 20 MiB）与总配额；流式 byte cap、魔数+扩展/MIME 匹配，默认拒绝可执行文件、宏、脚本、HTML/SVG、嵌套压缩包；上传隔离区扫描通过才可用，扫描失败 fail closed。基础恶意文件检测和可选 ClamAV 不能宣称识别所有病毒。临时/删除生命周期写清保留期限。

拒绝绝对路径、NUL、`..`、分隔符文件名、符号链接/硬链接逃逸；受攻击可写目录不能仅先 realpath 再读写。文件服务打开时采用 nofollow/独占写和原子 rename；不通过猜宿主路径下载。Runtime 生成文件导出先检查普通文件、大小/内容和真实归属，再复制到受管文件库。跨用户读/写/ID 猜测均测试。

工具/Skill/MCP 为受审查 allowlist；员工不能安装或传命令。审批绑定 user/session/run/tool/参数摘要/有效期，允许一次原子消费；拒绝后不得借新 call ID 绕过同一高风险动作策略。用户禁用/权限改变时正在执行的敏感后续动作也应拒绝。默认禁 Shell，特殊只读工具也不拥有业务管理权限。

## Secrets 与 Gateway

真实 Key 只经 `/run/secrets` 只读文件或显式环境注入 Gateway，业务表只存 secretRef；无源码/image/frontend/runtime/log 副本。内部 token 分 audience、用户、实例、版本、过期和撤销，DB 可存哈希；仅限受控模型调用，不能改 URL/Authorization/header。固定 HTTPS Ark，禁止重定向/任意 SSRF；请求字段白名单和输出/token/时长预算。流式响应也检查终态、secret 与日志脱敏，不能只扫完整 JSON。

## 审计保证

应用日志、审计、模型用量、安全事件分别存储/保留。审计追加序号和 HMAC(prevHash + canonicalEvent)，事务串行分配链，应用 DB role 无 UPDATE/DELETE/TRUNCATE；无修改历史 API。每日导出链头随加密离机备份留存，可检测锚点之后的链断裂。掌握宿主、DB owner 和审计密钥者仍可重写整链；V1 不承诺外部 WORM 级不可篡改。

## 来源

密码参数参考 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，会话与 CSRF 设计参考 [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 和 [CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。具体数值为本产品初始设计，性能须实测。

P5 落地：引用过知识的会话绑定全企业 ACL 版本；版本变化后保守拒绝该会话、来源和关联生成文件的新下载，关闭已连接 WS，并在 Gateway 后续帧检查中终止在途调用。原文下载在共享授权锁内接受响应；已传出内容不可撤回。Office/PDF 解析放入无网络、无宿主目录/秘密、非 root、只读、受限资源的一次性容器。MCP 仅通过上游显式环境配置接收实例能力令牌，上游 ambient credential scrub 不关闭。
