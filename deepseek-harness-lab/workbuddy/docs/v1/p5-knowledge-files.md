# P5 知识权限、解析与 Web 文件

状态：实现及本机验收通过；不是外部设备验收。基础复用保持 R2 选型，唯一 Agent 为固定 Harness。

## 复用与边界

文件拖拽采用 react-dropzone 20.1.2，聊天附件采用 assistant-ui AttachmentAdapter 与附件组件，multipart 采用 Busboy 1.6.0。解析选择 PDF.js 6.3.289、OfficeParser 8.0.0，ZIP 预检采用 yauzl 3.4.0。包、精确源码版本、tarball integrity、许可证及依赖闭包见来源锁；不复制 Onyx EE，不引入 RAGFlow/Onyx Agent 或整套后端。相比引入完整知识平台，这一组合保留单套身份、索引和动态授权，部署只增加短时解析容器。

## 已实现规则

知识库授权每次查询重新读取员工、部门、角色与全企业规则；拒绝优先。文档权限与知识库相交；文档没有允许规则时继承知识库，有允许规则时需额外匹配。全局 knowledge.manage 不替代具体知识库管理权限；super_admin 只覆盖管理权，不默认读取所有文档。用户/角色/部门变更与知识变更提高全企业 ACL 版本，引用过知识的旧任务保守失效。

上传原文、解析状态、索引任务、文档版本、分块、引用均持久化于 PostgreSQL。检索使用中文分词和参数化关键词匹配，最多返回 8 段；不是语义向量检索。来源使用不可猜测的版本 ID，访问原文和下载再次检查当前文档版本和 ACL。助手只能检索已关联且当前员工可读的知识库。企业检索与产品目录 MCP 共用这套授权。

授权查询持有组织共享锁，ACL 修改持有排他锁，结果写入响应队列前保持授权顺序。WebSocket、旧会话恢复与 Gateway 后续模型帧重新检查版本。已经展示或传出的字节无法远程收回；撤权后阻止旧知识会话、原文链接和相关生成文件的新下载，不能宣称模型遗忘。

Web 文件每次最多 10 个、合计 20 MiB；支持 TXT/MD/CSV/JSON/PDF/DOCX/XLSX/PPTX。纯文本或提取文字上限 1 MiB，Runtime 单次 read 上限 256 KiB；大文档优先进入知识库分块检索。格式、MIME、魔数、UTF-8、路径与文件名均校验，服务端 UUID 存储，下载检查当前 owner，普通管理员无私人文件读取权。每人暂定 1000 个文件、500 MiB，总量超限拒绝。基础检查不是完备杀毒服务。

PDF/Office 在无网络、无宿主挂载、非 root、只读根、cap-drop、no-new-privileges 容器中解析；CPU、内存、PID、时间与输出均有上限。PDF 字符映射来自本地包；拒绝加密、无文字、活动内容。Office 拒绝外部关系、宏/嵌入对象、实体声明、路径逃逸和压缩体积超限；不启用 OCR。失败状态可见，更新文档保留版本记录，重新索引可以重新排队解析。

MCP 子进程继续使用上游凭据清理；只通过上游显式 env 配置绑定当前实例的 capability token。启动器在容器 tmpfs 创建 0600 配置，Provider Key 不在 Runtime 中，上游 Core 未修改。

## 验收与已修复问题

- 正式上传 → 数据库任务 → Docker 解析：7/7，四种格式同时核对英文唯一标记与中文；扫描件、加密 PDF、外部引用 Word 均拒绝。
- 实际 API 20/20：用户/部门/角色/企业授权、拒绝优先、文档交集、管理范围、版本切换、撤权、禁用恢复、跨用户文件和恶意 multipart。
- Chrome 浏览器 4/4：拖拽组件多文件、真实模型读取聊天附件、后台知识/权限/索引、搜索/原文/下载；page errors 0。
- 完整真实模型场景 4/4：工作法 + read + enterprise_search + MCP + write；多轮修改、审批、导出与恢复；撤权断开 WS 并拒绝派生下载；在途撤权终止为 PermissionDenied。

初次失败及修复证据保留：PDF 清理接口与中文映射、Busboy 恶意文件名触发未处理流异常、MCP 默认清理令牌、浏览器测试文件选择器/导航竞态。multipart 崩溃是产品缺陷，现已修复并由实际攻击复验；不是网络失败。文件清理只停用测试创建的账号，不删除其他项目数据。

证据：`evidence/v1/p5/`；入口脚本：`test-parser-files.mjs`、`test-knowledge-api.mjs`、`test-files-knowledge-browser.mjs`、`test-knowledge-runtime.mjs`。构建、类型、lint、许可、秘密扫描结果以该目录当前文件为准。P6 继续全量安全语义回归；P8 继续镜像分发许可、备份与生命周期。
