# RC2 执行与 Gate

核对：2026-09-20。已冻结 RC1、创建独立分支、Pin 上游与源码清单、完成加密备份；RC1 双传输性能基线已测量；RC2 PG17/Redis 和官方 Schema 已就绪，Java/Vue 联合启动、原生 API 和 Chrome 用户/部门/角色页已通过。所有完成状态以实际 evidence 为准。

| Gate | 工作 | 状态 | 必要证据 |
|---|---|---|---|
| R1 | RC1 冻结、上游 Pin、性能基线 | COMPLETE | tag/lock/hash/备份/双传输采样 |
| R2 | 官方 RuoYi + PG17 + Redis + Vue | COMPLETE | 构建、启动、登录、SQL 兼容 |
| R3 | 原生 IAM、Sa-Token、Brand | CORE_VERIFIED | API/Chrome 已通过；Employee 品牌随 R4，资产随 R10 |
| R4 | 最小真实核心链 | COMPLETE | API、Chrome、WSS、重启、在途模型撤权及差异回归通过 |
| R5 | Resource/Version/ACL | CORE_VERIFIED | 真实 Assistant 版本/撤权、所有权/动作/超管负例、WSS/身份集成回归；完整资源产品在 R7–R11 |
| R6 | Provider/Model | CORE_VERIFIED | Chrome 配置/真实调用/撤权、密钥替换、四种授权、非流式与错误模型；其它供应商未实测 |
| R7 | Skill | CORE_VERIFIED | SKILL.md 导入、原生 Skill Load、Chrome 任务/历史、依赖越权与在途撤回；企业发布随 R11 |
| R8 | MCP | CORE_VERIFIED | 个人/企业凭据隔离、原生连接/发现/重连/调用、在途禁用、Chrome 闭环；企业管理页/发布随 R11 |
| R9 | Tool | CORE_VERIFIED | 精确计算/文本生成、Skill 依赖、Admin 开关、持久审批/幂等/重启、Chrome 下载；危险资源公开审核随 R11 |
| R10 | Knowledge/File | CORE_VERIFIED | 原生检索/附件、版本引用、全路径 ACL、共享在途撤权、索引恢复、Chrome 和品牌图片；公共资源随 R11 |
| R11 | Assistant/Share/Review | CORE_VERIFIED | A/B 原生完整资源任务、依赖缺项、分享/公开撤回、固定审核版本、Chrome 员工/企业管理 |
| R12 | Audit/Usage | CORE_VERIFIED | 真实模型/MCP 回执、取消后记账、幂等/冲突、脱敏分页、Chrome 运维/员工文件审批 |
| R13 | 数据迁移演练 | REHEARSAL_VERIFIED | 真快照 1831 行、ID/对象/审计哈希、重复导入、首次改密、历史只读/撤权、Chrome 与大集成；旧助手草稿保留 |
| R14 | 完整安全回归 | NOT_RUN | RC1 保留项 + RuoYi 专项 |
| R15 | 性能验收 | NOT_RUN | 与 RC1 对照、目标、冷/热 |
| R16 | 回滚演练 | NOT_RUN | 备份/恢复/冻结/新写保护 |
| R17 | legacy-off | NOT_RUN | 停旧 BFF 后全部真实核心能力 |
| R18 | Cutover | NOT_RUN | 前置 Gate manifest、单写权威 |
| R19 | Quick Tunnel RC2 | NOT_RUN | 统一入口、浏览器、安全/UAT |
| R20 | 真人产品验收 | WAIT_USER_AFTER_R19 | 用户明确 Product Acceptance PASS |

R4 未通过不得铺开完整资源 CRUD。R4/R5/R13/R14/R17/R19 进行对应的大规模集成回归；普通小阶段按风险运行相关测试。R18 不得早于安全、性能和回滚演练。

最终 evidence 在 `evidence/v1/rc2/` 提供 actual-version、migration-results、security-results、performance-results、resource-uat、model-uat、cutover-results、rollback-results、known-limitations。不以文档数量或旧测试数量替代新证据。
