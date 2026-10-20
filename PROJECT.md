# ZhenWork 腾讯云网页试点

核对日期：2026-10-20。范围为网页试点；员工站、管理后台、必要服务和按员工启动的 Linux Core/Gateway。无桌面安装包、下载页或桌面更新服务。

## 访问与账号

- 员工：https://zhenwork.shizibandu.icu/
- 管理后台/RC2：https://zhenwork-admin.shizibandu.icu/admin/ （根地址自动跳转）
- 独立管理员 zhen-admin；普通员工 pilot-a、pilot-b；均为随机独立口令，普通员工初始改密步骤已完成。未使用仓库默认密码或搬运本机试点数据库。
- 服务器账号凭据唯一维护副本：`/srv/apps/zhenwork/shared/config/pilot-credentials.json`（root 0600）；本轮本机 QA 私有凭据：`.codex/enterprise-delivery/qa-private.json`（0600）。`zhenwork-accounts.json` 仅是初始化输入，不再作为当前密码来源。完整凭据和加密密钥禁止提交或写入日志。
- 一个默认办公模型 Doubao Seed 2.0 Mini（doubao-seed-2-0-mini-260428），通过已有授权 ARK 配置初始化到 RC2，三个账号均已明确授权；员工无需填写 API。真实模型探测和工具调用通过，无模拟回复。

## 源码和产物

- 仓库 https://github.com/JokerMok/zhenwork ，首次核对本机与远端 main 均为 `42d834a75722bdbe6331dba226d0febdc6179383`；以 git archive 独立冻结构建，未混入内部工程的工作树修改。本次部署修复和维护脚本保留在本仓库工作树，尚未推送 GitHub。
- 当前已激活 release：`20261020-office-sources`，SHA `afd9cea5d80cd90cc4f1385bc8a4c50f4b8ab0d0`；平台 linux/amd64；部署位置 `/srv/apps/zhenwork/current`。`20261020-office-workflows`（SHA `68eed01330c6ee029ef3c6848d432e585511e5b6`）仅已暂存，尚未激活，不视为线上版本。
- 远端快照未包含 Core Cargo.lock；保留兼容锁（zip2.4.2），SHA256 `6dab2a00dc751f1e2c6ad5873d24befd7bd076c26a7730b78e19a3626a1221cf`。
- 部署所需最小 Core 修复：初始化但未提交任务的 Pending 空会话，在无运行时 claim/状态迁移、无后台子任务、无前台租约和团队活动时允许回收；Running/未知状态仍保守拒绝。补丁 `deploy/tencent/core-idle-pending.patch`，SHA256 `39d4f30b2efbbb54a38001ed26855ec63a561f0f53b8c7b31309c903ecca5fd7`；未关闭权限、身份复核或工具审批。
- 所有镜像完整 ID、依赖锁、补丁和非敏感配置版本在 `current/RELEASE.json`；产物哈希在 SHA256SUMS；验收在 VERIFIED.json。私有配置版本位于 `shared/config/versions/`，应按当前激活 release 核对，不能用 staged 目录替代 current。
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

RC2 真正使用 PostgreSQL；当前迁移已执行到 0019；不沿用 MySQL 模板或旧 Harness 演示。审计归档写权限撤销保留。Web Host 使用 Docker 组及真实宿主路径，不塞入容器，不公开 Docker 接口。

最大同时 Core=1、启动并发=1，空闲阈值120秒，排队等待180秒，配置位于 shared/config/web.env。Core上限2GiB、Gateway128MiB、Java堆768MiB/服务1400MiB、Host768MiB、PG768MiB、Redis256MiB；容器上限不是实际占用。zhenwork-infra 开机拉起 db/redis/bridge-anchor，容器健康检查、失败恢复；RC2/Host独立自启/失败重启，Host启动前等待RC2。

为维持 Linux Docker 默认桥 UP，使用非root只读 bridge-anchor（无端口、cap_drop ALL、8MiB上限）。只在 docker0 放行受控172.17.0.0/16到172.17.0.1 TCP32768:60999；公网保持既有22及80/443，未开放数据库、Redis、Core或Docker API。/etc/hosts 两域名127.0.0.1仅供宿主走真实HTTPS，不关闭证书校验。

