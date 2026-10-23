package org.dromara.ai.workspace.connectors;

/** Safe, bounded connector error. It must never contain credentials or upstream bodies. */
public final class ConnectorException extends RuntimeException {
    public final int status;
    public final String code;

    public ConnectorException(int status, String code, String safeMessage) {
        super(safeMessage);
        this.status = status;
        this.code = code;
    }
}
