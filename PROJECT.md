# ZhenWork 腾讯云网页维护

核对日期：2026-10-21。当前范围：四项办公业务失败修复、真实员工网页集中回归和保留数据更新；不制作桌面安装包。

## 当前发布与访问

- 员工：[ZhenWork](https://zhenwork.shizibandu.icu/)；后台：[管理端](https://zhenwork-admin.shizibandu.icu/admin/)。两入口已由 Mac 直连实际公网 IP、正常 TLS 校验并获得 HTTP200；不是仅内部可用。
- 激活 release：`20261021-office-reconciliation-v8`；准确应用 SHA：`619c3d9272018a519d5f385f1f86d115aa3dbcf6`；平台 `linux/amd64`。本文件之后的纯维护文档提交不会重建应用，不能把文档 HEAD 当作实际应用 SHA。
- 基线 `20261020-office-diagnostics` 对应 `1b601eea104668b684f1aba57a46e3fa2940a672`；其后 `3c8b36f1b82aa78d5e08663c01c25957e6030cc8` 只更新 PROJECT.md 和 deploy/tencent/README.md。两者不同不表示部署错误。
- 本轮只重新构建 Host；employee/Admin/Java/control-source 按不可变候选复用，19条迁移未变。`current/RELEASE.json`、`SHA256SUMS`、`VERIFIED.json` 保存来源、完整镜像及实际验收范围；私有配置和业务数据在 release 外。
- Core：`sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0`；Gateway：`sha256:81dfa364e6bda9b8383dcb17fda523ccb95a9c583ec3371333a40a83ff937217`。Core binary：`a43e0efe7406762813ccb12c766ff77c720b9c7993df3441efd7485cb7ac5f07`；其余镜像与锁以 manifest 为准。本轮没有上传 Mac 原生二进制或重建 Rust。

## 四项修复与真实验收

详细实现和安全边界见 `docs/office-reconciliation.md`。私有证据入口：`.codex/enterprise-delivery/business/20261021/acceptance-report.md`，含截图、完整会话/工具、实际下载和内容检查。公司原件、人员、金额、Cookie、凭据不进入公开 Git。

| 失败项 | 根因与修复 | 实际结果 |
| --- | --- | --- |
| 报销成品与后续核对不一致 | 原脚本把跨日汇总单作为一条、日期取首日，模型又混淆汇总单/明细/业务日及重复汇总。改为按来源真实业务日写回，当前 XLSX 重新读取、Decimal 精确计算及支持公式重算；明确币种/舍入/分组；拒绝空明细、日期列和依赖重复相加。 | v8真实模板/票据上传生成、同会话追问、新默认任务及重启后复核一致；另有四行小数及修改后复核。源票据不改、未知费用不填零，实际成品结构/图片保留。 |
| 产品引用与解释错误 | PDF跨栏引用和来源存在被当作符合结论，缺独立需求。连续原文、文件版本/哈希与页码定位校验，引用使用时重查授权；缺需求强制不足，明确限定条件。 | 合成需求/产品真实网页验证符合、不符合、部分符合、证据不足；授权真实扫描PDF生成18条有页码原文的发现，均保留证据不足；不宣称真实客户验收通过。 |
| 研究报告有、对比表没有 | 模型可见参数提示与真实schema不一致、空/失效引用、分开产物数据漂移。结构/类型预检、清晰纠错和有限重复限制；一个数据集同时生成并验证DOCX/XLSX，研究与客户核查状态分开。 | 默认入口真实联网检索/读取，8条事实的报告与表均实际下载并独立读取；双文件原文引用、来源和数据集标记一致，缺失价格/效果明确缺失。 |
| 新增列标题残留 | 未读取真实标题、合并、空行和数据边界，续改还另存相似文件。定向列修改先读结构、清理被替换列标题旧值，安全扩展合并/打印范围；同文件乐观哈希冲突保护，保存后重开。 | 真实旧文件同名改列、刷新再次改单元格、真实浏览器下载；原10列保留，新增列/标题/打印区正确；旧版与最新版恢复后字节一致。精确下载件另用系统预览检查全部11列。 |

- v6/v7仍出现过的日期解释错误保留为失败证据；v8修复真实写回粒度后才标记报销通过。未靠更换模型掩盖数据问题。
- 默认模型先同输入比较，现有同一凭据可调用的 DeepSeek Flash 已设为企业默认；另外两个候选实际返回 ModelNotOpen，未虚构可用。正常验收入口核实通用助手与实际默认模型，无需员工高级配置。
- 集中定向回归：两个普通账号的会话/文件/知识原文版本/记忆/job隔离和退出旧Cookie拒绝；离线短任务实际运行程序并只执行1次；仅重启本项目后运行记录、任务和4个成果SHA保留，默认工具继续可用。网页无JavaScript页面错误；现有 `REALTIME_UNSUPPORTED_MESSAGE` 兼容噪声仍存在，不影响已测流式/授权/结束。
- XLSX网页内嵌预览仍显示明确限制，提供有效下载和继续处理；未宣称已实现完整Office内嵌预览。此次视觉检查使用真实浏览器下载件的系统原生预览。
- 代码检查按受影响范围执行：最新workbook 13项、解析器3项、read-document 6项及办公工具/交付定向用例通过，Host类型检查通过。重复运行不累计测试数量；未跑全历史、桌面或大规模压测。业务通过依据网页过程和实际文件，不是测试计数或HTTP200。

## 配置、身份与数据

- RC2 `office-defaults` 版本2；默认助手 `zhenwork-general-office`；默认模型 `3cdb425d-b8df-456c-b769-8abc5a66cd82` / `deepseek-v4-1-flash-261017`。保留原模型，仅复制仍有效的原授权；API密钥未变、价格未配置时费用未知。
- 完整报销能力包沿原资源权限发布 packageVersion6 / Skill2.2.6，保留21个配套文件；解析器SHA256：`f70f56c06e63a39e5e36bf5f80fca7faeced2b2a3dd4acb9431346269e8c08e0`。发布记录 `shared/config/office-publication-20261021.json`、模型变更前后记录 `shared/config/office-model-change-20261021.json`，root0600。
- 初始化管理员凭据 `shared/config/pilot-credentials.json`，root0600；后续后台改密不自动回写。QA材料 `.codex/enterprise-delivery/qa-private.json` 为0600。完整口令、Cookie、令牌、密钥禁止进入日志/Git/交付文字。
- 后台重置固定临时值 `a123456`；首次自设/常规改密为8—16位ASCII字母数字且含两类。该密码流程、后台真实统计等前轮已验收功能保留，本轮不重置账号。
- 员工profile/workspace/会话：`shared/profiles`；上传：真实目录`shared/uploads`，`shared/config/uploads`仅受控链接；数据库`shared/data/postgres`，Redis`shared/data/redis`。更新不覆盖shared。

## 运行架构与资源

| 组件 | 启动与端口 | 配置/日志 |
| --- | --- | --- |
| Web Host | 非root `zhenwork-web.service`，127.0.0.1:18891 | shared/config/web.env；journalctl -u zhenwork-web |
| RuoYi/RC2 | zhenwork-rc2.service，127.0.0.1:18890 | shared/config/application-rc2.yml；shared/logs/rc2 |
| PostgreSQL17 / Redis8 | 独立Compose zhenwork，18432/18379均loopback | shared/data；健康检查、自启 |
| 员工Core/Gateway | 按员工启动，无公网端口 | 每员工隔离profile；受控Docker内部代理 |
| HTTPS | 复用宿主Caddy80/443，两origin独立 | /etc/caddy/sites-enabled/zhenwork.caddy |

仍是PostgreSQL企业架构，未采用MySQL模板或旧Harness。Core最多1、启动并发1、空闲120秒、排队180秒；保留身份复核/授权/隔离。Core2GiB、Gateway128MiB、Java服务1400MiB（堆768MiB）、Host768MiB、PG768MiB、Redis256MiB是上限，不是占用。

收口实测（2026-10-21T03:49:26.909792+00:00）：Core0；系统可用内存5.58GiB，盘空闲23.06GiB；Host约122MiB、Java约742MiB。拼豆PID43616及2026-10-20 10:22:17启动时间未变；拼豆公网TLS/HTTP200、ops-check内部HTTP200。自动回收和其他项目均正常，未重启整机。

## 备份、更新与回滚

- 既有每日 `server-config-backup.timer`；运行Core时延后，无Core时仅停本项目写入者，`pg_dump -Fc` + profile/workspace/uploads停写快照。私有配置、密钥及业务文件保留，排除可重建缓存/镜像。
- 本轮实际包 `20261021T032755541854Z.tar.gz`，542803963 bytes，完整读取/校验通过；超过旧512MiB门禁后，将输入/单包/LimitFSIZE调到768MiB，总保留仍2GiB、最多7份、最低空闲2GiB、MemoryMax384MiB。4份合计2060679670 bytes，按总额轮转，不保证7份。旧脚本/单元保存在 `/srv/ops/history/backup-budget-20261021/`。
- 前轮 `20261020T150442678681Z.tar.gz` 已隔离恢复验证原生DB、迁移19、profile/SQLite/Office；本轮未重复还原生产或重复隔离恢复。异机备份/外部告警仍未配置，同机包不抵御整机丢失。

```sh
# 完整更新只暂存已提交源码；Host范围可按README使用restage-host.sh
bash deploy/tencent/deploy.sh --ref COMMIT_SHA --release RELEASE_ID
# 审阅不可变候选、迁移与镜像后，保留数据激活
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/finalize-release.sh RELEASE_ID'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh status'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh restart'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh logs 100'
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh backup'
# 当前v8专用：数据库保留，回到已验证基础可用但仍有原业务缺陷的旧应用
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261021-office-reconciliation-v8-to-office-diagnostics.json'
```

回滚审核绑定当前/目标SHA及实际19条迁移hash。应用回滚不等于数据库回滚，也不回退数据库中的默认模型/Skill发布；这些通过管理后台单独版本回退。原默认模型与历史能力包仍保留。没有实际执行应用/数据库回滚、整机重启、down -v、全局prune或清理业务数据。后续新发布/迁移会使本次审核失效。

## 外部条件与未覆盖事项

- 仍需独立客户需求及对应真实验收依据，才能作真实客户符合性结论；本轮流程和证据不足处理已实测。
- 真实外部业务API、真实共享目录尚未指定；不伪造接入成功，不阻塞此次四项修复。无须在聊天提供模型密钥。
- 其余历史功能保留对应版本证据；本轮为上述定向回归，不代表全企业系统、所有文件格式或任意公式全量验收。
