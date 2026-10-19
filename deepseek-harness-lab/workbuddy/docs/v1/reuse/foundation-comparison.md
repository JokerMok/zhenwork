# Foundation 方案比较

2026-09-18；源码审查结果，运行结论等待 R1。比较对象为单企业私有部署，唯一 Agent 为固定版本 DeepSeek Harness。

| 方案 | 复用收益 | 必须拆除/新增 | 安全与维护代价 | 结论 |
|---|---|---|---|---|
| assistant-ui + Better Auth + 精选 dashboard 模块 | 包依赖覆盖聊天、Markdown、认证；成熟 Sidebar/Table/Form | 一个 BFF adapter；业务 RBAC；品牌与 API | 明确的包升级和 adapter 契约；没有第二 Agent | 优先做三个 Spike |
| 完整 dashboard starter | 成熟 Next shell、导航、组件 | 官方 cleanup 移除 Clerk/计费/组织/样例/外部遥测，再接企业身份 | 仍有无关页面、样例依赖与前端权限占位 | 只移植清理后的必要闭包 |
| AnythingLLM 全量 fork | 管理、知识、文件 UI 完整 | 替换自身 auth/provider/agent/session/vector 后端 | 两套权限与运行链，迁移和长期合并成本高 | 不做 Full Fork；源码参考 |
| LibreChat 全量 fork | 聊天历史/附件/错误 UX | 删除自身 Agent/provider/auth/storage | MongoDB/Redis 等额外部署与数据模型；assistant-ui 已覆盖核心 UI | 参考交互与测试，不引入服务 |
| Onyx CE / RAGFlow 全服务 | 搜索、连接器、解析器 | 外置当前身份与动态 ACL；关闭自身 Agent | 多服务资源与升级成本；检索返回前仍需业务授权复检 | 不引入全服务；后续仅选解析器 |
| 手写 Chat/Auth/Admin | 完全可控 | 重写密码、Cookie、消息状态、可访问性与表格 | 重复安全维护与基础 UI 工作 | 拒绝；只写领域适配和边界 |

当前产品无成熟 React/Vite 骨架，Next.js 不造成既有前端迁移。仍采用模块移植而非保留整个模板，防止未来无关依赖扩散。官方 cleanup 已在 `.research/dashboard-clean` 执行；日志在 `evidence/v1/reuse-r0/dashboard-cleanup.log`，原候选 checkout 保留。

R1 测量：A 真实 Harness chat/stream/cancel/resume/tool/approval；B PostgreSQL login/logout/expiry/revoke/disabled；C 登录、Sidebar、真实用户表、设置和 BrandConfig。接口负例和浏览器网络证据随运行保存。仅组件能编译不等于集成通过。
