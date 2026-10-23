package org.dromara.ai.workspace.connectors;

/** Decrypted credentials are passed only for the duration of one validation/query call. */
public record ConnectorCredential(String token, String businessIdentity) {
}
