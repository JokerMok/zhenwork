# ZhenWork 腾讯云网页试点

## 2026-10-21 四项业务修复（进行中）

- 基线已核实：`1b601eea104668b684f1aba57a46e3fa2940a672` 是 `20261020-office-diagnostics` 应用源码；`3c8b36f1b82aa78d5e08663c01c25957e6030cc8` 仅补充 PROJECT.md 与 deploy/tencent/README.md，两者不冲突。
- 已复现成品与追问不一致、跨栏摘录/过度解释、研究表格参数失败，以及标题列旧值残留；原始输入/会话/工具/文件证据保留于私有 `.codex/enterprise-delivery/business/`。
- 新工具与约束见 `docs/office-reconciliation.md`。代码定向检查通过不代表网页业务验收已通过；本轮集中网页回归与部署尚在进行。


核对日期：2026-10-20。范围为员工网页、管理后台、必要服务，以及按员工启动的 Linux Core/Gateway；不含桌面安装包、下载页或桌面更新服务。

## 访问、身份与凭据边界

- 员工入口：`https://zhenwork.shizibandu.icu/`。
- 管理后台/Native RC2：`https://zhenwork-admin.shizibandu.icu/admin/`，根地址自动跳转。
- 独立管理员与普通员工使用彼此独立的账号；普通员工初始改密流程已完成。后台创建、重置、首次改密和个人改密的现行密码规则已做真实页面与接口验证。
- `/srv/apps/zhenwork/shared/config/pilot-credentials.json` 是部署初始化管理员的 root 私有安全位置，不是后台改密后的自动同步副本。后续后台改密不会回写该文件，使用前必须确认用途和时效。
- 本轮 QA 私有账号材料位于 `.codex/enterprise-delivery/qa-private.json`，权限为 `0600`。完整凭据、Cookie、令牌和加密密钥不得提交或写入日志。
- 默认办公模型通过既有授权配置初始化到 RC2；员工无需自行填写 API。真实模型和工具链已有运行证据，但具体业务成稿仍须按下文逐项判断，不能由模型成功结束替代内容验收。

## 当前线上版本与源码边界

- 当前激活 release：`20261020-office-diagnostics`；source SHA：`1b601eea104668b684f1aba57a46e3fa2940a672`；平台：`linux/amd64`；入口：`/srv/apps/zhenwork/current`。本地对应记录为 `.codex/enterprise-delivery/current-release.json`。
- 本次 release 是 Host-only 构建；Web、Admin、Java 和 control-source 字节复用自已冻结候选，复用关系及哈希记录在 `RELEASE.json`。数据库迁移链保持 `0001—0019`。
- 当前完整镜像 ID：Core `sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0`；Gateway `sha256:81dfa364e6bda9b8383dcb17fda523ccb95a9c583ec3371333a40a83ff937217`；PostgreSQL `sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3`；Redis `sha256:daae2745949526529c969f121bde3e534f84e0e3dab6c10e31d5a85acd1ea162`；bridge-anchor `sha256:6eae4c12e6e88340275d16401e54ff8e6c8d0185f6796a5c952bdc320fc62cc8`。
- 已审核 Core 二进制 SHA256 为 `a43e0efe7406762813ccb12c766ff77c720b9c7993df3441efd7485cb7ac5f07`；`Cargo.lock` SHA256 为 `6dab2a00dc751f1e2c6ad5873d24befd7bd076c26a7730b78e19a3626a1221cf`。
- 初始快照使用的 Core Pending 空会话回收补丁为 `deploy/tencent/core-idle-pending.patch`，SHA256 `39d4f30b2efbbb54a38001ed26855ec63a561f0f53b8c7b31309c903ecca5fd7`。该补丁仅适用于精确旧快照；当前版本的修复应在 Git 源码中，不再叠加旧补丁。
- Web、Node CLI、Java/Admin 产物由受控本地构建生成；Linux Rust/Core 使用服务器原生构建或经审核的精确 amd64 镜像，不能上传其他平台二进制冒充。源码发布由 `git archive` 冻结已提交内容，不把未提交工作树混入候选。
- 应用代码及维护记录由本轮 Git 提交保存；应用源码SHA与后续维护文档提交SHA分别核对。线上版本只由上述 release/SHA 定义；正文优先提取和有界搜索降级修复已随本次 Host 发布；不包含未提交工作树内容。
- 所有完整镜像 ID、依赖锁、产物哈希和配置版本以线上 `current/RELEASE.json`、`SHA256SUMS` 和 `VERIFIED.json` 为准。当前资源瞬时统计在最后一次业务检查退出后读取，见后文。

