package org.dromara.ai.workspace.connectors;

import java.util.Map;

public record ConnectorMethod(
    String name,
    String title,
    String path,
    boolean readOnly,
    Map<String, Object> inputSchema,
    Map<String, Object> outputSchema,
    Map<String, String> returnFields,
    String unit,
    String timeSemantics,
    String environmentNotes,
    String contractStatus
) {
}
