# 腾讯云网页试点维护

本部署只提供员工网页、管理后台、RC2、Web Host 和按需启动的 Linux Core/Gateway。源码由 --ref 指定的已提交版本冻结（省略时为本机 HEAD）；更新前先核对 origin 默认分支和本机提交，保留工作树修改；不调用桌面打包、签名、下载页或更新服务。

本轮持久任务说明见 `docs/task-workspace.md`。发布脚本按源码差异复用未变管理网页与监控产物，重建受影响员工网页/Host/Java；manifest记录并验证实际复用摘要。

## 当前任务版本（2026-10-27）

release `20261026-task-workspace-v6`，应用 SHA `bbfe9447b4711251ff2c82c6b1205dac2224b73e`。后续维护文档提交不重建应用；RELEASE.json的sourceSha为执行版本，VERIFIED.json记录限定验收范围。23条迁移链及完整amd64镜像不变；最终只构建员工Web/Host，按manifest复用Admin/Java/Monitor等未变产物。

任务数据位于 `shared/profiles/control/<serverHash>/<userId>/tasks/tasks.json`，独立task-grants与私有配置在release外，纳入既有停写一致备份。状态、文件、历史只读不唤醒Core。Core1/启动1/队列2/等待180秒/闲120秒、安全检查60秒不变；已受理任务持久队列2/30分钟，执行20分钟。首次创建原生会话仍依赖Core，受理前容量错误不能冒充已入持久队列。

普通员工公网主流程、离页执行双成果、定点修改/版本恢复、部分重试成功成果不变、去重/单Core排队/取消/独立后台授权撤销/Host重启中断及隔离有真实证据；具体复用与未覆盖项见服务器root私有 `shared/config/acceptance/20261026-task-workspace.md` 和本机 `.codex/task-work/acceptance-report.md`。没有重跑全历史或压测。

保留已验证artifact-delivery-v2作为回滚目标。审核文件 `shared/config/rollback-reviews/20261026-task-v6-to-artifact-v2.json`；先暂停新受理并等执行收敛，再执行 `sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261026-task-v6-to-artifact-v2.json`。仅回滚应用/配置，保留任务/数据库/资料/权限；旧版没有新任务UI，恢复新版可读取，不能删除TaskStore来回滚。

## 当前主机与入口

部署前阅读 `~/server-ops/tencent-main/SERVER.md`、服务器 `/srv/ops/SERVER.md`、项目 `PROJECT.md` 及 `docs/deployment.md`。主机别名 `tencent-main`，项目独占 `/srv/apps/zhenwork`；员工入口 https://zhenwork.shizibandu.icu ，后台 https://zhenwork-admin.shizibandu.icu/admin/ 。后台静态与 `/api` 走同一 origin；Host 的 RC2 URL 为管理 origin 根地址。

应用版本看 `current/RELEASE.json`、实际验收看 `current/VERIFIED.json`。初次源码 SHA 为 `42d834a75722bdbe6331dba226d0febdc6179383`，额外保留 Core 依赖锁及空会话回收补丁，各自 SHA256 在 manifest 中。补丁只用于该准确源码版本；不关闭身份复核、目录隔离、后台授权或单次工具审批。

## 2026-10-25 知识与专家当前发布

`20261025-knowledge-experts-v3` / 应用 `76806bb96381b07523ebc3d9215325bb1532d354`。本机构建员工网页/Host及预压缩，最终v3按manifest复用v2管理端、Java/control、23迁移和精确amd64镜像。功能与验收边界见 `docs/knowledge-experts.md`、私有 `.codex/knowledge-experts/acceptance-report.md` 及服务器VERIFIED。维护文档HEAD不等于应用SHA。

管理员在AI资源管理→企业资源→知识库/助手配置资料、专家依赖和对象共享；员工在工作台知识库及输入区本次知识范围使用。目录、索引状态、原文、已有成果读取不需Core；任务仍独立按需启动。企业凭据未进入个人配置。

保持Core1/启动1/队列2/等180秒/闲120秒和备份预算。previous为已验证resource-efficiency-v4，回滚审核 `shared/config/rollback-reviews/20261025-knowledge-v3-to-resource-v4.json`。仅退应用/配置，保留数据库、索引、文件、版本、授权和Host范围元数据；回退会失去新范围UI/执行限制。没有实际回滚。

更新：`sudo bash /srv/apps/zhenwork/deploy/finalize-release.sh NEW_RELEASE`；状态/重启/日志：`sudo bash /srv/apps/zhenwork/deploy/manage.sh status|restart|logs 100`；回滚：`sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261025-knowledge-v3-to-resource-v4.json`。更新前按manifest检查代码范围/依赖复用和磁盘预算，不覆盖shared。

## 2026-10-25 资源效率历史发布

