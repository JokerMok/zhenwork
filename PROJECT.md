# ZhenWork 腾讯云网页试点

核对日期：2026-10-20。范围为网页试点；员工站、管理后台、必要服务和按员工启动的 Linux Core/Gateway。无桌面安装包、下载页或桌面更新服务。

## 访问与账号

- 员工：https://zhenwork.shizibandu.icu/
- 管理后台/RC2：https://zhenwork-admin.shizibandu.icu/admin/ （根地址自动跳转）
- 独立管理员 zhen-admin；普通员工 pilot-a、pilot-b；均为随机独立口令，普通员工初始改密步骤已完成。未使用仓库默认密码或搬运本机试点数据库。
- Mac 初始账号凭据（后台改密后不会自动同步，当前密码以用户或管理员新设为准）：`~/server-ops/tencent-main/secrets/zhenwork-accounts.json`（0600）；服务器：`/srv/apps/zhenwork/shared/config/accounts.json`（root 0600）。完整初始化和加密密钥仅在私有 config 中，禁止提交或写入日志。
- 一个默认办公模型 Doubao Seed 2.0 Mini（doubao-seed-2-0-mini-260428），通过已有授权 ARK 配置初始化到 RC2，三个账号均已明确授权；员工无需填写 API。真实模型探测和工具调用通过，无模拟回复。

## 源码和产物

- 仓库 https://github.com/JokerMok/zhenwork ，首次核对本机与远端 main 均为 `42d834a75722bdbe6331dba226d0febdc6179383`；以 git archive 独立冻结构建，未混入内部工程的工作树修改。本次部署修复和维护脚本保留在本仓库工作树，尚未推送 GitHub。
- 当前 release：`20261020-42d834a-admin3`；平台 linux/amd64；部署位置 `/srv/apps/zhenwork/current` -> releases 同名目录。
- 远端快照未包含 Core Cargo.lock；保留兼容锁（zip2.4.2），SHA256 `6dab2a00dc751f1e2c6ad5873d24befd7bd076c26a7730b78e19a3626a1221cf`。
- 部署所需最小 Core 修复：初始化但未提交任务的 Pending 空会话，在无运行时 claim/状态迁移、无后台子任务、无前台租约和团队活动时允许回收；Running/未知状态仍保守拒绝。补丁 `deploy/tencent/core-idle-pending.patch`，SHA256 `39d4f30b2efbbb54a38001ed26855ec63a561f0f53b8c7b31309c903ecca5fd7`；未关闭权限、身份复核或工具审批。
- 所有镜像完整 ID、依赖锁、补丁和非敏感配置版本在 `current/RELEASE.json`；产物哈希在 SHA256SUMS；验收在 VERIFIED.json。额外私有配置版本 `shared/config/versions/20261020-42d834a-admin3`。
- 网页、Node CLI、Java/Admin 在 Mac 构建；Linux Rust 在服务器原生构建，2 CPU/3GiB 限额，未上传 Mac 二进制充当 Linux Core。镜像网络不可达时采用官方归档或本机 save/load，未加未知镜像源。

## 运行结构

| 组件 | 启动/端口 | 数据/配置 |
| --- | --- | --- |
| Web Host | 非root zhenwork-web.service；127.0.0.1:18891 | shared/config/web.env；shared/profiles |
| RuoYi/RC2 | zhenwork-rc2.service；127.0.0.1:18890 | shared/config/application-rc2.yml；shared/logs/rc2 |
| PostgreSQL17 | Compose zhenwork db；127.0.0.1:18432 | shared/data/postgres |
| Redis8 | Compose zhenwork redis；127.0.0.1:18379 | shared/data/redis |
| Core/Gateway | Web Host 按员工启动；无公网端口 | 每员工独立 profile/workspace/runtime-temp；加密后台状态 |
| HTTPS | 复用宿主 caddy.service 80/443 | /etc/caddy/sites-enabled/zhenwork.caddy |

RC2 真正使用 PostgreSQL；首次依次执行企业 PostgreSQL 基表、独立身份/客户端与 DML app 角色、员工角色、RC2 0001—0017 checksum 迁移；不沿用 MySQL 模板或旧 Harness 演示。审计归档写权限撤销保留。Web Host 使用 Docker 组及真实宿主路径，不塞入容器，不公开 Docker 接口。

