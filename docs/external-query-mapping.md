# 外部只读查询映射

本文记录 ZhenWork 当前可审计的外部查询契约。运行时只接受目录中的方法名和参数，路径由适配器固定拼接；工具调用不能传 URL、HTTP 方法、SQL 或未登记参数。

## 统一返回与错误边界

`ConnectorQueryResult` 将上游业务数据放在 `data`，将 `connector`、`method`、`upstreamPath`、`httpStatus`、`businessCode`、`queriedAt`、`environment`、`complete` 放在 `metadata`。固定 10 条一页的接口还会返回 `pagination=UPSTREAM_FIXED_PAGE_SIZE_10`，且 `complete=false`，防止把单页结果表述成全量。

适配器连接超时 5 秒、读取超时 20 秒、禁止重定向，响应上限 512 KiB。HTTP 错误、非 JSON、超限响应和业务失败只返回有界错误，不回传上游响应体。响应中的凭据字段和凭据字面值会递归移除或替换。

## CSWM_IOT

官方来源：

- [接口目录](https://docs.cswm.org.cn/iot/)
- [加密传输说明](https://docs.cswm.org.cn/iot/sjjm.html)
- [接口地址说明](https://docs.cswm.org.cn/iot/jkdz.html)
- 各方法的字段、长度、必填项和错误码来自目录中对应页面，例如 [单位信息](https://docs.cswm.org.cn/iot/base/enterprise.html)、[库存状态](https://docs.cswm.org.cn/iot/base/kczt.html)、[联单查询](https://docs.cswm.org.cn/iot/zyld/ldcx.html)、[台账查询](https://docs.cswm.org.cn/iot/tz/tzcx.html)。

允许的 base URL 只有：

- 测试：`https://test-iotapi.cswm.org.cn/iot-server`
- 正式：`https://iotapi.cswm.org.cn/iot-server`

请求体始终包含 `data`、`nonce`、`timestamp`、`sign`。`data` 使用 `new SM4(HexUtil.decodeHex(token)).encryptHex(JSON)`；空入参也加密 `{}`。签名原文固定为 `data={data}&nonce={nonce}&timestamp={seconds}`，使用 SM3 后转大写，Header 传 `token`。实际锁定的 Hutool 5.8.47/BC 实现与独立 OpenSSL 的 SM4-ECB/PKCS#7 测试向量一致；明文采用 UTF-8，密文为小写十六进制。响应不解密。只有 HTTP 200 且 `code` 的数字或字符串表示为 `1000` 才算成功。

管理员验证固定调用 `entInfo`。业务单位为必填本地显示标签，不作为上游鉴权参数，也不据其名称认定凭据归属；验证以凭据实际返回的 `qyid` 绑定运行时，并展示 `dwmc` 与 `tyshxydm` 供管理员核对。验证结果只保存 `matched`、`enterpriseId`、`name`、`creditCode`、`verifiedAt` 和环境，不保存 token、原始响应或单位的联系人、地址等其他字段。运行查询时使用验证得到的 `enterpriseId` 作为身份边界；`ledger.qyid` 由 MCP 服务端注入已验证企业 ID，不向模型开放该参数；适配器仍校验其精确一致。小微查询中的目标企业 ID 仍受当前已验证单位边界限制，不据此宣称已开放跨单位查询。

### 方法目录

| 方法 | 固定路径 | 严格入参 | 主要返回字段与单位 | 时间、范围与分页 |
|---|---|---|---|---|
| `entInfo` | `/iot/entInfo` | 无 | `qyid` 企业 ID、`dwmc` 单位名、`tyshxydm` 信用代码、行政区划、状态、单位类型 | 查询时点主数据 |
| `listWasteInfo` | `/iot/listWasteInfo` | 无 | 废物统一编号、名称、代码、形态、特性；容器容量；计量单位由 `jldw` 给出 | 当前年度管理计划已关联数据 |
| `listStorageInfo` | `/iot/listStorageInfo` | 无 | 设施编号、名称、经纬度、设施大小、贮存能力、状态；大小和能力的单位官方页未声明 | 查询时点主数据 |
| `listProductionInfo` | `/iot/listProductionInfo` | 无 | 设施、废物、预计产生量 `yjcsl`，单位 `jldw` | 当年生效管理计划 |
| `listDispositionInfo` | `/iot/listDispositionInfo` | 无 | 自行利用处置设施、废物、利用处置方式 | 当年生效管理计划 |
| `listDispositionOutInfo` | `/iot/listDispositionOutInfo` | 无 | 经营单位利用处置设施、状态、利用处置方式 | 查询时点主数据 |
| `listDictionary` | `/iot/listDictionary` | 必填 `zdbm`，只允许官方列出的 19 个字典编码 | `zdxbm` 字典项编码、`zdxz` 字典项值 | 查询时点 |
| `getCurrentTime` | `/iot/getCurrentTime` | 无 | `dqsj` 当前时间；官方页未声明格式 | 国家平台申报时间 |
| `listOwnLicence` | `/iot/listOwnLicence` | 必填 `dqys`；可选 `xkzbh`，最长 100 | 许可证、有效期、设施、核准量 `nhzl` 与 `jldw` | 固定 10 条一页，仅请求页 |
| `listReceiveWaitInRecord` | `/iot/listReceiveWaitInRecord` | 必填 `ldbh` 最长 36、`dqys` | 数字识别码、废物、接受量 `jsl` 与 `jldw` | 当前未入库状态；固定 10 条一页 |
| `getInventoryStatusByBatchCode` | `/iot/getInventoryStatusByBatchCode` | 必填 `szsbm`，最长 50 | `kczt`，字典 `PARCEL_STATUS_TYPE` | 查询时点实时库存状态 |
| `getFacilityInfoByQrCode` | `/iot/getFacilityInfoByQrCode` | 必填 `ssewm`，最长 100 | 设施编号、编码、名称、状态、类型、处置方式 | 查询时点 |
| `listOutStorageInventory` | `/iot/listOutStorageInventory` | 必填 `dqys`；可选 `fwdm`、`ckqx`；`ckqx` 仅 `zxlycz/lycz/wwlycz` | 数字识别码、废物、重量 `zl` 与 `jldw`、去向 | 当前出库区；固定 10 条一页 |
| `listWaitInStorageInventory` | `/iot/listWaitInStorageInventory` | 必填 `dqys`；可选 `fwdm`、`sjly`；`sjly` 仅 `prodWaitIn/backWaitIn` | 数字识别码、废物、重量 `zl` 与 `jldw`、数据来源 | 当前待入库；固定 10 条一页 |
| `listLicence` | `/iot/listLicence` | 必填 `jydwmc`，2–300 字；可选许可证、废物名/代码 | 经营单位、许可证、委托利用数组、预计转移量；此页未声明数量单位 | 当年生效管理计划 |
| `listToOthers` | `/iot/listToOthers` | 必填 `dqys`；可选经营单位、许可证、废物名/代码 | 经营单位、拟转移废物数组、预计转移量；此页未声明数量单位 | 当年生效计划；固定 10 条一页 |
| `listCollectToOthers` | `/iot/listCollectToOthers` | 同 `listToOthers` | 收集后委外转移计划；此页未声明数量单位 | 当年生效计划；固定 10 条一页 |
| `listTransport` | `/iot/listTransport` | 必填 `ysdwmc`，2–200 字，精确查询 | 运输企业、信用代码、地址、道路运输许可证 | 查询时点主数据 |
| `listManifest` | `/iot/listManifest` | 必填 `dqys`；可选联单编号/状态/类型、移出/运输单位、操作起止时间；时间格式 `yyyy-MM-dd HH:mm:ss` | 联单主体、废物数组、运输单位数组；数量使用各记录 `jldw` | 操作时间过滤；固定 10 条一页 |
| `getManifestNoByQrCode` | `/iot/getManifestNoByQrCode` | 必填 `zyldewm`，最长 100 | `ldbh` 联单编号 | 查询时点 |
| `listKsycsq` | `/iot/listKsycsq` | 可选 `sqrq`（`yyyy-MM-dd`）、`kszysqbh` 最长 50 | 商请主体、危险废物及附件数组；废物量使用 `jldw`，附件 `wjdx` 为字节 | 官方页未声明分页 |
| `ledger` | `/iot/ledger` | 必填 `qyid`、`lx`、`dqys`；业务日期或操作日期至少完整一组，日期为 `yyyy-MM-dd`，每组不超过一个月；可选设备号、数字识别码；`lx` 只允许官方 24 个编码 | 产生、入库、处置、委外、接受、调整、撤销、联单、移库等台账；数量使用各记录 `jldw` | 业务或操作日期；固定 10 条一页 |
| `listMicroEnt` | `/iot/listMicroEnt` | 必填 `dqys`；可选单位名最长 100 | 小微单位、联系人、绑定状态 | 查询时点；固定 10 条一页 |
| `listMicroTrans` | `/iot/listMicroTrans` | 必填小微单位 `qyid`，最长 50 | 小微转移废物、许可证、处置方式、容器信息与 `jldw` | 查询时点 |

`ledger` 的 `lx` 白名单为：`cs`、`rk`、`zxlycz`、`wwlycz`、`jsrk`、`lclq`、`lycz`、`tz`、`csc`、`rkc`、`zxlyczc`、`wwlyczc`、`jsrkc`、`lclqc`、`lyczc`、`ldjs`、`cshrk`、`cshrkc`、`ldth`、`ldthrk`、`lclz`、`lclzc`、`ykr`、`ykc`。

目录没有收录产生、入库、出库、处置、撤销、调整、标签打印、联单填领或办结等写接口。

## UFEI_DASHBOARD

可核实来源：

- [开发 Swagger 入口](https://dev-aiapi.ufei.center/swagger-ui/index.html#/)
- 当前对接契约确认 JSON POST 查询端点为 `/biz-api/sql/data`（对象）与 `/biz-api/sql/dataList`（列表），Header `Authorization` 直接传 JWT、不加 `Bearer`，请求体为 `method`、`params`、`type`，且 `type` 固定为 `hwDashboardSql`。本地旧后台文档中的 `/admin/commonSql/*` 仅作为旧版资料，不用于当前适配器。

2026-10-23 使用管理员已保存凭据进行只读联调，11 个固定方法均实际返回 HTTP 200、业务码 `200`、message `操作成功`。成功码取自真实调用而非 Swagger 占位示例；不接受 `0` 或国家平台的 `1000`。两类路由均进行了有界只读核实：聚合项选 `data`，趋势与地区分布选 `dataList`，避免把对象接口的首条记录误作完整趋势。所有方法使用固定 `type=hwDashboardSql`、空 `params={}`，严格空参数 schema；不提供任意企业、时间、SQL 或 URL。

受保护 OpenAPI 在传相同 JWT 时仍返回 401，不影响已由真实固定查询确认的合同。定向检索本地 Coze 工作流/旧后台资料没有找到这些方法的原节点；不将缺失节点当成停止真实只读验证的理由。以下映射依据真实响应形状。业务字段中仍未确认的定义保留明确限制，不猜测单位或统计范围。

| 方法 | 路径后缀 | 实际返回字段 | 范围与限制 |
|---|---|---|---|
| `dealerData` | `data` | sumWeight、inWeight、outWeight、useWeight、v | 经营单位重量快照；重量单位、sumWeight 与明细关系未声明 |
| `companyData` | `data` | sumWeight、inWeight、outWeight、useWeight、transWeight、v | 产废企业重量快照；重量单位和完整统计范围未声明 |
| `entSummary` | `data` | companyCount、dealerCount、totalCount、v | 三项原值口径不同；不能认定 totalCount 等于前两项之和 |
| `entTend` | `dataList` | dateAt、count、v | 实际返回月份，按月；不支持自选日期 |
| `deviceSummary` | `data` | v0Count、a3Count、count、v | V0/A3 与总数量原值 |
| `mgrCat` | `data` | importantCount、registrationCount、simpleCount、v | 管理类别分布 |
| `onlineTime` | `data` | less1Year、more1less2Year、more2Year、v | 上游时长分组；临界值开闭口径未声明 |
| `areaCover` | `dataList` | province、city、count、v | 完整省市分布列表，不能只取第一项 |
| `deliveryTend` | `dataList` | dateAt、weight、v | 实际月份重量趋势；重量单位未声明 |
| `ledgerSummary` | `data` | count、v | 台账数量快照，统计起止时间未声明 |
| `warnNotice` | `data` | expiredCount、nextExpiredCount、cooling、offline、syncError、noDataCount、v | 预警原值；cooling 具体定义、到期阈值未声明 |

实际 JSON 字符串编码最多解析两层；严格校验对象/列表形状。统一 source 带原始版本 `sourceVersions`，趋势带实际 `sourcePeriod`、月粒度。`queriedAt` 只表示本次查询时刻；`v` 未经明确合同不解释为统计时间，不能将快照声称为今天/实时数据。重量单位未确认时必须标为未知，不擅自使用吨或公斤。

这 11 项目录合同已就绪，连接仍须独立完成凭据验证、勾选允许方法及员工授权。优废验证调用 `entSummary`，验证的是凭据可执行该固定查询；接口不返回企业鉴权主体，不能凭本地业务单位名称声称已核对优废凭据所属企业。仍仅开放已确认测试地址；无可靠刷新协议，不实现猜测式登录/自动续期。

## 本轮实际联调边界

国家平台生产 entInfo 返回实际企业身份。已成功取得废物、设施、管理计划、许可证、联单、台账等真实记录；部分处置、库存及小微列表为空，须列为调用成功无数据。按页请求和日期过滤分别验证；分页的 total 与当前页条数分开，不把当前页当全量。二维码查询仍需要真实设施/联单二维码，小微下属单位查询需要已授权的真实子单位及受控归属链，不用构造参数假称业务验收通过。

真实业务记录和截图只保存在部署方私有验收目录，不进入 Git。网页专家查询、文件、权限和部署结果另见本轮维护记录；协议与定向测试不替代网页验收。
