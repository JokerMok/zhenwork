# V1.0 部署架构

目标：单企业、单实例 Docker Compose；Linux AMD64 为正式外部验收平台，Linux ARM64 同时构建。macOS Docker ARM64 结果只证明本地平台。无需 Kubernetes。

## 网络与服务

公网仅 reverse-proxy 80/443；数据库、Gateway、Manager、Runtime 无 published ports。web/bff 位于前端内部网；bff/db/manager 位于受控后端网；每用户 Runtime 独立 internal 网只接入所属能力代理。Gateway 具有外网出口；禁止 Runtime 路由至公网或另一用户。Manager 持 daemon socket 的专属挂载，web/bff/gateway 无 socket。

Compose 使用固定版本或 release digest，非 latest；服务 restart unless-stopped、healthcheck、只读 rootfs（必要数据卷例外）、non-root、cap_drop、no-new-privileges、内存/PID、日志轮转。数据库使用独立持久卷。镜像运行用户与目录权限预先初始化，不 chmod 777。

TLS 优先 Caddy 自动证书；正式域名/DNS 指向服务器，80 仅重定向/ACME。受限企业可提供现有证书文件，文档说明续期。PUBLIC_ORIGIN 必须 HTTPS 且唯一；测试开发 HTTP 仅显式 local 配置，生产模式拒绝。

## 容量假设与验证

测试候选服务器：8 vCPU、64 GiB RAM、100 GiB 可用 SSD；这是针对每个活跃 Runtime 约 2 GiB 上限的预算假设，不是最低配置承诺。20 活跃用户对话/stream/检索/上传与登录测试记录实际 RSS/CPU/PID/磁盘、p50/p95、失败率和 Provider 限流。控制面资源与 Runtime 容量分别计算；内存不足不应无限创建 Runtime，应排队/明确容量不足。

## 配置与 Secret

`.env.example` 仅空值/非敏感样例：PUBLIC_ORIGIN、版本/镜像、DB 服务地址、secret file paths、上传/用量限额、Runtime 容量、日志级别、LOCAL_BRIDGE_ENABLED=false、CONFIG_SCHEMA_VERSION。Secret 文件 owner-only，容器只挂到需要的服务；Provider Key 仅 Gateway。安装脚本不能在 stdout/命令行回显 Key。基础镜像和依赖安装保持 TLS 校验。

## 安装和运维入口

最终交付 `docker-compose.prod.yml`，`scripts/install.sh start.sh stop.sh update.sh backup.sh restore.sh healthcheck.sh rollback.sh`。install 验证 Docker/Compose/平台/磁盘/配置/Secret，拉取 release artifact，启动 DB，运行专用迁移，CLI 初始化管理员，启动整栈，验证 readiness。无默认管理员密码。

update：检查签名/sha manifest、备份、维护模式、拉取固定镜像、迁移、readiness/冒烟；失败不自动删除数据。rollback：按兼容矩阵回到旧 image/config；不兼容时恢复升级前备份到新卷再切换。restore 默认新环境，不覆盖现存生产卷；覆盖必须明确确认。stop 保留所有卷，不能包含 compose down -v。

## 可观测与故障

`/health/live` 只进程存活，`/health/ready` 检查 DB schema 和关键内部能力；外部健康不泄露 Secret/详细拓扑。结构化 JSON 日志含 requestId/service/version/code，默认不含完整 prompt。审计与用量落库，容器 stdout 日志有轮转。运维查看错误率/队列/Runtime 数/磁盘阈值/备份时间/审计链校验。Provider 不可用影响模型能力但不得伪报成功。

## 外部 staging Gate 所需最少信息

开发到 P8 才请求：可用于全新安装的 Linux AMD64 服务器地址和 SSH 用户/授权方式；已指向服务器的域名或 DNS 管理协作方式；80/443 连通；Provider Secret 的安全注入方式（已有凭据可复用但不复制到报告）；一名使用另一台电脑的验收者/第二客户端协作。若系统中已有业务，先隔离测试资源，绝不当成“干净服务器”。

验收执行全部 23 项：artifact 安装、TLS/外部访问、管理员、创建两员工、双客户端并发、模型、文件、知识、resume、cancel、approval、禁用、撤权、调用/审计、品牌、整栈重启持久性、backup/restore、upgrade/rollback。每项留环境/命令/结果/截图或客户端证据。缺失项标 BLOCKED，不能用 loopback 替代。

## P8 实现增量（2026-09-19）

当前实现见 `deploy/v1/docker-compose.prod.yml` 和 `deployment-runbook.md`。服务为 Entry/Web/BFF/Manager/Gateway/PostgreSQL，Parser 及每员工 Runtime 由 Manager 创建。只有 Entry 发布端口，Provider 文件仅 Gateway 可见，Docker socket 仅 Manager 可见；不再由宿主 BFF 管理 Docker。资源名称和卷均包含独立部署前缀，便于同机恢复演练。

使用明确私网子网池分配每员工 `/28`，避免 Docker 默认网络池在二十人测试时耗尽。实际生产仍需核对企业路由。备份采用流式 AES-256-GCM，加密数据库/文件/会话/应用密钥并记录审计锚点；Provider 不打入备份。恢复仅限空库和新命名空间；跨 schema 回退走升级前备份重建。

运行池默认 4，不把二十人排队结果表述为二十活跃实例容量。真实 Linux 及目标容量验收仍按 P11 和测试计划执行。
