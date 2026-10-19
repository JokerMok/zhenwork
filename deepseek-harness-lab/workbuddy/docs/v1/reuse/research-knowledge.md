# R0 知识库与 RAG 开源复用审计

核对时间：2026-09-18 15:52（Asia/Shanghai）。本轮只做静态源码审计：四个仓库均从官方 GitHub 地址浅克隆到 `.research/`，固定 HEAD 后查看许可证、目录、实现、测试、迁移、Docker 与安全资料；未安装依赖，未运行仓库脚本、测试、构建、Docker 或服务。机器可读证据见 [`evidence/v1/reuse-r0/knowledge-repos.json`](../../../evidence/v1/reuse-r0/knowledge-repos.json)。

## 结论

采用 **A → B**：先建设 WorkBuddy 自有的轻量知识能力，再按真实文档语料选择性适配解析组件。DeepSeek Harness 继续固定为唯一 agent/provider/session/tool/approval Runtime；知识检索通过受控 capability API 或工具接入，不引入第二套 agent runtime。

四个仓库都不适合整体集成或 fork。原因不是功能不足，而是授权模型不匹配：WorkBuddy 要求每次查询读取当前用户、组织、部门和角色，KB ACL 与文档 ACL 取交集，索引只返回候选 ID，文本返回前再次鉴权，并在响应前检查 `aclVersion`。本轮查看的四套检索路径都没有完整实现这条链路。

- **首选复用候选：Onyx CE 的解析隔离与过滤组合思路。** 只允许使用 MIT 范围内的文件，解析结果仍由 WorkBuddy 分配文档身份、版本和 ACL。
- **次选复用候选：RAGFlow DeepDoc 的局部算法。** 只在真实语料证明 Onyx CE/基础解析不足时，提取小而明确的 Apache-2.0 片段，例如 DOCX 文本框去重。其 PDF/OCR 主链过重，不作为首批依赖。
- **AnythingLLM、LibreChat 仅作设计和测试参考。** AnythingLLM 的权限粒度停在 workspace；LibreChat 主仓库只有外部 RAG API 适配层，无法审计其解析与检索核心。

## 硬边界

WorkBuddy 的授权权威留在 BFF/数据库。任何 parser、embedding 或向量索引都不是授权权威，也不能自行决定可返回哪些文本。

一次查询至少要经过：

1. BFF 从服务端登录会话解析主体，并读取当前 enabled、organization、department、roles 与 `aclVersion`。
2. 计算 KB ACL 与 Document ACL 的交集，deny by default；把可检索文档 ID 或不可伪造的授权上下文交给检索层。
3. 索引返回候选 ID 与分数，不直接向 Runtime 返回正文。
4. BFF 按当前授权再次筛选候选，核对文档版本、索引版本和 `aclVersion`，再加载正文片段。
5. 若查询期间 `aclVersion` 改变，重查或拒绝；缓存键包含权限版本，但缓存不能替代鉴权。

因此，开源代码可以复用解析、分块、索引适配、引用格式和测试思路；身份、ACL、审计、撤权与正文释放逻辑不得委托给这些项目。

## 仓库快照与许可