最大同时 Core=1、启动并发=1，空闲阈值120秒，排队等待180秒，配置位于 shared/config/web.env。Core上限2GiB、Gateway128MiB、Java堆768MiB/服务1400MiB、Host768MiB、PG768MiB、Redis256MiB；容器上限不是实际占用。zhenwork-infra 开机拉起 db/redis/bridge-anchor，容器健康检查、失败恢复；RC2/Host独立自启/失败重启，Host启动前等待RC2。

为维持 Linux Docker 默认桥 UP，使用非root只读 bridge-anchor（无端口、cap_drop ALL、8MiB上限）。只在 docker0 放行受控172.17.0.0/16到172.17.0.1 TCP32768:60999；公网保持既有22及80/443，未开放数据库、Redis、Core或Docker API。/etc/hosts 两域名127.0.0.1仅供宿主走真实HTTPS，不关闭证书校验。

## 域名与配置边界

DNSPod仅新增 zhenwork 和 zhenwork-admin 两个A记录175.178.236.56/TTL600；主域名、www、邮箱及无关记录保留。部署前已据 SERVER.md 核对腾讯云备案接入正常。Caddy候选经 caddy-site-install 校验/reload，自动证书和两个不同 HTTPS origin 均实际验证。

Host publicOrigin=员工域名、RC2 URL=管理origin根地址、RC2 public-origin=员工域名；管理前端 /admin/ + /api；稳定 serverId/clientId 保存在私有配置。Cookie均Secure/HttpOnly/Strict；仅精确管理Origin做受信改写，外来Origin仍拒绝。外部internal路径403，宿主内部通过loopback访问。

## 数据、备份和维护

员工 profile/workspace、上传 runtime-temp、会话SQLite、资料和必要密钥独立于releases。shared/uploads是预留目录，实际上传在员工profile中。更新不覆盖shared，不删除旧镜像/业务数据，不运行down -v/全局prune。

已接入现有每日03:20后随机5分钟内的 server-config-backup.timer，hook为 /etc/server-ops/backup.d/zhenwork.sh。有运行Core时延后；无Core时只停止本项写入者，以pg_dump -Fc加停写profile快照，结束恢复本项服务；shared/config由主备份覆盖。Node/cache可重建内容排除，数据库不直接打包运行目录。原有拼豆备份hook保留。

沿用输入128MiB、单包256MiB、总1GiB、7份预算，容量增长时须重核；只在新包完整验证后轮转。备份位于 /srv/backups/config，仅root可读。同机备份不抵御整机丢失，异机副本和外部告警尚未配置。

```sh
# 在 Mac 本仓库更新：默认从 origin 默认分支冻结已提交源码
bash deploy/tencent/deploy.sh
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh status'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh restart'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh logs 100'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh backup'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback'
```

已保留原pilot1版本；它不支持8位密码，部署兼容性门禁拒绝直接退回该旧版。后续只能回退经验证且支持当前密码策略的应用与配置，数据库保持原状。新迁移或checksum变化会阻止自动激活，须先审查数据兼容性。详细脚本与恢复检查入口见 deploy/tencent/README.md。日志：journalctl -u zhenwork-web -u zhenwork-rc2；Caddy日志 /var/log/caddy/zhenwork*-access.log（5MiB×3/7天）；容器日志沿用local轮转。

## 实际验收（2026-10-20）

内部服务可用；**两个公网 HTTPS 入口均已在真实 Chromium 中验证**（正常DNS、有效TLS，无忽略证书或临时隧道）。Mac系统解析器曾缓存员工域名NXDOMAIN，收口时两个域名的系统解析也已恢复正常；公网结果来自真实浏览器。

