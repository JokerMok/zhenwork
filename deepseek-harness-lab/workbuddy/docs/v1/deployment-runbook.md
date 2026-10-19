# 私有部署运维手册

本手册适用于候选版本的单企业实例。当前本机验收不等同真实 Linux 生产验收。执行前确认 release manifest 中的 commit、平台、镜像 digest 和迁移校验值；禁止使用不明来源的同名镜像。

## 安装

准备 Node.js 24、Docker Engine/Compose、非 root 专用部署用户及 Docker 权限、已载入的全部同架构镜像、仅该用户可读的 Provider 配置文件。Docker 权限等价于宿主管理权限，不授予员工。生产域名 A/AAAA 指向服务器，只开放 80/443，出站允许模型服务与证书签发。不要开放数据库、Gateway、Manager、Runtime 或 Docker API。

校验候选包 SHA256SUMS 并用 `docker image load` 载入 `images.tar.gz`，解压源码后在产品目录执行。初始化直接读取 manifest 的全部镜像 digest、平台和迁移清单：

```sh
node scripts/ops/install.mjs init --artifact /release/candidate-manifest.json --state .state/company --id company-ai --origin https://ai.example.com --provider-file /secure/provider-key
./scripts/install.sh --state .state/company
./scripts/healthcheck.sh --state .state/company
```

首次管理员账号默认 `owner@local.example`，可用 `--email` 指定；随机密码位于实例目录 `bootstrap-password`。从安全本地终端读取，首次登录后按产品流程修改，不发送到日志或公开文档。配置目录与备份密钥只交给部署管理员。Provider 默认读取仅含 Key 的纯文本文件；若复用 Harness 的 YAML 凭据引用格式，显式传入 `--provider-format yaml-ref`，字段为 `refs.VOLCENGINE_ARK_API_KEY`。不要把凭据值放在命令行、聊天或 Git 中。

Mac 本地演练在初始化时增加 `--local-tls true --origin https://localhost:3443 --http-port 3480`；仅监听 loopback。CA 位于实例的 `caddy-data/caddy/pki/authorities/local/root.crt`。测试客户端可用 `NODE_EXTRA_CA_CERTS` 显式信任，禁止跳过证书校验。正式域名不要使用此参数。

初始化拒绝复用非空状态目录。资源前缀必须唯一；控制面和 Runtime 默认分别分配 10.230.0.0/16、10.231.0.0/16 内的子网，若与企业网络冲突，应通过 `--compose-subnet-base`、`--runtime-subnet-base` 指定空闲私网 /16。初始化检查 Docker 网络重叠，不替代企业路由规划。

## 日常启停与检查

```sh
./scripts/start.sh --state .state/company
./scripts/healthcheck.sh --state .state/company
./scripts/stop.sh --state .state/company
```

停止仅影响该部署的 Compose 服务及带该部署标签的 Runtime。不会删卷。健康检查确认六个服务 running/healthy，失败返回非零；它不证明模型服务、全部业务或跨用户安全通过。进一步检查统一入口登录、授权知识检索和实际模型终态。

日志采用 json-file 轮转。只采集必要错误、request ID 和指标；不要拷出环境变量、Provider 配置、Cookie、密码或员工正文。管理后台可查审计链、用量及最近备份状态。审计链不抵抗同时控制宿主和审计密钥的管理员；定期保留离机备份锚点。

## 备份与恢复

```sh
./scripts/backup.sh --state .state/company --output backups/company.wbbackup
```

备份会暂停本实例任务，安排维护窗口。加密文件与 `.state/company/backup-key` 分开保存；丢失密钥无法恢复。Provider 配置另行保管。实际 RPO/RTO 取决于备份频率、数据量和恢复演练，不承诺未经测量的数值。

恢复时先用 `init` 建立不同 id、不同 state、不同端口的空实例，载入备份记录的兼容镜像。不要先运行完整 install 创建业务表。随后：

```sh
./scripts/restore.sh --state .state/recovery --input backups/company.wbbackup --key-file /secure/company-backup-key
./scripts/start.sh --state .state/recovery
./scripts/healthcheck.sh --state .state/recovery
```

恢复保留原账号密码。恢复实例新生成的引导密码不覆盖数据库内已有密码。验证用户/角色/部门、品牌、知识 ACL、文件 SHA、审计锚点、Session 历史和实际继续执行后，才考虑入口切换。不要删除原实例来证明恢复成功。

## 升级与回滚

```sh
./scripts/update.sh --state .state/company --artifact releases/candidate-manifest.json
./scripts/rollback.sh --state .state/company
```

升级核对架构、数据库主版本、已应用迁移名称和 checksum，先加密备份，持续停写，保存旧配置和 schema，再执行迁移和健康检查。失败保留数据及恢复资料，不自动删除或覆盖。仅当 schema 完全一致时允许原位镜像回退；跨 schema 时脚本拒绝，必须把升级前备份恢复到独立实例，再验证和切换入口。恢复旧备份会丢失备份后的业务变化，正式切换须由负责人确认。

## 容量与发布边界

本机已验证 20 个请求在 4 个 Runtime 配额下排队完成。默认配置保持 4，不能据此宣称 20 个 Runtime 同时活跃。目标服务器、模型配额和完整持续负载报告通过后，再调整容量。未经过真实 Linux AMD64、独立设备、安全和分发 Gate 的版本最高为 rc，禁止标记 Production Ready。