`20261025-resource-efficiency-v4` / 应用 `8a913209a41758cfd13d34e0530911194a218aa6`。员工网页/Host本机构建和预压缩；最终v4仅重建Host，精确复用v3网页/Admin/Java/监控/control及23迁移、amd64镜像。说明及测量见 `docs/employee-resource-efficiency.md`，实际范围见 `current/VERIFIED.json` 和私有验收记录。后续维护提交不改变应用SHA。

登录、组织目录、工作台历史元数据、文件及预览/下载不启动Core；原生会话/执行配置仍需独立Core。仅真实活动续期，焦点/只读轮询不续期；在途读取及启动按身份合并，不缓存授权结果。安全回收继续核对任务/子进程/文件写入；排队及启动耗时不吃掉ready后的闲置预算。配置仍在 `shared/config/web.env`：Core1/启动1/队列2/等待180000ms/闲置120000ms，无新常驻服务或限额变化。

维护：`sudo bash /srv/apps/zhenwork/deploy/manage.sh status`、`logs 100`、`restart`；更新 `sudo bash /srv/apps/zhenwork/deploy/finalize-release.sh NEW_RELEASE`。回滚 `sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261025-resource-v4-to-startup-v1.json`；退回startup-v1会恢复旧Core浏览依赖，只退应用/配置，保留数据库/文件/授权，不是数据库回滚。v1曾因首页上下文遗漏实际回滚；v2被只读POST唤醒导致Core0失败，失败证据保留，未标记验证成功。

## 2026-10-23 员工继承历史部署

当前 `20261023-employee-inheritance-v7` / 应用SHA `cea46c0ef395f1a3e3c5712af477a55ecbb27e37`，23迁移，原21及amd64镜像不变。v7仅重建Host，按manifest复用v6的网页、Java、监控及部署资产。实际新建普通员工无需手选角色或个人模型/MCP，完成真实办公和部门查询；撤权/部门切换/双账号隔离/test1001原密码模型对话/登录来源/公网监控与工具页已定向回归。见 `docs/employee-capabilities.md` 和私有 `.codex/employee-inheritance/acceptance-report.md`。

新增非root `zhenwork-monitor.service`，仅127.0.0.1:18909，MemoryMax384MiB；员工Host18891、RC2 18890保持。私有edge和monitor-proxy认证独立；只认RC2明确204，不能使用通用2xx放行。SBA异步身份和HTTPS public-url均配置。`prepare-monitor.py` 与候选Caddy通过既有caddy-site-install安装；失败恢复本项目快照。

当前回滚审核 `shared/config/rollback-reviews/20261023-inheritance-v7-to-external-v4.json` 绑定实际23条迁移和此前已验证external-v4。仅退应用/配置，不回退数据库；将撤回本轮修复，旧前端无法渲染新增tool/index路由，作为应急回退限制明确保留。未实际回滚。Core1/启动1/闲120秒/等180秒、既有备份预算保持。

## 2026-10-23 外部查询历史部署记录

当前 `20261023-external-query-v4` / 应用SHA `fe272f3810d6ed8a62ce85488997d715643e628b`。v3构建管理网页/Java，复用未改employee/Host；v4修复MCP会话标识转发，仅重建Host，其余按manifest哈希复用v3。0021为验证详情加法迁移，原20条hash不变；原amd64镜像保持。

真实员工网页已查询两源，完成单项/组合/追问、程序计算、五表Excel、切表预览及实际下载；服务重启后原会话再次实际查询、文件字节及连接/模型配置保持。管理首页统计根因是重复CTE耗尽连接池，现有界扫描聚合、SQL10秒和UI15秒超时/取消/竞态保护；7/30/90与数据库独立计数一致，真实网页加载通过。

国家平台21方法真实成功，部分为空另列；其余二维码/小微范围待实际入参。优废11方法真实200/code200，固定空参数，8个data、3个dataList；重量单位及部分业务口径仍未知。完整映射/界面用法见 `docs/external-connections.md`、`docs/external-query-mapping.md`；私有证据 `followup/acceptance-report.md`。不再将已保存有效凭据写成缺失。

当前回滚审核 `shared/config/rollback-reviews/20261023-external-v4-to-external-v2.json`，只退应用/配置至此前已验证v2，保留21条DB迁移和文件/授权；新查询功能随旧应用退回，不是数据库回滚。既有一致备份、Core1/启动1/闲120秒/等180秒保持。

## 2026-10-22 历史部署记录

当前应用release `20261022-web-office-v16` / SHA `bac72eab9a9bb369c707bd04f76e1cb1fe70e6f7`。员工/管理网页重建并验证后，最终Host-only修复复用其精确哈希；Java/control及19迁移、amd64镜像保留。网页预览/完整包实际执行/更新/撤权/部分交付证据在私有20261022验收报告。管理员当前凭据由用户安全输入保存至root0600 `shared/config/qa-admin-current.json`，初始化文件不是当前口令。新发布先按manifest审查，再既有finalize；回滚审核 `shared/config/rollback-reviews/20261022-v16-to-v8.json`，只退应用/配置，不回退数据库或授权。

