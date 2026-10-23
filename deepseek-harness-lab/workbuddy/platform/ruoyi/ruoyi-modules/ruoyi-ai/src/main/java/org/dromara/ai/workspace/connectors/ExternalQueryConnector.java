package org.dromara.ai.workspace.connectors;

import java.util.Map;

public interface ExternalQueryConnector {
    ConnectorType type();

    ConnectorCatalog catalog();

    ConnectorValidationResult validate(String baseUrl, ConnectorCredential credential);

    ConnectorQueryResult query(
        String baseUrl,
        ConnectorCredential credential,
        String method,
        Map<String, Object> params
    );
}
