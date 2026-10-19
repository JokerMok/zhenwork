# 官方上游核验

2026-09-20 实际检查官方 releases、git 远端标签及本地 checkout，固定结果见根目录 `ruoyi-upstream.lock.json`。GitHub REST API 限流，采用 release 页面和 `git ls-remote` 的 annotated-tag 解引用交叉核对。

| 项目 | 选择 | Commit | 许可 |
|---|---|---|---|
| RuoYi-Vue-Plus Backend | 6.X / v6.0.0 | 7180b529776834fee912113b23f0bd7a387a8222 | MIT |
| plus-ui Vue | 6.X-Vue / v6.0.0-Vue | aa3f114bf4f6a49086e43aafd00f146b0b517d19 | MIT |

[后端 Release](https://github.com/dromara/RuoYi-Vue-Plus/releases/tag/v6.0.0)、[Vue Release](https://github.com/CrazyLionCat/plus-ui/releases/tag/v6.0.0-Vue)、[官方文档](https://plus-doc.dromara.org/)。plus-ui 最新 Release 指向 React，不能直接据此替换本次 Vue 技术栈。

源码 POM 要求 Java 21、Spring Boot 4.1.0；前端 package.json 要求 Node >=20.19.0、pnpm 10.34.5。采用官方配套 6.0.0，已通过本机 Java21 ARM64 + PG17.11 + Redis8.8.0 联合启动、原生登录/注销与部门读写，Chrome 已验证用户/部门/角色页（R2 Evidence）。

官方提供 `script/sql/postgres/postgres_ry_vue.sql`。admin POM 默认 MySQL，PostgreSQL JDBC 被注释；本次将显式启用 PostgreSQL 驱动并对真实 PostgreSQL 17 执行登录、菜单、用户、部门、角色读写验证。存在 SQL 文件不等于运行兼容已通过。

官方源码原样导入 `platform/ruoyi` 和 `platform/plus-ui`，初始 1326 个文件的 SHA256 清单位于 `evidence/v1/rc2/r1/upstream-files.json`，保留上游 LICENSE。后续自定义 Java 放既有 ruoyi-ai 模块的 workspace 包，Vue 页面放独立 AI feature。框架修改必须列明原因与差异，不自动追踪 HEAD。

上游已有 SnailAiController 与 common-ai，RC2 必须关闭 Snail 客户端和 OpenAPI；保留模块目录不代表启用第二 Runtime。上游示例密钥、数据库密码和默认账号不得沿用到 RC2 暴露实例。

## 已实施集成 Patch

- admin POM：MySQL JDBC 替换为 PostgreSQL JDBC；移除当前应用对 demo、job、workflow、common-mcp 的运行依赖，原始模块保留。业务 MCP 经 RC2 受权执行面接入。
- plus-ui Vite：开发监听默认 loopback、取消自动打开浏览器、通过环境变量设置代理目标。公开入口仍须统一反代；登录表单移除上游预填的示例账号/密码。
- 私有外部配置：关闭 Snail AI/OpenAPI、工作流、示例推送与公开文档，只保留 health；随机数据库/Redis/JWT/管理员凭据，不沿用示例秘密。

这些为应用装配变化，未修改框架 Core。实际证据在 evidence/v1/rc2/r2；只覆盖原生系统，不代表 AI/ACL 迁移通过。

### R3 应用扩展

- workspace 包增加原生 Sa-Token 登录响应适配、HttpOnly/Secure/SameSite=Strict Cookie、Origin 校验和 PostgreSQL auth_version 失效检查；配置覆盖默认 Bearer 前缀，不修改 Sa-Token Core。所有 MVC 业务处理器均经过失效检查，包括原生 OSS。
- 原生新用户必须改密；密码为 12–30 字符且 BCrypt 输入不超过 72 UTF-8 字节。原生角色/菜单策略变化使旧会话失效。
- BrandConfig 落 PostgreSQL，更新使用原生权限与乐观版本；Admin 登录页、侧栏、标题接入。资产上传与 Employee 接入仍待后续。
- Vue 请求去重不再在 sessionStorage 保存正文，只保存内存摘要；Cookie 以外不接受 bearer/header/query 授权。
- 上游 logininfo 页面导入路径修正为真实目录 loginInfo，消除 macOS 类型检查与 Linux 大小写兼容问题；密码页面规则与后端一致。

R3 API 与真实 Chrome 验证、截图见 evidence/v1/rc2/r3。首次 API 测试因测试脚本错误读取分页层级失败，失败报告保留；修正后通过。Origin 注入和 Bearer 前缀冲突在联调中修复，不把编译通过当作登录通过。

### R5 原生在线会话安全适配

上游 Online Controller 返回的 tokenId 是实际登录凭据。workspace 包通过 ResponseBodyAdvice 返回短期、绑定操作者的下线句柄，并通过 Aspect 在服务端解析和校验下线操作；未修改上游 Controller。管理权限保留，下线令牌不会进入响应或操作参数日志。升级时必须重新验证响应形状、AOP 目标和原生方法权限。

本地 Java 启动改为按 SHA256 固定的私有发布副本，避免 Maven 重打包覆盖运行中 Jar 引发延迟类加载失败；已有失败记录保留在 R5 evidence。