## 运行架构

| 组件 | 启动/端口 | 数据/配置 |
| --- | --- | --- |
| Web Host | 非 root `zhenwork-web.service`；`127.0.0.1:18891` | `shared/config/web.env`；`shared/profiles` |
| RuoYi/RC2 | `zhenwork-rc2.service`；`127.0.0.1:18890` | `shared/config/application-rc2.yml`；`shared/logs/rc2` |
| PostgreSQL 17 | Compose `zhenwork db`；`127.0.0.1:18432` | `shared/data/postgres` |
| Redis 8 | Compose `zhenwork redis`；`127.0.0.1:18379` | `shared/data/redis` |
| Core/Gateway | Web Host 按员工启动；无公网端口 | 每员工独立 profile/workspace/runtime-temp；加密后台状态 |
| HTTPS | 复用宿主 `caddy.service` 的 80/443 | `/etc/caddy/sites-enabled/zhenwork.caddy` |

RC2 使用 PostgreSQL，不沿用 MySQL 模板或旧 Harness 演示。最大同时 Core=1、启动并发=1，空闲阈值120秒，排队等待180秒。Core、Gateway、Java、Host、PG、Redis 的限制分别为2GiB、128MiB、1400MiB（Java堆768MiB）、768MiB、768MiB、256MiB；这些是上限，不是实际占用。

`zhenwork-infra` 管理 db、redis 和只读、无端口、`cap_drop ALL`、8MiB上限的 bridge-anchor。仅在 `docker0` 放行受控 `172.17.0.0/16` 到 `172.17.0.1 TCP 32768:60999`；公网未开放数据库、Redis、Core或Docker API。员工域名是 Host public origin；管理域名承载 Admin 与 Native API；RC2 public-origin 仍为员工域名。Cookie 使用 Secure/HttpOnly/Strict，外来 Origin 写请求保持拒绝。

## 已实现并有定向运行证据的能力

- 后台密码流程和管理首页真实统计通过；统计来自当前 Core 中继事件，支持7/30/90天范围，费用缺少价格时保持未知。
- 13语种办公流程、真实 Office 文档读写、PDF/OCR、知识检索与原文、完整能力包、个人记忆、授权 MCP 和后台任务已有实现及对应定向运行证据。
- 同一浏览器中两个普通账号的任务、会话、文件、记忆和知识隔离通过；新增后台 job 隔离检查也通过。退出后的旧身份不可继续使用。
- 后台任务已验证创建、编辑、停用/启用、浏览器离线后仅运行一次、运行记录保留和结果实际落盘。程序在 Core 中取得真实 UTC 时间并统计实际 workspace 文件数，证据见 `.codex/enterprise-delivery/business/cron.json`、`cron-check.json`、`cron-program-proof.json`。
- 员工成果页已有明确预览反馈；实际浏览器下载 Excel、PDF 内嵌预览、二进制版本差异、恢复旧版和最新版、刷新后保持均通过，证据见 `.codex/enterprise-delivery/business/file-ui.json`。
- 31页扫描 PDF 的 OCR、页码引用、授权原文预览和下载 SHA，以及资源完整包发布/版本/授权生命周期已有真实 Native API 证据。服务器目录同步工具另有合成文本的真实 RC2 上传、跳过、更新、默认保留和双开关撤回证据；工具仅静态安装，未配置真实共享目录或定时器。

早期真实 Chromium 还验证过两个公网 HTTPS 入口、员工上传 DOCX 后生成 Excel、合计72后同会话修改为90、WebSocket完成事件、项目服务重启后的会话和文件保持，以及120秒阈值下146秒内 Core 回收。当时只重启本项目服务，没有整机重启，也未把首次发布的回滚拒绝门禁写成真正执行过回滚。这些是对应版本和路径的历史运行证据，不替代当前业务成稿或当前备份恢复验收。

## 业务验收现状

