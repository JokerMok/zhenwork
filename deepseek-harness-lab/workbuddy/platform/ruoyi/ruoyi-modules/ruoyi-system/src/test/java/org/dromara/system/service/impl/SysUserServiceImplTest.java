package org.dromara.system.service.impl;

import org.dromara.common.core.exception.ServiceException;
import org.dromara.common.core.constant.SystemConstants;
import org.dromara.system.domain.SysRole;
import org.dromara.system.domain.bo.SysUserBo;
import jakarta.validation.Validation;
import org.dromara.system.domain.SysUserRole;
import org.dromara.system.mapper.*;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Collection;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class SysUserServiceImplTest {
    private final SysUserMapper userMapper = mock(SysUserMapper.class);
    private final SysDeptMapper deptMapper = mock(SysDeptMapper.class);
    private final SysRoleMapper roleMapper = mock(SysRoleMapper.class);
    private final SysPostMapper postMapper = mock(SysPostMapper.class);
    private final SysUserRoleMapper userRoleMapper = mock(SysUserRoleMapper.class);
    private final SysUserPostMapper userPostMapper = mock(SysUserPostMapper.class);
    private final SysUserServiceImpl service = new SysUserServiceImpl(
        userMapper, deptMapper, roleMapper, postMapper, userRoleMapper, userPostMapper);

    @Test
    void emptyRoleAuthorizationCannotReplaceSuperAdminRole() {
        assertThrows(ServiceException.class, () -> service.insertUserAuth(SystemConstants.SUPER_ADMIN_USER_ID, new Long[0]));
        verifyNoInteractions(roleMapper, userRoleMapper);
    }

    @Test
    void explicitRoleAuthorizationCannotReplaceSuperAdminRole() {
        assertThrows(ServiceException.class, () -> service.insertUserAuth(SystemConstants.SUPER_ADMIN_USER_ID, new Long[]{99L}));
        verifyNoInteractions(roleMapper, userRoleMapper);
    }

    @Test
    void nullRolesOnEditLeaveExistingRolesUntouched() throws Exception {
        invokeInsertUserRole(42L, null, true);
        verifyNoInteractions(roleMapper, userRoleMapper);
    }

    @Test
    void emptyRolesPassRequestValidationBeforeBaselineAssignment() {
        SysUserBo user = new SysUserBo();
        user.setRoleIds(new Long[0]);
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            assertEquals(0, factory.getValidator().validateProperty(user,"roleIds").size());
        }
    }

    @Test
    void emptyRolesOnOrdinaryCreateAssignEmployeeBaseline() throws Exception {
        SysRole employee = new SysRole();
        employee.setRoleId(1802000000000000099L);
        when(roleMapper.selectOne(any())).thenReturn(employee);

        invokeInsertUserRole(42L, new Long[0], false);

        @SuppressWarnings("unchecked")
        var roles = (Collection<SysUserRole>) mockingDetails(userRoleMapper).getInvocations().stream()
            .filter(invocation -> invocation.getMethod().getName().equals("insertBatch"))
            .findFirst().orElseThrow().getArgument(0);
        assertEquals(1, roles.size());
        SysUserRole assigned = roles.iterator().next();
        assertEquals(42L, assigned.getUserId());
        assertEquals(employee.getRoleId(), assigned.getRoleId());
    }

    private void invokeInsertUserRole(Long userId, Long[] roleIds, boolean clear) throws Exception {
        Method method = SysUserServiceImpl.class.getDeclaredMethod(
            "insertUserRole", Long.class, Long[].class, boolean.class);
        method.setAccessible(true);
        try {
            method.invoke(service, userId, roleIds, clear);
        } catch (InvocationTargetException error) {
            if (error.getCause() instanceof Exception exception) throw exception;
            throw error;
        }
    }
}
