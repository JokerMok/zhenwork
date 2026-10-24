package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.*;

@Service
@RequiredArgsConstructor
public class WorkspaceShareSupport {
    static final int MAX_GROUP_MEMBERS = 200;
    private final JdbcTemplate jdbc;
    private final AiResourceGuard guard;
    private final WorkspacePermissions permissions;
    private final WorkspaceModelAccess models;
    private final WorkspaceSkills skills;
    private final WorkspaceMcpAccess mcp;
    private final WorkspaceToolAccess tools;
    private final WorkspaceKnowledgeAccess knowledge;

    private record Dependency(String type, UUID id, String name) {}

    public Map<String,Object> preflight(UUID id,long actor,String subject,long subjectId,boolean use) {
        if(!Set.of("USER","ROLE","DEPARTMENT").contains(subject))throw new WorkspaceDenied(400,"InvalidShareSubject");
        var resource=guard.require(id,actor,AiResourceGuard.Action.SHARE);
        if(!guard.owner(resource,actor))throw new WorkspaceDenied(403,"OwnerSharingRequired");
        String targetName=targetName(subject,subjectId);
        boolean dynamic=!"USER".equals(subject);
        if(!use)return result(true,List.of(),0,dynamic);

        List<Dependency> dependencies=dependencies(id,resource,actor);
        List<Long> members=members(subject,subjectId);
        if(members.size()>MAX_GROUP_MEMBERS){
            var issue=issue("SUBJECT",Long.toString(subjectId),targetName,"ShareTargetTooLarge");
            return result(false,List.of(issue),0,dynamic);
        }
        if(members.isEmpty()){
            List<Map<String,Object>> issues=new ArrayList<>();
            issues.add(issue(resource.get("resource_type").toString(),id.toString(),Objects.toString(resource.get("name"),""),"NoActiveMembersToVerify"));
            for(var dependency:dependencies)issues.add(issue(dependency.type(),dependency.id().toString(),dependency.name(),"NoActiveMembersToVerify"));
            return result(false,issues,0,dynamic);
        }

        Map<String,Map<String,Object>> issues=new LinkedHashMap<>();
        String resourceType=resource.get("resource_type").toString();
        for(long member:members){
            try{permissions.require(member,guard.qualification(resourceType,AiResourceGuard.Action.USE));}catch(WorkspaceDenied denied){
                var issue=issue(resourceType,id.toString(),Objects.toString(resource.get("name"),""),denied.getMessage());
                issues.putIfAbsent(resourceType+"\n"+id+"\n"+denied.getMessage(),issue);
            }
            for(var dependency:dependencies)try{
                verify(dependency,member);
            }catch(WorkspaceDenied denied){
                var issue=issue(dependency.type(),dependency.id().toString(),dependency.name(),denied.getMessage());
                issues.putIfAbsent(dependency.type()+"\n"+dependency.id()+"\n"+denied.getMessage(),issue);
            }
        }
        return result(issues.isEmpty(),new ArrayList<>(issues.values()),members.size(),dynamic);
    }

    private Map<String,Object> result(boolean ready,List<Map<String,Object>> issues,int checkedUsers,boolean dynamic){
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("ready",ready);result.put("issues",issues);result.put("checkedUsers",checkedUsers);
        result.put("dynamicSubject",dynamic);result.put("futureMembersChecked",!dynamic);
        return result;
    }

    private Map<String,Object> issue(String type,String id,String name,String code){
        return Map.of("type",type,"id",id,"name",name,"code",code);
    }

    private String targetName(String subject,long subjectId){
        String sql=switch(subject){
            case "USER" -> "SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'";
            case "ROLE" -> "SELECT role_name FROM sys_role WHERE role_id=? AND status='0' AND del_flag='0'";
            default -> "SELECT dept_name FROM sys_dept WHERE dept_id=? AND status='0' AND del_flag='0'";
        };
        var names=jdbc.queryForList(sql,String.class,subjectId);
        if(names.size()!=1)throw new WorkspaceDenied(400,"ShareTargetUnavailable");
        return Objects.toString(names.getFirst(),"");
    }

