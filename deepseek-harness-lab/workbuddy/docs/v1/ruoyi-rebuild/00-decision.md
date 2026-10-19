# RC2 决策记录

核对日：2026-09-20。状态：R1 已完成，R2 实施中；以下架构为已确认决定，实现验收另行记录。

RC1 定位为 **RC1 Technical Baseline**。源码基线 `addff08`，冻结 tag `baseline/rc1-technical`，重构分支 `feat/rc2-ruoyi-rebuild`。运行镜像仍绑定 `5d797eb`，不能用文档提交号冒充镜像源码。历史 Evidence 保留原样。

RuoYi-Vue-Plus 是唯一正式业务控制面，plus-ui 是管理端，员工端继续独立。旧 Node BFF 是迁移来源和安全参考；Execution Plane 不得从旧业务表继续判断用户、资源或模型权限。RuoYi 原生用户、部门、角色、菜单、DataScope 与 Sa-Token 保留；AI 内容另行强制 Ownership 与动作 ACL，超级管理员不豁免。

RC2 只实现 DeepSeekHarnessAdapter。上游现有 Snail AI 接入关闭，不作为第二 Agent；Local Bridge 维持关闭，均不进入本轮门禁。保留 PostgreSQL 17，Redis 只承担会话、缓存和短期协调。

开发采用隔离实例逐步接通。R4 必须先验证登录、授权模型、真实 Harness、流、历史和恢复，才能扩展完整资源。迁移、安全、性能和回滚演练必须先于 Cutover。R20 之前的目标只是 LOCAL REMOTE PRODUCT ACCEPTANCE READY；真人明确 PASS 后才能考虑 P11，不请求服务器。

## RC1 仍有效的风险

- 源站 WSS 越权拒绝 403；Quick Tunnel 复测 4 次 403、1 次 500，零成功连接，原因尚未确认。
- 公网 20 MiB 上传出现 408；本地精确限额 413 不替代公网结果。
- Runtime HIGH 与 PostgreSQL/gosu 扫描原始记录保留。结论仅为 PASS_WITH_SCOPED_RUNTIME_MITIGATIONS；不得改为风险清零。
- 真实 Linux AMD64、20 活跃 Runtime 容量与真人产品验收未通过。

RC1 已完成 AES-256-GCM 备份：私有 `backups/rc1-before-rc2-20260920.wbbackup`，SHA256 `50f810599d5cfa8a102f05fcaea42ca5b60994d477248aa2ec09b0e175c0f31d`，包含 8 个 Runtime 卷。备份密钥不入 Git。本次备份不等于 RC2 恢复演练通过。

## RC1 全局资源归属迁移决定

RC1 Assistant 与 Knowledge Base 没有个人 owner 字段，且由管理员创建、按企业角色分发。迁移默认映射为 ENTERPRISE 所有权，保留原有角色授权，不推断为某员工私人资源；原始 createdBy 缺失保持 unknown。与数据事实冲突的记录进入 quarantine。
