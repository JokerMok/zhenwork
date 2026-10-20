# 腾讯云网页试点维护

本部署只提供员工网页、管理后台、RC2、Web Host 和按需启动的 Linux Core/Gateway。源码由 --ref 指定的已提交版本冻结（省略时为本机 HEAD）；更新前先核对 origin 默认分支和本机提交，保留工作树修改；不调用桌面打包、签名、下载页或更新服务。

## 当前主机与入口

部署前阅读 `~/server-ops/tencent-main/SERVER.md`、服务器 `/srv/ops/SERVER.md`、项目 `PROJECT.md` 及 `AionUi-enterprise-poc/docs/deployment.md`。主机别名 `tencent-main`，项目独占 `/srv/apps/zhenwork`；员工入口 https://zhenwork.shizibandu.icu ，后台 https://zhenwork-admin.shizibandu.icu/admin/ 。后台静态与 `/api` 走同一 origin；Host 的 RC2 URL 为管理 origin 根地址。

应用版本看 `current/RELEASE.json`、实际验收看 `current/VERIFIED.json`。初次源码 SHA 为 `42d834a75722bdbe6331dba226d0febdc6179383`，额外保留 Core 依赖锁及空会话回收补丁，各自 SHA256 在 manifest 中。补丁只用于该准确源码版本；不关闭身份复核、目录隔离、后台授权或单次工具审批。

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
  --from 20261020-office-evidence \
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

restart 重启本项目 Java/Host，确认 DB/Redis/bridge-anchor 健康。回滚不还原数据库，也不允许“旧应用 + 任意未来 schema”。目标必须有 `VERIFIED.json`、兼容当前密码策略，并由审核人基于 `rollback-compatibility.example.json` 创建 root 所有、不可组/全局写的文件，放到 `shared/config/rollback-reviews/`。审核文件必须精确绑定当前发布、目标发布、目标 source SHA、当前数据库的完整迁移名/hash 清单，以及目标发布迁移前缀；数据库后来新增一个迁移就会使旧审核失效。

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

本轮为真实办公资料将输入预算由128MiB调整为256MiB，单包仍256MiB、总量1GiB、最多7份；旧主脚本在 /srv/ops/config-history/20261020-zhenwork-office/server-config-backup.before 留存。预算并非承诺能保留7份大包，轮转以总量限制为准，超预算停止并保留旧包。须随员工资料增长重新核定；当前同机备份不抵御磁盘或整机丢失。未配置异机备份/外部通知；没有运行 down -v、全局 prune 或删除业务数据。

## 定向验收

verify-admin.mjs / verify-employee.mjs 使用独立无头 Chromium；本机设置 ZHENWORK_MODULES 指向可用 Playwright/XLSX依赖工程根、ZHENWORK_CREDENTIALS 指向 root 私有试点凭据副本、ZHENWORK_EVIDENCE 指向 .codex 下证据目录。阶段 create、modify、isolation、persistence、idle 分开运行；create/modify 为真实付费模型与工具任务，需要明确授权。脚本不关闭 TLS 校验、不伪造模型响应。

不运行桌面/全历史测试。当前 Linux Web 路径仍可能对前端复用的桌面缩放/更新订阅返回 REALTIME_UNSUPPORTED_MESSAGE；真实任务流与消息推送独立验收，具体边界见 PROJECT.md。


## 后台与密码更新

当前源码已包含网页密码与后台统计修复，不再为当前版本叠加旧 admin-usability.patch。管理首页使用 /ai/admin/dashboard 的真实 Core 中继事件，按北京时间和7/30/90天展示用户活跃、请求、Token与状态；费用未获取或未配置价格时明确未知，不混入旧Harness用量。

后台一键重置固定临时密码 a123456，不提供自选重置口令。员工正确登录后必须设置8–16位、同时含ASCII字母和数字的新密码；临时值是7位的专门例外。改密前不发员工身份、不启动Core，原凭据由RC2复核，第二次重置会撤销旧身份。初始账号文件不自动同步管理员后续改密，不应将其中旧口令当作当前密码。不得用真实员工账号跑重置回归。

受控办公 MCP 提供当前任务附件/工作区 read_document、结构化 write_workspace_json、四格式 create_office_document、validate_artifact、联网检索读取与权限知识检索。读取每次最多5页/位置（Excel最多3工作表，100行×40列），50MiB输入、30秒、OCR标记待复核；旧 .doc/.xls/.ppt 明确不支持，需用户先转为现行格式，不会伪称解析成功。研究与核查使用 sourceRef + 连续原文引用校验，生成文件自动嵌入真实定位；引用存在不代表推断成立或方案已实际验收。引用使用时重查知识授权/版本或工作区文件哈希，30分钟过期后需重读。Registry按员工Core隔离、最多128来源/2MiB文本，重启后重新检索即可恢复依据。个人/共享知识使用 PostgreSQL 轻量检索与 Office/PDF/OCR异步索引，没有增加独立向量数据库。

verify-admin-usability.mjs需要环境变量及私有qa-private.json所指的专用回归账号；all包含统计与重置/首次改密的真实浏览器验证，dashboard只验证读取和布局。禁止用实际员工账号跑重置回归。原生权限拒绝可能为HTTP200/JSONcode403，应同时检查响应体与无数据，而不是要求所有业务拒绝均使用HTTP403。
