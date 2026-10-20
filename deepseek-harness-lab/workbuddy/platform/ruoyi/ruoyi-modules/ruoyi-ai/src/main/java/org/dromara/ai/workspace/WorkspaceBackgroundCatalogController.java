package org.dromara.ai.workspace;

import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Read-only catalog for a running job; every request rechecks its grant and native RBAC. */
@SaIgnore
@RestController
@RequiredArgsConstructor
public class WorkspaceBackgroundCatalogController {
    private static final Set<String> TYPES = Set.of("ASSISTANT", "SKILL", "MCP", "KNOWLEDGE");
    private final WorkspaceBackgroundGrants grants;
    private final ExecutionCredentials execution;
    private final WorkspacePermissions permissions;
    private final WorkspaceModelAccess models;
    private final WorkspaceResources resources;
    private final WorkspaceMcpController mcp;

    private long owner(UUID grantId, String serviceAuthorization, String secret) {
        execution.checkBackgroundService(serviceAuthorization);
        return grants.require(grantId, secret).userId();
    }

    private void resourcePermission(long userId, String type) {
        if (!TYPES.contains(type)) throw new WorkspaceDenied(400, "InvalidResourceType");
        permissions.require(userId, "ai:" + type.toLowerCase(java.util.Locale.ROOT) + ":view");
    }

    @GetMapping("/internal/rc2/background/grants/{grantId}/models/available")
    public R<?> availableModels(@PathVariable UUID grantId,
        @RequestHeader("Authorization") String serviceAuthorization,
        @RequestHeader("X-Aion-Background-Secret") String secret) {
        execution.checkBackgroundService(serviceAuthorization);
        var authorized = grants.require(grantId, secret);
        models.checkIdentity(authorized.userId(), authorized.authVersion());
        return R.ok(models.models(authorized.userId()));
    }

    @GetMapping("/internal/rc2/background/grants/{grantId}/resources")
    public R<?> resources(@PathVariable UUID grantId, @RequestParam String type,
        @RequestParam String scope, @RequestParam int page,
        @RequestHeader("Authorization") String serviceAuthorization,
        @RequestHeader("X-Aion-Background-Secret") String secret) {
        long userId = owner(grantId, serviceAuthorization, secret);
        resourcePermission(userId, type);
        List<Map<String, Object>> items = resources.list(userId, type, scope, page);
        return R.ok(items.stream().filter(item -> item.get("actions") instanceof List<?> actions && actions.contains("USE") &&
            item.get("publishedVersion") != null).map(item -> {var active=new java.util.LinkedHashMap<>(item);active.put("version",item.get("publishedVersion"));return active;}).toList());
    }

    @GetMapping("/internal/rc2/background/grants/{grantId}/resources/{id}")
    public R<?> resource(@PathVariable UUID grantId, @PathVariable UUID id,
        @RequestHeader("Authorization") String serviceAuthorization,
        @RequestHeader("X-Aion-Background-Secret") String secret) {
        long userId = owner(grantId, serviceAuthorization, secret);
        Map<String, Object> item = resources.active(id, userId);
        String type = String.valueOf(item.get("resourceType"));
        resourcePermission(userId, type);
        if (!(item.get("actions") instanceof List<?> actions) || !actions.contains("USE") ||
            item.get("publishedVersion") == null || !item.get("publishedVersion").equals(item.get("version")))
            throw new WorkspaceDenied(403, "ResourcePermissionDenied");
        return R.ok(item);
    }

    @GetMapping("/internal/rc2/background/grants/{grantId}/mcp/connections")
    public R<?> mcpConnections(@PathVariable UUID grantId, @RequestParam UUID resourceId,
        @RequestHeader("Authorization") String serviceAuthorization,
        @RequestHeader("X-Aion-Background-Secret") String secret) {
        long userId = owner(grantId, serviceAuthorization, secret);
        permissions.require(userId, "ai:mcp:use");
        return R.ok(mcp.listForUser(resourceId, userId));
    }
}
