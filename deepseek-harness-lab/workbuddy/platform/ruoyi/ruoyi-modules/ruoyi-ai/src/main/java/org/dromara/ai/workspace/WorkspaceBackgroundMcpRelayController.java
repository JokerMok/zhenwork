package org.dromara.ai.workspace;

import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** Uses the same MCP destination and tool policy as an interactive employee call. */
@SaIgnore
@RestController
@RequiredArgsConstructor
public class WorkspaceBackgroundMcpRelayController {
    private final WorkspaceBackgroundGrants grants;
    private final WorkspacePermissions permissions;
    private final ExecutionCredentials execution;
    private final WorkspaceMcpRelayController relay;

    @PostMapping("/internal/rc2/background/grants/{grantId}/mcp/connections/{id}/relay")
    public ResponseEntity<byte[]> relay(@PathVariable UUID grantId, @PathVariable UUID id,
                                         @RequestBody byte[] body,
                                         @RequestHeader("Authorization") String serviceAuthorization,
                                         @RequestHeader("X-Aion-Background-Secret") String secret,
                                         @RequestHeader(value = "Mcp-Session-Id", required = false) String sessionId,
                                         @RequestHeader(value = "MCP-Protocol-Version", required = false) String protocolVersion) {
        execution.checkBackgroundService(serviceAuthorization);
        var authorized = grants.require(grantId, secret);
        Runnable recheck = () -> {
            grants.require(grantId, secret);
            permissions.require(authorized.userId(), "ai:mcp:use");
        };
        return relay.relayAuthorized(id, body, sessionId, protocolVersion, authorized.userId(), recheck);
    }
}
