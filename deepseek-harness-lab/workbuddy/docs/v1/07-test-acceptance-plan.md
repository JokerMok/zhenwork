# 测试与验收计划

## 证据规则

历史 Alpha 98 项原样保留。新执行每轮创建 `evidence/v1/<phase>/<run-id>/`，记录 commands（去 Secret）、exit codes、stdout/stderr、HTTP/业务结果、screenshots（适用）、Docker inspect（环境变量只列名称）、migration、security/load、image digest/SBOM/license/release manifest。历史 PASS 不替代新执行；模型结果只标真实 Provider。使用随机合成 Canary，旧文件不能成为本轮正向控制。

所有 runner 的断言失败必须非零退出。现有只写 status 的专项在 V1 runner 外层解析并强制 Gate，不能仅看进程 0。保留 98 个测试 ID/攻击意图，新增生产 API 适配，说明产品禁用 Shell 后安全拒绝如何等价验证；不得悄悄删攻击或把正向控制改成全拒绝。

## CI 分层

每次 push/PR：npm ci、lint、strict typecheck、unit、PostgreSQL integration/API、browser E2E、migration 空库/升级/失败恢复、Docker build、secret scan、dependency vulnerability scan、许可证 allowlist、SBOM、相关安全回归。Auth/BFF/Runtime/Workspace/Session/Knowledge/Credential/MCP/Bridge/Gateway 路径变化自动触发其越权矩阵。

真实模型/容器 98 套件使用有权限的受控 CI runner；无 Secret/daemon 时明确 BLOCKED，不能 skip 后当 release green。fork PR 不获得生产 Secret。RC pipeline 必须强制全套容器/模型/AMD64；普通 mock 契约测试只验证产品逻辑。多架构构建串行遵守主机资源预算。

## 安全测试矩阵

| 范围 | 必须负例和正向控制 |
|---|---|
| Auth | brute force、expired/revoked session、disabled user、会话轮换重放、password reset、privilege escalation、role tampering；正常登录/注销/改密 |
| Web | CSRF、XSS（聊天/知识/文件名/品牌）、unsafe redirect、CORS、Host header、重复 JSON/query、oversized body、慢请求；正常流 |
| File | malicious filename、traversal、absolute path、symlink/race、MIME spoof、huge upload、cross-user ID/read/write；自己的文件和生成导出 |
| Knowledge | revoked ACL、stale index/version、document ID guessing、department/role change、在途撤权、历史恢复片段；授权检索引用 |
| Admin | employee→admin、knowledge admin→system admin、auditor 写设置、授权超委派、最后管理员禁用；合法管理操作 |
| Runtime | escape 尝试、直接访问、跨网络、socket/HOME/Secret 挂载、资源耗尽、crash/recover、重复创建、idle/shutdown；持久恢复 |
| Gateway | provider/model/baseURL/auth/header override、SSRF/redirect、invalid/expired/revoked/cross-user token、请求预算、stream error、secret response/log；真实 chat/stream/function |
| Local Bridge | device impersonation/replay/revoked/cross-user、unauthorized folder、symlink/junction/path traversal、origin abuse、重连、审批重放；flag 关闭拒绝所有操作 |
| Audit/Usage | UPDATE/DELETE/TRUNCATE 拒绝、链篡改/尾截断锚点、并发顺序、用量去重、配额并发/预留回收、无价格不报准确成本 |

Docker 边界测试只是被测威胁/平台的工程证据，不宣称证明不存在内核逃逸。

## 功能与真实模型

员工九页、管理员导航、白标所有位置、双用户隔离、审批一次性、session resume/cancel、错误重试、上传下载、知识引用逐条 API 和浏览器测试。豆包必须普通/stream/function calling，Harness tools/files/Skill/MCP、多轮、resume、cancel、approval allow/deny、完整方案场景。DeepSeek 等未单独跑全矩阵不得显示“已验证”。

## 20 活跃用户负载目标

候选 8 vCPU/64 GiB Linux AMD64，20 独立账号/客户端 cookie；先 warm 再持续 10 分钟，至少 3 轮，记录机器/版本/Provider 配额和样本数。以下是验收目标而非已有性能事实：

| 操作 | 目标 |
|---|---|
| 20 并发登录 | p95 < 5s，无 5xx；哈希队列有界、内存稳定 |
| 普通 API/历史/鉴权 | p95 < 500ms（不含 Runtime 冷启动和模型） |
| 20 普通对话/stream | 无跨用户帧、无丢终态；平台引入额外延迟 p95 < 1s；模型 TTFT/整体耗时单独报告 |
| Runtime 创建/恢复 | p95 < 60s/15s；超容量明确排队或 503，不能 OOM 主机 |
| Knowledge search | 1,000 合成文档、20 并发 p95 < 1s；撤权不可被 cache 绕过 |
| 文件上传 | 20×5 MiB 并发，控制面内存有界，结果 SHA 一致；限额生效 |

平台错误率目标 <1%，安全/数据错误为零容忍。Provider 超限独立归因但仍影响实际容量结论；不能过滤失败样本。若达不到，优化并重测或正式容量边界降级说明，最终目标改变需用户决定。

## 恢复、升级与外部验收

实际创建用户/角色/ACL/品牌/知识/文件/session/审计 → 备份 → 删除并重建明确标记的测试环境 → 恢复 → 登录核对数据/隔离/审计 → 旧版本到候选迁移 → 回滚演练。生产卷不得用于破坏性测试。

P8 必须干净 Linux AMD64、release artifact、HTTPS 域名、至少另一电脑、两个独立客户端同时使用，执行 05 文档全部 23 步。最终 A–H Gate 与 00 一致；检查匹配同一 commit/image/schema，不允许拼不同候选的 PASS。

## P8 执行补充（2026-09-19）

新增 `images.yml` 手动工作流，AMD64/ARM64 两个平台串行构建控制面和固定 Harness Runtime，不发布镜像、不领取 Provider Secret。当前尚未在远程 CI 执行。基础单元测试已包含 Manager 子网分配；本机 Node 24 下 21 项通过。

长期 98 回归支持显式指定 `WORKSPACE_DEPLOYMENT_STATE` 和独立 `SECURITY_REPORT`；只接受 loopback/localTls 的验收实例。BFF 存储 symlink 攻击在该实例容器内执行，不把生产卷挂到宿主、不扩大公网端口。本机普通 local 模式仍可运行原入口。回归通过仅证明报告记录的版本和平台；最终候选与外部 Linux Gate 单独对齐。

P8 在 Mac 上执行可完成的部署、恢复、升级与交叉构建。前文“P8 必须干净 Linux AMD64”的外部条件按现行主计划移至 P11，验收要求保留，不因阶段移动视为完成。