以下v8记录作为历史基线保留：

当前激活 `20261021-office-reconciliation-v8`，应用源码 `619c3d9272018a519d5f385f1f86d115aa3dbcf6`。后续纯维护文档提交与应用SHA分别核对。Host-only更新、19条迁移及Web/Admin/Java/native镜像复用；四项真实办公回归和边界见PROJECT.md及私有验收记录。

RC2默认配置版本2，默认通用助手/DeepSeek Flash；沿用既有凭据与有效授权，费用无价格时未知。报销完整包packageVersion6 / Skill2.2.6，来源与解析器哈希在 `shared/config/office-publication-20261021.json`，变更前后模型记录在 `shared/config/office-model-change-20261021.json`，均root0600；应用回滚不会撤销数据库配置。

当前可用回滚审核：`shared/config/rollback-reviews/20261021-office-reconciliation-v8-to-office-diagnostics.json`，只绑定当前v8和上一已验证基础版本office-diagnostics及实际迁移链；旧版仍有四项业务缺陷，回滚用于基础可用性恢复。本轮未实际执行回滚。新发布/迁移必须重新审核。

## 首页资源刷新修复（2026-10-23）

首页目录初始化现在只读 `GET /enterprise/resources/status` 与当前助手目录，不再在每次进入、重挂载或重试时重写运行资源。显式刷新按员工合并请求；Core 的真实任务/取消/后台占用保护保持，忙时返回 HTTP202 pending，空闲后由原15秒调度安全更新。当前任务不取消，不清会话或文件；执行端原权限复核继续生效。状态读取失败可重试，错误码插值明确；普通员工不需填写API或MCP。

仅员工网页与Host变更时使用 `restage-web.sh --employee-only --from RELEASE --ref COMMIT --release NEW_RELEASE`，先核对管理端源码完全相同，再按原manifest复用管理前端、Java、控制源和精确amd64镜像；依赖及其余路径门禁保持。验收范围为真实员工首页、运行中切换/刷新、合并重试、任务结束/取消及服务恢复，不扩大办公场景。

## 网页与Host有界更新

本轮网页预览/任务交付/知识上传入口变更可使用 `restage-web.sh --from RELEASE --ref COMMIT --release NEW_RELEASE`。它重建员工网页、管理网页及Host，复用原Java/control-source与精确amd64镜像；依赖锁、Java、control或Rust变化拒绝复用。后续仍审阅manifest，再通过既有finalize完成一致性备份与激活。预览边界见docs/web-office-preview.md；未完成的网页验收不能由构建成功替代。

## 分阶段更新

`deploy.sh` 只暂存，不激活。它从指定提交执行 `git archive`，只构建 Web、后台和 Java；Bun/pnpm 缓存必须与归档 lockfile 完全一致，Maven 仓库按全部 POM 与 wrapper 输入摘要隔离。它不会运行 Cargo。Core/Gateway 源码与当前发布比较：未变化就强制复用当前完整镜像 ID；发生变化就必须显式给出已审核的 amd64 镜像 ID，不能盲用旧镜像。manifest 同时记录 Core 源树、Cargo lock、容器内 binary SHA256。`sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0` 的已审核 binary SHA256 为 `a43e0efe7406762813ccb12c766ff77c720b9c7993df3441efd7485cb7ac5f07`，并包含 system-site-packages 下的 openpyxl 3.1.5、python-docx 1.2.0、python-pptx 1.0.2。

当前 Core 已采用下述完整办公镜像。源码与当前发布未变时脚本自动复用它；首次切到该镜像或源变化时显式指定并核对来源：

```sh
bash deploy/tencent/deploy.sh --ref COMMIT_SHA \
  --core-image sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0
```

脚本只上传归档产物和部署维护白名单，不使用目录级覆盖；服务器既有私有配置、SERVER 记录及额外维护脚本保留。暂存完成并审阅 `releases/RELEASE/RELEASE.json`、`SHA256SUMS` 后，单独执行：

```sh
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/finalize-release.sh RELEASE'
```

finalize 在同一发布锁内先校验发布文件、镜像、密码策略和迁移前缀，再调用现有备份服务生成一致性 DB/profile 备份；备份失败或 Core 尚未退出会停止。随后停止本项目写入者，按文件名顺序用 `bootstrap.py --migrate-only` 事务执行尚未应用的迁移并写入 SHA256 台账；数据库必须在执行前是目标链的精确前缀，执行后必须与目标链完全一致。最后才切换 current、项目配置与服务。数据库迁移只前进。没有新增迁移时，切换失败可自动恢复原应用；一旦进入新增迁移阶段，失败会保持服务停止，不会未经审核把旧应用自动接到前进后的数据库，须修复新发布或按下述审核流程显式回滚。

