package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBodyReturnValueHandler;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class WorkspaceModelRelayControllerTest {
    @Test
    void adminProbeUsesTheSameChatEndpointWithEightTokens() {
        var payload = WorkspaceModelAdmin.probePayload("pilot-model", "ARK");
        assertEquals("pilot-model", payload.get("model"));
        assertEquals(false, payload.get("stream"));
        assertEquals(8, payload.get("max_tokens"));
        assertFalse(WorkspaceModelAdmin.probePayload("pilot-model", "OPENAI").containsKey("thinking"));
    }

    @Test
    void outputTokenSettingsAreForwardedWithoutPlatformLimit() {
        var raw = new java.util.HashMap<String, Object>();
        raw.put("model", "pilot");
        raw.put("stream", true);
        raw.put("messages", java.util.List.of(java.util.Map.of("role", "user", "content", "brief")));
        raw.put("max_tokens", 10000);
        assertEquals(10000, WorkspaceModelRelayController.normalize(raw, "pilot").get("max_tokens"));
        raw.remove("max_tokens");
        raw.put("max_completion_tokens", 12000);
        assertEquals(12000, WorkspaceModelRelayController.normalize(raw, "pilot").get("max_completion_tokens"));
        raw.remove("max_completion_tokens");
        var forwarded = WorkspaceModelRelayController.normalize(raw, "pilot");
        assertFalse(forwarded.containsKey("max_tokens"));
        assertFalse(forwarded.containsKey("max_completion_tokens"));
    }

    @Test
    void springMvcUsesStreamingReturnHandler() throws Exception {
        var method = WorkspaceModelRelayController.class.getMethod("chat", java.util.UUID.class, String.class);
        assertTrue(new StreamingResponseBodyReturnValueHandler()
            .supportsReturnType(new MethodParameter(method, -1)));
    }

    @Test
    void springMvcDeliversFixedSse() throws Exception {
        MockMvcBuilders.standaloneSetup(new FixedStreamController()).build()
            .perform(post("/fixed-stream"))
            .andExpect(status().isOk())
            .andExpect(content().string("data: fixed\n\ndata: [DONE]\n\n"));
    }

    @Test
    void fragmentedVendorUsageAndDoneAreObserved() throws Exception {
        var observer = new WorkspaceModelRelayController.SseUsage();
        var part1 = "data: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":".getBytes();
        var part2 = "3}}\r\n\r\ndata: [DONE]\r\n\r\n".getBytes();
        observer.accept(part1, part1.length);
        observer.accept(part2, part2.length);
        assertTrue(observer.reported);
        assertEquals(12L, observer.inputTokens);
        assertEquals(3L, observer.outputTokens);
        assertTrue(observer.done);
    }

    @RestController
    static class FixedStreamController {
        @PostMapping("/fixed-stream")
        ResponseEntity<StreamingResponseBody> stream() {
            StreamingResponseBody body = output -> output.write("data: fixed\n\ndata: [DONE]\n\n".getBytes());
            return ResponseEntity.ok().contentType(MediaType.TEXT_EVENT_STREAM).body(body);
        }
    }
}