    private List<Long> members(String subject,long subjectId){
        if("USER".equals(subject))return List.of(subjectId);
        if("ROLE".equals(subject))return jdbc.queryForList("SELECT u.user_id FROM sys_user_role ur JOIN sys_user u ON u.user_id=ur.user_id WHERE ur.role_id=? AND u.status='0' AND u.del_flag='0' ORDER BY u.user_id LIMIT ?",Long.class,subjectId,MAX_GROUP_MEMBERS+1);
        return jdbc.queryForList("SELECT u.user_id FROM sys_user u JOIN sys_dept d ON d.dept_id=u.dept_id WHERE u.dept_id=? AND u.status='0' AND u.del_flag='0' AND d.status='0' AND d.del_flag='0' ORDER BY u.user_id LIMIT ?",Long.class,subjectId,MAX_GROUP_MEMBERS+1);
    }

    private List<Dependency> dependencies(UUID id,Map<String,Object> resource,long actor){
        String type=resource.get("resource_type").toString();
        if(!Set.of("ASSISTANT","SKILL").contains(type))return List.of();
        Number version=(Number)resource.get("published_version");
        if(version==null)throw new WorkspaceDenied(400,"ActivateBeforeSharing");
        var rows=jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",id,version.intValue());
        if(rows.size()!=1)throw new WorkspaceDenied(404,"VersionNotFound");
        Map<String,Object> config=JsonUtils.parseMap(rows.getFirst().get("config").toString());
        List<Dependency> result=new ArrayList<>();
        if("ASSISTANT".equals(type)){
            Object model=config.get("modelId");if(model==null)throw new WorkspaceDenied(409,"InvalidResourceDependencies");
            add(result,"MODEL",List.of(model),actor);
            add(result,"SKILL",config.getOrDefault("skillIds",List.of()),actor);
            add(result,"MCP",config.getOrDefault("mcpIds",List.of()),actor);
            add(result,"TOOL",config.getOrDefault("toolIds",List.of()),actor);
            add(result,"KNOWLEDGE",config.getOrDefault("knowledgeIds",List.of()),actor);
        }else{
            Object raw=config.get("manifest");
            if(!(raw instanceof Map<?,?> manifest))throw new WorkspaceDenied(409,"InvalidSkillManifest");
            add(result,"SKILL",manifest.containsKey("dependencies")?manifest.get("dependencies"):List.of(),actor);
            add(result,"TOOL",manifest.containsKey("requiredTools")?manifest.get("requiredTools"):List.of(),actor);
        }
        return result;
    }

    private void add(List<Dependency> result,String type,Object raw,long actor){
        if(!(raw instanceof List<?> values))throw new WorkspaceDenied(409,"InvalidResourceDependencies");
        for(Object value:values){
            UUID id;try{id=UUID.fromString(value.toString());}catch(Exception exception){throw new WorkspaceDenied(409,"InvalidResourceDependencies");}
            result.add(new Dependency(type,id,dependencyName(type,id,actor)));
        }
    }

    private String dependencyName(String type,UUID id,long actor){
        if("MODEL".equals(type))try{return Objects.toString(models.model(actor,id).get("name"),"");}catch(WorkspaceDenied ignored){return "不可见模型";}
        try{return Objects.toString(guard.require(id,actor,AiResourceGuard.Action.VIEW).get("name"),"");}catch(WorkspaceDenied ignored){return "不可见资源";}
    }

    private void verify(Dependency dependency,long user){
        switch(dependency.type()){
            case "MODEL" -> models.model(user,dependency.id());
            case "SKILL" -> {var resolved=skills.resolve(List.of(dependency.id().toString()),user);tools.resolve(List.of(),resolved,user);}
            case "MCP" -> mcp.resolve(List.of(dependency.id().toString()),user);
            case "TOOL" -> tools.resolve(List.of(dependency.id().toString()),List.of(),user);
            case "KNOWLEDGE" -> knowledge.resolve(List.of(dependency.id().toString()),user);
            default -> throw new WorkspaceDenied(409,"InvalidResourceDependencies");
        }
    }
}
