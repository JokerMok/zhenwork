package org.dromara.ai.workspace;

import cn.dev33.satoken.stp.StpUtil;
import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Employee-authorized Chat Completions relay; provider credentials stay in RC2. */
@RestController
@RequestMapping("/ai/model-relay")
@RequiredArgsConstructor
public class WorkspaceModelRelayController {
    private static final int MAX_REQUEST_CHARS = 1_048_576;
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    private final WorkspacePrincipal principals;
    private final WorkspaceModelAccess access;
    private final WorkspaceSecrets secrets;
    private final JdbcTemplate jdbc;

    @PostMapping(value = "/{modelId}/chat/completions", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<StreamingResponseBody> chat(@PathVariable UUID modelId, @RequestBody String raw) {
        var actor = principals.require("ai:model:use");
        var token = StpUtil.getTokenValue();
        return relayAuthorized(modelId, raw, actor.userId(), actor.authVersion(), () -> {
            principals.fromToken(token);
            access.checkIdentity(actor.userId(), actor.authVersion());
        });
    }

    ResponseEntity<StreamingResponseBody> relayAuthorized(UUID modelId, String raw, long userId,
        long authVersion, Runnable recheck) {
        access.checkIdentity(userId, authVersion);
        var model = access.model(userId, modelId);
        if (raw.length() > MAX_REQUEST_CHARS) throw new WorkspaceDenied(413, "ModelRequestTooLarge");
        var payload = normalize(raw, model.get("code").toString());
        payload.put("stream_options", Map.of("include_usage", true));
        String providerType = model.get("provider_type").toString();
        if ("CUSTOM_OPENAI".equals(providerType)) throw new WorkspaceDenied(400, "RelayProviderUnsupported");
        if ("ARK".equals(providerType)) payload.put("thinking", Map.of("type", "disabled"));
        var baseUrl = WorkspaceProviderDestination.validate(providerType, model.get("base_url").toString());
        var cipher = jdbc.queryForObject(
            "SELECT secret_cipher FROM ai_provider WHERE id=? AND version=? AND enabled",
            String.class, model.get("provider_id"), model.get("provider_version"));
        if (cipher == null || cipher.isBlank()) throw new WorkspaceDenied(502, "ProviderUnavailable");

        UUID callId = UUID.randomUUID();
        audit(callId, userId, modelId, "model.relay.started", model, "STARTED", null);
        var request = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
            .timeout(Duration.ofSeconds(45))
            .header("Authorization", "Bearer " + secrets.decrypt(cipher))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(JsonUtils.toJsonString(payload))).build();
        HttpResponse<InputStream> upstream;
        try {
            upstream = HTTP.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            audit(callId, userId, modelId, "model.relay.finished", model, "CANCELLED", null);
            throw new WorkspaceDenied(502, "ProviderInterrupted");
        } catch (IOException error) {
            audit(callId, userId, modelId, "model.relay.finished", model, "FAILED", null);
            throw new WorkspaceDenied(502, "ProviderUnavailable");
        }
        if (upstream.statusCode() != 200) {
            try { upstream.body().close(); } catch (IOException ignored) { }
            audit(callId, userId, modelId, "model.relay.finished", model, "FAILED", null);
            throw new WorkspaceDenied(502, "ProviderUnavailable");
        }
        StreamingResponseBody stream = output -> {
            var usage = new SseUsage();
            String status = "FAILED";
            try (InputStream input = upstream.body()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    try {
                        recheck.run();
                        access.model(userId, modelId);
                    } catch (WorkspaceDenied denied) {
                        throw new IOException("Enterprise model authorization revoked");
                    }
                    usage.accept(buffer, count);
                    try { output.write(buffer, 0, count); output.flush(); }
                    catch (IOException disconnected) { status = "CANCELLED"; throw disconnected; }
                }
                if (usage.done) status = "COMPLETED";
            } finally {
                audit(callId, userId, modelId, "model.relay.finished", model, status, usage);
            }
        };
        return ResponseEntity.ok().contentType(MediaType.TEXT_EVENT_STREAM)
            .header("Cache-Control", "no-store")
            .header("X-Accel-Buffering", "no")
            .body(stream);
    }

    private void audit(UUID callId, long userId, UUID modelId, String action,
                       Map<String, Object> model, String status, SseUsage usage) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("callId", callId.toString());
        metadata.put("modelCode", model.get("code"));
        metadata.put("providerId", model.get("provider_id").toString());
        metadata.put("status", status);
        metadata.put("usageReported", usage != null && usage.reported);
        metadata.put("inputTokens", usage == null ? null : usage.inputTokens);
        metadata.put("outputTokens", usage == null ? null : usage.outputTokens);
        metadata.put("costStatus", "UNKNOWN");
        jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,?,?,?::jsonb)",
            UUID.randomUUID(), userId, action, modelId, JsonUtils.toJsonString(metadata));
    }

    /** Observes usage without altering the bytes sent to AionCore. */
    static final class SseUsage {
        private static final JsonMapper JSON = JsonMapper.builder().build();
        final StringBuilder pending = new StringBuilder();
        Long inputTokens;
        Long outputTokens;
        boolean reported;
        boolean done;

        void accept(byte[] bytes, int length) throws IOException {
            pending.append(new String(bytes, 0, length, StandardCharsets.ISO_8859_1));
            String normalized = pending.toString().replace("\r\n", "\n");
            pending.setLength(0);
            pending.append(normalized);
            if (pending.length() > 131_072) throw new IOException("Provider frame too large");
            int boundary;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
                String frame = pending.substring(0, boundary).replace("\r", "");
                pending.delete(0, boundary + 2);
                for (String line : frame.split("\n")) {
                    if (!line.startsWith("data:")) continue;
                    String data = line.substring(5).trim();
                    if ("[DONE]".equals(data)) { done = true; continue; }
                    if (!data.contains("\"usage\"")) continue;
                    try {
                        Object raw = JSON.readValue(data, Map.class).get("usage");
                        if (!(raw instanceof Map<?, ?> value)) continue;
                        Object in = value.get("prompt_tokens"), out = value.get("completion_tokens");
                        if (in instanceof Number a && out instanceof Number b && a.longValue() >= 0 && b.longValue() >= 0) {
                            inputTokens = a.longValue(); outputTokens = b.longValue(); reported = true;
                        }
                    } catch (Exception ignored) { /* only the vendor's usage frame is relevant */ }
                }
            }
        }
    }

    static Map<String, Object> normalize(String raw, String modelCode) {
        Map<String, Object> payload;
        try {
            payload = JsonUtils.parseMap(raw);
        } catch (Exception error) {
            throw new WorkspaceDenied(400, "InvalidModelRequest");
        }
        return normalize(payload, modelCode);
    }

    static Map<String, Object> normalize(Map<String, Object> raw, String modelCode) {
        var payload = new LinkedHashMap<>(raw);
        if (!Boolean.TRUE.equals(payload.get("stream")) || !(payload.get("messages") instanceof List<?> messages)
            || messages.isEmpty() || !modelCode.equals(payload.get("model")))
            throw new WorkspaceDenied(400, "InvalidModelRequest");
        for (String field : List.of("max_tokens", "max_completion_tokens")) {
            if (payload.containsKey(field)) {
                if (!(payload.get(field) instanceof Number n) || n.longValue() < 1)
                    throw new WorkspaceDenied(400, "InvalidModelRequest");
            }
        }
        return payload;
    }
}
