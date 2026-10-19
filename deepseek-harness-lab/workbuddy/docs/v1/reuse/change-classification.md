# 已有成果纠偏分类

日期：2026-09-18。不删除/重写现有成果，不重新跑历史 Alpha 验证。修改前清单包含 mtimeNs/size/SHA256：`evidence/v1/reuse-r0/pre-correction-manifest.json`。原规划完整保存在 2e1bccd。

| 成果 | 分类 | 处理 |
|---|---|---|
| Alpha src/tests/fixtures/reports/174 份 evidence | KEEP | 历史安全基线；原件保留，不声称本次重跑 |
| phase-0 摘要和 manifest | KEEP | 事实/哈希不改 |
| upstream-harness.lock.json | KEEP | 固定 Harness；不追 master |
| 00-master-plan | UPDATE | 增加 R0/R1/R2 前置；最终按 P1–P12；Quick Tunnel 与 AMD64 分离 |
| 01-product-spec | UPDATE | 功能边界不变，注明成熟组件复用和员工技术词屏蔽 |
| 02-system-architecture | UPDATE | 优先 assistant-ui/Better Auth/Admin Shell，保留安全与 Runtime |
| 03-security-model | UPDATE | 保留不变量，认证协议实现交成熟库，增量安全复核 |
| 04-data-model | UPDATE | 保留 PostgreSQL；身份表与 Better Auth 实际 migration 对齐 |
| 05-deployment-architecture | UPDATE | 增加 Quick Tunnel 验收与 Named Tunnel 选项；无后端端口暴露 |
| 06-release-versioning | UPDATE | 产品 Git 已存在；RC 用 v1.0.0-rc.x，生产须真实 AMD64 |
| 07-test-acceptance-plan | UPDATE | 新增 3 Spike、依赖/源码 License Gate、远程多设备 Gate |
| 08-local-bridge-design | UPDATE | 安全约束 KEEP；优先 Tauri2/Wails，不自建桌面框架 |
| ADR-001 控制面/上游 | KEEP | 唯一 Harness、独立 Manager；前端选型另记 ADR |
| ADR-002 数据库/认证 | SUPERSEDE（部分） | DB/迁移 KEEP；自建哈希/session 协议待 Better Auth Spike 替代 |
| ADR-003 动态知识 | KEEP | 复用不得绕过当前 ACL，禁止静态挂载唯一授权 |
| ADR-004 审计/回滚 | KEEP | 验证链与恢复演练不变 |
| ADR-005 Bridge Gate | UPDATE | 框架优先复用，失败维持 flag off/1.1 |
| REMOVE | 无 | 尚无需删除的产品实现；候选代码只进 .research |

Git 已在纠偏前完成：独立产品 root=`workbuddy`，基线 commit `2efae93`，官方 root=`../deepseek-harness`，未提交到上游。新 tag 指向 Alpha 基线，不表示 Production。
