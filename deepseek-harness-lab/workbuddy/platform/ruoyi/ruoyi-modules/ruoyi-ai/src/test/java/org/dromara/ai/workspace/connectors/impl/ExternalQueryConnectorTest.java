package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.ConnectorCredential;
import org.dromara.ai.workspace.connectors.ConnectorException;

import cn.hutool.core.util.HexUtil;
import cn.hutool.crypto.symmetric.SM4;
import com.sun.net.httpserver.HttpServer;
import org.dromara.common.json.utils.JsonUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ExternalQueryConnectorTest {
    private static final String TEST_TOKEN = "00000000000000000000000000000000";
    private HttpServer server;

    @BeforeAll
    static void configureProductionJsonMapper() {
        var context = new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(tools.jackson.databind.json.JsonMapper.class,
            () -> tools.jackson.databind.json.JsonMapper.builder().build());
        context.refresh();
        new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void cswmCatalogContainsOnlyPinnedReadMethodsWithStrictSchemas() {
        var catalog = new CswmIotConnector().catalog();
        assertEquals(24, catalog.methods().size());
        assertTrue(catalog.methods().stream().allMatch(method -> method.readOnly()
            && "VERIFIED".equals(method.contractStatus()) && method.path().startsWith("/iot/")));
        assertTrue(catalog.methods().stream().allMatch(method -> Boolean.FALSE.equals(method.inputSchema().get("additionalProperties"))));
        assertEquals("/iot/ledger", catalog.methods().stream().filter(method -> method.name().equals("ledger")).findFirst().orElseThrow().path());
    }

    @Test
    void ufeiFixedInventoryExposesOnlyConfirmedEmptySchemas() {
        var connector = new UfeiDashboardConnector();
        assertEquals(11, connector.catalog().methods().size());
        assertTrue(connector.catalog().methods().stream().allMatch(method -> "VERIFIED".equals(method.contractStatus())
            && ((Map<?,?>)method.inputSchema().get("properties")).isEmpty()));
        var error = assertThrows(ConnectorException.class, () -> connector.query("http://127.0.0.1:9",
            new ConnectorCredential("configured", "local label"), "entSummary", Map.of("date","2026-01")));
        assertEquals("ConnectorParameterNotAllowed", error.code);
    }

    @Test
    void ufeiUsesRawAuthorizationRealSuccessCodeAndCompleteTrendList() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var codes = new java.util.concurrent.ConcurrentLinkedQueue<>(java.util.List.of("200","0"));
        server.createContext("/biz-api/sql/dataList", exchange -> {
            assertEquals("test-private-jwt",exchange.getRequestHeaders().getFirst("Authorization"));
            var body=JsonUtils.parseObject(exchange.getRequestBody().readAllBytes(),Map.class);
            assertEquals(Map.of("type","hwDashboardSql","method","entTend","params",Map.of()),body);
            byte[] response=JsonUtils.toJsonString(Map.of("code",codes.remove(),"data","[{\"dateAt\":\"2026-01\",\"count\":2,\"v\":\"snapshot\"},{\"dateAt\":\"2026-02\",\"count\":3,\"v\":\"snapshot\"}]")).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200,response.length);exchange.getResponseBody().write(response);exchange.close();
        });
        server.start();
        var connector=new UfeiDashboardConnector(HttpClient.newHttpClient(),Clock.systemUTC());
        String base="http://127.0.0.1:"+server.getAddress().getPort();
        var result=connector.query(base,new ConnectorCredential("test-private-jwt","local label"),"entTend",Map.of());
        assertEquals(2,((java.util.List<?>)result.data()).size());
        assertEquals("2026-02",((Map<?,?>)result.metadata().get("sourcePeriod")).get("to"));
        assertEquals("UfeiBusinessCode0",assertThrows(ConnectorException.class,()->connector.query(base,new ConnectorCredential("test-private-jwt","label"),"entTend",Map.of())).code);
    }

    @Test
    void cswmBindsReturnedEnterpriseInsteadOfTreatingLocalLabelAsAuthentication() throws Exception {
        server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/iot-server/iot/entInfo",exchange->{
            exchange.getRequestBody().readAllBytes();
            byte[] response=JsonUtils.toJsonString(Map.of("code",1000,"data",Map.of("qyid","ENT-1","dwmc","Actual enterprise","tyshxydm","CREDIT"))).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200,response.length);exchange.getResponseBody().write(response);exchange.close();
        });server.start();
        var result=new CswmIotConnector(HttpClient.newHttpClient(),Clock.systemUTC()).validate(baseUrl(),new ConnectorCredential(TEST_TOKEN,"Local display label"));
        assertTrue(result.valid());assertEquals("ENT-1",result.metadata().get("enterpriseId"));
        assertFalse(new CswmIotConnector().validate("https://iotapi.cswm.org.cn/iot-server",new ConnectorCredential(TEST_TOKEN,"")).valid());
    }

    @Test
    void cswmEnvelopeUsesDocumentedSm4AndSm3Contract() {
        var clock = Clock.fixed(Instant.ofEpochSecond(1_761_203_265L), ZoneOffset.UTC);
        var request = CswmCrypto.request(Map.of(), TEST_TOKEN, clock);
        String encrypted = request.get("data").toString();
        // Independent OpenSSL SM4-ECB/PKCS#7 vector for UTF-8 '{}' and a zero test key.
        assertEquals("b72b5de8a41adcd476fdbddb7a9efccf", encrypted);
        assertEquals("{}", new SM4(HexUtil.decodeHex(TEST_TOKEN)).decryptStr(encrypted, StandardCharsets.UTF_8));
        assertEquals("1761203265", request.get("timestamp"));
        assertEquals(32, request.get("nonce").toString().length());
        assertEquals(64, request.get("sign").toString().length());
        assertEquals(request.get("sign").toString().toUpperCase(), request.get("sign"));
        assertEquals(cn.hutool.crypto.SmUtil.sm3("data=" + encrypted + "&nonce=" + request.get("nonce")
            + "&timestamp=1761203265").toUpperCase(java.util.Locale.ROOT), request.get("sign"));
    }

    @Test
    void cswmQueryPinsPathChecksBusinessCodeAndRedactsCredentialEchoes() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/iot-server/iot/getInventoryStatusByBatchCode", exchange -> {
            assertEquals("POST", exchange.getRequestMethod());
            assertEquals(TEST_TOKEN, exchange.getRequestHeaders().getFirst("token"));
            var envelope = JsonUtils.parseObject(exchange.getRequestBody().readAllBytes(), Map.class);
            String clear = new SM4(HexUtil.decodeHex(TEST_TOKEN)).decryptStr(envelope.get("data").toString(), StandardCharsets.UTF_8);
            assertEquals(Map.of("szsbm", "BATCH-1"), JsonUtils.parseObject(clear, Map.class));
            byte[] response = JsonUtils.toJsonString(Map.of(
                "code", "1000",
                "message", "ok",
                "data", Map.of("kczt", "IN", "token", TEST_TOKEN, "echo", "prefix-" + TEST_TOKEN)
            )).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        var connector = new CswmIotConnector(HttpClient.newHttpClient(), Clock.systemUTC());
        var result = connector.query(baseUrl(), new ConnectorCredential(TEST_TOKEN, "enterprise"),
            "getInventoryStatusByBatchCode", Map.of("szsbm", "BATCH-1"));
        var data = (Map<?, ?>) result.data();
        assertFalse(data.containsKey("token"));
        assertEquals("prefix-[REDACTED]", data.get("echo"));
        assertEquals("IN", data.get("kczt"));
        assertEquals("LOCAL_TEST", result.metadata().get("environment"));
    }

    @Test
    void http200DoesNotTurnBusinessErrorsIntoSuccessAndEmptyDataStaysEmpty() throws Exception {
        var codes = new java.util.concurrent.ConcurrentLinkedQueue<Object>(java.util.List.of(0, "1002", 1000));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/iot-server/iot/listWasteInfo", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] response = JsonUtils.toJsonString(Map.of("code", codes.remove(), "data", "[]"))
                .getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        var connector = new CswmIotConnector(HttpClient.newHttpClient(), Clock.systemUTC());
        var credential = new ConnectorCredential(TEST_TOKEN, "enterprise");
        assertEquals("CswmBusinessCode0", assertThrows(ConnectorException.class,
            () -> connector.query(baseUrl(), credential, "listWasteInfo", Map.of())).code);
        assertEquals("CswmBusinessCode1002", assertThrows(ConnectorException.class,
            () -> connector.query(baseUrl(), credential, "listWasteInfo", Map.of())).code);
        assertEquals(java.util.List.of(), connector.query(baseUrl(), credential, "listWasteInfo", Map.of()).data());
    }

    @Test
    void slowResponseBodyCannotHoldAnEmployeeQueryOpenIndefinitely() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/slow", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write('{');
            exchange.getResponseBody().flush();
            try { Thread.sleep(600); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            exchange.close();
        });
        server.start();
        var error = assertThrows(ConnectorException.class, () -> ConnectorHttp.post(HttpClient.newHttpClient(),
            java.net.URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/slow"), Map.of(), Map.of(),
            java.time.Duration.ofMillis(120)));
        assertEquals("ConnectorTimeout", error.code);
    }

    @Test
    void strictSchemaRejectsExtraParametersBeforeNetworkCall() {
        var connector = new CswmIotConnector(HttpClient.newHttpClient(), Clock.systemUTC());
        var error = assertThrows(ConnectorException.class, () -> connector.query(
            "http://127.0.0.1:9/iot-server", new ConnectorCredential(TEST_TOKEN, "enterprise"),
            "entInfo", Map.of("url", "https://attacker.invalid")));
        assertEquals("ConnectorParameterNotAllowed", error.code);
    }

    @Test
    void ledgerRequiresCompleteDatesAndVerifiedEnterpriseId() {
        var connector = new CswmIotConnector(HttpClient.newHttpClient(), Clock.systemUTC());
        var incomplete = assertThrows(ConnectorException.class, () -> connector.query(
            "http://127.0.0.1:9/iot-server", new ConnectorCredential(TEST_TOKEN, "ENT-1"), "ledger",
            Map.of("qyid", "ENT-1", "lx", "cs", "dqys", 1, "ksrq", "2026-10-01")));
        assertEquals("ConnectorParameterRequired", incomplete.code);
        var foreign = assertThrows(ConnectorException.class, () -> connector.query(
            "http://127.0.0.1:9/iot-server", new ConnectorCredential(TEST_TOKEN, "ENT-1"), "ledger",
            Map.of("qyid", "ENT-2", "lx", "cs", "dqys", 1,
                "ksrq", "2026-10-01", "jsrq", "2026-10-23")));
        assertEquals("ConnectorBusinessIdentityMismatch", foreign.code);
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/iot-server";
    }
}