## 域名与配置边界

DNSPod仅新增 zhenwork 和 zhenwork-admin 两个A记录175.178.236.56/TTL600；主域名、www、邮箱及无关记录保留。部署前已据 SERVER.md 核对腾讯云备案接入正常。Caddy候选经 caddy-site-install 校验/reload，自动证书和两个不同 HTTPS origin 均实际验证。

Host publicOrigin=员工域名、RC2 URL=管理origin根地址、RC2 public-origin=员工域名；管理前端 /admin/ + /api；稳定 serverId/clientId 保存在私有配置。Cookie均Secure/HttpOnly/Strict；仅精确管理Origin做受信改写，外来Origin仍拒绝。外部internal路径403，宿主内部通过loopback访问。

## 数据、备份和维护

员工 profile/workspace、上传 runtime-temp、会话SQLite、资料和必要密钥独立于releases。shared/uploads是预留目录，实际上传在员工profile中。更新不覆盖shared，不删除旧镜像/业务数据，不运行down -v/全局prune。

已接入现有每日03:20后随机5分钟内的 server-config-backup.timer，hook为 /etc/server-ops/backup.d/zhenwork.sh。有运行Core时延后；无Core时只停止本项写入者，以pg_dump -Fc加停写profile快照，结束恢复本项服务；shared/config由主备份覆盖。Node/cache可重建内容排除，数据库不直接打包运行目录。原有拼豆备份hook保留。

当前输入预算512MiB、单包上限512MiB、总压缩包上限2GiB、保留7份，运行单元 `LimitFSIZE=512M`；空闲不足2GiB或超预算时报错并保留已有备份，只在新包完整验证后轮转。备份位于 /srv/backups/config，仅root可读。同机备份不抵御整机丢失，异机副本和外部告警尚未配置。

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
- Core资源授权6项定向检查通过；空闲阈值120秒，实测在146秒内回收。未扩大到多Core或压力测试。
- 当前备份 `20261020T123921868745Z.tar.gz` 已成功生成，大小281167825 bytes；本轮恢复验证仍待完成，不能沿用旧约2MiB、17次迁移的恢复结果作为当前恢复结论。生产库未覆盖。
- 完成后实测总内存7.50GiB、可用6.16GiB、近似使用1.34GiB，磁盘剩35.96GiB；Core计数0。容器/进程实际用量在本机 .codex/tencent-verification/final-resources.json，未把限额当实际占用。
- 首次发布没有可回退旧版本；rollback拒绝保护已实际确认，未声称执行过应用/数据库回滚。

证据在本机 `.codex/tencent-verification/`，服务端 `current/VERIFIED.json`。仅执行本次相关构建、脚本语法/配置与定向验收；未运行全历史、桌面安装或大规模压测。

当前文档只证明已列明的技术与定向业务结果。报销、产品、研究三类最终业务任务尚未通过；cron重启验证和当前备份恢复验证仍待完成。异机备份和外部告警未配置。


## 当前版本与本轮验收更新（2026-10-20）

- 线上仍是 `20261020-office-sources`（SHA `afd9cea5d80cd90cc4f1385bc8a4c50f4b8ab0d0`）；`20261020-office-workflows`（SHA `68eed01330c6ee029ef3c6848d432e585511e5b6`）只完成暂存，尚未激活。
- 后台重置密码固定为临时值 `a123456`；用户首次改密、创建、编辑和个人修改均要求8—16位ASCII字母数字，且同时包含字母和数字。临时值只用于强制改密入口，不是用户长期密码。
- 已实测后台密码流程和管理首页；真实PDF预览与下载；同一浏览器中QA1登出后切换QA2的任务、会话、文件、知识和记忆隔离；原件31页OCR；Core资源授权6项检查；120秒空闲阈值下146秒内回收。
- 当前 PostgreSQL 迁移到0019。当前成功备份为 `20261020T123921868745Z.tar.gz`，281167825 bytes；本轮恢复仍待验证。cron重启验证仍待完成。
- 报销、产品、研究三类最终业务任务尚未通过，不得由PDF、OCR、隔离或资源授权的局部通过替代。
