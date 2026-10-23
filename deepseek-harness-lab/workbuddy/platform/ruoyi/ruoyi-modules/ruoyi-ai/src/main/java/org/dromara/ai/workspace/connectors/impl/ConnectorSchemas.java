package org.dromara.ai.workspace.connectors.impl;

import org.dromara.ai.workspace.connectors.ConnectorException;
import org.dromara.ai.workspace.connectors.ConnectorMethod;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class ConnectorSchemas {
    private ConnectorSchemas() {
    }

    static Map<String, Object> object(Map<String, Map<String, Object>> properties, String... required) {
        var schema = new LinkedHashMap<String, Object>();
        schema.put("type", "object");
        schema.put("properties", new LinkedHashMap<>(properties));
        schema.put("required", List.of(required));
        schema.put("additionalProperties", false);
        return Map.copyOf(schema);
    }

    static Map<String, Object> anyObject(String description) {
        return Map.of("type", "object", "description", description, "additionalProperties", true);
    }

    static Map<String, Object> array(String description) {
        return Map.of(
            "type", "array",
            "description", description,
            "items", Map.of("type", "object", "additionalProperties", true)
        );
    }

    static Map<String, Object> page(String description) {
        return object(Map.of(
            "total", Map.of("type", List.of("integer", "string"), "description", "统计数"),
            "list", array(description)
        ), "total", "list");
    }

    static Map<String, Object> string(String description, int maxLength) {
        return Map.of("type", "string", "description", description, "maxLength", maxLength);
    }

    static Map<String, Object> string(String description, int maxLength, String format) {
        return Map.of("type", "string", "description", description, "maxLength", maxLength, "format", format);
    }

    static Map<String, Object> enumString(String description, String... values) {
        return Map.of("type", "string", "description", description, "enum", List.of(values));
    }

    static Map<String, Object> pageNumber() {
        return Map.of("type", "integer", "minimum", 1, "maximum", 99_999_999, "description", "当前页数，每页固定 10 条");
    }

    @SuppressWarnings("unchecked")
    static void validate(ConnectorMethod method, Map<String, Object> supplied) {
        Map<String, Object> params = supplied == null ? Map.of() : supplied;
        Map<String, Object> schema = method.inputSchema();
        Map<String, Map<String, Object>> properties = (Map<String, Map<String, Object>>) schema.get("properties");
        Set<String> allowed = properties.keySet();
        if (!allowed.containsAll(params.keySet())) {
            throw new ConnectorException(400, "ConnectorParameterNotAllowed", "Query contains an unsupported parameter");
        }
        List<String> required = (List<String>) schema.getOrDefault("required", List.of());
        for (String name : required) {
            if (!params.containsKey(name) || params.get(name) == null || params.get(name).toString().isBlank()) {
                throw new ConnectorException(400, "ConnectorParameterRequired", "A required query parameter is missing: " + name);
            }
        }
        for (var entry : params.entrySet()) {
            if (entry.getValue() == null) {
                continue;
            }
            validateValue(entry.getKey(), entry.getValue(), properties.get(entry.getKey()));
        }
        validateCrossFields(method.name(), params);
    }

    private static void validateValue(String name, Object value, Map<String, Object> schema) {
        String type = schema.get("type").toString();
        if ("integer".equals(type)) {
            if (!(value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long)) {
                throw invalid(name);
            }
            long number = ((Number) value).longValue();
            long min = ((Number) schema.getOrDefault("minimum", Long.MIN_VALUE)).longValue();
            long max = ((Number) schema.getOrDefault("maximum", Long.MAX_VALUE)).longValue();
            if (number < min || number > max) {
                throw invalid(name);
            }
            return;
        }
        if (!(value instanceof String text)) {
            throw invalid(name);
        }
        int maxLength = ((Number) schema.getOrDefault("maxLength", Integer.MAX_VALUE)).intValue();
        if (text.isBlank() || text.length() > maxLength) {
            throw invalid(name);
        }
        if (schema.get("enum") instanceof List<?> values && !values.contains(text)) {
            throw invalid(name);
        }
        try {
            if ("date".equals(schema.get("format"))) {
                LocalDate.parse(text, DateTimeFormatter.ISO_LOCAL_DATE);
            } else if ("date-time-seconds".equals(schema.get("format"))) {
                LocalDateTime.parse(text, DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
            }
        } catch (DateTimeParseException e) {
            throw invalid(name);
        }
    }

    private static void validateCrossFields(String method, Map<String, Object> params) {
        if ("ledger".equals(method)) {
            boolean anyBusinessDate = params.containsKey("ksrq") || params.containsKey("jsrq");
            boolean anyOperationDate = params.containsKey("czksrq") || params.containsKey("czjsrq");
            boolean businessPair = params.containsKey("ksrq") && params.containsKey("jsrq");
            boolean operationPair = params.containsKey("czksrq") && params.containsKey("czjsrq");
            if ((anyBusinessDate && !businessPair) || (anyOperationDate && !operationPair)
                || (!businessPair && !operationPair)) {
                throw new ConnectorException(400, "ConnectorParameterRequired", "Ledger query requires one complete date range");
            }
            if (businessPair) {
                withinOneMonth(params.get("ksrq").toString(), params.get("jsrq").toString());
            }
            if (operationPair) {
                withinOneMonth(params.get("czksrq").toString(), params.get("czjsrq").toString());
            }
        }
        if ("listManifest".equals(method)) {
            boolean start = params.containsKey("czkssj");
            boolean end = params.containsKey("czjssj");
            if (start != end) {
                throw new ConnectorException(400, "ConnectorParameterRequired", "Manifest operation time range must be complete");
            }
        }
        if ("listLicence".equals(method) && params.get("jydwmc").toString().length() < 2) {
            throw invalid("jydwmc");
        }
        if ("listTransport".equals(method) && params.get("ysdwmc").toString().length() < 2) {
            throw invalid("ysdwmc");
        }
    }

    private static void withinOneMonth(String start, String end) {
        var first = LocalDate.parse(start);
        var last = LocalDate.parse(end);
        if (last.isBefore(first) || last.isAfter(first.plusMonths(1))) {
            throw new ConnectorException(400, "ConnectorDateRangeInvalid", "Query date range must be ordered and at most one month");
        }
    }

    private static ConnectorException invalid(String name) {
        return new ConnectorException(400, "ConnectorParameterInvalid", "Query parameter is invalid: " + name);
    }

    static Map<String, Map<String, Object>> properties(Object... pairs) {
        var result = new LinkedHashMap<String, Map<String, Object>>();
        for (int i = 0; i < pairs.length; i += 2) {
            result.put(pairs[i].toString(), cast(pairs[i + 1]));
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) {
        return (Map<String, Object>) value;
    }

    static Map<String, String> fields(String... pairs) {
        var result = new LinkedHashMap<String, String>();
        for (int i = 0; i < pairs.length; i += 2) {
            result.put(pairs[i], pairs[i + 1]);
        }
        return Map.copyOf(result);
    }
}
