package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.*;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.dromara.ai.workspace.connectors.impl.ConnectorSchemas.anyObject;
import static org.dromara.ai.workspace.connectors.impl.ConnectorSchemas.fields;
import static org.dromara.ai.workspace.connectors.impl.ConnectorSchemas.object;

/**
 * Explicit UFEI dashboard inventory. The upstream method contracts remain disabled until the
 * protected OpenAPI or a redacted successful request/response contract is supplied.
 */
@Component
public final class UfeiDashboardConnector implements ExternalQueryConnector {
    private static final String TEST_BASE = "https://dev-aiapi.ufei.center";
    private static final Set<String> HOSTS = Set.of("dev-aiapi.ufei.center");
    private final ConnectorCatalog catalog = buildCatalog();

    @Override
    public ConnectorType type() {
        return ConnectorType.UFEI_DASHBOARD;
    }

    @Override
    public ConnectorCatalog catalog() {
        return catalog;
    }

    @Override
    public ConnectorValidationResult validate(String baseUrl, ConnectorCredential credential) {
        try {
            ConnectorHttp.endpoint(baseUrl, "", "/biz-api/sql/data", HOSTS);
            if (credential == null || credential.token() == null || credential.token().isBlank()
                || credential.token().length() > 4096) {
                throw new ConnectorException(400, "ConnectorCredentialInvalid", "UFEI credential is missing or invalid");
            }
            return new ConnectorValidationResult(false, "CONNECTOR_CONTRACT_UNVERIFIED",
                "UFEI method routing, authentication and business success contract require upstream verification",
                Map.of("environment", "TEST", "identityVerified", false));
        } catch (ConnectorException e) {
            return new ConnectorValidationResult(false, e.code, e.getMessage(), Map.of("identityVerified", false));
        }
    }

    @Override
    public ConnectorQueryResult query(String baseUrl, ConnectorCredential credential, String method,
                                      Map<String, Object> params) {
        boolean declared = catalog.methods().stream().anyMatch(candidate -> candidate.name().equals(method));
        if (!declared) {
            throw new ConnectorException(400, "ConnectorMethodNotSupported", "External query method is not supported");
        }
        throw new ConnectorException(409, "ConnectorContractUnverified",
            "UFEI query contract has not been verified against the protected upstream documentation");
    }

    private static ConnectorCatalog buildCatalog() {
        var methods = new ArrayList<ConnectorMethod>();
        methods.add(unverified("dealerData", "经营单位数据"));
        methods.add(unverified("companyData", "产废企业数据"));
        methods.add(unverified("entSummary", "企业汇总"));
        methods.add(unverified("entTend", "企业趋势"));
        methods.add(unverified("deviceSummary", "设备汇总"));
        methods.add(unverified("mgrCat", "管理类别"));
        methods.add(unverified("onlineTime", "设备在网时长"));
        methods.add(unverified("areaCover", "地区覆盖"));
        methods.add(unverified("deliveryTend", "申报趋势"));
        methods.add(unverified("ledgerSummary", "台账汇总"));
        methods.add(unverified("warnNotice", "预警关注"));
        return new ConnectorCatalog(ConnectorType.UFEI_DASHBOARD, "优废数据大屏", List.of(
            new ConnectorCatalog.Environment("TEST", TEST_BASE, false)
        ), List.copyOf(methods));
    }

    private static ConnectorMethod unverified(String name, String title) {
        return new ConnectorMethod(name, title, "", true, object(Map.of()), anyObject("返回结构待上游核实"),
            fields(), "待上游核实", "待上游核实",
            "已确认 JSON POST、Authorization 直接传 JWT（无 Bearer）、固定 type=hwDashboardSql，"
                + "查询端点为 /biz-api/sql/data 或 /biz-api/sql/dataList；该 method 的具体端点映射、参数、字段和业务成功码仍未核实，因此禁止调用", "UNVERIFIED");
    }
}
