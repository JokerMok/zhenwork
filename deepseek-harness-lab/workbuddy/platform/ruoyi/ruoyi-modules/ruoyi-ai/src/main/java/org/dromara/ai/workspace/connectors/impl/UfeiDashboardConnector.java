package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.*;
import org.springframework.stereotype.Component;

import java.net.http.HttpClient;
import java.time.Clock;
import java.util.*;

import static org.dromara.ai.workspace.connectors.impl.ConnectorSchemas.*;

/** Fixed read contracts verified against credential-scoped upstream responses on 2026-10-23. */
@Component
public final class UfeiDashboardConnector implements ExternalQueryConnector {
    private static final String TEST_BASE = "https://dev-aiapi.ufei.center";
    private static final Set<String> HOSTS = Set.of("dev-aiapi.ufei.center");
    private final HttpClient client;
    private final Clock clock;
    private final ConnectorCatalog catalog = buildCatalog();

    public UfeiDashboardConnector() { this(ConnectorHttp.client(), Clock.systemUTC()); }
    UfeiDashboardConnector(HttpClient client, Clock clock) { this.client=client;this.clock=clock; }
    @Override public ConnectorType type() { return ConnectorType.UFEI_DASHBOARD; }
    @Override public ConnectorCatalog catalog() { return catalog; }

    @Override public ConnectorValidationResult validate(String baseUrl, ConnectorCredential credential) {
        try {
            var result=query(baseUrl,credential,"entSummary",Map.of());
            return new ConnectorValidationResult(true,"VALID",
                "已通过 /biz-api/sql/data 的 entSummary 固定只读查询验证凭据（HTTP 200、业务码 200）；该接口不返回凭据所属企业身份，业务单位仅为本地标签",
                result.metadata());
        } catch(ConnectorException e) { return new ConnectorValidationResult(false,e.code,e.getMessage(),Map.of("method","entSummary")); }
    }

    @Override public ConnectorQueryResult query(String baseUrl, ConnectorCredential credential, String method, Map<String,Object> params) {
        ConnectorMethod contract=catalog.methods().stream().filter(m->m.name().equals(method)).findFirst()
            .orElseThrow(()->new ConnectorException(400,"ConnectorMethodNotSupported","未登记的优废固定查询"));
        ConnectorSchemas.validate(contract,params);
        if(credential==null||credential.token()==null||credential.token().isBlank()||credential.token().length()>4096)
            throw new ConnectorException(400,"ConnectorCredentialInvalid","尚未配置优废访问凭据");
        var endpoint=ConnectorHttp.endpoint(baseUrl,"",contract.path(),HOSTS);
        var response=ConnectorHttp.post(client,endpoint,Map.of("Authorization",credential.token()),
            Map.of("type","hwDashboardSql","method",method,"params",Map.of()));
        String code=Objects.toString(response.get("code"),"");
        if(!"200".equals(code)) {
            String message=Objects.toString(response.getOrDefault("message",response.getOrDefault("msg","上游业务拒绝查询")));
            message=message.replace(credential.token(),"[REDACTED]").replaceAll("[\\r\\n\\t]"," ");
            throw new ConnectorException(502,code.matches("[0-9]{1,8}")?"UfeiBusinessCode"+code:"ConnectorBusinessRejected",message.substring(0,Math.min(200,message.length())));
        }
        if(!response.containsKey("data")) throw new ConnectorException(502,"ConnectorResponseInvalid","优废成功响应缺少 data 字段");
        Object data=ConnectorHttp.parseNestedJson(response.get("data"));
        boolean list=contract.path().endsWith("dataList");
        if(data!=null && !(list?data instanceof List<?>:data instanceof Map<?,?>))
            throw new ConnectorException(502,"ConnectorResponseInvalid","优废返回结构与当前固定方法合同不一致");
        Object clean=CswmIotConnector.sanitize(data,credential.token());
        var metadata=new LinkedHashMap<String,Object>();
        metadata.put("connector",type().name());metadata.put("method",method);metadata.put("upstreamPath",contract.path());
        metadata.put("httpStatus",200);metadata.put("businessCode",code);metadata.put("queriedAt",clock.instant().toString());
        metadata.put("environment",baseUrl.startsWith(TEST_BASE)?"TEST":"LOCAL_TEST");metadata.put("complete",true);
        metadata.put("scopeWarning","固定大屏统计，不支持任意企业或日期筛选；查询时间不等于数据统计时间。重量单位及未明示统计口径不得推断。");
        var rows=clean instanceof List<?> values?values:clean instanceof Map<?,?> value?List.of(value):List.of();
        metadata.put("empty",rows.isEmpty());
        var versions=new TreeSet<String>();var dates=new TreeSet<String>();
        for(Object row:rows) if(row instanceof Map<?,?> value) {
            if(value.get("v")!=null) versions.add(value.get("v").toString());
            if(value.get("dateAt") instanceof String date && date.matches("[0-9]{4}-[0-9]{2}")) dates.add(date);
        }
        if(!versions.isEmpty()) metadata.put("sourceVersions",versions);
        if(!dates.isEmpty()) metadata.put("sourcePeriod",Map.of("from",dates.first(),"to",dates.last(),"granularity","MONTH"));
        return new ConnectorQueryResult(clean,Map.copyOf(metadata));
    }

