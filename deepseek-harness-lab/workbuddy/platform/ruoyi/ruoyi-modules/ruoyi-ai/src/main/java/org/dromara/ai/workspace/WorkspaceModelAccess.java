package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
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

    private static final String ORGANIZATION_DEFAULT = """
        (m.id=(SELECT model_id FROM ai_office_defaults WHERE singleton)
         AND EXISTS(SELECT 1 FROM sys_user_role eu JOIN sys_role er ON er.role_id=eu.role_id
                    WHERE eu.user_id=u.user_id AND er.role_key='workspace_employee' AND er.status='0' AND er.del_flag='0'))
        """;
    private static final String MATCHES_SUBJECT = """
        (g.subject_type='ALL'
         OR (g.subject_type='USER' AND g.subject_id=u.user_id)
         OR (g.subject_type='DEPARTMENT' AND g.subject_id=u.dept_id
             AND EXISTS(SELECT 1 FROM sys_dept d WHERE d.dept_id=u.dept_id AND d.status='0' AND d.del_flag='0'))
         OR (g.subject_type='ROLE'
             AND EXISTS(SELECT 1 FROM sys_user_role ur JOIN sys_role r ON r.role_id=ur.role_id
                        WHERE ur.user_id=u.user_id AND ur.role_id=g.subject_id AND r.status='0' AND r.del_flag='0')))
        """;
    private static final String GRANTED = "(" + ORGANIZATION_DEFAULT
        + " OR EXISTS(SELECT 1 FROM ai_effective_model_policy g WHERE g.model_id=m.id AND " + MATCHES_SUBJECT + "))";

    private static final String CATALOG_FROM = """
        FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id JOIN sys_user u ON u.user_id=?
        WHERE u.status='0' AND u.del_flag='0' AND m.enabled AND p.enabled AND
        """ + GRANTED + """
        ORDER BY CASE WHEN m.id=(SELECT model_id FROM ai_office_defaults WHERE singleton) THEN 0 ELSE 1 END,m.name,m.id
        LIMIT 100
        """;
    private static final String SUBJECT_LABEL = """
        CASE g.subject_type
            WHEN 'DEPARTMENT' THEN (SELECT dept_name FROM sys_dept WHERE dept_id=g.subject_id)
            WHEN 'ROLE' THEN (SELECT role_name FROM sys_role WHERE role_id=g.subject_id)
        END
        """;

    // Preserve the provenance that ai_effective_model_policy merges for the runtime decision.
    private static final String EMPLOYEE_MODEL_ACCESS = """
        SELECT m.id, m.name, m.code, grants.sources,
               CASE
                 WHEN NOT m.enabled THEN 'MODEL_DISABLED'
                 WHEN NOT p.enabled THEN 'PROVIDER_DISABLED'
                 WHEN u.status<>'0' OR u.del_flag<>'0' OR a.user_id IS NULL THEN 'EMPLOYEE_INACTIVE'
                 WHEN a.must_change_password THEN 'PASSWORD_CHANGE_REQUIRED'
                 WHEN NOT ? THEN 'EMPLOYEE_PERMISSION_REQUIRED'
                 WHEN grants.sources IS NULL THEN 'NO_GRANT'
                 WHEN NOT m.streaming THEN 'STREAMING_REQUIRED'
                 WHEN c.id IS NULL THEN 'OUTSIDE_CATALOG'
                 ELSE 'AVAILABLE'
               END AS status
        FROM sys_user u
        LEFT JOIN ai_principal_state a ON a.user_id=u.user_id
        CROSS JOIN ai_model m
        JOIN ai_provider p ON p.id=m.provider_id
        LEFT JOIN catalog c ON c.id=m.id
        CROSS JOIN LATERAL (
            SELECT json_agg(row_to_json(source) ORDER BY source.type,source.label)::text AS sources
            FROM (
                SELECT 'ORGANIZATION_DEFAULT' AS type, NULL::text AS label WHERE %s
                UNION
                SELECT g.subject_type, %s FROM ai_model_policy g WHERE g.model_id=m.id AND %s
                UNION
                SELECT 'LINKED_' || g.subject_type, %s FROM ai_active_share_dependency g
                WHERE g.dependency_type='MODEL' AND g.dependency_id=m.id AND %s
            ) source
        ) grants
        WHERE u.user_id=? AND u.del_flag='0'
        """.formatted(ORGANIZATION_DEFAULT, SUBJECT_LABEL, MATCHES_SUBJECT, SUBJECT_LABEL, MATCHES_SUBJECT);

    public record EmployeeModelSource(String type, String label) {}
    public record EmployeeModel(UUID id, String name, String code, String status, List<EmployeeModelSource> sources) {}
    public record EmployeeModels(List<EmployeeModel> items, boolean hasMore) {}

    public EmployeeModels employeeModels(long user, UUID model, int page) {
        boolean canUse = permissions.has(user, "ai:model:use") && permissions.has(user, "ai:session:use");
        int pageSize = 30;
        int offset = (Math.max(1, Math.min(1000, page)) - 1) * pageSize;
        String sql = EMPLOYEE_MODEL_ACCESS;
        List<Object> arguments = new ArrayList<>(List.of(user, canUse, user));
        if (model != null) {
            sql += " AND m.id=?";
            arguments.add(model);
        }
        sql = "WITH catalog AS (SELECT m.id " + CATALOG_FROM + ") SELECT * FROM (" + sql + ") access ORDER BY (status='AVAILABLE') DESC,name,id LIMIT ? OFFSET ?";
        arguments.add(pageSize + 1);
        arguments.add(model == null ? offset : 0);
        var rows = jdbc.query(sql, (r, n) -> {
            String sources = r.getString("sources");
            return new EmployeeModel(r.getObject("id", UUID.class), r.getString("name"), r.getString("code"),
                r.getString("status"), sources == null ? List.of() : JsonUtils.parseArray(sources, EmployeeModelSource.class));
        }, arguments.toArray());
        return new EmployeeModels(List.copyOf(rows.subList(0, Math.min(pageSize, rows.size()))), rows.size() > pageSize);
    }

    public Map<String,Object> model(long user,UUID model) {
        var rows=jdbc.queryForList("SELECT m.id,m.name,m.code,m.version AS model_version,m.max_output_tokens,m.context_window,m.streaming,m.tools,m.default_parameters::text,m.cost_config::text,p.id AS provider_id,p.version AS provider_version,p.base_url,p.provider_type,p.timeout_seconds,p.retry_count FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id JOIN sys_user u ON u.user_id=? WHERE m.id=? AND u.status='0' AND u.del_flag='0' AND m.enabled AND p.enabled AND "+GRANTED,user,model);
        if(rows.size()!=1)throw new WorkspaceDenied(403,"ModelPermissionDenied");return rows.getFirst();
    }
    public List<Map<String,Object>> models(long user) {
        return jdbc.query("SELECT m.id,m.name,m.code,m.streaming,m.tools,m.context_window,m.max_output_tokens,m.id=(SELECT model_id FROM ai_office_defaults WHERE singleton) AS is_default " + CATALOG_FROM,(r,n)->Map.<String,Object>of("id",r.getString(1),"name",r.getString(2),"code",r.getString(3),"streaming",r.getBoolean(4),"tools",r.getBoolean(5),"contextWindow",r.getInt(6),"maxOutputTokens",r.getInt(7),"source","ORGANIZATION","isDefault",r.getBoolean(8)),user);
    }
}
