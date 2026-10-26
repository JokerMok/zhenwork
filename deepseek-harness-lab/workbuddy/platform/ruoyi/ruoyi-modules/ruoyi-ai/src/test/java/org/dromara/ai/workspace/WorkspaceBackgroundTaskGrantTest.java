package org.dromara.ai.workspace;

import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Tag;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@Tag("dev")
class WorkspaceBackgroundTaskGrantTest {
    @org.junit.jupiter.api.BeforeAll
    static void configureJson() {
        var context = new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(tools.jackson.databind.json.JsonMapper.class, () -> tools.jackson.databind.json.JsonMapper.builder().build());
        context.refresh();
        new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }

    @Test
    void acceptsTaskScopedIdsAndPreservesEmployeeAuthorizationChecks() {
        var jdbc = mock(JdbcTemplate.class);
        var tx = mock(TransactionTemplate.class);
        var principals = mock(WorkspacePrincipal.class);
        var permissions = mock(WorkspacePermissions.class);
        var grants = new WorkspaceBackgroundGrants(jdbc, tx, principals, permissions);
        var actor = new WorkspacePrincipal.Actor(17L, 4L, false);
        String task = "task_" + UUID.randomUUID();
        var issued = grants.issue(actor, task);
        assertEquals(task, issued.jobId());
        assertEquals(64, issued.secret().length());
        verify(principals).requireActiveVersion(17L, 4L);
        verify(permissions).require(17L, "ai:session:use");
        assertThrows(WorkspaceDenied.class, () -> grants.issue(actor, "arbitrary-user-selected-key"));
    }

    @Test
    void releaseUsesTheAuthorizedGrantOwnerAndScope() {
        var principals = mock(WorkspacePrincipal.class);
        var grants = mock(WorkspaceBackgroundGrants.class);
        var execution = mock(ExecutionCredentials.class);
        var controller = new WorkspaceBackgroundGrantController(principals, grants, execution);
        var id = UUID.randomUUID();
        String job = "task_" + UUID.randomUUID();
        when(grants.require(id, "test-secret")).thenReturn(new WorkspaceBackgroundGrants.Authorized(17L, 4L, job));
        controller.release(id, "Bearer test-service", "test-secret");
        verify(execution).checkBackgroundService("Bearer test-service");
        verify(grants).revoke(17L, job);
        verifyNoInteractions(principals);
    }

    @Test
    void revokedGrantCannotReleaseAnotherTask() {
        var grants = mock(WorkspaceBackgroundGrants.class);
        var controller = new WorkspaceBackgroundGrantController(mock(WorkspacePrincipal.class), grants, mock(ExecutionCredentials.class));
        var id = UUID.randomUUID();
        when(grants.require(id, "test-secret")).thenThrow(new WorkspaceDenied(401, "BackgroundAuthorizationRevoked"));
        assertThrows(WorkspaceDenied.class, () -> controller.release(id, "Bearer test-service", "test-secret"));
        verify(grants, never()).revoke(anyLong(), anyString());
    }
}