本轮新增迁移的固定摘要为：`0018_knowledge_office.sql` = `7d5be1f4b8636f16bde988f0b2cfa0769345245b31eac9980eadfc1dba2d11c1`，`0019_office_defaults.sql` = `08ad472cb0fb5189fb1e7912f58695c55c1d2601fbc87f7695f4877def0316c1`。manifest 和数据库台账均逐文件复算，不只依赖这段文档。正式 Java 定向测试必须显式使用 `-Dmaven.test.skip=false -DskipTests=false -Dprofiles.active=...`，避免父 POM 的 local profile/tag 把结果过滤成 0 tests；`deploy.sh` 的 Maven 命令只负责生成已通过定向验证的发布 JAR。

旧 `42d834a` 补丁路径仅由显式 `--legacy-42d834a-patches` 启用，且补丁在任何构建前应用。新版提交必须在 Git 源码中包含 Core idle、密码和后台修复，不再叠加这些补丁。

若完整候选已经成功构建，此后提交严格只改 Web Host/Web CLI 源码及其测试或部署文档，可复用候选中的 employee/admin/Java/control-source/native image，只重新生成 Host bundle：

```sh
bash deploy/tencent/restage-host.sh \
  --from 20261020-office-diagnostics \
  --ref COMMIT_SHA \
  --release NEW_RELEASE
```

helper 以来源发布的 `SOURCE_SHA` 做无 rename 的逐路径 Git diff。只允许 `packages/web-host/src`、`packages/web-cli/src`、测试、deploy、文档、PROJECT 和 justfile；renderer、common、desktop process、Rust、control、依赖或 lock 变化均拒绝，必须改走完整 stage。新源码仍由 `git archive` 冻结，bun.lock 必须与来源提交及本机依赖缓存同时完全一致，并仅用 esbuild 生成 `web-host.cjs`。服务器先验证来源发布完整哈希，再复制到新的 incoming，仅替换 Host、SOURCE_SHA、IMAGE_IDS；`build-linux.sh` 会逐项验证 employee/admin/rc2.jar/control-source 与来源发布字节摘要一致，并把 `artifactReusedFrom` 写入新 manifest。该 helper 不切 current、不读写 shared、不启动或停止服务。

`configure.py` 仅用于初始化/有意重建私有配置；凭证存在时沿用，但会重写受控配置文件。`bootstrap.py` 首次先 PostgreSQL 企业基表、独立账号/客户端、DML app 角色及员工角色，然后执行完整 checksum 迁移链；0009 审计归档写权限撤销必须保留。日常更新只由 finalize 使用 `--migrate-only`。`provision.py` 只初始化本试点账号与一个已授权模型，需先放置 root 私有 model-bootstrap.json；日常更新不运行初始化或 provision 路径。

## 运行与回滚

```sh
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh status'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh restart'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh logs 100'
```

restart 重启本项目 RC2/Host，并仅在监控 unit、当前不可变 release 的 `monitor.jar` 和私有配置完整时启动 Monitor，同时确认 DB/Redis/bridge-anchor 健康。Monitor 直接从 `current/monitor.jar` 运行，二进制由 release manifest 与 `SHA256SUMS` 管理，不复制到 shared，也不进入员工资料备份。发布切换前只把本项目 Caddy 站点、Web/Monitor unit、Caddy 环境 drop-in 和相关私有环境文件保存到当前版本的 `shared/config/versions/<release>/runtime-state/`。新站点只能经宿主机既有 `caddy-site-install` 校验并 reload；安装器校验和 reload 时同时加载 edge 与 monitor-proxy 私有环境。回滚到没有 monitor.jar/deploy-assets 的已验证旧版本时，恢复该版本快照并停用 Monitor，RC2/Host 仍按旧 unit 启动。

回滚不还原数据库，也不允许“旧应用 + 任意未来 schema”。目标必须有 `VERIFIED.json`、兼容当前密码策略，并由审核人基于 `rollback-compatibility.example.json` 创建 root 所有、不可组/全局写的文件，放到 `shared/config/rollback-reviews/`。审核文件必须精确绑定当前发布、目标发布、目标 source SHA、当前数据库的完整迁移名/hash 清单，以及目标发布迁移前缀；数据库后来新增一个迁移就会使旧审核失效。

```sh
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/REVIEW.json'
```

Web Host 以 zhenwork 非 root 用户运行，docker 组授予启动本机 Docker 的必要权限；仅本项服务使用该身份。宿主机 profile 路径保持真实可挂载，不启用 PrivateTmp。ExecStartPre 等待 RC2；RC2/Host 有失败重启、CPU/内存限额。zhenwork-infra 开机启动独立 Compose；db/redis/bridge-anchor 配置健康检查和 unless-stopped。bridge-anchor 是无端口、无能力、只读的 sleep 容器（8MiB 上限），维持 Docker 默认桥 UP，以通过 Host 的网络归属门禁。

