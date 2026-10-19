# Workspace Event Contract v1

状态：R4 文本核心链已实现并验证。API/真实 Chrome/WSS 回放/进程重启/运行中模型撤权通过；Tool/Approval 事件随对应资源阶段实施。

控制面统一分配 sessionId、runId、messageId、eventId（UUID）。sequence 为 session 内单调递增 BIGINT，在线协议用十进制字符串。每个命令带 requestId 与 idempotencyKey；Run 保存 configVersion、protocolVersion、资源版本和 authVersion。所有权从登录主体取得，不信任请求体 owner。

事件包含 eventId、sequence、sessionId、runId、timestamp、protocolVersion、type、payload。支持：session.started、run.started、message.started/delta/completed、tool.started/completed/failed、approval.requested/resolved、run.waiting_approval/cancelled/failed/completed、runtime.error。payload 按事件定义，错误对外返回稳定代码，不能含密钥或内部文件路径。

数据库为每个 session 原子分配序号，unique(session_id, sequence)、unique(event_id)；写入后才发布。客户端重连提供 lastEventSequence，服务端重新鉴权后从下一条补发，再接实时流；补发和订阅切换必须消除竞态。客户端按 eventId/sequence 去重，保留最后已应用序号。无权连接不回放正文。

命令幂等唯一键为 (actor, operation, idempotencyKey)，保存请求摘要和确定结果；同键不同参数拒绝。工具副作用单独使用 Run/toolCallId 的持久 ledger，审批使用 approvalId 与预期版本的原子状态迁移，用量按 providerRequestId 唯一入账。不能重启后再次执行已确认成功的动作。对无法确定是否已产生外部副作用的超时进入 UNKNOWN_REQUIRES_RECONCILIATION，不自动重试写动作。

Runtime 原生输出只在 Adapter 内解析；归一化事件与快照一并形成数据库事务。取消先原子改变 Run 状态并使能力失效，再通知执行层；晚到 delta/tool 结果不得重新激活 Run。撤权时中断对应连接及回放权限。刷新后以控制面持久历史恢复，不能靠浏览器内存。

性能 trace 使用 requestId/runId 关联 UI、enqueue、acquire、warmup、gateway、provider TTFB、first token、first visible token、completion。未采集字段为 null 并注明原因，不用 total 猜测各段。

## R4 实现边界

ai_session/ai_run/ai_message/ai_event/ai_command 为控制面持久真相。创建会话和发送消息按用户与幂等键去重，参数不同返回冲突。事件在事务中锁住 session 行分配序号；assistant 增量同时入库，历史读取持有一致性锁。WSS 从数据库游标持续取下一批，无内存订阅切换窗口；每批重新核验 Cookie、账号、原生权限和模型授权。连接有发送时限和 1MiB 缓冲上限。

Java 与执行管理器重启已实测：已完成消息/事件 ID 不变，重复请求不产生第二次执行；用户独立持久卷中的 Harness 会话经容器重建后可继续真实模型对话。控制面启动会将未完成 Run 记为 FAILED/ControlPlaneRestarted，禁止不确定动作自动重试。

R4 时仅文本 Run。R5 已加入资源版本，R7 已接入原生 Skill 的归一化 Tool 事件与历史恢复。通用工具副作用账本随 R8–R12 落地；尚不能声称 Tool/MCP/Knowledge/Approval 已迁移。streamEvents/history 接口保留归一化执行快照，浏览器只使用控制面持久事件，不消费 Harness 原生事件。

## R9 Approval / Artifact

`approval.requested` 包含控制面审批 ID、工具类型、展示文件名、可审核全文和到期时间；`approval.decided` 表达 APPROVED / DENIED / EXPIRED。审批及参数摘要以 PostgreSQL 为权威，Native Harness Approval 只执行控制面决定。`artifact.created` 返回文件 ID、展示名、大小和 SHA256，文件正文经单独鉴权下载。历史 API 同时恢复审批与文件，刷新不会重复请求确认或生成文件。

工具执行账本唯一键为 Run/toolCallId；同参数重放返回同一文件 ID，同键不同资源或参数返回冲突。审批消费与账本写入同一数据库事务。存储操作未提交时可能留下无元数据的私有孤立文件，该文件不可下载，不视为成功；后续文件维护可清理孤立项。当前没有远端写 API，不能把本地文件幂等结论扩展为未知外部副作用已解决。

## R10 Knowledge Citation

knowledge.retrieved 在控制面事务中保存引用后发布，包含引用 ID、Run 内 K1 等编号、文档版本、行号和返回原文。引用 ID 与 Run/文档版本/片段绑定，重复检索复用 ID；历史恢复同样重新鉴权。浏览器通过自己的知识引用卡片访问来源，不透传 Harness 事件。附件元数据从会话历史恢复，文件字节始终走独立鉴权接口。

## R12 调用回执与审计

Gateway 在发起每次模型请求或 MCP 工具调用前，向控制面登记独立 callId。控制面校验当前 Run 授权并持久化记录，签发仅限该 callId 的 `usage.record` 回执；它不能用于执行或读取私人正文。回执有效期 5 分钟，允许记录已取消/撤权任务已经发生的调用，不恢复任何执行权限。重复结果幂等，冲突结果拒绝。重试分别记录实际尝试。

供应商返回的输入/输出 Token 原样采用；未返回的用量为 null。价格按 Run 固定费率估算，缺任一必要费率/用量则费用未知。按日期和币种聚合，展示未知次数，不混币种或把未知记零。Gateway 记录请求发出到响应头、首内容 Token、完成的耗时；不是 UI 或 Runtime 冷启动耗时。调用完成回传失败有限重试，保留未完成回执，10 分钟后页面显示 INCOMPLETE，不伪造成功或零费用。

管理员审计提供 30 条分页的模型/MCP、工具/审批、知识、文件、安全事件；只投影 ID、类型、状态、时间和用量，排除提示词、回答、标题、参数、文件名、凭据及任意原始 payload。运行页同样只提供元数据。员工“我的文件/我的审批”独立按 Owner 分页，下载与打开会话仍走当前权限验证。

证据：`evidence/v1/rc2/r12/verification.json`，包括真实模型/MCP、在途取消、回执幂等及越权、Chrome 审计/用量/运行管理和员工文件下载。
