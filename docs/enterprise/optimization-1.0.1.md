# ZhenWork Enterprise 1.0.1 五项优化验收

核对日期：2026-11-05。候选应用源码：`69da089d34e837d5042d382c28d592797f98afa5`。隔离企业 B 通过五项定向实测，1.0.1 已发布至生产。结论：GO（本次范围）。

| 项目及入口 | 实际改动 | 隔离验收 |
| --- | --- | --- |
| 管理端 → AI 资源管理 → 资源管理 → 技能 → 从 GitHub 导入 / 维护来源 | 固定提交、许可、树及文件指纹；实际 Core 只读依赖回执，按资源版本、包哈希与镜像绑定。MCP 沿用连接、认证、发现和注册链路，区分失败环节。 | 导入公开 MIT Skill 并固定提交；实际 Core 读取到 `openpyxl 3.1.5`，分别得到 `READY`、缺包 `MISSING`、版本冲突 `INCOMPATIBLE`。界面显示冲突，发布新版本后旧回执失效；普通员工调用维护接口被拒绝。原标准 Skill 在实际任务中照常使用。 |
| 管理端 → 资源管理 → 知识库 → 文档 → 检索诊断 | 复用生产查询的 PostgreSQL FTS、Trigram、包含匹配和排序，展示真实命中候选、文档版本、位置、未索引和 Top K 排除原因。 | 模拟资料当前 v2 命中、不相关问句无命中；v1 历史索引与 v2 当前索引区分，授权原文打开核对。模拟条号、产品手册词和业务规则词均命中同一真实索引。普通员工诊断权限及未共享原文访问均被拒绝。 |
| 员工任务成果 → 结果反馈；管理端 → 运行与审计 → 反馈与 Badcase | 记录实际任务和尝试、成果版本、实际工具与已捕获的助手/模型/Skill 等版本。人工确认原因、修复并记录当前解决版本的定向复核。 | 原任务关联助手 v2、模型 v2、两个 Skill v1 与实际工具。管理员登记原因及证据，个人方法适配后待复核。无当前复核时关闭返回 409；同一输入实际复测并独立核对 Excel 后记录通过、关闭案例。只读审计员无写入控件且接口拒绝写入；其他员工读取返回 404。 |
| 员工工作台 → 能力 → 能力包 → 查看 → 复制为个人方法 / 预览修改 | 自然语言生成草稿和差异，使用既有保存、激活、版本和冲突校验。受控库存执行实际应用个人分组、容量提醒与异常输出。 | 复制标准包后生成真实模型草稿；预览和应用草稿时仍是 v1，显式保存并发布到 v2。新会话执行真实库存工具，下载 Excel 仅一张异常表、一行库区。账面与盘点均为 200 kg、净差 0，仍有两批差异，提示容量 83.333%／个人阈值 80%；数字单元格保持数值类型。组织原版、脚本、公司规则和复制血缘文件字节一致；旧版本及他人修改请求被拒绝。 |
| 员工聊天中的执行过程和成果 | 修复同批事件重复、乱序导致终态回退、切换任务后旧请求覆盖；沿用任务、审批与成果链路。 | 一条个人方法任务先检查 Skill，进入实际业务待确认；刷新仍是同一待确认尝试。员工确认后执行，断线重连恢复同一运行尝试，完成后下载哈希一致。切换任务无旧成果串入，刷新后同一成果卡仍只有一张。另一次中断任务经确认恢复，实际交付文件。 |

## 核心代码

- A：Java `WorkspaceSkillImports`、`WorkspaceSkillDependencyChecks`；Host `enterprise-resource-runtime.ts`、`enterprise-docker-core.ts`；管理端 `SkillMaintenance.vue`。
- B：Java `WorkspaceKnowledge`、`WorkspaceKnowledgeDiagnostics`；管理端 `KnowledgeDiagnostics.vue`。
- C：Java `WorkspaceFeedback`；Host `tasks/feedback.ts`；员工端 `TaskWork/Feedback/`，管理端 `views/ai/feedback/index.vue`；迁移 `0025_feedback.sql`。
- D：Java `WorkspacePersonalSkillDraft`；员工端 `capabilities/SkillDraft.tsx` 和 `SkillEditor.tsx`；Host `office/methods/inventoryGrouping.ts`。
- E：员工端 `pages/workspace/TaskWork/api.ts`、`pages/conversation/Messages/hooks.ts`。

