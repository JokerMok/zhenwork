package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.ConnectorCatalog;

import org.dromara.ai.workspace.connectors.ConnectorMethod;
import org.dromara.ai.workspace.connectors.ConnectorType;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.dromara.ai.workspace.connectors.impl.ConnectorSchemas.*;

final class CswmCatalog {
    static final String TEST_BASE = "https://test-iotapi.cswm.org.cn/iot-server";
    static final String PRODUCTION_BASE = "https://iotapi.cswm.org.cn/iot-server";

    private CswmCatalog() {
    }

    static ConnectorCatalog catalog() {
        var methods = new ArrayList<ConnectorMethod>();
        methods.add(method("entInfo", "单位信息查询", "/iot/entInfo", object(Map.of()), anyObject("单位信息"),
            fields("qyid", "企业ID", "dwmc", "单位名称", "tyshxydm", "统一社会信用代码", "xzqh", "行政区划", "xxdz", "详细地址", "jd", "经度", "wd", "纬度", "gllb", "管理类别", "zt", "状态", "dwlx", "单位类型"), "无统一计量单位", "查询时点的单位主数据"));
        methods.add(method("listWasteInfo", "废物信息查询", "/iot/listWasteInfo", object(Map.of()), array("废物信息"),
            fields("cfxxtybh", "产废信息统一编号", "fwmc", "废物名称", "fwlx", "废物类型", "fwdm", "废物代码", "fwxt", "废物形态", "zycf", "主要成分", "yhcf", "有害成分", "wxtx", "危险特性", "jldw", "计量单位", "rqlx", "容器类型", "rqrl", "容器容量", "zt", "状态"), "jldw 由上游逐项返回；rqrl 为容器容量", "当前年度管理计划已关联的废物主数据"));
        methods.add(method("listStorageInfo", "贮存设施信息查询", "/iot/listStorageInfo", object(Map.of()), array("贮存设施信息"),
            fields("zcsstybh", "贮存设施统一编号", "ssmc", "设施名称", "ssbm", "设施编码", "sszxjd", "设施中心经度", "sszxwd", "设施中心纬度", "sslx", "设施类型", "fzr", "负责人", "lxdh", "联系电话", "ssdx", "设施大小", "zcnl", "贮存能力", "ssdz", "设施地址", "zt", "状态"), "设施大小、贮存能力的单位由上游数据定义，文档未给定", "查询时点的设施主数据"));
        methods.add(method("listProductionInfo", "管理计划产生信息查询", "/iot/listProductionInfo", object(Map.of()), array("管理计划产生信息"),
            fields("cfsstybh", "产废设施统一编号", "ssmc", "设施名称", "ssbm", "设施编码", "sszt", "设施状态", "cfxxtybh", "产废信息统一编号", "fwmc", "废物名称", "fwdm", "废物代码", "yjcsl", "预计产生量", "jldw", "计量单位"), "yjcsl 使用同记录 jldw", "本单位当年生效管理计划"));
        methods.add(method("listDispositionInfo", "管理计划自行利用处置情况查询", "/iot/listDispositionInfo", object(Map.of()), array("自行利用处置信息"),
            fields("zxlyczsstybh", "自行利用处置设施统一编号", "ssmc", "设施名称", "ssbm", "设施编码", "sszt", "设施状态", "cfxxtybh", "产废信息统一编号", "fwmc", "废物名称", "fwdm", "废物代码", "lyczfs", "利用处置方式"), "无数量字段", "本单位当年生效管理计划"));
        methods.add(method("listDispositionOutInfo", "经营单位利用处置设施信息查询", "/iot/listDispositionOutInfo", object(Map.of()), array("经营单位利用处置设施"),
            fields("lyczsstybh", "利用处置设施统一编号", "ssmc", "设施名称", "ssbm", "设施编码", "sszt", "设施状态", "lyczfs", "利用处置方式"), "无数量字段", "查询时点的设施主数据"));
        methods.add(method("listDictionary", "字典信息查询", "/iot/listDictionary",
            object(properties("zdbm", enumString("字典编码", "MAN_CATEGORY", "WASTE_DISPOSE_MODE", "TRANSFER_TYPE", "STORAGE_ADJUSTED_REA", "RECEIVE_TYPE", "MANIFESTSTATUS", "PACKAGE_TYPE", "WASTE_PATTERN", "TRANS_MODE", "LICENCE_AUTH_TYPE", "LICENCE_TYPE", "LICENCE_OLD_STATUS", "CONTAINER_TYPE", "CONTAINER_MATERIAL", "CONTAINER_SIZE", "TRANSPORT_MODE", "PL_COLOR", "PARCEL_STATUS_TYPE", "WASTE_FEATURES")), "zdbm"), array("字典项"),
            fields("zdxbm", "字典项编码", "zdxz", "字典项值"), "无", "查询时点的字典值"));
        methods.add(method("getCurrentTime", "当前时间查询", "/iot/getCurrentTime", object(Map.of()), anyObject("全过程申报当前时间"),
            fields("dqsj", "当前时间"), "时间", "国家平台返回的申报当前时间；格式未在官方页面声明"));
        methods.add(method("listOwnLicence", "许可证信息查询", "/iot/listOwnLicence",
            object(properties("dqys", pageNumber(), "xkzbh", string("许可证编号，精确查询", 100)), "dqys"), page("许可证信息"),
            fields("xkzbh", "许可证编号", "xkzlx", "许可证类型", "fzjg", "发证机关", "jyfs", "经营方式", "yxqksrq", "有效期开始日期", "yxqjsrq", "有效期结束日期", "zt", "状态", "lyczsssz", "利用处置设施数组", "hzjylbsz", "核准经营类别数组", "nhzl", "年核准量", "jldw", "计量单位"), "nhzl 使用同记录 jldw", "许可证有效期字段为日期；每页固定 10 条，仅返回请求页"));
        methods.add(method("listReceiveWaitInRecord", "接受后未入库记录查询", "/iot/listReceiveWaitInRecord",
            object(properties("ldbh", string("联单编号，精确查询", 36), "dqys", pageNumber()), "ldbh", "dqys"), page("接受后未入库记录"),
            fields("szsbm", "数字识别码", "fwmc", "废物名称", "fwdm", "废物代码", "jsl", "接受量", "jldw", "计量单位"), "jsl 使用同记录 jldw", "当前未入库状态；每页固定 10 条，仅返回请求页"));
        methods.add(method("getInventoryStatusByBatchCode", "根据数字识别码获取库存状态", "/iot/getInventoryStatusByBatchCode",
            object(properties("szsbm", string("数字识别码，精确查询", 50)), "szsbm"), anyObject("库存状态"),
            fields("kczt", "库存状态，字典 PARCEL_STATUS_TYPE"), "无", "查询时点的实时库存状态"));
        methods.add(method("getFacilityInfoByQrCode", "根据设施二维码获取设施信息", "/iot/getFacilityInfoByQrCode",
            object(properties("ssewm", string("设施二维码", 100)), "ssewm"), anyObject("设施信息"),
            fields("sstybh", "设施统一编号", "ssbm", "设施编码", "ssmc", "设施名称", "sszt", "设施状态", "sslx", "设施类型", "lyczfs", "利用处置方式", "lyczfsmc", "利用处置方式名称"), "无", "查询时点的设施状态"));
        methods.add(method("listOutStorageInventory", "出库记录查询", "/iot/listOutStorageInventory",
            object(properties("dqys", pageNumber(), "fwdm", string("废物代码，精确查询", 10), "ckqx", enumString("出库去向", "zxlycz", "lycz", "wwlycz")), "dqys"), page("出库记录"),
            fields("szsbm", "数字识别码", "fwmc", "废物名称", "fwdm", "废物代码", "zl", "重量", "jldw", "计量单位", "qx", "去向"), "zl 使用同记录 jldw", "当前出库区记录；每页固定 10 条，仅返回请求页"));
        methods.add(method("listWaitInStorageInventory", "待入库记录查询", "/iot/listWaitInStorageInventory",
            object(properties("dqys", pageNumber(), "fwdm", string("废物代码，精确查询", 10), "sjly", enumString("数据来源", "prodWaitIn", "backWaitIn")), "dqys"), page("待入库记录"),
            fields("szsbm", "数字识别码", "fwmc", "废物名称", "fwdm", "废物代码", "zl", "重量", "jldw", "计量单位", "sjly", "数据来源"), "zl 使用同记录 jldw", "当前待入库状态；每页固定 10 条，仅返回请求页"));
        addPlanAndManifestMethods(methods);
        return new ConnectorCatalog(ConnectorType.CSWM_IOT, "全国危险废物全过程环境管理信息系统", List.of(
            new ConnectorCatalog.Environment("TEST", TEST_BASE, false),
            new ConnectorCatalog.Environment("PRODUCTION", PRODUCTION_BASE, true)
        ), List.copyOf(methods));
    }