- **报销成品内容：通过；整体任务：未通过。** 私有验收记录证明最终 XLSX 与服务器成品 SHA 一致，按业务日期的金额闭合，并保留原模板结构、公式、DISPIMG、凭证对应关系和缺失信息；OfficeCLI及工作簿定向校验通过。最新 fresh 任务正确统计了两份来源票数，但模型编写的核对脚本错误解析 `daily_amounts`，最终回复了错误金额和待确认数量。`business/finance-counts-inspection.json` 因此为 FAIL；真实 Exec 成功只证明程序运行，不能证明计算逻辑正确。最终工作簿未被改动。公司票据、金额和人员信息仅保留在私有验收材料，不进入公开源码。
- **产品核查：失败。** `.codex/enterprise-delivery/business/product-inspection-corrected.json` 仍发现跨栏 OCR 摘录，Word 又对“无跨栏”作过度断言；独立客户需求和实际验收证据均未提供。`product-trim.json` 最新重试因 `quoteIndex` 错误未产出有效更新，继续保留 FAIL。
- **文件修改：部分完成。** `.codex/enterprise-delivery/business/modify-content.json` 证明8条数据行新增列已写入，原10列保留；标题下空行仍残留旧值，因此不写成全部完成。
- **研究交付：未完成。** 正文提取与查询降级修复后的 `business/research-after-reader.json` 实测完成两次搜索、三次官方网页读取，以及新DOCX生成和独立校验；但模型给部分Excel证据行提交空引用，随后又丢失路径、格式等必需字段，最终没有生成本轮对比表，整体为 FAIL。新DOCX的逐项语义未另做完整复核；旧版 `research-inspection-clean.json` 的引用问题只作为历史证据，不能据此认定新报告仍有相同问题。

## 备份、恢复与维护

员工 profile/workspace、会话、上传和必要密钥位于 `shared`，独立于 release。更新不得覆盖 `shared`，不得运行 `down -v`、全局 prune 或删除业务数据。

现有 `server-config-backup.timer` 每日北京时间03:20后随机5分钟内运行。备份有运行 Core 时延后；无 Core 时仅停止本项目写入者，执行 `pg_dump -Fc` 和停写 profile/workspace 快照。当前输入预算512MiB、单包上限512MiB、总压缩包上限2GiB、最多7份、最低空闲2GiB；轮转以2GiB总量为硬约束，因此不保证始终保留7份。

最新成功备份为 `20261020T150442678681Z.tar.gz`，大小451230128 bytes，当前保留4份、总计1803929967 bytes。已对该包完成隔离恢复：PostgreSQL恢复成功（迁移19），1378个profile文件、6个SQLite完整性检查、190个Office ZIP检查通过；生产库未覆盖。恢复运行限制1 CPU/1.5GiB，实测峰值1.2GiB。异机备份和外部告警尚未配置，同机包不能抵御磁盘或整机丢失。

```sh
# 第一步只暂存已提交源码，不切换 current
bash deploy/tencent/deploy.sh --ref COMMIT_SHA --release RELEASE_ID

# 审核 /srv/apps/zhenwork/releases/RELEASE_ID/RELEASE.json、产物哈希、镜像和迁移前缀后，第二步才激活
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/finalize-release.sh RELEASE_ID'

ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh status'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh logs 100'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh restart'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh backup'

# 回滚必须提供位于受控目录、精确绑定当前/目标release与迁移链的审核文件
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/REVIEW.json'
```

部署只允许“stage → 审核 → finalize”。数据库迁移只前进；回滚不还原数据库，也不能把旧应用接到未经审核的未来 schema。详细门禁见 `deploy/tencent/README.md`。

收口实测（2026-10-20T15:07:46.919668+00:00）：系统可用内存6.00GiB、近似使用1.50GiB，系统盘空闲25.47GiB；Core计数0。拼豆仍为PID43616、自10:22:17运行，拼豆页面与ops-check均HTTP200。两个ZhenWork入口还通过Mac到服务器公网IP的直接HTTPS请求（绕过本机代理，TLS正常验证），两个A记录均为175.178.236.56。

## 待完成或待输入

- 使用已开通且工具调用能力更强的模型复测报销业务语义，并修正产品引用定位与跨栏语义、研究对比表参数与引用等问题；任务结束、真实 Exec 和模型回复都不能替代结果复核。
- 客户独立需求与对应实际验收资料尚未提供；未提供不等于系统未实现，只表示当前无法完成符合性结论。
- 真实企业外部业务 API 和要同步的真实共享目录尚未指定；目录同步工具已验证链路但未启用真实目录。
- 本轮一致性备份和隔离恢复已通过；异机备份和外部告警仍未配置。
- 代码推送状态以本轮最终提交记录为准；线上应用 SHA 与维护文档提交 SHA 分别记录，不把文档提交误作已重建的应用。

本文件只声明已列出的当前事实和证据范围。未测试项不自动认定为未实现；局部技术通过也不自动升级为整体业务通过。
