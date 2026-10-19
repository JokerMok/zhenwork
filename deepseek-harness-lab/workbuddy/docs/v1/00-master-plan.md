# Enterprise AI Workspace V1.0 主计划

日期：2026-09-18。状态：初版规划已保存；R0–R2 与 P1–P7 本地阶段完成，P8 双架构构建及本地验收通过，P9 最终镜像公网 API/WSS 与 Chrome 通过、独立设备待验收，P10 双架构私有验收候选已完成，P11 等待服务器条件；各阶段本地证据见下表。定位：单企业、多人、可私有化部署的企业 AI 工作平台。默认显示名 AI Workspace，目录暂保留 workbuddy。

## 当前事实与盘点

本轮逐文件读取了现有 src、tests、fixtures、README、配置样例及两份 Alpha 报告和攻击矩阵，核对关键 evidence；文件摘要见 `evidence/v1/phase-0/alpha-source-manifest.json`。相邻官方仓库按入口、Agent/Session、运行配置、工具、部署及许可证检查；不声称逐行审计其一万余个跟踪文件。

| 项目 | 核对结果 | 依据 |
|---|---|---|
| Alpha Gate | 历史 PASS，限定合成双用户、macOS + Linux ARM64 | reports/workbuddy-alpha-validation-report.md、evidence/final-qa.json |
| 真实模型 | 豆包 doubao-seed-2-0-mini-260428；DeepSeek E2E 未通过 | gateway-probe-doubao.jsonl、harness-e2e-summary.json |
| 隔离与能力 | 历史 98/98、容器 14/14、主链路 10/10；resume/cancel/approval 有证据 | evidence/v1/phase-0/baseline-verification.json |
| Harness | 0.1.6-alpha.2；ddefc45fbc7f8e46dd73185e68295696d1297887；工作树干净 | 本轮 Git 查询 |
| Git 差异 | workbuddy 原来没有 .git、产品分支/tag/remote/commit；已有 Git 历史属于 Harness | 本轮目录与 Git 查询 |
| 技术栈差异 | 产品是紧凑 ESM JavaScript/Python，不是现成 TS 企业应用；仅 ws 运行依赖 | package.json、src/* |
| 部署现状 | Dockerfile 和宿主 provisioning；无 Compose、HTTPS、正式 DB/CI/Web | 文件盘点 |
| 失败语义 | prompt 传输 200/idle 不证明任务成功，需按当前回合事件判定 | runtime-bridge.mjs、上游 TurnEndReasonMap |

历史测试没有被当成本轮重跑。174 个原始证据文件已记录 SHA256；后续测试写入独立轮次目录，不覆盖它们。现存合成分区与宿主 Harness Web 不作为生产数据迁移源。

## V1.0 范围

员工工作台、独立管理后台、可配置品牌、正式 IAM/RBAC、私有 Session/文件、动态企业知识 ACL、受控助手/Skill/MCP/工具、豆包真实链路、审计/用量/配额、Runtime 生命周期、Compose HTTPS 安装、备份恢复升级回滚、CI/安全回归和外部 AMD64 验收。企业管理员默认不能读取员工私人内容。

Local Bridge 按安全设计、最小 Spike、攻击、双平台打包顺序独立验收；未达到 Gate 保持关闭并归入 1.1，不拖延 Web 文件能力。OIDC 预留适配接口，V1 不承诺未验证的 SSO。

## 明确不做

公网多租户 SaaS、插件市场、无限制 Shell、任意 MCP 安装、员工自定义 Provider、企微/钉钉/飞书、手机 App、Kubernetes、大规模微服务、模型训练、自研模型、复杂收费、大量预制助手。V1 不是官方 Harness UI 的转发站。默认不接真实企业敏感资料。

## 复用优先纠偏（2026-09-18）

原规划保留在 commit 2e1bccd，Alpha 基线 commit 2efae93，tag `baseline/alpha-boundary-pass-2026-09-18`；产品仓库现已独立，官方 Harness 仍 clean。新增 R0 → R1 → R2 为大规模产品实现前置：开源源码/许可证审计 → 三个实际运行 Spike → Foundation Decision。顺序为 ADOPT → ADAPT → INTEGRATE → REFERENCE → BUILD；每项 BUILD 必须证明复用不适合。认证优先 Better Auth，聊天优先 assistant-ui，后台优先成熟 starter，最终以 Spike 为准。

R1 已以真实模型/浏览器验证三个 Spike，R2 正式选用组合 Foundation，依据 `reuse/foundation-decision.md`。Quick Tunnel 只在生产候选本地开发完成后用于真实远程验收，Spike 不对外暴露。

## 阶段与依赖

每阶段 Done 必须包含 Implementation、Test、Security、Docs、Evidence、Git Commit。历史测试、替身、模拟架构或编译通过不能代替对应实际验收。

| 阶段 | 交付 | Gate/状态 |
|---|---|---|
| R0 | 开源源码/许可证/耦合审计、矩阵与来源锁 | 完成 `6d93df1` |
| R1 | assistant-ui/Harness、Better Auth/PG、Admin/Brand 实际 Spike | 完成 `317a06e`；详见报告 |
| R2 | 固定 Foundation，增量修订现有主计划/规格/架构/ADR | 完成选型；不等于实现生产 |
| P1 | 独立仓库（已完成）、TS 工程、PG17、校验 migration、配置、CI | 本地通过；详见 p1-foundation.md，远程 CI 未执行 |
| P2 | Better Auth、企业 RBAC、owner | 本地 24 项 API 正负例通过，含在途重置；详见 p2-identity.md |
| P3 | 可信 Manager/Gateway、员工端 assistant-ui、正式 WS adapter、持久 run/approval/history | 本机真实模型/浏览器及 12 项边界通过，详见 p3-employee-runtime.md；附件接 P5 |
| P4 | 独立 Admin、部门/用户/角色/能力、完整 BrandConfig | 本地 11 组 API、13 项浏览器通过；详见 p4-admin-brand.md |
| P5 | 持久 Knowledge 动态 ACL、索引/引用、Web 文件 | 本地解析7项、API20项、浏览器4项、真实场景4项通过；详见 p5-knowledge-files.md |
| P6 | 审计链、用量/配额、安全矩阵与 98 回归 | 本地 98 项及活跃 Gateway/审批/审计用量通过；详见 p6-operations-module.md |
| P7 | Tauri Local Bridge 安全与打包 Gate | 归 V1.1；关闭 Gate 三项通过；未宣称桌面实现 |
| P8 | Compose、multi-arch、backup/restore/upgrade/rollback、CI/SBOM/license、20人基准 | 实际数据恢复、升级演练和实测容量；无虚构大并发 |
| P9 | Quick Tunnel 统一入口远程验收 | 不同设备/浏览器/真实账号；不能用两个 Tab 替代 |
| P10 | v1.0.0-rc.x 候选与 release manifest | 本地 Gate 全通过；缺真实外部验收如实标记，不称 Production Ready |
| P11 | 真实 Linux AMD64 干净部署/HTTPS/升级/安全验收 | 真正需要时一次性索取 SSH/服务器/必要域名条件；此前持续本地开发 |
| P12 | v1.0.0 | 所有发布 Gate 同候选通过才打 tag |

## 架构取舍与技术债

沿用固定 Harness 和外置桥接，先保留 Alpha 源码作为回归基线，新控制面逐步替换。Node/TypeScript 模块化单体 BFF 负责员工与管理员不同路由；不另拆无收益的 admin 微服务。Docker 权限移至单独可信 Manager。PostgreSQL 成为业务权威；Harness 自有日志仍在各用户独立持久卷，owner 在 DB。知识文件不挂载 Runtime，授权检索经受限执行接口。详细见 02–04 与 ADR。

现有实验债：users.json 明文测试密码、永久内存 bearer、无 RBAC、宿主 BFF 可 docker exec、固定 user_a/b、静态知识挂载、进程预算重启清零、审批内存状态、无忙碌任务持久锁、原始事件直接透传、密集单行源码、部分旧测试仅写状态而不非零退出。这些不会被标成 Production 实现。

## 风险与停止条件

- 发现跨用户内容/凭据泄漏立即停止依赖功能与真实资料接入，保存失败、修复并完整复验。
- 动态撤权不能收回已经展示或下载的内容；不能承诺模型“遗忘”。新检索、引用下载和新执行均重新授权，旧会话受控恢复，见安全模型。
- 单用户 2 GiB Runtime 意味 20 活跃用户可能需要约 40 GiB 加控制面余量；容量以实测为准，不承诺普通小服务器承载 20 个全活跃运行实例。
- 多架构原生模块、上游已知失败、Provider 限流、许可/依赖漏洞可能阻断 RC。失败不得改断言迎合结果。
- 审计 HMAC 链无法抵抗同时控制宿主和密钥的管理员；外部备份锚点减小事后篡改空间，必须写清保证边界。
- 外部环境、域名或真实凭据不足仅阻断依赖验收；此前继续本地可完成工作。真实数据删除、不可逆外部动作和核心范围变化需用户决定。
- 不切换上游、不放开 Runtime 公网、不挂宿主 HOME/socket、不复用生产目录进行破坏性测试。

## 最终上线 Gate

| Gate | 必须满足 |
|---|---|
| A Product | 员工端/管理端/品牌/RBAC/Knowledge/日志真实可用 |
| B AI | 当前豆包普通/stream/function、Harness Tool/Skill/MCP、多轮、resume/cancel/approval 和完整场景 |
| C Security | 原 98 语义与新增矩阵全部通过；无跨用户泄漏、无 Provider Key 泄漏 |
| D Deployment | 干净 Linux AMD64 服务器从 artifact 安装，域名 HTTPS，另一电脑且两个独立客户端并发 |
| E Persistence | 整栈重启、实际 backup → 重建测试环境 → restore，用户/Session/ACL/品牌/审计恢复 |
| F Upgrade | migration、RC → V1 升级、带数据回滚演练 |
| G Operations | 健康/readiness、日志/审计、资源限额、正确错误映射、20 活跃用户容量报告 |
| H Release | SBOM、许可证、secret/vulnerability scan、CHANGELOG/release notes、源码和镜像 digest、签核证据 |

每个 Gate 记录 PASS/FAIL/BLOCKED/NOT_RUN、commit、时间、平台、命令和证据哈希。NOT_RUN 不能折算 PASS；测试替身不替代真实模型或真实外部部署。
