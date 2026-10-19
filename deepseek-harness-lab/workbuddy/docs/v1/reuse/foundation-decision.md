# Foundation Decision Gate

状态：ACCEPTED_R2。日期：2026-09-18。依据：R0 `6d93df1`；R1 `317a06e`；`spike-report.md` 与 `evidence/v1/reuse-r1/`。三个实际 Spike 通过；结论只固定基础选型，不是 V1 已完成。

| 模块 | 决策 | 固定基础与职责 |
|---|---|---|
| Web | ADOPT | Next.js 16.3.5 / React 19.2.4 / Node 24；前端服务与 BFF 分离部署，通过统一入口同源访问 |
| Chat | ADOPT | @assistant-ui/react 0.15.20、react-markdown 0.14.15；仅视图状态，不执行 Agent 工具 |
| Chat Adapter | INTEGRATE | 产品服务端消息投影 + WebSocket；仅真实用户来源进入 user messages；Harness 唯一 Agent |
| Admin/Employee Shell | ADAPT | Kiranism 固定 SHA 清理后的 Sidebar/Base UI、TanStack table、表单输入和 token；不保留 Clerk、组织切换、计费或模板示例 |
| Tool UI | ADAPT | tool-ui 固定 SHA ApprovalCard/async action 状态；授权、单次消费与持久记录归 BFF |
| Authentication | ADOPT | Better Auth 1.7.5 与 PostgreSQL；密码/Cookie/session/到期/撤销由库承担；cookieCache=false |
| RBAC/Owner/Knowledge ACL | BUILD | 企业领域规则不由库的 organization/admin plugin 代替；每次 API/WS/工具执行读取当前权限 |
| Knowledge/Parser | BUILD + REFERENCE | 持久元数据和动态 ACL 由产品掌握；解析库优先复用，Onyx CE/RAGFlow 仅按真实格式语料精选，不引入全服务 |
| Runtime/Gateway | INTEGRATE | 沿用 pinned Harness 与边界 guard；将 Docker 控制从 BFF 移入可信 Manager，停止 Alpha 合成身份映射 |
| Local Bridge | ADOPT | 后续优先 Tauri 2.11.5；只作为文件连接器，默认关闭，未达双平台安全/安装 Gate 归 V1.1 |

R1 数据：认证 12/12、浏览器生命周期 11/11、投影回归 7/7、浏览器后台流程/品牌持久化、类型检查和 production build 均通过；浏览器无外部服务请求，当前 npm audit 0。174 份 Alpha 历史证据保持原摘要，官方 Harness clean。

重要取舍：不 Full Fork AnythingLLM/LibreChat/Onyx/RAGFlow；不迁移 Harness；不引入第二 Agent。BFF 保留现有 Node HTTP/WS 技术边界并演进为严格类型模块，领域业务用参数化 SQL 与 Zod 校验；若路由维护成本显著增加再独立评估框架，不与当前 Runtime 改造叠加。

生产工程采用 `apps/web`、`apps/server`、`apps/manager`、`apps/gateway`、`packages/contracts`、`migrations`。web 采用 Next 自身 standalone 产物；BFF 与 WS 在独立服务运行，避免把 Spike 的 Next custom server 当成可直接采用的 standalone 部署方案。统一 reverse proxy 分派 `/api`、`/ws` 与页面。

未关闭的工作：完整附件/文件 ACL、持久审批与运行幂等、RBAC、动态知识撤权、运行实例管理、日志用量、部署运维、20 人基准、独立设备远程验收、真实 Linux AMD64。LGPL native 库的匹配源码/通知/替换说明是 P8 制品许可义务。以上都不能由 R1 PASS 抵扣。
