# Cutover 门禁

状态：未执行，生产业务路径尚未切换。

必须依序取得 RC2 新入口证据：R13 数据迁移演练 → R14 安全回归 → R15 性能 → R16 备份恢复/回滚演练 → R17 legacy-off → R18 Cutover。任何缺项均不切换。R4 真实核心链和 R5 ACL Gate 是此前必要条件。

每个实体在路由表中声明权威。隔离开发数据不与 RC1 双写；正式迁移先冻结 RC1 写操作，生成新备份，记录源 revision 与表级计数/摘要，执行幂等映射并检查孤儿引用。旧 Session Token 不迁移。RuoYi 密码重置完成前不开放登录。

legacy-off 在可还原隔离环境停止旧 BFF，验证 Admin/Employee 登录、真实 Chat、流、Knowledge、Skill、MCP、Tool、Share、Audit，确认 Gateway/Manager 不依赖旧业务 DB。不能仅证明首页能开。

Cutover 写入审计化 gate manifest：源备份、目标镜像、schemaVersion、迁移 ID、校验结果、权限快照和回滚检查点。统一 Web Entry 指向 RC2，禁止旧端继续写。外部只开放 /、/admin、/api、/ws；健康检查从真实入口执行。

随后 R19 建 Quick Tunnel 并重跑浏览器/安全/模型资源 UAT。R20 真人验收之前不能称 Product Acceptance PASS，更不能称 Production Ready。
