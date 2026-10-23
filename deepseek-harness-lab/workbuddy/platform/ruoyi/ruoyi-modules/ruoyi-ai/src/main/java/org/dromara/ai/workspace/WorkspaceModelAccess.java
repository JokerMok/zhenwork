package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.util.*;

@Service
@RequiredArgsConstructor
public class WorkspaceModelAccess {
    private final JdbcTemplate jdbc;
    private final WorkspacePermissions permissions;
    public void checkIdentity(long user,long version) {
        Boolean valid=jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM sys_user u JOIN ai_principal_state a ON a.user_id=u.user_id WHERE u.user_id=? AND u.status='0' AND u.del_flag='0' AND a.auth_version=? AND NOT a.must_change_password)",Boolean.class,user,version);
        if(!Boolean.TRUE.equals(valid))throw new WorkspaceDenied(403,"AuthorizationRevoked");
        permissions.require(user,"ai:model:use");
        permissions.require(user,"ai:session:use");
    }

    private static final String GRANTED="((m.id=(SELECT model_id FROM ai_office_defaults WHERE singleton) AND EXISTS(SELECT 1 FROM sys_user_role eu JOIN sys_role er ON er.role_id=eu.role_id WHERE eu.user_id=u.user_id AND er.role_key='workspace_employee' AND er.status='0' AND er.del_flag='0')) OR EXISTS(SELECT 1 FROM ai_model_policy g WHERE g.model_id=m.id AND (g.subject_type='ALL' OR (g.subject_type='USER' AND g.subject_id=u.user_id) OR (g.subject_type='DEPARTMENT' AND g.subject_id=u.dept_id AND EXISTS(SELECT 1 FROM sys_dept d WHERE d.dept_id=u.dept_id AND d.status='0' AND d.del_flag='0')) OR (g.subject_type='ROLE' AND EXISTS(SELECT 1 FROM sys_user_role ur JOIN sys_role r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND ur.role_id=g.subject_id AND r.status='0' AND r.del_flag='0')))))";
    public Map<String,Object> model(long user,UUID model) {
        var rows=jdbc.queryForList("SELECT m.id,m.name,m.code,m.version AS model_version,m.max_output_tokens,m.context_window,m.streaming,m.tools,m.default_parameters::text,m.cost_config::text,p.id AS provider_id,p.version AS provider_version,p.base_url,p.provider_type,p.timeout_seconds,p.retry_count FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id JOIN sys_user u ON u.user_id=? WHERE m.id=? AND u.status='0' AND u.del_flag='0' AND m.enabled AND p.enabled AND "+GRANTED,user,model);
        if(rows.size()!=1)throw new WorkspaceDenied(403,"ModelPermissionDenied");return rows.getFirst();
    }
    public List<Map<String,Object>> models(long user) {
        return jdbc.query("SELECT m.id,m.name,m.code,m.streaming,m.tools,m.context_window,m.max_output_tokens,m.id=(SELECT model_id FROM ai_office_defaults WHERE singleton) AS is_default FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id JOIN sys_user u ON u.user_id=? WHERE u.status='0' AND u.del_flag='0' AND m.enabled AND p.enabled AND "+GRANTED+" ORDER BY CASE WHEN m.id=(SELECT model_id FROM ai_office_defaults WHERE singleton) THEN 0 ELSE 1 END,m.name LIMIT 100",(r,n)->Map.<String,Object>of("id",r.getString(1),"name",r.getString(2),"code",r.getString(3),"streaming",r.getBoolean(4),"tools",r.getBoolean(5),"contextWindow",r.getInt(6),"maxOutputTokens",r.getInt(7),"source","ORGANIZATION","isDefault",r.getBoolean(8)),user);
    }
}
