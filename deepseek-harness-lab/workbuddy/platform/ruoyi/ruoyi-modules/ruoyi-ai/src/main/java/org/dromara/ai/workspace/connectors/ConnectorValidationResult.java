package org.dromara.ai.workspace.connectors;

import java.util.Map;

public record ConnectorValidationResult(
    boolean valid,
    String code,
    String message,
    Map<String, Object> metadata
) {
}
