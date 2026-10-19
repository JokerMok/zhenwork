package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.util.*;

@Service
@RequiredArgsConstructor
public class AiResourceGuard {
    public enum Action { VIEW,USE,EDIT,SHARE,PUBLISH,DELETE,GOVERN }
    private final JdbcTemplate jdbc;
    private final WorkspacePermissions permissions;
    public String qualification(String type,Action action){return switch(action){case SHARE,PUBLISH,GOVERN->"ai:resource:"+action.name().toLowerCase(Locale.ROOT);default->"ai:"+type.toLowerCase(Locale.ROOT)+":"+action.name().toLowerCase(Locale.ROOT);};}
    public boolean owner(Map<String,Object> row,long user){return "USER".equals(row.get("owner_type"))?Long.toString(user).equals(Objects.toString(row.get("owner_user_id"))):permissions.has(user,"ai:resource:enterprise");}
    public boolean acl(UUID id,long user,Action action) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_resource_acl a WHERE a.resource_id=? AND a.action=? AND ((a.subject_type='USER' AND a.subject_id=?) OR (a.subject_type='ROLE' AND EXISTS(SELECT 1 FROM sys_user_role ur JOIN sys_role r ON r.role_id=ur.role_id WHERE ur.user_id=? AND r.role_id=a.subject_id AND r.status='0' AND r.del_flag='0')) OR (a.subject_type='DEPARTMENT' AND EXISTS(SELECT 1 FROM sys_user u WHERE u.user_id=? AND u.dept_id=a.subject_id))))",Boolean.class,id,action.name(),user,user,user));
    }
    public Map<String,Object> require(UUID id,long user,Action action) {
        var rows=jdbc.queryForList("SELECT * FROM ai_resource WHERE id=?",id);if(rows.size()!=1)throw new WorkspaceDenied(404,"ResourceNotFound");var row=rows.getFirst();
        permissions.require(user,qualification(row.get("resource_type").toString(),action));
        // GOVERN permits explicit metadata governance only; callers must not serialize private config/name.
        if(action==Action.GOVERN)return row;
        boolean publicAccess="ENTERPRISE_PUBLIC".equals(row.get("visibility")) && "ACTIVE".equals(row.get("lifecycle_state")) && row.get("published_version")!=null && (action==Action.VIEW||action==Action.USE);
        if(!owner(row,user)&&!publicAccess&&!acl(id,user,action))throw new WorkspaceDenied(404,"ResourceNotFound");
        if(action==Action.USE&&(!Boolean.TRUE.equals(row.get("enabled"))||Boolean.TRUE.equals(row.get("security_disabled"))||!"ACTIVE".equals(row.get("lifecycle_state"))||row.get("published_version")==null))throw new WorkspaceDenied(403,"ResourceUnavailable");
        return row;
    }
    public Map<String,Object> version(UUID id,int version,long user,Action action) {
        var resource=require(id,user,action);
        if(action==Action.GOVERN)throw new WorkspaceDenied(403,"PrivateContentNotGovernanceMetadata");
        // Recipients see only the published version. Owners/editors can inspect their drafts.
        if(!owner(resource,user)&&!acl(id,user,Action.EDIT)&&!Objects.equals(resource.get("published_version"),version))throw new WorkspaceDenied(404,"VersionNotFound");
        var rows=jdbc.queryForList("SELECT config::text,metadata::text,content_hash,review_state FROM ai_resource_version WHERE resource_id=? AND version=?",id,version);if(rows.size()!=1)throw new WorkspaceDenied(404,"VersionNotFound");return rows.getFirst();
    }
    public void pinned(UUID id,int version,long expectedAuth,long user) {
        var resource=require(id,user,Action.USE);
        if(((Number)resource.get("auth_version")).longValue()!=expectedAuth)throw new WorkspaceDenied(403,"ResourceAuthorizationRevoked");
        if(!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_resource_version WHERE resource_id=? AND version=?)",Boolean.class,id,version)))throw new WorkspaceDenied(403,"ResourceVersionUnavailable");
    }
}
