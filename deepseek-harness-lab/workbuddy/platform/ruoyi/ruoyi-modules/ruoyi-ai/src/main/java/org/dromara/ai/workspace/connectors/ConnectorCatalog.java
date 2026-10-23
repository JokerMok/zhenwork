package org.dromara.ai.workspace.connectors;

import java.util.List;

public record ConnectorCatalog(
    ConnectorType type,
    String displayName,
    List<Environment> environments,
    List<ConnectorMethod> methods
) {
    public record Environment(String name, String baseUrl, boolean production) {}
}
