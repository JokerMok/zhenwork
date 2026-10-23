package org.dromara.ai.workspace.connectors;

import java.util.Map;

public record ConnectorQueryResult(Object data, Map<String, Object> metadata) {
}