## 对标依据

- [LibreChat Skill 同步](https://github.com/LibreChat-AI/LibreChat/blob/main/api/server/services/Skills/sync.js) 将来源身份和同步状态分开；[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 按插件包组织能力。ZhenWork 在原资源权限内使用固定来源和版本回执。
- [RAGFlow](https://github.com/infiniflow/ragflow) 用文档及片段元数据定位来源；[MOVO 候选选择](https://github.com/himovo/movo/blob/main/services/document-parser/app/services/retrieval_selection.py) 区分候选、排名与最后选择，并保留同一文档的不同条款。ZhenWork 保留本身的词法检索策略，只呈现实际阶段。
- [Dify](https://github.com/langgenius/dify) 将反馈和运行记录关联；ZhenWork 复用自己的任务与资源版本，通过人工证据处理案例。
- [OpenHands 事件存储](https://github.com/OpenHands/agent-canvas/blob/main/src/stores/use-event-store.ts) 用事件身份处理重复和回放；ZhenWork 保留既有 [AionUI](https://github.com/iOfficeAI/AionUi) 聊天与工具折叠，修复展示层合并边界。

本轮借鉴实现原则，未复制这些项目的服务端或界面源码，也未加入相应运行依赖。包来源及许可按固定提交单独记录。

## 安全和验证范围

身份、授权、数据范围和版本仍由企业后端决定。依赖探针只读取已授权 Core 的安装元数据，不执行包脚本、不安装、不联网。未声明依赖的包不生成虚假检测回执；无法确认则标记未验证。知识诊断不虚构向量检索、重排或去重阶段。反馈不会复制整段会话，无法关联的历史或未登记助手版本显示未知。自然语言草稿如包含未授权字段会被拒绝，不写入资源；实际验收中一次模型输出被保护规则挡下，随后合规草稿经员工显式保存。

已通过各组定向检查、集成类型检查、新增 Host 边界测试、个人草稿 Java 9 项（含真实中继输入契约回归）、执行展示 20 项、受影响组件构建和独立复核。两处既有 Host 测试失败在原基线复现：旧准备页断言，以及 macOS 不支持 Linux 管理目录清理。未将两处标记为通过。未重跑全量固危废业务、Office 格式矩阵、备份恢复或并发压力测试。

## 发布回执

- 生产版本：`1.0.1`，发布目录 `20261105-enterprise-1.0.1-opt-v2`。应用提交 `69da089d34e837d5042d382c28d592797f98afa5`，标签 `enterprise-v1.0.1`。
- [员工端](https://zhenwork.shizibandu.icu/) 和 [管理端](https://zhenwork-admin.shizibandu.icu/admin/) 均已在公网实际登录。员工 Core 就绪，助手目录读取通过；管理端反馈列表读取通过。两个入口的 JS 哈希与不可变发布一致，运行中的 Host 和 Core 均为 `1.0.1`。
- 备份完成后切换应用。备份与上线后均为 13 个用户和 3 个模型；迁移 24 → 25，前 24 条哈希完全一致。生产没有写入隔离验收的模拟任务、知识或反馈。前一已验收版本 `20261103-business-query-recovery-v2` 保留为应用回退目标；兼容审查已按实际 25 条迁移记录保存，未执行回退演练。

原 24 个迁移的名称和哈希均保留；新增反馈三表、索引和菜单。保留数据库、会话、文件及配置。生产与隔离 B 采用已审核且与 RC1 源码一致的 Core 镜像，移除生产旧镜像所含受限 PDF Skill；没有重新构建 Runtime。回退只切换应用及其配置，保留追加数据和原迁移，按目标兼容性审查执行。RC1 的标签、历史发行及安装包均保留。