    private static ConnectorCatalog buildCatalog() {
        var methods=new ArrayList<ConnectorMethod>();
        methods.add(method("dealerData","经营单位重量数据",false,fields("sumWeight","上游汇总重量，不能推断为其它字段之和","inWeight","入库重量","outWeight","出库重量","useWeight","利用处置重量"),true));
        methods.add(method("companyData","产废企业重量数据",false,fields("sumWeight","上游汇总重量，不能推断为其它字段之和","inWeight","入库重量","outWeight","出库重量","useWeight","利用处置重量","transWeight","转移重量"),true));
        methods.add(method("entSummary","企业数量汇总",false,fields("companyCount","产废企业数量","dealerCount","经营单位数量","totalCount","上游总数字段，口径未声明，不能认定为前两项之和"),false));
        methods.add(method("entTend","企业数量月度趋势",true,fields("dateAt","统计月份 yyyy-MM","count","对应月份上游数量"),false));
        methods.add(method("deviceSummary","设备数量汇总",false,fields("v0Count","V0 设备数量","a3Count","A3 设备数量","count","设备总数字段"),false));
        methods.add(method("mgrCat","管理类别分布",false,fields("importantCount","重点管理数量","registrationCount","登记管理数量","simpleCount","简化管理数量"),false));
        methods.add(method("onlineTime","在网时长分布",false,fields("less1Year","上游不足一年分组数量","more1less2Year","上游一年至两年分组数量","more2Year","上游超过两年分组数量"),false));
        methods.add(method("areaCover","地区覆盖分布",true,fields("province","省份","city","城市","count","对应地区数量"),false));
        methods.add(method("deliveryTend","月度重量趋势",true,fields("dateAt","统计月份 yyyy-MM","weight","对应月份重量"),true));
        methods.add(method("ledgerSummary","台账数量汇总",false,fields("count","台账数量"),false));
        methods.add(method("warnNotice","预警关注",false,fields("expiredCount","上游已过期数量","nextExpiredCount","上游即将过期数量，阈值未声明","cooling","上游 cooling 数量，具体定义待确认","offline","上游离线数量","syncError","上游同步错误数量","noDataCount","上游无数据数量"),false));
        return new ConnectorCatalog(ConnectorType.UFEI_DASHBOARD,"优废数据大屏",List.of(new ConnectorCatalog.Environment("TEST",TEST_BASE,false)),List.copyOf(methods));
    }
    private static ConnectorMethod method(String name,String title,boolean list,Map<String,String> fields,boolean weight) {
        var mapped=new LinkedHashMap<>(fields);mapped.put("v","上游快照/版本标记，未经合同确认不解释为统计时间");
        return new ConnectorMethod(name,title,"/biz-api/sql/"+(list?"dataList":"data"),true,object(Map.of()),list?array(title):anyObject(title),Map.copyOf(mapped),
            weight?"重量单位未在实际响应或可用资料声明，保留原始值，不得默认吨或公斤":"数量按上游原值；各指标口径不同，不可任意相加",
            list&& !"areaCover".equals(name)?"dateAt 为上游实际返回月份；仅这些月份，不支持自选日期":"固定大屏快照，统计起止时间未声明；v 是原始版本标记",
            "2026-10-23 真实凭据只读核实 HTTP 200 / code 200，JSON 字符串已规范化；固定空 params，不提供任意企业、日期或 SQL 参数", "VERIFIED");
    }
}