    private static void addPlanAndManifestMethods(List<ConnectorMethod> methods) {
        methods.add(method("listLicence", "管理计划委外利用处置信息", "/iot/listLicence",
            object(properties("jydwmc", string("经营单位名称，至少 2 字，模糊查询", 300), "xkzbh", string("许可证编号", 100), "fwmc", string("废物名称", 50), "fwdm", string("废物代码", 10)), "jydwmc"), array("委外利用处置信息"),
            fields("jyqyid", "经营企业ID", "jydwmc", "经营单位名称", "xkzbh", "许可证编号", "lxr", "联系人", "lxrsj", "联系人手机", "wtlysz", "委托利用数组", "fwmc", "废物名称", "fwdm", "废物代码", "lyczfs", "利用处置方式", "yjzyl", "预计转移量"), "预计转移量的计量单位未在此页面声明", "本单位当年生效管理计划"));
        var toOthersInput = object(properties("dqys", pageNumber(), "jydwmc", string("经营单位名称，模糊查询", 300), "xkzbh", string("许可证编号", 100), "fwmc", string("废物名称", 50), "fwdm", string("废物代码", 10)), "dqys");
        var toOthersFields = fields("jyqyid", "经营企业ID", "jydwmc", "经营单位名称", "xkzbh", "许可证编号", "lxr", "联系人", "lxrsj", "联系人手机", "nzyfwsz", "拟转移废物数组", "cfxxtybh", "产废信息统一编号", "fwmc", "废物名称", "fwdm", "废物代码", "lyczfs", "利用处置方式", "yjzyl", "预计转移量");
        methods.add(method("listToOthers", "管理计划委外计划查询", "/iot/listToOthers", toOthersInput, page("委外计划"), toOthersFields, "预计转移量的计量单位未在此页面声明", "本单位当年生效管理计划；每页固定 10 条，仅返回请求页"));
        methods.add(method("listCollectToOthers", "管理计划收集后委外转移计划查询", "/iot/listCollectToOthers", toOthersInput, page("收集后委外转移计划"), toOthersFields, "预计转移量的计量单位未在此页面声明", "本单位当年生效管理计划；每页固定 10 条，仅返回请求页"));
        methods.add(method("listTransport", "运输单位信息查询", "/iot/listTransport",
            object(properties("ysdwmc", string("运输单位名称，至少 2 字，精确查询", 200)), "ysdwmc"), array("运输单位"),
            fields("ysqyid", "运输企业ID", "ysdwmc", "运输单位名称", "xzqh", "行政区划", "lxr", "联系人", "lxrsj", "联系人手机", "tyshxydm", "统一社会信用代码", "ysdwdz", "运输单位地址", "dlysjyxkzh", "道路运输经营许可证号"), "无", "查询时点的运输单位主数据"));
        methods.add(method("listManifest", "联单信息查询", "/iot/listManifest",
            object(properties("dqys", pageNumber(), "ldbh", string("联单编号，精确查询", 36), "ldzt", string("联单状态，字典 MANIFESTSTATUS", 3), "ldlx", string("联单类型，字典 TRANSFER_TYPE", 36), "ycdwmc", string("移出单位名称，模糊查询", 300), "ysdwmc", string("运输单位名称，模糊查询", 300), "czkssj", string("操作开始时间", 19, "date-time-seconds"), "czjssj", string("操作结束时间", 19, "date-time-seconds")), "dqys"), page("转移联单"),
            fields("ldbh", "联单编号", "ldlx", "联单类型", "ycdwqyid", "移出单位企业ID", "ycdwmc", "移出单位名称", "jsdwqyid", "接受单位企业ID", "jsdwmc", "接受单位名称", "wfycsj", "危废移出时间", "bjsj", "办结时间", "czsj", "操作时间", "ldzt", "联单状态", "fwsz", "废物数组", "ysdwsz", "运输单位数组"), "废物转移量/接受量使用各记录 jldw", "操作时间范围；每页固定 10 条，仅返回请求页"));
        methods.add(method("getManifestNoByQrCode", "根据转移联单二维码获取联单编号", "/iot/getManifestNoByQrCode",
            object(properties("zyldewm", string("转移联单二维码", 100)), "zyldewm"), anyObject("联单编号"), fields("ldbh", "联单编号"), "无", "查询时点"));
        methods.add(method("listKsycsq", "跨省移出商请查询", "/iot/listKsycsq",
            object(properties("sqrq", string("商请日期", 10, "date"), "kszysqbh", string("跨省转移商请编号，精确查询", 50))), array("跨省移出商请"),
            fields("kszysqbh", "跨省转移商请编号", "qyid", "企业ID", "ycdwmc", "移出单位名称", "jsdwmc", "接受单位名称", "zt", "商请状态", "sqrq", "商请日期", "ksrq", "开始日期", "jsrq", "结束日期", "fwsz", "危险废物数组", "sqfjsz", "申请附件数组", "hffjsz", "回复附件数组", "qrfjsz", "确认附件数组"), "废物数量使用各记录 jldw；附件大小 wjdx 为字节", "按商请日期过滤；官方接口未声明分页"));
        methods.add(method("ledger", "台账查询", "/iot/ledger",
            object(properties("wlwsbtybh", string("物联网设备统一编号", 50), "qyid", string("企业ID", 20), "ksrq", string("业务开始日期", 10, "date"), "jsrq", string("业务结束日期", 10, "date"), "czksrq", string("操作开始日期", 10, "date"), "czjsrq", string("操作结束日期", 10, "date"), "lx", enumString("台账类型", "cs", "rk", "zxlycz", "wwlycz", "jsrk", "lclq", "lycz", "tz", "csc", "rkc", "zxlyczc", "wwlyczc", "jsrkc", "lclqc", "lyczc", "ldjs", "cshrk", "cshrkc", "ldth", "ldthrk", "lclz", "lclzc", "ykr", "ykc"), "dqys", pageNumber(), "szsbm", string("数字识别码，精确查询", 50)), "qyid", "lx", "dqys"), anyObject("按 lx 命名的台账分页数据"),
            fields("total", "统计数", "cs", "产生台账", "rk", "入库台账", "zxlycz", "自行利用处置台账", "wwlycz", "委外利用处置台账", "jsrk", "接受入库台账", "lycz", "利用处置台账", "tz", "调整台账", "ldjs", "联单接受台账", "ldth", "联单退回台账", "ykr", "移库入台账", "ykc", "移库出台账", "jldw", "记录计量单位", "ywsj", "业务时间", "jssj", "结算时间", "czsj", "操作时间"), "数量字段使用各记录 jldw", "业务日期或操作日期必须提供完整一组，区间不超过一个月；每页固定 10 条，仅返回请求页"));
        methods.add(method("listMicroEnt", "小微单位信息查询", "/iot/listMicroEnt",
            object(properties("dqys", pageNumber(), "dwmc", string("单位名称，模糊查询", 100)), "dqys"), page("小微产废单位"), fields("qyid", "企业ID", "dwmc", "单位名称", "lxr", "联系人", "lxrsj", "联系人手机", "zt", "绑定状态"), "无", "查询时点；每页固定 10 条，仅返回请求页"));
        methods.add(method("listMicroTrans", "小微转移信息查询", "/iot/listMicroTrans",
            object(properties("qyid", string("小微单位企业ID", 50)), "qyid"), array("小微转移信息"), fields("dwmc", "小微产生单位名称", "xkzbh", "许可证编号", "lyczfs", "利用处置方式", "cfxxtybh", "产废信息统一编号", "fwmc", "废物名称", "fwdm", "废物代码", "fwlb", "废物类别", "fwxt", "废物形态", "jldw", "计量单位", "rqlx", "容器类型", "rqrl", "容器容量"), "jldw 为计量单位；rqrl 为容器容量", "查询时点"));
    }

    private static ConnectorMethod method(String name, String title, String path, Map<String, Object> input,
                                          Map<String, Object> output, Map<String, String> fields, String unit, String time) {
        return new ConnectorMethod(name, title, path, true, input, output, fields, unit, time,
            "测试与正式环境使用相同相对路径；baseUrl 必须包含 /iot-server", "VERIFIED");
    }
}
