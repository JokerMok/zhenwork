# 正式 Reuse Matrix

2026-09-18；R0 选型假设，R1/R2 后更新。ADOPT/ADAPT 不代表已集成通过。Integration Cost 为相对工程量，不是时间承诺。

| Module | Candidate | Decision | License | Exact Commit | Integration Cost | Security Risk | Maintenance Risk | Reason |
|---|---|---|---|---|---|---|---|---|
| Employee Shell | dashboard | ADAPT | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 中 | 前端权限不是授权 | 中 | 清理后 Sidebar/Layout，接真实身份和品牌 |
| Chat UI | assistant-ui | ADOPT | MIT | `6cd9226241d7e3f1a89e93f3160baa4f63157f6f` | 低 | 工具调用禁止在客户端执行 | 中 | 成熟 Thread/Message/Composer/Markdown |
| Chat Runtime Adapter | assistant-ui | INTEGRATE | MIT | `6cd9226241d7e3f1a89e93f3160baa4f63157f6f` | 中 | owner/终态/重连必须服务器权威 | 中 | 保留 Harness；新写协议适配不是重写聊天 |
| Tool UI | tool-ui | ADAPT | MIT | `49a870286facdbf28160cd647f0d337ebdc9b275` | 低 | 审批必须重新鉴权且幂等 | 低 | 精选 ApprovalCard/结构化结果 |
| Admin Shell | dashboard | ADAPT | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 中 | 移除 Clerk/SaaS/假权限 | 中 | 官方 cleanup 后移植组件闭包 |
| Authentication | better-auth | ADOPT | MIT | `5468e6bfcdff799848537cf5ad06ebab15aad9dd` | 中 | session 撤销与 enabled 逐次检查 | 中 | 采用密码/Cookie/session，不自建协议 |
| RBAC | better-auth | BUILD | MIT | `5468e6bfcdff799848537cf5ad06ebab15aad9dd` | 中 | 逐 API/WS 授权；默认拒绝 | 中 | 库只做认证；候选组织模型不满足本产品管理员无私人内容权限 |
| Knowledge | onyx | BUILD | Mixed repository: MIT Expat outside named ee directories; Onyx Enterprise License inside ee directories | `2931768b33b412e0588268ad1d069012776b2373` | 中高 | KB与文档交集、当前版本二次检查 | 中 | 审计候选均无完整动态撤权契约；复用解析/索引库，领域授权自建 |
| Document Parser | PDF.js / OfficeParser | ADOPT | Apache-2.0 / MIT | `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56` / `222487e391c25f32fd94d15d3f305c15798082c5` | 中 | 无网络受限 worker、格式预检 | 中 | P5 四格式中文样本及三类拒绝样本实测通过；不引入完整平台 |
| File UI | react-dropzone / assistant-ui | ADOPT | MIT | `5b92949564dd2ec93a8a19192810e1f2a090407e` / `6cd9226241d7e3f1a89e93f3160baa4f63157f6f` | 低 | 服务器 MIME/path/owner 校验 | 低 | 复用拖拽和聊天附件生命周期，浏览器真实上传已验证 |
| Audit UI | dashboard | ADAPT | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 低 | 日志脱敏与审计权限 | 低 | 复用 TanStack 表格与筛选 |
| Usage UI | dashboard | ADAPT | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 低 | 计量由服务端持久化 | 低 | 复用表格/图表组件 |
| Branding | dashboard | ADAPT | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 低 | 颜色/图片/URL验证 | 低 | 复用 token 和表单，业务 BrandConfig 自建 |
| Local Bridge | Tauri 2 | ADOPT | Apache-2.0 OR MIT | `7cd71369c00978a3783b6ae3e9972358abbe4ae6` | 中高 | nofollow/reparse/配对/撤销 | 中 | 仅选框架，后续 Gate 前保持关闭 |
| Deployment | dashboard | ADAPT | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 中 | 统一入口、无 socket 到 BFF | 中 | 采用 standalone 多阶段模式；企业 Compose 需领域集成 |
| Observability | dashboard | REFERENCE | MIT | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 中 | 禁用外部遥测、正文不入日志 | 中 | 表格复用；指标采集与权限按当前服务边界集成 |