## 数据、资源与网络

- DB `shared/data/postgres`；Redis `shared/data/redis`；实际员工资料、上传与生成文件在 `shared/profiles/profiles/<serverHash>/<userId>`，workspace、runtime-temp 及会话数据库持久保存。RC2 的 `WorkspaceFileStore` 会按 `secret-key-file` 的父目录寻找 `shared/config/uploads`；部署只允许这个入口是 root 所有、解析到 `shared/uploads` 的受控链接，新建时固定为相对链接 `../uploads`。文件实际保存在 zhenwork 所有、0700 的真实目录 `shared/uploads`，不会写入 root 只读的 `shared/config`，也不会覆盖已有上传文件。发布文件单独在 releases。
- 私有配置与稳定 serverId/clientId、模型凭证/加密密钥在 shared/config，禁止提交或打印。模型由 RC2 集中授权，员工无需输入 API。Core 容器内置 OfficeCLI、Python 办公/PDF工具、OCR及已有技能；Web Host 另用 /opt/zhenwork-office 受控解释器读写四格式文件和按页OCR。prepare-office-host.sh 只用官方 Ubuntu/PyPI 补齐固定依赖。普通文档生成不运行用户代码，复杂模板通过已授权 Skill 执行，仍保留工具一次性授权。
- `shared/config/web.env`：最大 Core=1、启动并发=1、空闲阈值120000ms，Host 定期检查后回收；前台租约、运行中任务、后台子任务、团队任务仍阻止回收。容量不足时排队/拒绝，不扩到两 Core。
- RC2 18890、Host 18891、PG 18432、Redis 18379 全为127.0.0.1。Core 无公网映射；Gateway 受控代理保留。仅 docker0 子网172.17.0.0/16至172.17.0.1 TCP32768:60999的宿主内部路径受限放行；不公开 Docker API。
- 公网复用现有 Caddy80/443，配置 zhenwork.caddy 用 caddy-site-install 安装并 reload。仅新增本项目两个 DNSPod A 记录；HTTPS origin 分离、Secure/HttpOnly/Strict Cookie、外部 internal 路由阻断。管理同 origin 请求仅对精确管理 Origin 改写，外来 Origin 原样交给后端拒绝。
- Core 内存上限2GiB、Gateway128MiB，RC2 Java堆768MiB/服务1400MiB，Host768MiB，PG768MiB，Redis256MiB；上限不等于实际占用。当前实测见 PROJECT.md。

## 备份与恢复

现有 server-config-backup.timer 每日北京时间03:20后随机5分钟内运行。hook `/etc/server-ops/backup.d/zhenwork.sh` 使用本目录 backup.sh：有运行 Core 时延后并保留既有包；无 Core 时只停本项目写入者，pg_dump -Fc，加员工 profile/workspace、真实 `shared/uploads` 及会话的停写快照；随后恢复本项服务。系统主备份覆盖根 .env 与 shared/config，记录受控链接本身而不解引用成第二份上传内容。排除可重建 Node/cache、容器卷原文件、日志、镜像与构建缓存；不可排除业务 workspace。

```sh
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh backup'
# ARCHIVE 为 /srv/backups/config 中已完成的具体 tar.gz
ssh tencent-main 'sudo python3 /srv/apps/zhenwork/deploy/restore-check.py ARCHIVE'
```

restore-check 只新建随机命名的隔离数据库，实际 pg_restore/计数比对、恢复 profile、SQLite integrity_check 和 Office ZIP 检查，结束仅删除自己的检查库，不覆盖生产。结果 root 私有 shared/config/restore-check.json。

本轮真实模板、Skill完整版本、上传和成果历史使256MiB输入门禁实际拒绝新备份；旧包仍保留、应用未切换。按当前30GiB空闲容量审查后，先改为512MiB；2026-10-21完整能力包及员工历史使实际新包超过512MiB，经磁盘与总量复核后，仅把输入/单包和systemd LimitFSIZE改为768MiB（MemoryMax仍384MiB）。当前包20261021T032755541854Z.tar.gz为542803963字节，完整读取/校验通过。总量仍2GiB、最多7份，最低剩余2GiB要求不变；校验改为流式SHA256以免大包占满服务内存。旧主脚本在 /srv/ops/config-history/20261020-zhenwork-office/server-config-backup.before 和 server-config-backup.input256.before 留存；本次512→768MiB的脚本/单元副本在 /srv/ops/history/backup-budget-20261021/，Mac运维镜像同步。轮转以总量限制为准，容量增长必须重新核定，超预算停止并保留旧包。须随员工资料增长重新核定；当前同机备份不抵御磁盘或整机丢失。未配置异机备份/外部通知；没有运行 down -v、全局 prune 或删除业务数据。

## 定向验收