- 后台：真实页面登录、系统管理导航、同源API、Secure/HttpOnly/Strict Cookie、外来Origin写请求403、注销后旧身份401，通过。
- 员工：网页真实上传《试点办公样例.docx》，默认办公模型实际调用工具并保留一次性审批，生成可预览/下载且可读取的Excel，合计72；同会话继续修改数量后合计90，重新预览/下载及内容检查通过；实时WebSocket包含message.stream和turn.completed。
- 两普通账号会话、任务确认、生成文件、上传资料越权抽查拒绝；注销后旧Cookie401。真实浏览器页面无JS错误的最终定向检查通过。
- 仅重启本项目db/redis/bridge-anchor、RC2、Host，旧会话及合计90的Excel仍可读取。拼豆PID43616、自10:22:17运行，未被本项目重启；CaddyPID19836也保持。没有整机重启。
- 新建空会话并保持身份、关闭WebSocket；无需注销/重启，Core及Gateway约137秒后自然回收。运行中/后台/前台租约保护六项定向Rust策略检查通过；未扩大到多Core或压力测试。
- 一致性备份已接入现有全局任务并实际成功（最终含本项目包约2.12MiB）；pg_restore进入临时独立检查库，用户5/模型1/迁移17计数匹配；profile真实恢复395文件、两份SQLite完整性通过，56个Office包（含内置模板和试点文件）校验通过。生产库未覆盖；自己的临时恢复库已删除。详细记录 shared/config/restore-check.json。
- 完成后实测总内存7.50GiB、可用6.16GiB、近似使用1.34GiB，磁盘剩35.96GiB；Core计数0。容器/进程实际用量在本机 .codex/tencent-verification/final-resources.json，未把限额当实际占用。
- 首次发布没有可回退旧版本；rollback拒绝保护已实际确认，未声称执行过应用/数据库回滚。

证据在本机 `.codex/tencent-verification/`，服务端 `current/VERIFIED.json`。仅执行本次相关构建、脚本语法/配置与定向验收；未运行全历史、桌面安装或大规模压测。

当前无阻塞网页试点的问题。非阻塞边界：前端复用的少量桌面缩放/更新/日志订阅返回REALTIME_UNSUPPORTED_MESSAGE，未部署桌面服务去消除提示，真实任务流已通过；后续增加员工前须按实测调整容量/备份预算。异机备份和外部告警未配置，当前同机恢复检查不等于异机容灾验收。


## 后台可用性更新（2026-10-20 14:55）

当前版本 `20261020-42d834a-admin3`，仍以42d834a源码及原Core空闲补丁为基线，新增 `deploy/tencent/admin-usability.patch`。补丁SHA和准确产物哈希在current/RELEASE.json与SHA256SUMS，源码/维护脚本改动仍未推送GitHub。本轮没有数据库迁移，Core/Gateway镜像、员工资料和其它项目保持。

- 修复根因：后台重置/新建账号会标记must_change_password，但原员工网页直接拒绝，并显示成密码错误。现在正确凭据会进入首次改密流程；未完成时不发员工会话、不启动Core。原凭据由RC2重新验证，调用原生个人改密接口后正常登录；身份版本撤销、Origin校验及限流保留。
- 新建/重置/个人修改密码统一为恰好8位ASCII字母数字，必须同时包含字母和数字。已有长密码继续兼容登录，本轮未批量覆盖既有账号密码。后台重置对话框不再明文回显新密码。
- 移除员工登录页“使用试点账号开始办公任务”，并保留空副标题，不通过备用文案重新显示。初始化品牌配置同步为空。
- 后台首页改为真实用户使用统计：启用用户、期间活跃用户、模型调用、Token、每日趋势和用户明细，支持7/30/90天。来自当前Core模型中继开始/结束事件；不混用旧Harness任务表，不把调用数写成任务数，不把未报告用量/费用当零。接口要求ai:audit:view，按北京时间统计，读事务保持一次响应内口径一致。
- 定向实际验收：独立临时账号在真实后台界面两次重置8位密码、两次网页首次改密/进入工作台成功，第二次重置后旧会话失效；错误旧密码/纯数字新密码/外来Origin拒绝。普通用户读取统计返回原生权限拒绝（HTTP200、响应体code403、无统计数据）；测试按此原生约定修正断言，仅复测受影响路径通过。
- 清理测试账号后，真实统计为4个启用用户、1个期间活跃用户、10次模型调用，已报告输入120941/输出2346 Token；与数据库现有事件独立核对一致。管理员统计页和时间切换通过，最后页面无JS错误；临时账号及其模型授权已通过原生接口清理，业务资料未删除。
- 网页/Java构建、后台类型检查通过；密码网关5项定向测试通过（22项未选中）。复用未改变的Core办公工具验收，没有重复付费模型任务或全历史测试。证据 `.codex/admin-fix-verification/`，当前release的VERIFIED.json为本次范围，原pilot1/VERIFIED.json保留前次部署范围。
- 维护脚本已修正探针Host头及迁移checksum查询的引号，兼容性门禁记录8-alnum-v1，阻止旧版重新拒绝8位密码。更新前已有一致性备份；一次探针误判曾自动恢复旧应用，业务数据未回退，随后成功发布修正版本。