| 仓库 | 审计 HEAD（提交时间） | 版本标签 | 许可证 | 结论 |
|---|---|---|---|---|
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm/tree/da6685510ce691b2e1be417f739c7dffee3cfc49) | `da6685510ce691b2e1be417f739c7dffee3cfc49`（2026-09-17T16:23:16-07:00） | `v1.16.1`，`35c58d89907e675a8c4fb10544c19be0f050f611`，2026-08-27 | MIT；`LICENSE` SHA-256 `782d2dc18a1ed9028ca992520f42b2e0b6187807da0d14455b8ae608e2e5692e` | reference |
| [LibreChat](https://github.com/danny-avila/LibreChat/tree/12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a) | `12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a`（2026-09-16T22:13:49-04:00） | 最新版本标签 `v0.8.8-rc3`；稳定版 `v0.8.7` | 根 `LICENSE` 为 MIT，SHA-256 `1ce5c9d51e5ab764b44142cd44d1e687f5bfe32f807c7221c14d061007309b97`；根 `package.json` 却声明 ISC，复制时必须按具体文件保留通知，并在分发前解决元数据不一致 | reference |
| [Onyx](https://github.com/onyx-dot-app/onyx/tree/2931768b33b412e0588268ad1d069012776b2373) | `2931768b33b412e0588268ad1d069012776b2373`（2026-09-18T05:37:08Z） | 最新版本标签 `v4.8.0-cloud.2`；稳定版 `v4.7.7` | 混合许可：根 `LICENSE` 明确 ee 目录之外为 MIT Expat；根许可 SHA-256 `d4847240794058c7ac3cfdf8e5d528fe8b0edf15b32a96612ecb9b3e182092b7` | selective adapt，限 CE |
| [RAGFlow](https://github.com/infiniflow/ragflow/tree/4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5) | `4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5`（2026-09-18T15:40:33+08:00） | `v0.27.2`，`a024bea0cd93f39e6652a42bf84dd20c55bc560b`，2026-09-10 | Apache-2.0；`LICENSE` SHA-256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` | reference；特定 parser 可做窄幅 spike |

上述 HEAD 在文档落盘前用 `git ls-remote origin HEAD` 复核，与本地审计 SHA 一致。“最新版本标签”按远端 version sort 选取；稳定版排除 `rc`、`beta`、`cloud` 后缀。

### Onyx 路径级排除

Onyx 根许可证明确列出三个企业许可目录：

- `backend/ee/**`，许可证 `backend/ee/LICENSE`
- `web/src/app/ee/**`，许可证 `web/src/app/ee/LICENSE`
- `web/src/ee/**`，许可证 `web/src/ee/LICENSE`

三个企业许可证文件 SHA-256 均为 `38099c15fbd2f7f63245cb24a147f8f4b51e84b17a79560b9f74e7bdd4211edd`。本轮搜索排除了 `**/ee/**`，没有复制或以 EE 实现正文作为结论依据。后续适配必须保持同样的路径拒绝规则，且不得直接安装 Onyx 默认依赖组，因为 [`pyproject.toml`](https://github.com/onyx-dot-app/onyx/blob/2931768b33b412e0588268ad1d069012776b2373/pyproject.toml) 的默认组包含 `ee`。

## 源码审计

### AnythingLLM：参考，不集成

权限入口在 [`validWorkspace.js`](https://github.com/Mintplex-Labs/anything-llm/blob/da6685510ce691b2e1be417f739c7dffee3cfc49/server/utils/middleware/validWorkspace.js#L5-L39)：多用户模式下校验用户是否属于 workspace，thread 再绑定 user 与 workspace。文档写入则在 [`documents.js`](https://github.com/Mintplex-Labs/anything-llm/blob/da6685510ce691b2e1be417f739c7dffee3cfc49/server/models/documents.js#L83-L141) 中以 `workspace.slug` 作为向量 namespace。聊天检索在 [`stream.js`](https://github.com/Mintplex-Labs/anything-llm/blob/da6685510ce691b2e1be417f739c7dffee3cfc49/server/utils/chats/stream.js#L94-L190) 直接查询该 namespace 并消费正文；此路径没有文档级主体交集、候选后二次鉴权或 `aclVersion` 复核。

Collector 的 [`processSingleFile`](https://github.com/Mintplex-Labs/anything-llm/blob/da6685510ce691b2e1be417f739c7dffee3cfc49/collector/processSingleFile/index.js#L24-L90) 有可借鉴的目录约束、扩展名分派和 unknown-type 处理，但它依赖 collector 的 watch directory、converter map、文件移动和输出约定，直接搬入会带进整套 CJS 服务边界。

安全默认也不适合 WorkBuddy。[`SECURITY.md`](https://github.com/Mintplex-Labs/anything-llm/blob/da6685510ce691b2e1be417f739c7dffee3cfc49/SECURITY.md#L21-L59) 把无认证模式、采集器访问内网地址、管理员配置任意服务 URL、全权限 Developer API Key 和管理员启用的宽权限 agent tool 视为有意设计。Docker Compose 还为容器添加 `SYS_ADMIN`。这些并非项目错误，但与 WorkBuddy 的 deny-by-default、固定上游和受审查工具边界相冲突。

审计库存：5,685 个 tracked files、66 个 test-like paths、12 个 Docker-like paths、41 个 migration-like paths。未执行测试。

### LibreChat：只复用生命周期与测试思路

主仓库没有 RAG parser 或检索服务实现。[`rag.yml`](https://github.com/danny-avila/LibreChat/blob/12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a/rag.yml#L3-L28) 启动 pgvector 和外部 registry 的 `rag_api` 镜像。仓库里的 [`crud.js`](https://github.com/danny-avila/LibreChat/blob/12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a/api/server/services/Files/VectorDB/crud.js) 只负责用绑定 `req.user.id` 的短期 JWT 调用 `/embed` 与 `/documents`。

文件搜索在 [`fileSearch.js`](https://github.com/danny-avila/LibreChat/blob/12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a/api/app/clients/tools/util/fileSearch.js) 中先按 agent/file 权限筛文件，再逐文件调用外部 `/query`。这是查询前过滤；收到正文后直接格式化为引用，没有 WorkBuddy 所需的 `aclVersion` 和返回前二次授权。该实现还绑定 LibreChat agent、Mongo file model、PermissionService、JWT crypto 与 tool schema。

可复用的是边缘设计：[`file.ts`](https://github.com/danny-avila/LibreChat/blob/12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a/packages/data-schemas/src/schema/file.ts) 的 embedded/tenant/expiration/retry/entity 元数据，以及 [`permissions.spec.js`](https://github.com/danny-avila/LibreChat/blob/12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a/api/server/services/Files/permissions.spec.js) 中 owner、agent attachment、无 VIEW、DB 异常 fail-closed 等用例。应重写为 WorkBuddy 的模型和测试，不复制 adapter 主链。

审计库存：5,392 个 tracked files、1,907 个 test-like paths、13 个 Docker-like paths、12 个 migration-like paths。未执行测试。

### Onyx CE：首选选择性适配候选

Onyx 是四个项目中最接近动态 ACL 的实现。CE 的 [`access_filters.py`](https://github.com/onyx-dot-app/onyx/blob/2931768b33b412e0588268ad1d069012776b2373/backend/onyx/context/search/preprocessing/access_filters.py) 会从当前用户建立索引 ACL；[`FILTER_SEMANTICS.md`](https://github.com/onyx-dot-app/onyx/blob/2931768b33b412e0588268ad1d069012776b2373/backend/onyx/document_index/FILTER_SEMANTICS.md) 明确把 tenant、ACL 与 assistant knowledge scope 组合为 AND 条件。

但 CE 边界仍不够。MIT 范围的 [`access.py`](https://github.com/onyx-dot-app/onyx/blob/2931768b33b412e0588268ad1d069012776b2373/backend/onyx/access/access.py) 主要把用户当前/历史邮箱和 public 标记组成 ACL；user group、external group 等逻辑通过 versioned/EE hook 扩展。即使索引过滤正确，本轮也没有找到候选返回前用当前业务 ACL 与版本号再次核验正文的完整链路。因此不能把 Onyx CE ACL 直接当成 WorkBuddy 授权权威。

可做 parser spike 的是 [`extract_file_text.py`](https://github.com/onyx-dot-app/onyx/blob/2931768b33b412e0588268ad1d069012776b2373/backend/onyx/file_processing/extract_file_text.py)：编码检测、PDF 子进程隔离、PDFium 失败回退、嵌入图片上限等做法具有明确价值。适配时只提取必要函数和测试，放进无网络、有限 CPU/内存/时限的 parser worker；不导入 Onyx 应用、auth、agent 或索引服务。

完整服务不可取。官方 Compose 同时依赖 API/background worker、PostgreSQL、OpenSearch、Redis、inference/indexing model server 与可选 MinIO，迁移和部署责任远超 V1 所需。

审计库存：7,907 个 tracked files、2,013 个 test-like paths、39 个 Docker-like paths、481 个 migration-like paths。未执行测试。

### RAGFlow：解析质量参考，整套拒绝

RAGFlow 的权限在数据集层面。[`knowledgebase_service.py`](https://github.com/infiniflow/ragflow/blob/4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5/api/db/services/knowledgebase_service.py#L118-L128) 将可见性定义为本人拥有，或用户已加入租户下的 `TEAM` 数据集；[`accessible`](https://github.com/infiniflow/ragflow/blob/4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5/api/db/services/knowledgebase_service.py#L569-L590) 延续这一模型。Dify 检索路由在调用 retriever 前校验数据集权限，随后直接把返回 chunk 正文组装为 records，见 [`dify_retrieval_api.py`](https://github.com/infiniflow/ragflow/blob/4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5/api/apps/restful_apis/dify_retrieval_api.py#L252-L309)。没有文档 ACL 交集或响应前版本复核。

DeepDoc 功能强，但模块耦合明显。比如 [`docx_parser.py`](https://github.com/infiniflow/ragflow/blob/4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5/deepdoc/parser/docx_parser.py#L17-L113) 会处理文本框以及 `mc:Choice`/`mc:Fallback` 重复内容，这个局部算法值得留作候选；同一模块同时依赖 pandas、RAG tokenizer、图片抽象和项目常量。PDF 主链还依赖 OCR、视觉模型、资源文件与布局识别，不宜作为 V1 基础解析器。

安全维护证据存在疑点：当前 `v0.27.2` 仓库的 [`SECURITY.md`](https://github.com/infiniflow/ragflow/blob/4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5/SECURITY.md#L3-L21) 仍写“支持 <=0.7.0”，正文保留一份旧代码执行漏洞报告。这不能证明当前版本不安全，但说明该文件不能作为清晰的现行支持承诺。

审计库存：6,226 个 tracked files、786 个 test-like paths、38 个 Docker-like paths、32 个 migration-like paths。未执行测试。

## A / B / C / D 比较

| 方案 | 动态 ACL | Runtime 影响 | 运维/迁移 | 复用价值 | 决定 |
|---|---|---|---|---|---|
| A. WorkBuddy 自有轻量知识能力 | 可按 V1 精确实现：查询前 + 候选后 + `aclVersion` | Harness 不变，只新增受控 capability | 最低；沿用 WorkBuddy DB、审计和文件边界 | 复用开源接口、测试和索引适配思路 | **现在采用** |
| B. 选择性适配 parser | parser 不参与授权；解析后由 WorkBuddy 赋 ACL | 独立 worker，不接 agent/provider/session | 中等；需文件类型、沙箱、超时和语料回归 | Onyx CE 优先，RAGFlow 小算法按需 | **A 契约稳定后采用** |
| C. 完整 RAG API/service | 四者均不满足完整的候选后版本化鉴权 | 会带入第二套 auth/agent/provider/session 或 opaque service | 高：新 DB、索引、迁移、队列、镜像与安全升级 | 表面能力多，适配后优势大幅缩水 | **拒绝** |
| D. 不提供知识服务 | 因无功能而 fail-closed | 无 | 无 | 无 | **V1 拒绝**：无法完成带引用检索和撤权场景 |

A 不是继续使用 Alpha 的 `documents.json` 与 substring search。现有实现只证明边界；V1 需要 durable `knowledge_bases/documents/document_versions/knowledge_acl/document_acl/knowledge_index/index_jobs`、版本一致性、引用、失效与审计。A 的含义是由 WorkBuddy 自己掌握这条最小生产链，而不是引入完整开源平台。

## 交给 Spike 的最小入口

1. 先固定 WorkBuddy 的 `ParserOutput` 与 `RetrievalCandidate` 契约。parser 输出正文、结构、页码、资源引用、告警和 parser/version；不得带“已授权”结论。retriever 只返回 `documentVersionId/chunkId/score/indexVersion`。
2. 以三类合成语料做 parser spike：中文 PDF（文本层/扫描/损坏字体各一份）、DOCX（表格、文本框、页眉脚）、XLSX/PPTX。对比现有基础解析、Onyx CE 选择性适配；只在失败样本上加入 RAGFlow 局部算法。
3. ACL spike 必须覆盖：KB allow + doc deny、KB deny + doc allow、部门/角色变化、禁用用户、查询中途撤权、旧缓存、旧 session 引用、索引残留候选、外人 ID 猜测。
4. 开源代码进入产品前保存 `upstream repo + SHA + source path + license hash + local adapted file + modification notice`。Onyx 适配器增加 CI 路径守卫，拒绝任何来源位于三个 `ee` 前缀的文件。

本报告支持进入 R1 Spike，不构成依赖安装、运行通过、生产安全或法律意见。