verify-admin.mjs / verify-employee.mjs 使用独立无头 Chromium；本机设置 ZHENWORK_MODULES 指向可用 Playwright/XLSX依赖工程根、ZHENWORK_CREDENTIALS 指向 root 私有试点凭据副本、ZHENWORK_EVIDENCE 指向 .codex 下证据目录。阶段 create、modify、isolation、persistence、idle 分开运行；create/modify 为真实付费模型与工具任务，需要明确授权。脚本不关闭 TLS 校验、不伪造模型响应。

不运行桌面/全历史测试。当前 Linux Web 路径仍可能对前端复用的桌面缩放/更新订阅返回 REALTIME_UNSUPPORTED_MESSAGE；真实任务流与消息推送独立验收，具体边界见 PROJECT.md。


## 后台与密码更新

当前源码已包含网页密码与后台统计修复，不再为当前版本叠加旧 admin-usability.patch。管理首页使用 /ai/admin/dashboard 的真实 Core 中继事件，按北京时间和7/30/90天展示用户活跃、请求、Token与状态；费用未获取或未配置价格时明确未知，不混入旧Harness用量。

后台一键重置固定临时密码 a123456，不提供自选重置口令。员工正确登录后必须设置8–16位、同时含ASCII字母和数字的新密码；临时值是7位的专门例外。改密前不发员工身份、不启动Core，原凭据由RC2复核，第二次重置会撤销旧身份。初始账号文件不自动同步管理员后续改密，不应将其中旧口令当作当前密码。不得用真实员工账号跑重置回归。

受控办公 MCP 提供当前任务附件/工作区 read_document、结构化 write_workspace_json、四格式 create_office_document、validate_artifact、联网检索读取与权限知识检索。读取每次最多5页/位置（Excel最多3工作表，100行×40列），50MiB输入、30秒、OCR标记待复核；旧 .doc/.xls/.ppt 明确不支持，需用户先转为现行格式，不会伪称解析成功。研究与核查使用 sourceRef + 连续原文引用校验，生成文件自动嵌入真实定位；引用存在不代表推断成立或方案已实际验收。引用使用时重查知识授权/版本或工作区文件哈希，30分钟过期后需重读。Registry按员工Core隔离、最多128来源/2MiB文本，重启后重新检索即可恢复依据。个人/共享知识使用 PostgreSQL 轻量检索与 Office/PDF/OCR异步索引，没有增加独立向量数据库。

verify-admin-usability.mjs需要环境变量及私有qa-private.json所指的专用回归账号；all包含统计与重置/首次改密的真实浏览器验证，dashboard只验证读取和布局。禁止用实际员工账号跑重置回归。原生权限拒绝可能为HTTP200/JSONcode403，应同时检查响应体与无数据，而不是要求所有业务拒绝均使用HTTP403。

## 办公、研究与目录维护边界

新建企业任务会等待默认助手详情及工具目录加载；目录失败时显示重试入口，并保留 Core 的助手默认配置，不用空选择覆盖默认连接。单个已撤权或缺失连接会提示，不阻止其余能力使用。

网页读取优先真实结构化正文和 `article/main`，再使用明确标记的 HTML/元数据降级内容；不会执行网页脚本。语义块采用有界单遍处理，返回最多45,000字符。网络仍执行 HTTPS、公开IPv4固定解析、重定向重查、2MiB响应上限。正文和原文存在不自动证明模型推断成立，OCR和宣传性描述须分别说明。

搜索使用实际 Bing RSS。普通查询请求一次；带 `site:` 或引号且未命中约束时，最多进行一次去操作符的自然化查询，保留原域名/路径筛选，并返回实际查询与降级提示。未得到符合范围的结果会明确报错，不把词典等无关页面冒充目标来源。搜索日期不能当作网页发布日期，仍需打开原文。

连续引文至少2字符、最多2,000字符，候选最多16条；每条引用严格使用 `quote` 或 `quoteIndex` 二选一。引用错误指出条目序号和原因，不能重复原样提交。每个员工Core最多128个来源/2MiB文本，每个会话最多64个来源，30分钟后重新读取；来源授权、版本及文件哈希在使用时重查。Excel证据表支持最多12个额外标量列，实际文件修改仍须重新打开检查真实表头、数据行和保留内容。

服务器目录同步通过 `scripts/rc2/install_knowledge_directory_sync_remote.sh tencent-main` 从本地仓库安装或更新工具。它仅写入本项目 tools 目录，不覆盖私有配置或启用真实目录/定时器；实际启用须明确源目录、知识库授权、容量边界和root私有凭据。说明见 `scripts/rc2/README-knowledge-directory-sync.md`。代码更新、应用回退和知识文档撤回分别处理，不借更新删除业务数据。

