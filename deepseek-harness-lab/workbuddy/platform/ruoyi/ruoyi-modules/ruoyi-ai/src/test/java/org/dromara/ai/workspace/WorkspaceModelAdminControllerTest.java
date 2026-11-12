package org.dromara.ai.workspace;

import org.dromara.common.core.exception.ServiceException;
import org.dromara.system.service.ISysUserService;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

@Tag("local")
class WorkspaceModelAdminControllerTest {
    private final WorkspacePrincipal principals = mock(WorkspacePrincipal.class);
    private final WorkspaceModelAccess access = mock(WorkspaceModelAccess.class);
    private final ISysUserService users = mock(ISysUserService.class);
    private final WorkspaceModelAdminController controller = new WorkspaceModelAdminController(
        mock(WorkspaceModelAdmin.class), principals, access, users);

    @Test
    void employeeModelQueryRequiresBothPermissionsAndChecksOrganizationScope() {
        long employee = 17L;
        UUID model = UUID.randomUUID();
        var result = new WorkspaceModelAccess.EmployeeModels(List.of(), false);
        when(principals.require("ai:model:admin")).thenReturn(new WorkspacePrincipal.Actor(10L, 1L, false));
        when(access.employeeModels(employee, model, 2)).thenReturn(result);

        assertSame(result, controller.employeeAccess(employee, model, 2).getData());

        var ordered = inOrder(principals, users, access);
        ordered.verify(principals).require("ai:model:admin");
        ordered.verify(principals).require("system:user:list");
        ordered.verify(users).checkUserDataScope(employee);
        ordered.verify(access).employeeModels(employee, model, 2);
    }

    @Test
    void outOfScopeEmployeeDoesNotReachModelQuery() {
        long employee = 17L;
        when(principals.require("ai:model:admin")).thenReturn(new WorkspacePrincipal.Actor(10L, 1L, false));
        doThrow(new ServiceException("Forbidden")).when(users).checkUserDataScope(employee);

        assertThrows(ServiceException.class, () -> controller.employeeAccess(employee, null, 1));

        verifyNoInteractions(access);
    }
}
