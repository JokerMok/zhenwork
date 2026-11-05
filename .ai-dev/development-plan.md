# 开发与发布计划

## 技术方案与决定
复用现有Java resources/versions/ACL、PostgreSQL检索、Host tasks、员工SkillEditor和stream事件协调。各组隔离worktree，独占JSON清单路径。共享gateway、entry、admin resource mount和全部locale由T006统一集成。新增接口走现有control代理白名单。
## 数据、接口和模块
A: /ai/skills/import/github与Core只读probe；B: POST /ai/knowledge/{base}/retrieval-diagnostics；C: /enterprise/tasks/{id}/feedback与/ai/me/feedback、/ai/admin/feedback；D: POST /ai/resources/{id}/personal-draft，返回草稿不保存；E:保留现有协议与稳定身份。
## 批次与依赖
Wave1 T001–T005，无共享写文件；最多3个执行代理，余下主线程按工作树执行。Wave2 T006在五组审查通过后集成。
- [T001](tasks/T001.md)
- [T002](tasks/T002.md)
- [T003](tasks/T003.md)
- [T004](tasks/T004.md)
- [T005](tasks/T005.md)
- [T006](tasks/T006.md)
## 迁移、备份与回滚
仅C新增0025追加反馈表及既有菜单登记；原24条校验和不变，旧应用忽略新表，回退不降数据库。正式发布前现有一致备份；RC1及当前已验证release保留。远端内存/盘量先核实；高负载构建串行。
## 验证命令
见任务JSON verification_commands；集成后现有build-web、Vite、Maven和deploy/finalize真实执行，必要边界ACL/version/probe/feedback权限定向覆盖。
## 排除项
不更新无关依赖、Native/Rust镜像、模型密钥或其他服务器项目，不自动安装第三方代码。