本轮更新（2026-10-23）：全量发布脚本在所有 `AionUi-enterprise-poc` 源码及 `build-web.mjs` 均与当前不可变发布完全一致时，复用 employee 与 web-host.cjs，仅构建本次管理前端/Java。RELEASE 记录来源发布和逐产物哈希；服务端检查原发布 SHA256SUMS 及复用内容一致。源码变化仍走原完整网页构建，Rust/镜像均不会隐式重建。

### 员工组织能力与登录来源（2026-10-23）

普通新增、导入和注册统一保留 `workspace_employee` 基础角色；编辑角色为 null 表示不修改，显式空数组保留基础角色。0022仅修复既有用户的必要关联，不改密码、文件或个人配置。企业默认模型通过 `ai_office_defaults.model_id` 引用供活动员工继承；其他模型继续按 ALL/部门/角色/用户策略授权，停用账号、角色、模型或 Provider 不可继续使用。后台“模型管理→设为企业默认”明确告知面向全员；不要把敏感专用模型设为全员默认。

员工页面、交互执行与离线任务的资源目录统一使用 `scope=available`，返回当前有 USE 权限的发布版本；执行仍重新检查资源及助手、Skill 的依赖。企业资源沿用发布、角色/部门/用户共享机制，不给每位员工复制模型 Key、MCP 或技能包。默认通用办公助手和办公文件工具在 Host 内安装；业务连接凭据继续留在 RC2。组织通用 Skill 可共享给基础员工角色；敏感知识、业务专家及其连接分别按业务部门/角色授权。

登录来源仅由 Caddy 的实际 socket 来源认定，生产当前没有上游可信 CDN/负载均衡；浏览器 XFF、X-Real-IP 等输入不能改写来源。Caddy→Host→RC2 使用私有 edge token 传递 IP/UA，支持单个 IPv4/IPv6；在线用户与登录日志统一由 RC2 原解析链记录。新增代理须先明确 CIDR/信任链，不能直接取客户端 XFF 第一项。私有 edge/monitor token 不进入浏览器、模型或访问日志。

员工缺模型/授权时应联系组织管理员；身份过期回到员工登录页。环境准备有180秒排队上限、明确失败与重试。Admin监控通过原 Cookie 和 `monitor:admin:list` 权限访问 `/monitor/`，独立 JVM 仅监听18909、Xmx256MiB/MemoryMax384MiB，公网只读。系统工具总览只链接当前权限允许的既有监控页面，生产代码生成器继续禁用。运行产物及真实网页验收以相应 RELEASE.json、VERIFIED.json 和项目维护记录为准。

### 2026-10-23 首页刷新最终部署

当前 `20261023-guid-refresh-v3` / 实际应用SHA `5dac6e06240eb711c40b4fdf6730d239a05418e9`。仅员工Web/Host重建；管理/Java/control、23迁移、精确amd64镜像与Core1/启动1/闲120秒保持。v1真实回归发现状态接线遗漏，v2只暂存，v3修正CLI到Gateway状态回调并通过真实员工回归。

test1001原密码实际登录：首页/刷新、新会话/双标签、真实长模型中显式刷新202 pending、完成和取消后安全更新ready、正常网页默认模型回复、发布相关服务重启后的旧会话保留和新对话通过。状态GET503故障注入的错误码/快速重试证据与真实模型结果分开；未制造上游模型故障或宣称永久active已复现。安全门禁包含前台90秒租约，不强杀任务；首页继续使用当前有权资源，后台15秒安全调度。私有证据 `.codex/guid-refresh/acceptance-report.md`，服务器 `shared/config/acceptance/20261023-guid-refresh.md`。

回滚审核 `shared/config/rollback-reviews/20261023-guid-v3-to-inheritance-v7.json`，只恢复v7应用/配置，保留23迁移/文件/权限，会恢复旧首页缺陷；未实际执行。日志/重启仍用manage.sh，更新沿用restage-web --employee-only与finalize。未扩展办公场景或新增外部接口验收。


## 2026-10-24 登录过渡与管理交互最终发布

当前 `20261024-workspace-ui-v6`，实际应用SHA `0abc20978c5c11bdeab77849a33647bd9cf7bd8b`；应用代码已提交推送，后续维护提交与运行SHA分开记录。员工/Host与管理网页按现有流程构建；本轮Java共享改动已构建，v6复用v4的Java/control、23迁移和精确amd64镜像。上线前一致备份成功，未清库/改密码或重启其他项目。

准备页修复成功后误报失败、无原因/无限重试边界；真实阶段与追踪耗时、自动恢复、品牌/i18n壳及脚本失败重载。真实回归额外发现React清空root短空白、布局品牌闪烁和ready跳转丢hash，均已修复。test1001原密码公网冷登录、刷新/双标签、真实默认模型回复、会话刷新保留和退出旧身份401通过。一次冷登录19.451秒，其中实际Core启动1.524秒、前端挂载13.961秒；无虚假百分比，保留自动语言。

