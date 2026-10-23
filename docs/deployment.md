# ZhenWork 开发部署说明

当前发布为源码开发预览。部署方须配置自己的账号、数据库、模型凭据与域名；仓库不携带可登录的试点环境。

## 组件

RC2/RuoYi 管理身份、企业资源与模型授权；Web Host 提供网页入口，并为员工启动独立的 Docker Core；桌面端使用本机工作区。网页工作区存放于服务端，不直接映射员工电脑的任意目录。

Web Host 和 RC2 使用两个不同的 HTTPS origin。反向代理提供 HTTPS，Web Host 监听宿主回环地址；Core、数据库、Redis 和 Docker 管理接口不作为公网入口。

## 构建网页执行环境

在 `AionUi-enterprise-poc` 目录安装锁定依赖后运行：

```sh
bash scripts/setup-enterprise-core.sh
bun run package
bun run --cwd packages/web-cli build
docker build -f packages/web-host/docker/Dockerfile.core -t zhenwork-core:development .
docker build -f packages/web-host/docker/Dockerfile.gateway -t zhenwork-gateway:development .
docker image inspect zhenwork-core:development zhenwork-gateway:development --format '{{.Id}}'
```

生产启动器要求完整镜像 ID 或仓库摘要；将上一步取得的摘要填写到配置中，不能用可变 tag 替代。

## Web Host 配置

| 环境变量 | 用途 |
| --- | --- |
| `AION_ENTERPRISE_WEB_PUBLIC_ORIGIN` | 员工网页 HTTPS origin |
| `AION_ENTERPRISE_WEB_RC2_URL` | RC2 HTTPS 地址 |
| `AION_ENTERPRISE_WEB_STATIC_DIR` | `out/renderer` 绝对路径 |
| `AION_ENTERPRISE_WEB_PROFILE_ROOT` | 持久化员工 profile 根目录 |
| `AION_ENTERPRISE_WEB_RC2_SERVICE_TOKEN_FILE` | 主机私有后台服务令牌文件，权限 0600 |
| `AION_ENTERPRISE_WEB_APP_VERSION` | 本次构建版本 |
| `AION_ENTERPRISE_WEB_DOCKER_CORE_IMAGE` | Core 完整镜像 ID / 摘要 |
| `AION_ENTERPRISE_WEB_DOCKER_GATEWAY_IMAGE` | Gateway 完整镜像 ID / 摘要 |
| `AION_ENTERPRISE_WEB_PORT` | 宿主回环监听端口 |

配置后由专用运行账号启动 `packages/web-cli/dist/aionui-enterprise-web.cjs`。后台服务令牌由部署方使用 `deepseek-harness-lab/workbuddy/scripts/rc2/derive-background-service-token.mjs` 在自己的 RC2 环境生成，不能提交到 Git。

## 管理后台

Java 服务位于 `deepseek-harness-lab/workbuddy/platform/ruoyi`，管理界面位于 `platform/plus-ui`。数据库迁移见 `migrations/rc2`。仓库中的 YAML 凭据字段已改为环境变量占位符，部署时应通过环境变量或外部配置分别提供数据库、Redis、模型与业务凭据。

旧 Workbuddy / Harness 集成代码保留作接口与迁移来源，不能将旧运行记录视作当前 ZhenWork 的验收结果。

## 使用边界

空闲 Core 回收可降低进程占用；运行中的任务和有效后台任务会保留相应 Core。是否向外部模型发送资料取决于模型与工具配置，私有部署工作台不自动表示模型也在内网运行。

本次公有发布不包含生产部署、收费接口调用、正式签名安装包或业务验收。目标 Linux、异机登录、员工隔离、真实授权任务及升级恢复需要在部署方环境验证。

## 员工组织能力与服务监控

默认模型通过现有 office-defaults 与 workspace_employee 角色引用；新增、导入及已有员工修复不复制上游凭据。组织资源仍须发布并明确授权，助手依赖同样检查。页面、执行和后台任务统一使用 available 目录。配置和实际验证边界见 [员工组织能力](employee-capabilities.md)。

部署新增独立 loopback Spring Boot Admin 服务，仅经 RC2 明确204授权的 Caddy 代理访问；SBA设置当前版本的HTTPS public-url，异步响应重新验证私有代理身份。公开API与网页文档的未登录响应分别处理，员工API必须401而非登录HTML。监控资产、单元、私有配置及恢复快照纳入既有部署，备份不打包可重建monitor.jar。
