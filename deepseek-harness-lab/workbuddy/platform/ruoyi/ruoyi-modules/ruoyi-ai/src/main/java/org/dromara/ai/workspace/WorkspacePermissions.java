package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.core.constant.SystemConstants;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Reads native RuoYi qualifications for background work; it never grants resource ownership. */
@Service
@RequiredArgsConstructor
public class WorkspacePermissions {
    private final JdbcTemplate jdbc;
    public boolean has(long user,String permission) {
        if(SystemConstants.SUPER_ADMIN_USER_ID.equals(user))return true;
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM sys_user_role ur JOIN sys_role r ON r.role_id=ur.role_id JOIN sys_role_menu rm ON rm.role_id=r.role_id JOIN sys_menu m ON m.menu_id=rm.menu_id WHERE ur.user_id=? AND r.status='0' AND r.del_flag='0' AND m.status='0' AND m.perms=?)",Boolean.class,user,permission));
    }
    public void require(long user,String permission){if(!has(user,permission))throw new WorkspaceDenied(403,"PermissionDenied");}
}
