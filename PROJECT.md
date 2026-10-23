# ZhenWork 腾讯云网页维护

核对日期：2026-10-23。当前范围：企业外部连接管理、只读 MCP 与查询专家；本轮配置与隔离回归通过，真实上游业务查询仍受凭据/合同阻塞。不制作桌面安装包。

## 当前发布与访问

- 员工：[ZhenWork](https://zhenwork.shizibandu.icu/)；后台：[管理端](https://zhenwork-admin.shizibandu.icu/admin/)。两入口已由 Mac 直连实际公网 IP、正常 TLS 校验并获得 HTTP200；不是仅内部可用。
- 激活 release：`20261023-external-query-v2`；准确应用 SHA：`0c408c209f2ceb1df525c7d436754b7cfd5b6ef4`；平台 `linux/amd64`。本文件之后的纯维护文档提交不会重建应用，不能把文档 HEAD 当作实际应用 SHA。
- 基线 `20261020-office-diagnostics` 对应 `1b601eea104668b684f1aba57a46e3fa2940a672`；其后 `3c8b36f1b82aa78d5e08663c01c25957e6030cc8` 只更新 PROJECT.md 和 deploy/tencent/README.md。两者不同不表示部署错误。
- 本轮重建employee/Admin网页、Host与Java；保留精确amd64原生镜像。迁移链20条，新增0020外部连接/调用表与管理菜单，原19条校验和不变。`current/RELEASE.json`、`SHA256SUMS`、`VERIFIED.json` 保存来源、完整镜像及实际验收范围；私有配置和业务数据在 release 外。
- Core：`sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0`；Gateway：`sha256:81dfa364e6bda9b8383dcb17fda523ccb95a9c583ec3371333a40a83ff937217`。Core binary：`a43e0efe7406762813ccb12c766ff77c720b9c7993df3441efd7485cb7ac5f07`；其余镜像与锁以 manifest 为准。本轮没有上传 Mac 原生二进制或重建 Rust。

## 2026-10-23 外部数据连接

管理员入口：管理后台“AI 资源管理 → 外部数据连接”，路径 `/admin/workspace-resources/connections`。说明见 `docs/external-connections.md`，逐接口映射见 `docs/external-query-mapping.md`。私有实际证据：`.codex/external-connectors/acceptance-report.md`。

- 已实现：实际业务单位/环境/固定地址/方法白名单、AES-GCM加密凭据、留空保留/明确清除、验证时间与安全失败原因、启停、既有USER/ROLE/DEPARTMENT资源授权、独立MCP及最多8个连接的查询专家绑定、无原始参数/结果的调用元数据审计。凭据不进入助手、模型或资源包；只读调用在返回前再次复核身份和权限。
- 国家平台：24项官方只读方法，SM4/SM3、空对象加密、数字/字符串1000、字段/单位/分页/日期范围校验已实现并经定向协议测试；台账企业ID由服务端注入。企业身份须用entInfo核对名称/ID/信用代码。**尚无真实物联网凭据，真实单位验证、员工单项/组合/追问及成果生成未验收**。小微目标企业仍受当前单位边界限制，不能据目录存在就宣称已开放跨单位查询。
- 优废：11项原拼写登记，采用本次已确认的 `/biz-api/sql/data|dataList`、JSON POST及无Bearer的JWT头定义。受保护Swagger均401、本地工作流无逐方法依据；具体端点映射、参数、返回口径及业务成功码未核实，全部UNVERIFIED/不可调用。**优废实际查询尚未实现开放**，不将目录或占位配置说成成功接入。
- 真实网页通过：后台创建两类停用待配置项、保存、无凭据/格式错误的持久反馈、留空更新密文不变、显式清除后无凭据且停用、版本冲突、独立MCP页面授权/撤回。服务端拒绝非管理员、无授权、撤权及停用调用。实际服务重启后配置/默认模型逐字段保留；普通员工在存在不可用外部资源时登录、新建空白任务、默认模型流式响应/持久化及退出旧身份401通过。
- 真实外部业务查询与专家多源回答：BLOCKED，未用合成结果替代。两条“待配置”记录均停用、无凭据、QA共享已撤回；原模型、助手、办公资料、品牌及自动语言保留。
- 新增配置表随既有DB一致性备份，沿用数据库外的原主密钥；无需新增MCP进程或公网端口。最新备份和资源实测见当前VERIFIED与两端SERVER记录。

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

- RC2 `office-defaults` 版本2；默认助手 `zhenwork-general-office`；默认模型 `3cdb425d-b8df-456c-b769-8abc5a66cd82` / `deepseek-v4-1-flash-261017`。保留原模型，仅复制仍有效的原授权；API密钥未变、价格未配置时费用未知。
- 完整报销能力包沿原资源权限发布 packageVersion6 / Skill2.2.6，保留21个配套文件；解析器SHA256：`f70f56c06e63a39e5e36bf5f80fca7faeced2b2a3dd4acb9431346269e8c08e0`。发布记录 `shared/config/office-publication-20261021.json`、模型变更前后记录 `shared/config/office-model-change-20261021.json`，root0600。
- 当前管理员由用户隐藏输入后保存于 `shared/config/qa-admin-current.json`，root0600，实际登录已验证；本轮未改密码。初始化 `shared/config/pilot-credentials.json` 不自动同步后续改密，不能当当前管理员密码。QA材料 `.codex/enterprise-delivery/qa-private.json` 为0600。完整口令、Cookie、令牌、密钥禁止进入日志/Git/交付文字。
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
# 当前external-query-v2专用：只退应用/配置到已验证v16，保留20条数据库迁移、文件及授权
ssh tencent-main 'sudo bash /srv/apps/zhenwork/deploy/manage.sh rollback /srv/apps/zhenwork/shared/config/rollback-reviews/20261023-external-v2-to-web-office-v16.json'
```

当前回滚审核绑定v2/v16准确SHA、实际20条迁移及目标19条前缀。v16不提供新外部查询API和页面，不能把回退应用当成撤销连接配置。应用回滚不等于数据库回滚，也不回退数据库中的默认模型/Skill发布；这些通过管理后台单独版本回退。原默认模型与历史能力包仍保留。没有实际执行应用/数据库回滚、整机重启、down -v、全局prune或清理业务数据。后续新发布/迁移会使本次审核失效。

## 外部条件与未覆盖事项

- 仍需独立客户需求及对应真实验收依据，才能作真实客户符合性结论；本轮流程和证据不足处理已实测。
- 当前已指定优废与国家平台接口；缺各自真实业务凭据及优废逐方法合同，详见2026-10-23记录。真实共享目录尚未指定。无须在聊天提供任何密钥。
- 其余历史功能保留对应版本证据；本轮为上述定向回归，不代表全企业系统、所有文件格式或任意公式全量验收。

2026-10-22收口实测：Core0；可用内存约4.86GiB、磁盘空闲18.61GiB；Host约206MiB、Java约651MiB。拼豆HTTPS200、ops-check内部200，Caddy及账号中心active。本轮未操作其发布配置。最新一致性备份20261022T103506190160Z.tar.gz为749543218字节，保留2份合计1500061018字节；768MiB单包/2GiB总预算及2GiB最低空闲保持。
