# P6 运维管理模块

本模块提供审计索引、审计链校验、用量汇总和员工额度配置。服务端入口为 `operationsRoute(Context)`，由主服务在鉴权和首次密码修改检查之后接入。前端导出 `AuditAdmin`、`UsageAdmin({canManageQuotas})`，由管理后台现有 QueryClient 包裹。

## 接口

| 接口 | 权限 | 输入 | 返回 |
| --- | --- | --- | --- |
| `GET /api/admin/audit` | `audit.read` | `from`、`to`（含首尾日期，最多 30 天），`limit` 1–200，`cursor` 为上一页最小序号；可选 `action`、`actor`、`result`、`category` | `items`、`nextCursor`、`from`、`to` |
| `GET /api/admin/audit/verify` | `audit.read` | `after` 为前一事件序号，`limit` 1–10000 | `valid`、`reason`、`verified`、`verifiedThrough`、`headSeq`、`complete`、`limited`、`nextAfter` |
| `GET /api/admin/usage` | `usage.read` | `from`、`to`（最多 30 天），`group=user\|department\|model` | `items`、`limited`、筛选日期与维度 |
| `GET /api/admin/quotas` | `system.manage` | `search`、`limit` 1–100、`offset` 0–100000 | `items`、`hasMore` |
| `PUT /api/admin/quotas/:userId` | `system.manage` | `{dailyRequests, dailyTokens}`，分别为 0–100000、0–1000000000 的整数 | `{success:true}` |

审计列表只投影序号、操作者 ID、动作、资源、结果、请求 ID 和时间；不返回 `metadata`、消息或哈希密钥。分类通过固定动作前缀映射，既有未知动作仍可在“全部”或精确动作筛选中查看。日期和页长有界；多页列表按序号游标读取，事件新增不会造成重复页。

校验使用 PostgreSQL `REPEATABLE READ` 快照，先固定链头，再按升序读取最多 `limit+1` 条记录；逐条检查连续序号、前驱哈希和使用现有 `audit.key` 计算的 HMAC，并在扫描到链头时核对链头哈希及是否存在额外尾段。缺失的中间事件、缺失的尾段、链头不一致或多余尾段均返回 `valid:false`。只有从首条事件开始、单次覆盖到链头时 `complete:true`；超过上限或从 `after` 续读的片段只表示局部校验，不能作为全链通过的证明。响应不包含密钥或原始 `metadata`。校验是在线诊断，不是离线防篡改证明；持有数据库与密钥双重权限的攻击者仍可重算链。

用量聚合仅使用 `usage_events`。请求数、错误数和延迟来自所有事件；输入与输出 Token 仅累计 `usage_reported=true` 的事件，同时返回 `reportedRequests` 和 `usageComplete`。分组最多返回 1000 组，达到上限时 `limited:true`，界面要求缩小日期范围。当前不推算金额，所有费用标为 `unavailable`。部门归属使用事件写入时的部门 ID，不追溯现有组织结构。额度列表仅给 `system.manage`，未单独设置额度的员工显示网关当前默认值 200 请求、1000000 Token；保存后创建显式配置，记录 `quota.updated` 审计事件。保存事务先锁组织行并重新认证权限，使用与 Gateway 相同的员工额度 advisory lock，再锁目标员工行。

## 验收边界

模块提供只读审计与用量及受控额度修改；已接入主服务与管理后台，完成真实 API、Chrome、数据库与模型验证。审计校验的 `complete` 仅对应响应所记录的同一数据库快照链头；后续追加的新事件需要再次校验。


## 2026-09-19 本地验收

复用现有 shadcn/TanStack DataTable、Better Auth 权限、PostgreSQL 审计链和 Gateway 额度预留。没有引入新的 Agent Runtime。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 审计/用量/配额 API 六组 | PASS，包含实际零额度请求返回 RateLimit，且 usage 持久化 | `evidence/v1/p6/operations-api.json` |
| Chrome 三组 | PASS，审计分页/全链校验、模型汇总、额度搜索、员工拒绝；页面异常 0 | `operations-browser.json`、两张截图 |
| PostgreSQL 临时表四组 | PASS，篡改事件/尾段/链头拒绝，导出失败回滚审批与文件、并发仅一次提交 | `operations-database.json` |
| V1 攻击矩阵 | 98/98 PASS，另有两项 hardlink PASS；历史 Alpha 未重跑 | `security-regression.json`、`docs/v1/security-regression-map.md` |
| 活跃 Gateway 四组 | PASS，本人正例、令牌用途、跨容器来源 IP、任务结束后拒绝 | `gateway-binding.json` |
| 实际模型审批导出三组 | PASS，write/read、拒绝/跨用户审批、允许后下载实际内容 | `tool-lifecycle.json` |
| 工程检查 | 类型/lint/Web 构建及 20 项单元通过 | 阶段日志 |

发现并修复：重复 JSON 键被接受（含转义同名键）；导出审批先消费、文件入库后失败的原子性问题；审计表分页未接行模型；额度修改与请求预留未共享锁；启动脚本覆盖已有 Parser/Runtime 配置。Gateway 已识别用户的限流/契约拒绝也写入用量，缺失 Provider 用量不算成零消耗。工具授权记录只含能力名，不保存路径或正文。

首轮安全失败与测试夹具失败均保留。Gateway 绑定首轮遇到旧 Runtime 被替换，改为等待数据库实际 running/ready；临时文件夹需使用 macOS canonical path；浏览器汇总选择器补充无歧义标签。上述结果只证明本机真实服务配合合成账号的边界，未包含外部设备或 Linux 生产环境。
