# AI Resource 与授权模型

状态：R5 资源与 ACL 核心已实现并通过本地真实 Assistant Run 验证；完整资源 UI、依赖解析与审核分别在 R7–R11 验收。

统一资源类型为 ASSISTANT、SKILL、MCP、TOOL、KNOWLEDGE。资源主记录包含 UUID、resourceType、ownerType（USER/ENTERPRISE）、ownerUserId、visibility（PRIVATE/SHARED/ENTERPRISE_PUBLIC）、lifecycleState（DRAFT/ACTIVE/ARCHIVED）、enabled、currentPublishedVersionId、authVersion、createdBy/Time、updatedBy/Time。资源版本不可变，含 version、内容摘要、schemaVersion、依赖、reviewState（NOT_REQUIRED/PENDING/APPROVED/REJECTED）与审核记录。主记录对外返回当前编辑版本的 reviewState，不能因此覆盖已发布版本。

每个具体操作须同时满足账号有效、原生 RBAC 与 Ownership/ACL。USE 另要求 ACTIVE、已激活版本、enabled 且未被安全治理停用；所有者仍可查看和编辑被停用的资源以修正问题。动作拆分 VIEW、USE、EDIT、SHARE、PUBLISH、DELETE、GOVERN；如实现 COPY 则单独授权，不能从 VIEW 推导。PRIVATE 不是管理员可见；SHARED 不是可编辑；企业公开也不自动授予治理权。

所有者编辑产生新版本；审核中的草稿不替换当前发布版本。Run 固定资源版本和依赖图；版本固定不固定授权。分享撤回、停用、用户禁用提升 authVersion 并 CANCEL 受影响 Run，停止后续动作和内容注入。已完成外部副作用保留真实审计，不声称自动撤销。

Assistant 分享的是引用，默认不复制依赖权限。启动前解析模型、知识、Skill、MCP、Tool 的完整依赖；返回明确的缺项代码，不能把 A 的模型权或个人凭据赋给 B。MCP Template 不含 Secret；Personal Connection 绑定使用者凭据上下文，Enterprise Connection 另设 USE 权限。

Skill 导入格式必须由实际 Adapter 能力决定并有版本化 manifest、instruction、requiredTools、dependencies。MCP transport/auth 与 Tool 类型只暴露已实现并有真实 Example 的选项；危险类型的企业发布需审核。当前支持清单与真实任务证据在 R7–R9 写入，不先声称已支持。

Knowledge 拆分 Base、Document、DocumentVersion、Index、Job 与 ACL。原始文件、转换稿、索引、引用、预览、下载、搜索、历史恢复和模型上下文沿同一授权边界。删除/撤权使旧版本与缓存不可再用；每次模型请求前复核依赖，撤权在途采用 CANCEL。

Provider Secret 使用受控密钥加密保存或外部 Secret Service；读取仅 configured/masked/lastUpdated，更新不回显。Provider、Model、权限可动态变更；新 Run 使用最新有效配置，安全撤权覆盖正在运行的版本。密钥解密仅限经过授权的实际连接测试/模型调用路径。

## R5 已实施与边界

SQL 0006/0007 建立统一资源、不可变版本、动作 ACL、引用分享、审核记录、Run 版本绑定及安全事件。五种资源共享授权模型，R5 时仅 Assistant 的 instruction/modelId 接入真实运行；其他类型不能通过空配置冒充可执行能力。

真实 A/B 测试证明：VIEW 不含 USE，VIEW+USE 不含 EDIT/DELETE；V1 在途运行不受普通 V2 编辑/激活影响，下一 Run 使用 V2；撤回分享后原 Run CANCELLED、WSS 1008，恢复和新 Run 被拒绝。超级管理员只能使用治理元数据接口，不获得私人名称、配置和内容；security_disabled 与所有者 enabled 独立，所有者不能解除管理员安全停用。证据见 evidence/v1/rc2/r5/resource-core-2026-09-20T08-42-47-463Z.json。

R5 同时补查并修复原生在线用户接口的身份绕过通道：管理及本人设备列表只返回绑定操作者的五分钟下线句柄，真实 Sa-Token 不返回浏览器。通过句柄强制下线后 Cookie 失效、已有 WSS 关闭。此结论不替代 R14 全量原生接口安全回归。

## R7 Skill 格式与执行路径

当前支持 SKILL_MD_V1：单文件 `SKILL.md`，可放在 `<skill-name>/SKILL.md` 目录内选择该文件导入；不接受 ZIP、可执行脚本或任意附件目录。文件以 YAML frontmatter 开始，字段为 name、description、version、requiredTools、dependencies，正文为 Markdown 指令。name 使用小写英文和连字符，version 为语义版本；requiredTools/dependencies 为资源 UUID 数组，平台另维护不可变资源版本与 manifest.schemaVersion=1。解析拒绝重复键、自定义 YAML 对象、集合别名展开和超限输入。

