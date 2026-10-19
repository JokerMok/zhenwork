package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.InetAddress;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.io.InputStream;
import java.io.IOException;
import java.time.Duration;
import java.util.*;

/** One authorized Streamable HTTP exchange; no old Harness Run grant is involved. */
@RestController
@RequestMapping("/ai/mcp/connections")
@RequiredArgsConstructor
public class WorkspaceMcpRelayController {
    private final WorkspacePrincipal principals;
    private final WorkspaceMcpAccess access;
    private final JdbcTemplate jdbc;
    @Value("${workspace.mcp.acceptance-catalog-url:}")
    private String catalogUrl;
    @Value("${workspace.mcp.allowed-hosts:}")
    private String allowedHosts;

    @PostMapping("/{id}/relay")
    public ResponseEntity<byte[]> relay(@PathVariable UUID id, @RequestBody byte[] body,
                                        @RequestHeader(value = "Mcp-Session-Id", required = false) String sessionId,
                                        @RequestHeader(value = "MCP-Protocol-Version", required = false) String protocolVersion) {
        long user = principals.require("ai:mcp:use").userId();
        return relayAuthorized(id, body, sessionId, protocolVersion, user, () -> principals.require("ai:mcp:use"));
    }

    ResponseEntity<byte[]> relayAuthorized(UUID id, byte[] body, String sessionId, String protocolVersion,
                                           long user, Runnable recheck) {
        recheck.run();
        if (body.length == 0 || body.length > 1_048_576) throw new WorkspaceDenied(400, "InvalidMcpRequest");
        Map<String,Object> message;
        try { message = JsonUtils.parseMap(new String(body, java.nio.charset.StandardCharsets.UTF_8)); }
        catch (Exception e) { throw new WorkspaceDenied(400, "InvalidMcpRequest"); }
        String method = Objects.toString(message.get("method"), "");
        if (!Set.of("initialize", "notifications/initialized", "ping", "tools/list", "tools/call").contains(method))
            throw new WorkspaceDenied(400, "McpMethodNotAllowed");
        var connection = access.owned(id, user);
        if (!Boolean.TRUE.equals(connection.get("enabled")) || !"READY".equals(connection.get("status")))
            throw new WorkspaceDenied(403, "McpConnectionNotReady");
        var plan = access.secretPlan(id, ((Number)connection.get("auth_version")).longValue(), user);
        if (!"STREAMABLE_HTTP".equals(plan.get("transport"))) throw new WorkspaceDenied(400, "McpTransportNotSupported");
        if ("tools/call".equals(method)) {
            if (!(message.get("params") instanceof Map<?,?> params)
                || !((List<?>)plan.get("allowedTools")).contains(Objects.toString(params.get("name"), "")))
                throw new WorkspaceDenied(403, "McpToolNotAllowed");
        }
        URI destination = destination(plan);
        var builder = HttpRequest.newBuilder(destination).timeout(Duration.ofSeconds(60))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofByteArray(body));
        if (sessionId != null && sessionId.matches("[A-Za-z0-9._-]{1,128}")) builder.header("Mcp-Session-Id", sessionId);
        if (protocolVersion != null && protocolVersion.matches("[0-9-]{1,20}")) builder.header("MCP-Protocol-Version", protocolVersion);
        if ("BEARER".equals(plan.get("authType"))) builder.header("Authorization", "Bearer " + plan.get("secret"));
        HttpResponse<InputStream> upstream;
        byte[] data;
        try {
            upstream = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER).build()
                .send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream stream = upstream.body()) { data = stream.readNBytes(1_048_577); }
        } catch (Exception e) { throw new WorkspaceDenied(502, "McpUpstreamUnavailable"); }
        if (data.length > 1_048_576) throw new WorkspaceDenied(502, "McpResponseTooLarge");
        recheck.run();
        access.owned(id, user);
        String contentType = upstream.headers().firstValue("content-type").orElse("application/json");
        if (!contentType.startsWith("application/json") && !contentType.startsWith("text/event-stream"))
            throw new WorkspaceDenied(502, "McpResponseTypeInvalid");
        Map<String,Object> metadata = new LinkedHashMap<>();
        metadata.put("connectionId", id.toString());
        metadata.put("method", method);
        metadata.put("status", upstream.statusCode());
        if ("tools/call".equals(method)) metadata.put("toolName", ((Map<?,?>)message.get("params")).get("name"));
        jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,?,?,?::jsonb)",
            UUID.randomUUID(), user, "mcp.relay", connection.get("resource_id"), JsonUtils.toJsonString(metadata));
        var headers = new HttpHeaders();
        headers.set(HttpHeaders.CONTENT_TYPE, contentType);
        headers.set(HttpHeaders.CACHE_CONTROL, "no-store");
        upstream.headers().firstValue("mcp-session-id").ifPresent(value -> headers.set("Mcp-Session-Id", value));
        return new ResponseEntity<>(data, headers, HttpStatusCode.valueOf(upstream.statusCode()));
    }

    /** Admin-approved destinations only. Do not follow redirects or accept private DNS answers. */
    URI destination(Map<String,Object> plan) {
        if ("acceptance-catalog".equals(plan.get("managedProfile"))) {
            if (catalogUrl.isBlank()) throw new WorkspaceDenied(503, "McpManagedDestinationUnavailable");
            URI uri = URI.create(catalogUrl);
            if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()))
                throw new WorkspaceDenied(503, "McpManagedDestinationInvalid");
            return uri;
        }
        URI uri = URI.create(Objects.toString(plan.get("endpoint"), ""));
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null ||
            Arrays.stream(allowedHosts.split(",")).map(String::trim).noneMatch(host::equalsIgnoreCase))
            throw new WorkspaceDenied(403, "McpDestinationNotAllowed");
        try {
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() ||
                    address.isSiteLocalAddress() || address.isMulticastAddress())
                    throw new WorkspaceDenied(403, "McpDestinationNotPublic");
            }
        } catch (java.net.UnknownHostException e) {
            throw new WorkspaceDenied(503, "McpDestinationUnresolved");
        }
        return uri;
    }

    /** Probe a saved connection without the old Harness Manager or a Run grant. */
    List<?> probe(Map<String,Object> plan) {
        URI uri = destination(plan);
        String initialize = JsonUtils.toJsonString(Map.of("jsonrpc", "2.0", "id", 1,
            "method", "initialize", "params", Map.of("protocolVersion", "2025-03-26",
                "capabilities", Map.of(), "clientInfo", Map.of("name", "rc2-admin-probe", "version", "1"))));
        var first = probeExchange(uri, plan, initialize, null, null);
        Map<String,Object> initialized = probeMessage(first.body(), 1);
        if (!(initialized.get("result") instanceof Map<?,?> result)) throw new WorkspaceDenied(502, "McpInitializeFailed");
        String protocol = Objects.toString(result.get("protocolVersion"), "2025-03-26");
        if (!protocol.matches("[0-9-]{1,20}")) throw new WorkspaceDenied(502, "McpProtocolInvalid");
        String session = first.headers().firstValue("mcp-session-id").orElse(null);
        probeExchange(uri, plan, JsonUtils.toJsonString(Map.of("jsonrpc", "2.0",
            "method", "notifications/initialized")), session, protocol);
        var listed = probeExchange(uri, plan, JsonUtils.toJsonString(Map.of("jsonrpc", "2.0",
            "id", 2, "method", "tools/list")), session, protocol);
        Map<String,Object> message = probeMessage(listed.body(), 2);
        if (!(message.get("result") instanceof Map<?,?> toolsResult) ||
            !(toolsResult.get("tools") instanceof List<?> tools) || tools.isEmpty())
            throw new WorkspaceDenied(502, "McpToolsUnavailable");
        var names = tools.stream().filter(Map.class::isInstance).map(Map.class::cast)
            .map(tool -> Objects.toString(tool.get("name"), "")).toList();
        if (((List<?>)plan.get("allowedTools")).stream().anyMatch(name -> !names.contains(name.toString())))
            throw new WorkspaceDenied(409, "McpAllowedToolMissing");
        return tools;
    }

    private ProbeResponse probeExchange(URI uri, Map<String,Object> plan, String raw,
                                               String session, String protocol) {
        var request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        if (session != null && session.matches("[A-Za-z0-9._-]{1,128}")) request.header("Mcp-Session-Id", session);
        if (protocol != null) request.header("MCP-Protocol-Version", protocol);
        if ("BEARER".equals(plan.get("authType"))) request.header("Authorization", "Bearer " + plan.get("secret"));
        try {
            var response = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER).build()
                .send(request.POST(HttpRequest.BodyPublishers.ofString(raw)).build(), HttpResponse.BodyHandlers.ofInputStream());
            byte[] data;
            try (InputStream stream = response.body()) { data = stream.readNBytes(1_048_577); }
            if (response.statusCode() != 200 && response.statusCode() != 202)
                throw new WorkspaceDenied(502, "McpProbeUpstreamRejected");
            if (data.length > 1_048_576) throw new WorkspaceDenied(502, "McpResponseTooLarge");
            return new ProbeResponse(data, response.headers());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new WorkspaceDenied(502, "McpProbeInterrupted");
        } catch (IOException e) {
            throw new WorkspaceDenied(502, "McpUpstreamUnavailable");
        }
    }

    private record ProbeResponse(byte[] body, java.net.http.HttpHeaders headers) {}

    static Map<String,Object> probeMessage(byte[] bytes, int id) {
        String raw = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
        var mapper = tools.jackson.databind.json.JsonMapper.builder().build();
        for (String line : raw.split("\\R")) {
            String candidate = line.startsWith("data:") ? line.substring(5).trim() : line.trim();
            if (!candidate.startsWith("{")) continue;
            try {
                Map<String,Object> message = mapper.readValue(candidate,
                    new tools.jackson.core.type.TypeReference<Map<String,Object>>() {});
                if (Objects.toString(message.get("id"), "").equals(Integer.toString(id))) return message;
            } catch (Exception ignored) { /* Keep looking for the matching JSON-RPC frame. */ }
        }
        throw new WorkspaceDenied(502, "McpProbeResponseInvalid");
    }
}
