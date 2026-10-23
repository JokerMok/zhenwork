package org.dromara.ai.workspace.connectors;

import org.springframework.stereotype.Component;

import java.util.EnumMap;
import java.util.List;

@Component
public final class ExternalQueryConnectorRegistry {
    private final EnumMap<ConnectorType, ExternalQueryConnector> connectors = new EnumMap<>(ConnectorType.class);

    public ExternalQueryConnectorRegistry(List<ExternalQueryConnector> connectors) {
        for (var connector : connectors) {
            if (this.connectors.put(connector.type(), connector) != null) {
                throw new IllegalStateException("Duplicate external connector: " + connector.type());
            }
        }
    }

    public ExternalQueryConnector require(ConnectorType type) {
        var connector = connectors.get(type);
        if (connector == null) {
            throw new ConnectorException(400, "ConnectorNotSupported", "External connector is not supported");
        }
        return connector;
    }

    public List<ConnectorCatalog> catalogs() {
        return connectors.values().stream().map(ExternalQueryConnector::catalog).toList();
    }
}
