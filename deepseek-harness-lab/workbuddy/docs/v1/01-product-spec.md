# V1.0 产品规格

状态：R2 选型已确定；生产产品尚未实现验收。单企业单实例；中文桌面 Web 优先，响应式适配，文字资源预留 i18n。

## 已验证基础

员工聊天采用 assistant-ui；两端布局、表格、表单使用清理后 dashboard 模块；审批卡使用 tool-ui；认证使用 Better Auth。R1 只验证合成账号与组件集成，完整页面行为仍按下列规格交付。禁止将 Spike 的双用户映射、临时内存状态或开发服务器作为生产实现。

## 角色与数据权限

Super Admin 管理系统/组织策略；Organization Admin 管理部门、成员和可授权的角色；Knowledge Admin 只管理获授权知识库；Auditor 只读脱敏审计与用量；Employee 只操作自己任务、文件、审批和获授权助手/知识。配置权与内容权分离。管理员无私人 Session/文件内容接口；更改角色不能授予超出操作者可委派权限，不能禁用最后一位有效 Super Admin。

权限点采用明确动作，如 users.manage、roles.manage、knowledge.manage、audit.read、usage.read、branding.manage、models.manage、assistants.manage。服务端每次查询实际权限；前端隐藏菜单只是体验。知识管理也需资源范围，不能因角色名自动读全企业文档。

## 员工工作台

| 页面 | 必须行为 | 失败/空状态 |
|---|---|---|
| 登录 | 企业品牌、账号密码、统一登录错误、注销/过期提示 | 限流倒计时；禁用账号拒绝；不泄露用户名存在性 |
| 首页 | 可用助手、最近任务、待审批、开始任务 | 尚无任务可直接创建；无权限助手不展示 |
| 新建 AI 任务 | 选择获授权助手、需求输入、拖拽/选择多文件 | 显示每个文件校验/上传结果，失败可逐个重试 |
| 对话/任务 | 流式、多轮、操作状态、引用、取消、审批、恢复、重试、输出文件 | 区分完成/取消/拒绝/失败；断线恢复不重复提交 |
| 企业知识 | 仅可读知识库/文档和查询结果，来源版本 | 撤权后下一次检索不返回，来源链接也鉴权 |
| 文件 | 私人上传/生成文件、下载、删除、到期提示 | 拒绝危险格式/超限/非本人文件；不显示宿主路径 |
| 历史任务 | 本人搜索、列表、恢复；按最后活动时间分页 | 进程重启仍可读；已删除不可恢复访问 |
| 我的审批 | 自己会话的操作说明、影响文件、允许一次/拒绝 | 已过期/撤销/已处理不可重放 |
| 我的设置 | 个人显示名、改密码、注销、本地设备状态 | 改密码要求当前密码并撤销旧会话 |

员工看到“正在检索资料”“正在处理文件”“等待你的确认”，不显示 Harness、Runtime、MCP、Skill、Tool、Prompt、Provider、Agent Loop。完整技术日志仅向获授权管理员提供且脱敏。员工不能指定身份、运行实例、目录、owner、凭据或模型上游。

## 管理后台

独立 `/admin` 页面壳和 `/api/admin/*` 鉴权，不复用员工菜单。导航分为总览、组织与成员、AI 能力、知识管理、安全与审计、模型与用量、系统设置。管理界面必须支持创建/禁用用户、重置密码、部门/角色/权限分配、助手/知识/工具/模型访问控制、用量查询、配额、安全日志、品牌、系统状态。本地连接器默认显示关闭及原因，不能以开关绕过安全 Gate。

AI 能力中的 Skill/MCP/Provider 是管理员配置词汇；只允许已打包审查的能力，禁止上传任意可执行插件、填写任意命令或任意 baseURL。配置有版本、操作者及审计记录。Provider 只显示 secret reference/是否已设置，从不回显 Key。

## Branding

BrandConfig（数据库维护递增配置版本）：productName（默认 AI Workspace）、companyName、logo、logoDark、favicon、primaryColor、loginTitle、loginSubtitle、copyright、supportText。资产使用受控文件 ID/内部 URL；不能任意 URL/HTML/CSS。颜色只接受六位十六进制；文本长度限制；Logo 支持经过内容校验的 PNG/JPEG/WebP，favicon 上传后统一转为 PNG（ICO 不纳入 V1）；不允许可执行 SVG。

管理员修改并保存后，版本递增，登录页、两端导航、浏览器 title/favicon 同步拉取。主色写入组件语义变量 `--primary` / `--sidebar-primary`；对比度不合格提示管理员并采用可读的文字颜色。既有 Alpha 历史报告名称不篡改；新用户界面无 WorkBuddy 硬编码。

## 完整业务验收场景

以合成客户需求创建“销售方案助手”任务，检索有权企业知识并显示文档版本/引用，调用已打包方案 Skill 和只读产品目录 MCP，读取用户上传需求，生成方案。用户在同一会话修改要求、保存，重启后恢复继续，下载实际输出文件。另一个用户无法读取。中途取消、拒绝敏感保存审批、撤回知识 ACL、Provider 故障都必须呈现正确状态。

## 交互与接口约束

所有提交具有 requestId/idempotencyKey；同会话同一时刻最多一个运行任务，忙碌返回 409。任务状态：queued → running → awaiting_approval → running → completed/failed/cancelled/denied/interrupted。流传输 200 只代表连接建立，必须等 terminal outcome；没有完成事件不得显示成功。重试需要新的请求并确认是否可能存在已完成副作用，禁止自动重放写操作。

设计 Token：语义颜色（背景/文字/边线/危险/成功/警告）、4px spacing 标尺、6/10/16px radius、14/16px 正文、清晰标题层级、focus/hover/disabled/loading/error 状态。品牌覆盖限于受检变量。键盘可达，表单标签/错误关联，流输出不抢焦点。

P5 文件能力当前支持 TXT/MD/CSV/JSON/PDF/DOCX/XLSX/PPTX；每次最多 10 个、合计 20 MiB，提取文字上限 1 MiB，单次对话文件读取上限 256 KiB。较长企业资料通过知识库分块检索。扫描件无 OCR，带密码/外部引用/宏等不支持内容显式拒绝，不把解析失败标为可用。