控制面保存原始文本与解析后的 manifest/instruction。R7 阶段的真实可执行范围为无 Tool 依赖的 Skill；依赖 Skill 按权限解析、检测循环并逐项绑定版本。R7 对非空 requiredTools 返回 SkillRequiredToolsUnavailable；R9 已接入真实 Tool 依赖解析与执行，见下文。

Manager 将授权快照注册到当前 Agent 的原生 scoped Skill registry，原生 `skill` 工具负责加载正文。关闭 Runtime 默认文件 Skill 目录，不向模型自动列出未绑定内容；用户显式斜杠加载关闭，所有加载经过原生 Tool guard 和 Gateway 当前授权复核。Gateway 支持受控 Skill 函数调用；调用事件归一化为 tool.started/completed/failed，原生事件不进入浏览器。

旧会话恢复及新 Run 都复核历史中实际使用过的资源版本和授权版本。移除助手当前依赖不能使已撤权的历史 Skill 内容重新进入模型；需要开启新的授权会话。普通编辑不会取消旧版本 Run，安全撤权仍会取消使用该资源的在途 Run。

API 真实加载已通过，见 evidence/v1/rc2/r7/skill-core-2026-09-20T09-17-09-350Z.json。原生 Skill 内容中的独有校验词和输出格式均生效；分享助手不自动分享 Skill；撤回 Skill 后，历史、恢复和继续旧上下文被拒绝。员工 Chrome 已通过文件导入、绑定、真实任务及刷新恢复工具记录；在实际 Skill 加载后撤权的在途 Run 取消与 WSS 关闭也已验证。证据见 R7 最新 browser-skill 与 skill-core 报告。

## R8 MCP 模板、连接与原生执行

实际支持 Streamable HTTP，认证为 Bearer 或无需认证；支持 JSON 响应及请求内 SSE 结果，不开放服务器主动推送、sampling、任意 stdio 命令和 MCP 资源读取。公网端点仅 HTTPS/443，逐次校验 DNS 结果并固定实际连接地址，禁止私网、URL 凭据和重定向。另有地址固定的本地合成目录验收服务，位于独立 internal Docker 网络，不映射主机端口。它证明协议与执行链路，不代表真实企业数据接入已验收。

模板仅包含地址或受控服务标识、transport、authType、允许调用的工具名和超时。个人与企业连接单独保存，密钥加密且不回显；个人连接只能由本人管理，超级管理员不能接管。企业连接要求原生企业资源权限、企业模板 EDIT；员工仍需模板 USE，不能凭公开模板继承凭据管理权。

连接绑定明确的模板版本。模板更新不会将旧密钥自动发送到新地址；新的 Run 返回 McpTemplateReconnectionRequired，连接所有者确认绑定并重新测试后才能使用。当前 Run 保持原模板端点，连接凭据替换、禁用或撤权则立即取消在途任务，后续模型输入和历史读取也复核连接授权版本。

控制面保存连接测试、发现工具、状态和错误。真实 Run 将 MCP 版本与连接授权版本写入持久化绑定；仅网关在当前授权校验后读取解密凭据。Harness 使用原生 scoped MCP Client，Runtime 只持短期网关能力令牌，实际工具名经白名单约束。发现阶段兼容原生客户端的 server/discover 探测和 initialize 回退；未开放的 MCP 能力不因服务端声明自动启用。

R8 本地验证包含个人连接隔离、错误密钥、密钥替换、真实发现/调用、同会话服务重启重连、模板升级确认、在途禁用、企业连接管理边界及撤回 USE。员工 Chrome 验证模板→个人连接→绑定助手→原生调用→刷新恢复；实际目录数据为合成验收数据。企业管理端完整资源页和发布审核在 R11 完成，不将本阶段 API 核心通过记作全部产品验收。

## R9 Tool 与持久化审批

当前正式支持 CALCULATOR（十进制加、减、乘、除）和 TEXT_DOCUMENT（生成 txt、md、csv、json）。计算参数是有限长度十进制字符串，使用 BigDecimal；除法精度 0–8 位、HALF_UP，不执行表达式或脚本。文本生成仅写入控制面管理的 UUID 文件，正文最大 64 KiB，展示名不得包含路径。当前不支持 Shell、任意代码、数据库写入和自定义网络请求；UI 不提供这些选项。

原生 Admin“AI 资源管理→工具类型”控制类型开关，保存版本化策略并取消使用该类型的任务。员工可创建、版本化和绑定管理员允许的工具。Skill.requiredTools 按统一 Resource USE 解析，并与助手 toolIds 去重、逐项固定资源和类型策略版本；缺少权限或类型被停用时，不创建可执行 Run。

