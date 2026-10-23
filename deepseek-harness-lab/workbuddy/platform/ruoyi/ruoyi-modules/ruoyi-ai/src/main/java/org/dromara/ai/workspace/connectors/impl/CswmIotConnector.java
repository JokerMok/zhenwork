package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.*;

import org.springframework.stereotype.Component;

import java.net.http.HttpClient;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Component
public final class CswmIotConnector implements ExternalQueryConnector {
    private static final Set<String> HOSTS = Set.of("test-iotapi.cswm.org.cn", "iotapi.cswm.org.cn");
    private static final Set<String> SENSITIVE_KEYS = Set.of(
        "token", "authorization", "password", "secret", "credential", "sign", "apikey", "api_key"
    );
    private final HttpClient client;
    private final Clock clock;
    private final ConnectorCatalog catalog;

    public CswmIotConnector() {
        this(ConnectorHttp.client(), Clock.systemUTC());
    }

    CswmIotConnector(HttpClient client, Clock clock) {
        this.client = client;
        this.clock = clock;
        this.catalog = CswmCatalog.catalog();
    }

    @Override
    public ConnectorType type() {
        return ConnectorType.CSWM_IOT;
    }

    @Override
    public ConnectorCatalog catalog() {
        return catalog;
    }

    @Override
    public ConnectorValidationResult validate(String baseUrl, ConnectorCredential credential) {
        String environment;
        try {
            requireCredential(credential, true);
            environment = environment(baseUrl);
            var result = query(baseUrl, credential, "entInfo", Map.of());
            Map<?, ?> enterprise = result.data() instanceof Map<?, ?> map ? map : Map.of();
            String enterpriseId = text(enterprise.get("qyid"));
            String name = text(enterprise.get("dwmc"));
            String creditCode = text(enterprise.get("tyshxydm"));
            // The local business-unit label is not an upstream authentication parameter.
            // Bind queries to the identity returned by the credential-scoped entInfo call.
            boolean matched = !enterpriseId.isBlank() && (!name.isBlank() || !creditCode.isBlank());
            var metadata = new LinkedHashMap<String, Object>();
            metadata.put("matched", matched);
            metadata.put("enterpriseId", enterpriseId);
            metadata.put("name", name);
            metadata.put("creditCode", creditCode);
            metadata.put("verifiedAt", clock.instant().toString());
            metadata.put("environment", environment);
            return new ConnectorValidationResult(matched, matched ? "VALID" : "BUSINESS_IDENTITY_MISMATCH",
                matched ? "已通过 /iot/entInfo 验证凭据，并绑定其返回的实际企业身份；请管理员核对下方单位信息" : "单位信息接口未返回可绑定的企业身份",
                Map.copyOf(metadata));
        } catch (ConnectorException e) {
            return new ConnectorValidationResult(false, e.code, e.getMessage(), Map.of(
                "matched", false,
                "verifiedAt", clock.instant().toString()
            ));
        }
    }

