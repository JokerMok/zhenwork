package org.dromara.ai.workspace;

import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

class WorkspaceBackgroundCatalogControllerTest {
    private final WorkspaceBackgroundGrants grants = mock(WorkspaceBackgroundGrants.class);
    private final ExecutionCredentials execution = mock(ExecutionCredentials.class);
    private final WorkspacePermissions permissions = mock(WorkspacePermissions.class);
    private final WorkspaceModelAccess models = mock(WorkspaceModelAccess.class);
    private final WorkspaceResources resources = mock(WorkspaceResources.class);
    private final WorkspaceMcpController mcp = mock(WorkspaceMcpController.class);
    private final WorkspaceBackgroundCatalogController controller = new WorkspaceBackgroundCatalogController(
        grants, execution, permissions, models, resources, mcp, mock(WorkspaceToolAccess.class));
    private final UUID grantId = UUID.fromString("11111111-1111-4111-8111-111111111111");

    @Test
    void backgroundCatalogDelegatesOnlyToAvailableScope() {
        authorize();
        when(resources.list(17L, "SKILL", "available", 2)).thenReturn(List.of(Map.of(
            "id", "resource-1", "actions", List.of("USE"), "publishedVersion", 3, "version", 3)));

        controller.resources(grantId, "SKILL", "available", 2, "Bearer service", "a".repeat(64));

        verify(resources).list(17L, "SKILL", "available", 2);
    }

    @Test
    void backgroundCatalogRejectsLegacyClientSelectedScopes() {
        authorize();

        WorkspaceDenied denied = assertThrows(WorkspaceDenied.class, () ->
            controller.resources(grantId, "SKILL", "shared", 1, "Bearer service", "a".repeat(64)));

        assertEquals(400, denied.status);
        assertEquals("InvalidResourceFilter", denied.getMessage());
        verifyNoInteractions(resources);
    }

    private void authorize() {
        when(grants.require(grantId, "a".repeat(64)))
            .thenReturn(new WorkspaceBackgroundGrants.Authorized(17L, 4L, "cron_12345678"));
    }
}
