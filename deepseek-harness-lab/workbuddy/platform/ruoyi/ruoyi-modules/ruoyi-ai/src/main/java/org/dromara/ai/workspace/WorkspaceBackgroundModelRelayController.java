package org.dromara.ai.workspace;

import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.UUID;

/** A job-scoped grant lets server-side cron use the model after the browser session ends. */
@SaIgnore
@RestController
@RequiredArgsConstructor
public class WorkspaceBackgroundModelRelayController {
    private final WorkspaceBackgroundGrants grants;
    private final ExecutionCredentials execution;
    private final WorkspaceModelAccess access;
    private final WorkspaceModelRelayController relay;

    @PostMapping(value = "/internal/rc2/background/grants/{grantId}/models/{modelId}/chat/completions",
        consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<StreamingResponseBody> chat(@PathVariable UUID grantId, @PathVariable UUID modelId,
        @RequestBody String raw, @RequestHeader("Authorization") String serviceAuthorization,
        @RequestHeader("X-Aion-Background-Secret") String secret) {
        execution.checkBackgroundService(serviceAuthorization);
        var authorized = grants.require(grantId, secret);
        Runnable recheck = () -> {
            var current = grants.require(grantId, secret);
            if (current.userId() != authorized.userId() || current.authVersion() != authorized.authVersion())
                throw new WorkspaceDenied(401, "BackgroundAuthorizationRevoked");
            access.checkIdentity(current.userId(), current.authVersion());
        };
        return relay.relayAuthorized(modelId, raw, authorized.userId(), authorized.authVersion(), recheck);
    }
}