    @Override
    public ConnectorQueryResult query(String baseUrl, ConnectorCredential credential, String method,
                                      Map<String, Object> params) {
        requireCredential(credential, false);
        ConnectorMethod contract = catalog.methods().stream()
            .filter(candidate -> candidate.name().equals(method) && "VERIFIED".equals(candidate.contractStatus()))
            .findFirst()
            .orElseThrow(() -> new ConnectorException(400, "ConnectorMethodNotSupported", "External query method is not supported"));
        ConnectorSchemas.validate(contract, params);
        if ("ledger".equals(method) && !credential.businessIdentity().equals(params.get("qyid"))) {
            throw new ConnectorException(403, "ConnectorBusinessIdentityMismatch", "Query enterprise does not match the verified connection identity");
        }
        var endpoint = ConnectorHttp.endpoint(baseUrl, "/iot-server", contract.path(), HOSTS);
        var response = ConnectorHttp.post(client, endpoint, Map.of("token", credential.token()),
            CswmCrypto.request(params == null ? Map.of() : params, credential.token(), clock));
        Object businessCode = response.get("code");
        if (!"1000".equals(businessCode == null ? "" : businessCode.toString())) {
            String code = businessCode == null ? "" : businessCode.toString();
            throw new ConnectorException(502, code.matches("[0-9]{1,8}") ? "CswmBusinessCode" + code : "ConnectorBusinessRejected",
                safeBusinessMessage(response.get("message"), credential.token()));
        }
        Object normalized = sanitize(ConnectorHttp.parseNestedJson(response.get("data")), credential.token());
        var metadata = new LinkedHashMap<String, Object>();
        metadata.put("connector", type().name());
        metadata.put("method", method);
        metadata.put("upstreamPath", contract.path());
        metadata.put("httpStatus", 200);
        metadata.put("businessCode", businessCode.toString());
        metadata.put("queriedAt", clock.instant().toString());
        metadata.put("environment", environment(baseUrl));
        metadata.put("complete", !contract.timeSemantics().contains("仅返回请求页"));
        if (contract.timeSemantics().contains("仅返回请求页")) {
            metadata.put("pagination", "UPSTREAM_FIXED_PAGE_SIZE_10");
        }
        return new ConnectorQueryResult(normalized, Map.copyOf(metadata));
    }

    private void requireCredential(ConnectorCredential credential, boolean requireBusinessIdentity) {
        if (credential == null) {
            throw new ConnectorException(400, "ConnectorCredentialInvalid", "Connector credential is missing");
        }
        CswmCrypto.requireToken(credential.token());
        if (requireBusinessIdentity && (credential.businessIdentity() == null
            || credential.businessIdentity().isBlank() || credential.businessIdentity().length() > 200)) {
            throw new ConnectorException(400, "ConnectorBusinessIdentityInvalid", "Enterprise identity is missing or invalid");
        }
    }

    private String environment(String baseUrl) {
        ConnectorHttp.endpoint(baseUrl, "/iot-server", "/iot/entInfo", HOSTS);
        if (CswmCatalog.TEST_BASE.equals(stripSlash(baseUrl))) {
            return "TEST";
        }
        if (CswmCatalog.PRODUCTION_BASE.equals(stripSlash(baseUrl))) {
            return "PRODUCTION";
        }
        return "LOCAL_TEST";
    }

    private static String stripSlash(String value) {
        String result = value == null ? "" : value.trim();
        while (result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static String safeBusinessMessage(Object message, String token) {
        if (!(message instanceof String text) || text.isBlank()) {
            return "External service rejected the business query";
        }
        String bounded = text.replace(token, "[REDACTED]").replaceAll("[\\r\\n\\t]", " ").trim();
        return bounded.length() <= 200 ? bounded : bounded.substring(0, 200);
    }

    private static String text(Object value) {
        return value == null ? "" : value.toString();
    }

    static Object sanitize(Object value, String token) {
        if (value instanceof Map<?, ?> source) {
            var clean = new LinkedHashMap<String, Object>();
            for (var entry : source.entrySet()) {
                String key = entry.getKey().toString();
                if (sensitiveKey(key)) {
                    continue;
                }
                clean.put(key, sanitize(entry.getValue(), token));
            }
            return clean;
        }
        if (value instanceof List<?> source) {
            var clean = new ArrayList<>(source.size());
            for (Object item : source) {
                clean.add(sanitize(item, token));
            }
            return clean;
        }
        if (value instanceof String text && text.contains(token)) {
            return text.replace(token, "[REDACTED]");
        }
        return value;
    }

    private static boolean sensitiveKey(String key) {
        String normalized = key.toLowerCase(Locale.ROOT).replace("-", "").replace("_", "");
        return SENSITIVE_KEYS.contains(normalized) || normalized.endsWith("token")
            || normalized.contains("password") || normalized.contains("secret")
            || normalized.contains("credential") || normalized.contains("authorization");
    }
}
