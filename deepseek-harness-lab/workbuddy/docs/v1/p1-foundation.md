# P1 生产工程骨架

范围：独立产品仓库内的 Node 24 / TypeScript 工作区、Next.js 产品壳、PostgreSQL 17、受校验迁移、配置和基础 CI。此阶段不宣称员工业务页面、Runtime Manager 或正式容器部署完成。

复用 Better Auth 的 PostgreSQL 模型、认证接口和密码处理；迁移只在显式管理命令执行。API 启动只读校验所有迁移的版本与 SHA256，不自动补表、不静默修改已应用迁移。迁移进程通过 PostgreSQL advisory lock 串行、每个文件独立事务；应用账号不能 DDL、改写迁移或更新/删除/截断历史审计。

本地初始化命令使用 `scripts/v1/init-local.mjs`，创建独立 PG17 容器、命名卷及 owner-only Secret 文件。已有配置存在即退出，不重置密码或数据。`migrate` 使用专用 migration URL，`grant-local-db.mjs` 配置应用角色，`bootstrap` 仅为空企业创建初始管理员。应用进程不得挂载迁移账号秘密；Compose 中落实该边界属于 P8。

```sh
node scripts/v1/init-local.mjs
export WORKSPACE_CONFIG_FILE="$PWD/.state/v1/config.json"
export WORKSPACE_BOOTSTRAP_FILE="$PWD/.state/v1/bootstrap.json"
npm run migrate
node scripts/v1/grant-local-db.mjs
npm run bootstrap
npm run dev:api
```

生产必须 HTTPS；local 模式仅接受 loopback HTTP。所有 Secret 使用独立文件、拒绝符号链接及组/其他用户可读权限。业务配置严格 schema，Local Bridge 当前只能为 false。公开注册和 Better Auth 通用管理/冒充接口不暴露。

证据位于 `evidence/v1/p1/`。相关检查包括迁移 7 项、契约与秘密文件 4 项、真实 PG17 应用权限/模型结构/单企业默认 3 项、实际 HTTP 身份/注销/CSRF 等 7 项。重复 bootstrap 返回 already_initialized，不改账户。失败的初次构建、测试入口和 lint 日志保留，修复后的证据另存。

`.github/workflows/foundation.yml` 运行安装、lint、类型、单元、真实 PG 集成、构建、秘密/许可/漏洞扫描和 SBOM；P3 加入正式浏览器 E2E，P6 加入生产安全矩阵与受控真实模型，P8 加入可分发 Docker/恢复门禁。远程 CI 尚未运行，本地等效命令不写成 GitHub Actions 通过。原始 Alpha 攻击测试保留为历史与后续适配基础，此阶段没有重复执行。