企业资源共享统一部门树/角色员工搜索多选、中文权限状态、可读对象、稳定底部/未提交保护；服务端依赖预检、重复授权幂等、权限调整复用、撤回沿用原权限链。外部连接不再隐式连带共享依赖。真实后台创建专用资源，员工身份验证授权、减权与撤回后实际拒绝；没有将资源USE检查误称为原生CALCULATOR工具执行。搜索故障后的鼠标/键盘重试、竞态、焦点恢复通过；3个专用资源已停用，保留历史和既有业务授权。

当前管理员实际26入口审查/现有搜索重置排序标签刷新、16主要真实弹窗回归；1440基线/1366发布回归，共享另验900。共性修复包含长弹窗滚动、稳定操作、AI编辑未保存/重复提交保护、状态/元数据业务展示、客户端密钥默认遮蔽。notice/cache初次读取早、原模型data.rows正确的误判已纠正，不作为实际缺陷。

证据 `.codex/ui-transition/acceptance-report.md`；服务器 `shared/config/acceptance/20261024-workspace-ui.md`、当前VERIFIED.json。Host31、标题3、Java共享5定向用例实际通过，renderer类型及受影响组件编译通过；未跑历史全量/桌面/办公扩展。Host既存research.ts:137完整tsc问题未修不计通过，独立客户符合性仍待独立需求资料。

最终Core0，可用内存4.88GiB、盘余3.04GiB；Host/RC2/monitor/拼豆/Caddyactive，两入口及拼豆TLS200、ops-check200。Core1/启动1/闲120秒/等180秒保持。最新一致备份 `20261024T035251536989Z.tar.gz` / 752031283字节，保留2份/1504059344字节，原预算保持；前轮隔离恢复证据复用，本轮不生产还原。回滚审核 `shared/config/rollback-reviews/20261024-ui-v6-to-guid-v3.json`，previous仍guid-refresh-v3；仅应用/配置回滚、保留数据/授权，会恢复旧UI限制，未实际执行。


## 2026-10-25 员工启动性能

已部署 `20261025-employee-startup-v1` / 实际应用 `1a17dab1ea647e769c5a4571d7bc9058eb2da796`。两个主脚本实传8.90MB→2.24MB（Brotli），下载15.8→3.4秒；本机预压缩、服务器流送，只有内容哈希静态资源长期private缓存，身份/用户/组织数据no-store，保留认证、品牌、真实状态及原并发。

同条件：平台已热时员工Core冷/无缓存，首页19.27→6.57秒、输入20.58→7.40秒、真实模型回复23.87→10.71秒；已有Core无缓存输入17.93→5.57秒。首次发布后的冷输入另为9.80秒，包含1.716秒登录服务预热，未混为同条件。有缓存输入1.24→1.92–2.07秒，本轮没有明显改善；冷Core有缓存3.28→3.97秒，刷新0.88→1.01秒，均如实保留，配置/授权不长期缓存。

五组真实网页/模型回归、历史恢复/继续消息/刷新、Gzip/Brotli与内容SHA256、304/no-store/退出旧身份拒绝通过。证据docs/employee-startup-performance.md与私有.codex/startup-performance/acceptance-report.md；服务器acceptance/20261025-employee-startup.md。Host32定向通过；旧Host完整tsc research.ts:137未扩展修复。不重复后台全巡检/办公三场景。

Admin/Java/control/23迁移/amd64镜像和Caddy模板逐字节复用v6。备份成功，Core1/启动1/闲120秒/等180秒保持。只清理未验收workspace-ui-v1/v4/v5，保留清单、配置快照、全部已验证发布与数据。最终Core0，可用内存5.03GiB、磁盘3.54GiB；本项目/拼豆/Caddy及HTTPS正常。最新备份20261025T065012557834Z.tar.gz / 752216047字节；2份/1504298426字节。回滚审核20261025-startup-v1-to-ui-v6.json，仅应用/配置，保留数据/权限，未实际回滚。


## 2026-10-26 文件可交付性发布

当前 `20261026-artifact-delivery-v2` / 应用 `f2a07f0378f6b95a1f2354b0eeefa38dc8202538`。只重建员工网页/Host与预压缩，复用knowledge-v3管理端/Java/control/native、23迁移、精确amd64镜像；没有新常驻转换服务。实际网页双资料四份文件、定点续改、版本/链接权限和中文Office显示通过；桌面Office点击链接后的落地未确认。详见docs/artifact-delivery.md与私有验收记录。

状态、重启、日志仍为 `sudo bash /srv/apps/zhenwork/deploy/manage.sh status`、`restart`、`logs 100`。更新沿用本机restage-web --employee-only及finalize-release，不混入未提交工作。previous为已验证knowledge-v3；回滚命令 `sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261026-artifact-v2-to-knowledge-v3.json`，仅退应用/配置，保留数据库、资料、授权及文件历史，会恢复旧版文件生成限制。未实际回滚。
