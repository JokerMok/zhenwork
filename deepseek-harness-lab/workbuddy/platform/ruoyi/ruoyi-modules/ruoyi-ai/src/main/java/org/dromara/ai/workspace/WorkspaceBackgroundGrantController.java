package org.dromara.ai.workspace;

import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

/** The web host holds the returned secret; the browser and AionCore never receive it. */
@RestController
@RequiredArgsConstructor
public class WorkspaceBackgroundGrantController {
    private final WorkspacePrincipal principals;
    private final WorkspaceBackgroundGrants grants;
    private final ExecutionCredentials execution;

    @GetMapping("/internal/rc2/background/health")
    @SaIgnore
    public R<?> health(@RequestHeader("Authorization") String serviceAuthorization) {
        execution.checkBackgroundService(serviceAuthorization);
        return R.ok(Map.of("ready", true));
    }

    @PostMapping("/ai/background/jobs/{jobId}/grant")
    public R<?> issue(@PathVariable String jobId, @RequestHeader("Authorization") String serviceAuthorization) {
        execution.checkBackgroundService(serviceAuthorization);
        var actor = principals.require("ai:session:use");
        return R.ok(grants.issue(actor, jobId));
    }

    @DeleteMapping("/ai/background/jobs/{jobId}/grant")
    public R<?> revoke(@PathVariable String jobId, @RequestHeader("Authorization") String serviceAuthorization) {
        execution.checkBackgroundService(serviceAuthorization);
        var actor = principals.require("ai:session:use");
        grants.revoke(actor.userId(), jobId);
        return R.ok();
    }

    @GetMapping("/internal/rc2/background/grants/{id}")
    @SaIgnore
    public R<?> check(@PathVariable UUID id,
                      @RequestHeader("Authorization") String serviceAuthorization,
                      @RequestHeader("X-Aion-Background-Secret") String secret) {
        execution.checkBackgroundService(serviceAuthorization);
        var authorized = grants.require(id, secret);
        return R.ok(Map.of("userId", Long.toString(authorized.userId()),
            "jobId", authorized.jobId()));
    }
}
