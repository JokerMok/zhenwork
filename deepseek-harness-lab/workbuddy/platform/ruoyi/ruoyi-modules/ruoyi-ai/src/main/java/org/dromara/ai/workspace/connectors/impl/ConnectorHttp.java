package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.ConnectorException;

import org.dromara.common.json.utils.JsonUtils;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

final class ConnectorHttp {
    private static final int MAX_RESPONSE_BYTES = 512 * 1024;
    private static final java.util.concurrent.ScheduledThreadPoolExecutor DEADLINES = deadlines();

    private static java.util.concurrent.ScheduledThreadPoolExecutor deadlines() {
        var executor = new java.util.concurrent.ScheduledThreadPoolExecutor(1, runnable -> {
            var thread = new Thread(runnable, "external-query-body-deadline");
            thread.setDaemon(true);
            return thread;
        });
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }

    private ConnectorHttp() {
    }

    static HttpClient client() {
        return HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    }

    static URI endpoint(String baseUrl, String requiredBasePath, String fixedPath, java.util.Set<String> allowedHosts) {
        try {
            URI base = URI.create(baseUrl == null ? "" : baseUrl.trim());
            if (base.getScheme() == null || base.getHost() == null || base.getUserInfo() != null
                || base.getQuery() != null || base.getFragment() != null) {
                throw invalidBaseUrl();
            }
            boolean secure = "https".equalsIgnoreCase(base.getScheme());
            boolean testLoopback = "http".equalsIgnoreCase(base.getScheme())
                && ("127.0.0.1".equals(base.getHost()) || "localhost".equalsIgnoreCase(base.getHost()));
            if (!secure && !testLoopback) {
                throw invalidBaseUrl();
            }
            if (!testLoopback && !allowedHosts.contains(base.getHost().toLowerCase(java.util.Locale.ROOT))) {
                throw invalidBaseUrl();
            }
            String path = base.getPath() == null ? "" : base.getPath();
            if (!path.equals(requiredBasePath) && !path.equals(requiredBasePath + "/")) {
                throw invalidBaseUrl();
            }
            String normalized = base.toString();
            while (normalized.endsWith("/")) {
                normalized = normalized.substring(0, normalized.length() - 1);
            }
            return URI.create(normalized + fixedPath);
        } catch (IllegalArgumentException e) {
            throw invalidBaseUrl();
        }
    }

    static Map<String, Object> post(HttpClient client, URI endpoint, Map<String, String> headers, Object body) {
        return post(client, endpoint, headers, body, Duration.ofSeconds(20));
    }

    static Map<String, Object> post(HttpClient client, URI endpoint, Map<String, String> headers, Object body, Duration timeout) {
        long started = System.nanoTime();
        var bodyExpired = new java.util.concurrent.atomic.AtomicBoolean();
        var builder = HttpRequest.newBuilder(endpoint)
            .timeout(timeout)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(JsonUtils.toJsonString(body), StandardCharsets.UTF_8));
        headers.forEach(builder::header);
        try {
            var response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            byte[] bytes;
            try (var stream = response.body()) {
                long remaining = Math.max(0, timeout.toNanos() - (System.nanoTime() - started));
                var deadline = DEADLINES.schedule(() -> {
                    bodyExpired.set(true);
                    try { stream.close(); } catch (IOException ignored) { /* Cancel the bounded read. */ }
                }, remaining, java.util.concurrent.TimeUnit.NANOSECONDS);
                try {
                    bytes = stream.readNBytes(MAX_RESPONSE_BYTES + 1);
                    if (bodyExpired.get()) throw new java.net.http.HttpTimeoutException("Body deadline");
                } finally {
                    deadline.cancel(false);
                }
            }
            if (bytes.length > MAX_RESPONSE_BYTES) {
                throw new ConnectorException(502, "ConnectorResponseTooLarge", "External service response is too large");
            }
            if (response.statusCode() != 200) {
                throw httpError(response.statusCode());
            }
            try {
                return JsonUtils.parseObject(new String(bytes, StandardCharsets.UTF_8), Map.class);
            } catch (RuntimeException e) {
                throw new ConnectorException(502, "ConnectorResponseInvalid", "External service returned invalid JSON");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ConnectorException(503, "ConnectorInterrupted", "External query was interrupted");
        } catch (java.net.http.HttpTimeoutException e) {
            throw new ConnectorException(504, "ConnectorTimeout", "External query timed out");
        } catch (javax.net.ssl.SSLException e) {
            throw new ConnectorException(503, "ConnectorTlsFailed", "上游 TLS 安全连接失败，请检查证书和服务状态");
        } catch (java.net.ConnectException | java.net.UnknownHostException e) {
            throw new ConnectorException(503, "ConnectorNetworkFailed", "无法连接上游地址，请检查网络和域名解析");
        } catch (IOException e) {
            if (bodyExpired.get()) throw new ConnectorException(504, "ConnectorTimeout", "External query timed out");
            throw new ConnectorException(503, "ConnectorUnavailable", "External service is unavailable");
        }
    }

    static Object parseNestedJson(Object value) {
        Object current = value;
        for (int depth = 0; depth < 2 && current instanceof String text; depth++) {
            String trimmed = text.trim();
            if (!(trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\""))) {
                break;
            }
            try {
                current = JsonUtils.parseObject(trimmed, Object.class);
            } catch (RuntimeException e) {
                throw new ConnectorException(502, "ConnectorResponseInvalid", "External service returned invalid business data");
            }
        }
        return current;
    }

    private static ConnectorException invalidBaseUrl() {
        return new ConnectorException(400, "ConnectorBaseUrlInvalid", "Connector base URL is invalid");
    }

    private static ConnectorException httpError(int status) {
        return switch (status) {
            case 401 -> new ConnectorException(401, "ConnectorAuthenticationFailed", "External credential was rejected");
            case 403 -> new ConnectorException(403, "ConnectorAccessDenied", "External service denied access");
            case 404 -> new ConnectorException(502, "ConnectorEndpointNotFound", "Configured external endpoint was not found");
            default -> status >= 500
                ? new ConnectorException(503, "ConnectorUnavailable", "External service is unavailable")
                : new ConnectorException(502, "ConnectorRequestRejected", "External service rejected the query");
        };
    }
}
