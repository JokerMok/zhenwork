# ZhenWork 腾讯云网页维护

核对日期：2026-10-23。当前范围：新员工组织能力继承、登录来源、受保护服务监控和系统工具；定向真实网页验收通过，外部资料边界继续单列。不制作桌面安装包。

## 当前发布与访问

- 员工：[ZhenWork](https://zhenwork.shizibandu.icu/)；后台：[管理端](https://zhenwork-admin.shizibandu.icu/admin/)。两入口已由 Mac 直连实际公网 IP、正常 TLS 校验并获得 HTTP200；不是仅内部可用。
- 激活 release：`20261023-employee-inheritance-v7`；准确应用 SHA：`cea46c0ef395f1a3e3c5712af477a55ecbb27e37`；平台 `linux/amd64`。本文件之后的纯维护文档提交不会重建应用，不能把文档 HEAD 当作实际应用 SHA。
- 基线 `20261020-office-diagnostics` 对应 `1b601eea104668b684f1aba57a46e3fa2940a672`；其后 `3c8b36f1b82aa78d5e08663c01c25957e6030cc8` 只更新 PROJECT.md 和 deploy/tencent/README.md。两者不同不表示部署错误。
- 上轮外部查询v3构建Admin/Java并复用未变employee/Host；v4仅重建Host，Admin/Java/control/employee按不可变哈希复用v3（源码8bb9b72bf12d0dcf6ae5e5e9906c304b547f8748）。保留精确amd64原生镜像。迁移链21条，仅新增0021验证详情，原20条校验和不变。`current/RELEASE.json`、`SHA256SUMS`、`VERIFIED.json` 保存来源、完整镜像及实际验收范围；私有配置和业务数据在 release 外。
- Core：`sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0`；Gateway：`sha256:81dfa364e6bda9b8383dcb17fda523ccb95a9c583ec3371333a40a83ff937217`。Core binary：`a43e0efe7406762813ccb12c766ff77c720b9c7993df3441efd7485cb7ac5f07`；其余镜像与锁以 manifest 为准。本轮没有上传 Mac 原生二进制或重建 Rust。

## 2026-10-23 员工组织能力、登录来源和管理入口

完整根因、设置及权限边界见 [员工组织能力维护说明](docs/employee-capabilities.md)。企业默认模型引用对基础员工生效；新增/导入/注册统一补基础角色，已有员工幂等修复；页面、运行时、后台任务统一 available 目录，助手依赖及撤权再次检查。员工看到组织/个人能力，无需个人 API/MCP。敏感业务连接仍按部门/角色/用户显式授权，不开放全企业。

实际后台新建未手选角色的普通员工，个人模型策略与资源授权均0；首次登录真实对话，组织包脚本/模板生成 XLSX、预览/下载、117.50元独立核算及部门专家真实上游查询通过。撤权拒绝实际调用、部门变更旧身份失效、双账号会话/文件/预览下载隔离、刷新及切换通过。test1001 原密码登录并完成真实模型回合。新会话 IP/Chrome/OSX 与在线/审计一致，伪造转发头未覆盖；旧审计保留。

监控新增真实受保护 SBA4.1.2 服务，修复 HTTPS base、异步身份及200错误信封误放行；代理只认明确204。公网显示 RC2 UP、刷新/重进通过；未登录及普通员工登录均拒绝。系统工具为真实落地页，既有缓存/在线用户入口及刷新通过。部门变更暴露的 API302→HTML200 已修为真实401，普通员工能进入现有重新登录流程。

本轮最初构建员工/管理网页及 Java/监控，v7只补Host401处理，其他产物按manifest复用v6，23条迁移（新增0022/0023），原21hash和原生镜像不变。完整新员工办公/业务查询复用未变产物的真实证据；v7再验身份、部门、隔离、文件版本、test1001模型和管理入口。私有证据 `.codex/employee-inheritance/acceptance-report.md`；未跑全历史/桌面/压测。Core1/启动1/闲120秒/等180秒保持。

收口：Core0，可用内存5.04GiB、磁盘余5.07GiB；Host/RC2/monitor/拼豆/Caddy active，两入口及拼豆正常TLS200、ops-check200。最新一致备份 `20261023T125542688920Z.tar.gz`（751867057字节），2份合计1503902195字节；原768MiB/2GiB/最低2GiB预算不变。历史隔离恢复证据复用，未再次生产还原。

## 2026-10-23 真实外部查询与配置修复

管理员入口：[AI资源管理 → 外部数据连接](https://zhenwork-admin.shizibandu.icu/admin/workspace-resources/connections)。连接目录决定测试/生产环境和只读地址；业务单位为必填本地标签。凭据留空保留，明确清除才删除并停用。验证后核对国家平台返回的企业ID、名称、信用代码，勾选固定方法，创建/绑定查询专家，通过“共享”授员工、角色或部门VIEW/USE（专家与全部绑定连接一并授权）。员工在新任务的高级设置/助手入口选择已获授查询专家，无须API/token/模型配置。

- 国家平台：复用管理员真实生产凭据，entInfo实际身份已核对。24项官方只读方法中21项已真实成功调用。废物、贮存设施、管理计划、许可证、委外计划、联单、产生台账、运输单位及库存状态等有真实记录；页1/页2、日期过滤和台账单位等有实际证据。自行处置/经营设施、出库/待入库/接受未入库及小微列表本次成功但为空，不能写为有数据核对通过。二维码两项和小微转移仍缺实际二维码/子单位归属链，不构造假参数验收。
- 优废：11项原名全部通过真实HTTP200/code200核实并启用。8个聚合走data，entTend/areaCover/deliveryTend走dataList；严格空params。中继结果与独立直连接口逐项一致，包含实际来源、快照版本、月份、范围限制。重量单位、cooling定义、到期阈值、部分总数与统计范围未声明，明确未知，不把v解释为当天统计时刻，不猜生产地址或JWT刷新协议。
- 真实员工网页：普通账号选择后台发布的双源专家，完成单项、跨能力/跨源组合、连续追问、程序计算及五表Excel生成；实际接口审计对应员工身份。预览可切工作表，正常下载按钮取得与已验证文件相同字节；月度明细合计经程序核对，未将其当累计企业数。刷新/正常退出/本项目重启后文件SHA不变，原会话重新查询成功。
- 员工初次真实回归暴露v3运行端断点：Rc2Client.relayMcp引用未声明会话参数，Host转发又遗漏该参数。v4修复共享客户端/交互及后台转发链；保留受控会话路由、身份复核及资源权限。旧“未取得数据”的会话属于失败证据，不能因其生成了说明文件或HTTP成功而标记业务通过。
- 连接交互真实通过：新建/编辑环境切换、地址只读、必填、保存重开、真实凭据留空保留、返回实际单位；历史环境地址不一致在上游前拒绝，单环境优废也可显式重新确认地址后保存。验证持久区分配置缺失/不一致、网络/TLS/超时、上游码与说明、通过；方法未就绪不再伪装鉴权失败。真实无效验收凭据返回业务码3000及说明；验收凭据已明确清除，临时连接停用。
- 权限与恢复：未授权第二员工两条连接的list/call共4次拒绝；员工已授连接停用403、撤权404、其它单位未授权404，恢复授权后真实查询成功。伪qyid在本地schema拒绝；台账ID服务端绑定。实际RC2/Host重启后两条真实连接完整DTO及默认模型逐字段保持，普通办公文件工具仍可执行。

私有证据入口：`.codex/external-connectors/followup/acceptance-report.md`；业务数据、账户及截图不进Git。接口映射见 `docs/external-query-mapping.md`。Java18项、Node资源/中继18项、Host受影响8项通过；一个扩查的Mac专用历史清理测试因要求Linux profile失败，不扩展修复，未作为业务通过证据。

## 2026-10-23 管理首页统计

真实浏览器与服务器日志确认：原统计CTE重复运行且取消浏览器后仍占用6个数据库连接，首页50秒等待骨架。仅取消已确认旧只读查询恢复池；改为一次有界物化扫描和聚合，数据库10秒上限，前端15秒、取消与竞态保护。

7/30/90天、直接打开/刷新/重新登录/快速切换真实网页通过，约0.3–0.5秒，统计与数据库独立记录一致。失败保留上次数据并可重试；空数据/503/超时/401的反馈用明确注入响应验证，未当真实业务数据。模型调用和Token来自真实中继回执，未知费用保留未知，不依赖Core或外部业务凭据。证据 `.codex/external-connectors/followup/stats-browser.json` 与 `followup-stats/report.md`。

## 2026-10-21 四项修复历史验收

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
- 上轮XLSX仅有下载fallback；2026-10-22已补齐当前版本基础内嵌预览，详见本轮记录。
- 代码检查按受影响范围执行：最新workbook 13项、解析器3项、read-document 6项及办公工具/交付定向用例通过，Host类型检查通过。重复运行不累计测试数量；未跑全历史、桌面或大规模压测。业务通过依据网页过程和实际文件，不是测试计数或HTTP200。

## 2026-10-22 网页办公更新

实现契约见 `docs/web-office-preview.md`；私有证据 `.codex/enterprise-delivery/business/20261022/acceptance-report.md`，不公开公司文件、账号、Cookie及密钥。

- XLSX内嵌切换工作表，基础合并/列宽/样式及支持公式的Decimal鲜算；Word/PPT正文表格分页，PDF/图片/文本沿私有预览路径。Office上限25MiB、每次1个转换、Linux子进程限额；失败/空/超限/未知格式均有反馈，原件仍可下载。未支持公式显示原式，复杂Office版式下载原件核对。
- 上传附件、会话成果和历史版本可预览；真实产物回执带下载/继续入口，部分交付保留逐文件失败。相同证据数据重试复用已验证成功文件，不重复覆盖；文本直接UTF-8存储并带版本/SHA回执。
- 新任务刷新默认配置后加载详情/Skill/MCP。修复共享SWR key被其它读取者占用造成发送永久禁用；独立企业目录保留刷新版本。补只读企业Skill当前USE/运行版本检查，避免模型猜CLI或扫旧缓存。
- 管理端Office/PDF/图片知识上传、10MiB限制、索引状态/失败原因和正确版本预览接通现有后端。独立完整Skill包脚本/模板实际执行v1/v2，停用/恢复/撤权进入真实Core。
- 修复原生Skill软删除残留：只清Host管理企业包及其暂存副本，目录描述符/不跟随符号链接，保留个人Skill、会话与业务文件；失败不遗忘待清理项。
- 真实网页：新普通员工上传/执行/三格式预览和浏览器实际下载、同名续改、刷新、历史恢复；受控真实写入失败→部分交付→只补Word，已有Excel SHA/mtime不变；新包v2实际用脚本与模板；知识原文版本/撤权均有证据。额外文本状态任务曾偏离并被网页取消，补通用状态/文本工具后仅3个工具完成，未新增无关PDF。旧失败保留，不能把取消当业务通过。
- 双浏览器额外复验了单Core容量：第二员工看到准备/等待页，第一员工正常退出后自动进入；旧身份401，会话/原件/预览/下载隔离保持，未提高并发。
- 原密码、自动语言、品牌配置、记忆/定时/用量架构保留；v8已通过且未受影响路径复用旧证据，没有再次全历史、桌面或压测。完整Host tsc的research.ts:137既有null推断问题仍在，未扩展修理；相关新增类型、renderer检查、定向用例及真实业务结果单独记录。

## 配置、身份与数据

- RC2 `office-defaults` 版本2；默认助手 `zhenwork-general-office`；默认模型 `3cdb425d-b8df-456c-b769-8abc5a66cd82` / `deepseek-v4-1-flash-261017`。保留原模型，企业默认通过组织引用生效、其他模型保留原授权；API密钥未变、价格未配置时费用未知。
- 完整报销能力包沿原资源权限发布 packageVersion6 / Skill2.2.6，保留21个配套文件；解析器SHA256：`f70f56c06e63a39e5e36bf5f80fca7faeced2b2a3dd4acb9431346269e8c08e0`。发布记录 `shared/config/office-publication-20261021.json`、模型变更前后记录 `shared/config/office-model-change-20261021.json`，root0600。
- 当前管理员由用户隐藏输入后保存于 `shared/config/qa-admin-current.json`，root0600，实际登录已验证；本轮未改密码。初始化 `shared/config/pilot-credentials.json` 不自动同步后续改密，不能当当前管理员密码。QA材料 `.codex/enterprise-delivery/qa-private.json` 为0600。完整口令、Cookie、令牌、密钥禁止进入日志/Git/交付文字。
- 后台重置固定临时值 `a123456`；首次自设/常规改密为8—16位ASCII字母数字且含两类。该密码流程、后台真实统计等前轮已验收功能保留，本轮不重置账号。
- 员工profile/workspace/会话：`shared/profiles`；上传：真实目录`shared/uploads`，`shared/config/uploads`仅受控链接；数据库`shared/data/postgres`，Redis`shared/data/redis`。更新不覆盖shared。

## 运行架构与资源

| 组件 | 启动与端口 | 配置/日志 |
| --- | --- | --- |
| Web Host | 非root `zhenwork-web.service`，127.0.0.1:18891 | shared/config/web.env；journalctl -u zhenwork-web |
| RuoYi/RC2 | zhenwork-rc2.service，127.0.0.1:18890 | shared/config/application-rc2.yml；shared/logs/rc2 |
| 服务监控 | zhenwork-monitor.service，127.0.0.1:18909 | 私有monitor.env/proxy.env；受保护/monitor/ |
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
# 当前inheritance-v7专用：只退应用/配置到已验证external-v4，保留23条迁移及业务数据；新功能会退回
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261023-inheritance-v7-to-external-v4.json'
```

当前回滚审核绑定v4/v2准确SHA、实际21条迁移及目标20条前缀。0021仅加法列与前置状态修正，回滚不退数据库；v2不含本轮优废实用方法/统计修复及会话参数修复，回退用于基础可用性恢复，不能称新查询能力仍保留。应用回滚不等于数据库/文件/授权回滚。未实际执行回滚、整机重启、down-v、全局prune或清理业务数据；新发布或迁移必须重新审核。

## 外部条件与未覆盖事项

- 仍需独立客户需求及对应真实验收依据，才能作真实客户符合性结论；本轮流程和证据不足处理已实测。
- 两套业务凭据均已在后台保存并真实联调，无须补新密钥。待补：国家平台真实设施/联单二维码及小微关联单位范围；优废重量单位、cooling/到期阈值等具体字段口径。真实共享目录仍未指定。
- 其余历史功能保留对应版本证据；本轮为上述定向回归，不代表全企业系统、所有文件格式或任意公式全量验收。

2026-10-22收口实测：Core0；可用内存约4.86GiB、磁盘空闲18.61GiB；Host约206MiB、Java约651MiB。拼豆HTTPS200、ops-check内部200，Caddy及账号中心active。本轮未操作其发布配置。最新一致性备份20261022T103506190160Z.tar.gz为749543218字节，保留2份合计1500061018字节；768MiB单包/2GiB总预算及2GiB最低空闲保持。

2026-10-23 v4收口实测（2026-10-23T07:19:10.783521+00:00）：Core0；系统MemAvailable 5.31GiB、盘空闲7.22GiB。Host/RC2/拼豆/Caddy/账号中心active、天墟healthy，拼豆及ops-check HTTP200。并发1/启动1/闲120秒/等待180秒保持。最新一致备份 `/srv/backups/config/20261023T070155150461Z.tar.gz`，750421284 bytes，保留2份共1499915270 bytes，原容量预算未改。没有对生产做恢复或数据库回滚。

### 2026-10-23 首页资源刷新定向修复

已在test1001真实网页复现：长模型输出过程中进入 `/#/guid`，旧首页两次POST资源刷新，Core正确判定任务活跃却被UI解释为配置缺失，助手目录拒绝且错误码漏插值。空闲路径可用，本轮未发现永久残留active的证据。修复将首页改为只读目录/状态，显式刷新忙时202排队、同员工并发复用，空闲15秒调度；保留真实任务和实时权限复核。只重建员工网页/Host，复用其他产物。发布及公网回归结果在本节后续记录。
