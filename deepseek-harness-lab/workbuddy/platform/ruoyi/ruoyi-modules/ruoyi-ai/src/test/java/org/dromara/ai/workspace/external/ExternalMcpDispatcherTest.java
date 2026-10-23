package org.dromara.ai.workspace.external;

import org.dromara.ai.workspace.connectors.ConnectorType;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class ExternalMcpDispatcherTest {
    @Test
    void ledgerEnterpriseIdIsInjectedByTheServerInsteadOfChosenByTheModel() {
        var runtime = new ExternalConnectionService.RuntimeConnection(UUID.randomUUID(),UUID.randomUUID(),
            ConnectorType.CSWM_IOT,"连接","本单位","TEST","https://test-iotapi.cswm.org.cn/iot-server",
            "secret",List.of("ledger"),Map.of("matched",true,"enterpriseId","verified-qyid"),1);
        var method = new org.dromara.ai.workspace.connectors.ConnectorMethod("ledger","台账","/iot/ledger",true,
            Map.of("type","object","properties",Map.of("qyid",Map.of("type","string"),"lx",Map.of("type","string")),
                "required",List.of("qyid","lx"),"additionalProperties",false),Map.of(),Map.of(),"","", "", "VERIFIED");
        var schema = ExternalMcpDispatcher.toolSchema(runtime,method);
        assertDoesNotThrow(() -> ExternalMcpDispatcher.validate(Map.of("lx","cs"),schema));
        assertThrows(RuntimeException.class,() -> ExternalMcpDispatcher.validate(Map.of("lx","cs","qyid","another-unit"),schema));
    }
    @Test
    void stripsCredentialFieldsAndEchoedTokenFromConnectorResult() {
        Object sanitized=ExternalMcpDispatcher.sanitize(Map.of(
            "data",List.of(Map.of("value",12,"token","must-not-leak")),
            "message","upstream echoed must-not-leak"),"must-not-leak");
        String text=sanitized.toString();
        assertFalse(text.contains("must-not-leak"));
        assertFalse(text.contains("token="));
        assertTrue(text.contains("[redacted]"));
    }

    @Test
    void rejectsArgumentsOutsideThePublishedSchema() {
        Map<String,Object> schema=Map.of("type","object","properties",Map.of("page",Map.of("type","integer")),"required",List.of("page"),"additionalProperties",false);
        assertThrows(RuntimeException.class,()->ExternalMcpDispatcher.validate(Map.of("page",1,"sql","select *"),schema));
        assertThrows(RuntimeException.class,()->ExternalMcpDispatcher.validate(Map.of("page","1"),schema));
        assertDoesNotThrow(()->ExternalMcpDispatcher.validate(Map.of("page",1),schema));
    }

    @Test
    void cswmCannotQueryAnotherEnterpriseIdentity() {
        UUID id=UUID.randomUUID();
        var runtime=new ExternalConnectionService.RuntimeConnection(id,UUID.randomUUID(),ConnectorType.CSWM_IOT,"连接","本单位","PRODUCTION","https://iotapi.cswm.org.cn/iot-server","secret",List.of("ledger"),Map.of("matched",true,"enterpriseId","verified-qyid"),3);
        assertThrows(RuntimeException.class,()->ExternalMcpDispatcher.enforceIdentity(runtime,Map.of("qyid","other-qyid")));
        assertDoesNotThrow(()->ExternalMcpDispatcher.enforceIdentity(runtime,Map.of("qyid","verified-qyid")));
    }
}