工具经 Harness 原生 scoped Tool 注册、参数校验及权限 Guard 后调用控制面。计算直接执行；文本文件生成必须触发原生 Approval，持久记录 Run、Resource、toolCallId、完整参数、参数 SHA256 和 120 秒有效期。Employee 展示全文，由本人确认或拒绝；超级管理员没有代理确认私人任务的权限。控制面原子校验并消费审批，按 Run/toolCallId 持久去重，同调用不同参数拒绝，不能通过 Runtime 绕过审批生成文件。

文本文件与元数据由 RuoYi 控制，存储目录 0700、文件 0600。浏览器下载携带原生 clientid 和 HttpOnly Cookie，先验证响应再保存文件；下载复核所有者、会话和历史依赖，超级管理员仍不能下载私人文件。文件 SHA256、大小和生成 Run 可核对。当前为纯文本附件，正式上传、文件版本、知识索引和品牌资产在 R10 实施。

确认、拒绝、过期、刷新恢复、控制面重启、重复调用、目录穿越、跨账号下载与管理员停用均有本地实际验证。后端重启将未完成 Run 标为 ControlPlaneRestarted 并取消审批；执行管理器取消残留 Runtime 轮次后，新任务可以继续。类型策略变更使引用旧授权版本的历史上下文不可再用，需要新建任务；已发生的文件写入不会被宣称为自动撤销。企业公开发布的危险资源审核仍由 R11 完成。

## R10 Knowledge / File 实施边界

支持 UTF-8 txt/md/csv/json，每份知识文档最大 2 MiB、50 万字符，每库最多 50 份；账号活动上传文件合计上限 50 MiB。检索采用 PostgreSQL 关键词匹配及 trigram 排序，最多返回 5 个原文片段，不宣称向量或语义检索。持久 Job 驱动分块索引，启动恢复中断任务；版本正文不可变，Run 固定具体文档版本，普通更新仅影响新 Run。

原生 Harness 的 knowledge_search 返回持久引用、版本、行号和原文；attachment_read 读取本会话授权附件。会话最多 5 份附件，每份 64 KiB。知识检索、预览、来源、引用、下载及会话恢复均检查当前权限；文档删除或分享撤回取消在途 Run，旧上下文不能继续注入。员工 Chrome 已验证创建、上传、索引状态、绑定助手、实际模型引用、原文下载和刷新恢复。

复用 RuoYi sys_oss 元数据、ID 生成器和原生文件管理入口；Workspace 私有文件使用本地 UUID 存储键、0700 目录、0600 文件，元数据不暴露正文和真实文件名。原生 OSS 列表排除私有对象，原生下载/按 ID 查询/删除路径不能绕过 Workspace ACL，包括超级管理员。当前未验证云对象存储；软删除和事务前异常留下的私有字节仍保留，不产生匿名链接，保留期与孤立文件清理尚待运维收尾。

品牌图片仅管理员上传 PNG/JPEG，限制 1 MiB 和 16–1024 像素，重新编码 PNG 去除元数据；SVG 拒绝。只有当前 BrandConfig 引用的资产能匿名访问，普通私有文件不能充当品牌资产。Admin、Employee 登录页、侧栏和 Favicon 已接入，Chrome 实测后恢复原品牌配置。

## R11 已验证的发布与共享规则

分享按引用授予 VIEW/USE/EDIT，依赖分别检查；助手可用性检查明确返回无权依赖和个人 MCP 凭据缺项。员工提供五类资源中心、分页和分享撤回。企业管理员可创建五类企业资源、管理知识文档及企业 MCP 连接；凭据不进入模板或审核配置。

公开发布必须显式提交版本，再由有审核权限的管理员审批。USER 所有资源禁止本人审核；企业资源允许具备企业审核权限的管理员显式批准。普通私有资源查询仍拒绝超管；审核接口仅允许读取用户主动提交的版本，知识正文需单独打开已提交文档。撤回待审申请后，该申请详情及正文均拒绝访问。

新版本待审/驳回保留旧发布版本。公开知识检索和文档列表采用审核时固定的文档版本集合；未审核新文档不可预览或下载。历史已批准引用可继续使用，前提是当前资源授权仍有效；撤回公开/分享、禁用和删除覆盖版本固定并取消在途运行。

证据：`evidence/v1/rc2/r11/verification.json`。A、B 均真实执行同一助手的 Skill、Knowledge citation、MCP、计算工具、流式与历史链；B 未授权依赖及缺个人凭据时明确失败，撤权后旧会话不可恢复。Chrome 完成分享→管理员审核→企业发现→真实任务→撤回，以及企业知识索引/预览、MCP 凭据配置/测试。
