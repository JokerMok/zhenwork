package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceMcpRelayControllerTest {
    @Test
    void probeReadsMatchingJsonRpcFrameFromStream() {
        var frames = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"
            + "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"search\"}]}}\n\n";
        var message = WorkspaceMcpRelayController.probeMessage(frames.getBytes(StandardCharsets.UTF_8), 2);
        assertEquals(2, ((Number) message.get("id")).intValue());
        assertThrows(WorkspaceDenied.class, () ->
            WorkspaceMcpRelayController.probeMessage(frames.getBytes(StandardCharsets.UTF_8), 3));
    }

    @Test
    void onlyConfiguredMcpDestinationsCanBeUsed() {
        var relay = new WorkspaceMcpRelayController(null, null, null);
        ReflectionTestUtils.setField(relay, "catalogUrl", "http://127.0.0.1:3588/mcp");
        ReflectionTestUtils.setField(relay, "allowedHosts", "mcp.example.com");
        assertEquals("127.0.0.1", relay.destination(Map.of("managedProfile", "acceptance-catalog")).getHost());
        assertThrows(WorkspaceDenied.class, () -> relay.destination(Map.of("endpoint", "https://other.example.com/mcp")));
    }
}
