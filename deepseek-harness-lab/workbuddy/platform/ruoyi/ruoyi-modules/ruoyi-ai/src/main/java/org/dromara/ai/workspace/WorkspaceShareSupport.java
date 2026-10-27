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

    public record Target(String subjectType, String subjectId) {}

    /** A fresh authorization plan, not a grant or a cached runtime capability. */
    public Map<String,Object> plan(UUID id,long actor,List<Target> targets,boolean use) {
        if(targets==null||targets.isEmpty()||targets.size()>50||new HashSet<>(targets).size()!=targets.size())throw new WorkspaceDenied(400,"InvalidShareTargets");
        var resource=guard.require(id,actor,AiResourceGuard.Action.SHARE);
        if(!guard.owner(resource,actor))throw new WorkspaceDenied(403,"OwnerSharingRequired");
        guard.require(id,actor,AiResourceGuard.Action.USE);
        List<Dependency> dependencies=use?allDependencies(id,resource,actor,new LinkedHashSet<>()):List.of();
        List<Map<String,Object>> additions=new ArrayList<>(),issues=new ArrayList<>(),recipients=new ArrayList<>();
        Set<Long> checkedMembers=new HashSet<>();
        for(var target:targets){
            long subjectId=targetId(target);String subject=target.subjectType();
            String name=targetName(subject,subjectId);
            List<Long> users=members(subject,subjectId);
            checkedMembers.addAll(users);
            if(checkedMembers.size()>MAX_GROUP_MEMBERS||checkedMembers.size()*Math.max(1,dependencies.size())>2000)throw new WorkspaceDenied(409,"ShareTargetTooLarge");
            recipients.add(Map.of("subjectType",subject,"subjectId",target.subjectId(),"name",name,"checkedUsers",users.size()));
            if(users.isEmpty()||users.size()>MAX_GROUP_MEMBERS){issues.add(issue("SUBJECT",target.subjectId(),name,users.isEmpty()?"NoActiveMembersToVerify":"ShareTargetTooLarge"));continue;}
            for(long user:users)if(use)try{permissions.require(user,guard.qualification(resource.get("resource_type").toString(),AiResourceGuard.Action.USE));}catch(WorkspaceDenied denied){issues.add(issue("SUBJECT",target.subjectId(),name,"PermissionDenied"));}
            for(var dependency:dependencies){
                boolean missing=!"USER".equals(subject)&&!scopeGranted(dependency,subject,subjectId);
                for(long user:users)try{verify(dependency,user);}catch(WorkspaceDenied denied){missing=true;if("PermissionDenied".equals(denied.getMessage()))issues.add(issue(dependency.type(),dependency.id().toString(),name+" / "+dependency.name(),"PermissionDenied"));}
                if(!missing)continue;
                try{
                    var grant=delegation(dependency,actor);
                    grant.put("subjectType",subject);grant.put("subjectId",target.subjectId());grant.put("subjectName",name);
                    additions.add(grant);
                }catch(WorkspaceDenied denied){issues.add(issue(dependency.type(),dependency.id().toString(),dependency.name(),denied.getMessage()));}
            }
        }
        var result=new LinkedHashMap<String,Object>();
        result.put("dependencyConfig",referenceConfig(id,resource));
        result.put("resourceVersion",resource.get("published_version"));result.put("resourceAuthVersion",resource.get("auth_version"));
        result.put("dependencies",dependencies.stream().map(d->d.type()+":"+d.id()).toList());
        result.put("recipients",recipients);result.put("additions",additions);result.put("issues",issues);result.put("ready",issues.isEmpty());
        // Include versions, scopes, targets and required additions in the confirmation fence.
        result.put("fingerprint",WorkspaceResources.hash(JsonUtils.toJsonString(result)));
        return result;
    }

    static long targetId(Target target){
        if(target==null||target.subjectType()==null||!Set.of("USER","ROLE","DEPARTMENT").contains(target.subjectType())||target.subjectId()==null||!target.subjectId().matches("[0-9]{1,19}"))throw new WorkspaceDenied(400,"InvalidShareSubject");
        try{return Long.parseLong(target.subjectId());}catch(Exception e){throw new WorkspaceDenied(400,"InvalidShareSubject");}
    }

    private List<Dependency> allDependencies(UUID id,Map<String,Object> resource,long actor,Set<UUID> visited){
        if(!visited.add(id))return List.of();
        if(visited.size()>64)throw new WorkspaceDenied(409,"TooManyResourceDependencies");
        Map<String,Dependency> result=new LinkedHashMap<>();
        for(var dependency:dependencies(id,resource,actor)){
            result.put(dependency.type()+dependency.id(),dependency);
            if("SKILL".equals(dependency.type())){
                var row=guard.require(dependency.id(),actor,AiResourceGuard.Action.USE);
                for(var nested:allDependencies(dependency.id(),row,actor,visited))result.put(nested.type()+nested.id(),nested);
            }
        }
        return new ArrayList<>(result.values());
    }

    private Map<String,Object> referenceConfig(UUID id,Map<String,Object> resource){
        var rows=jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",id,resource.get("published_version"));
        if(rows.size()!=1)throw new WorkspaceDenied(404,"VersionNotFound");
        var config=JsonUtils.parseMap(rows.getFirst().get("config").toString());
        var result=new LinkedHashMap<String,Object>();
        if("ASSISTANT".equals(resource.get("resource_type"))){
            result.put("modelId",config.get("modelId"));
            for(String key:List.of("skillIds","mcpIds","toolIds","knowledgeIds"))result.put(key,config.getOrDefault(key,List.of()));
        }else if("SKILL".equals(resource.get("resource_type"))){
            var manifest=(Map<?,?>)config.get("manifest");
            for(String key:List.of("dependencies","requiredTools"))result.put(key,manifest.containsKey(key)?manifest.get(key):List.of());
        }
        return result;
    }

    private boolean scopeGranted(Dependency dependency,String subject,long subjectId){
        if("MODEL".equals(dependency.type()))return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_office_defaults WHERE singleton AND model_id=?) OR EXISTS(SELECT 1 FROM ai_effective_model_policy WHERE model_id=? AND (subject_type='ALL' OR (subject_type=? AND subject_id=?)))",Boolean.class,dependency.id(),dependency.id(),subject,subjectId));
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_resource WHERE id=? AND visibility='ENTERPRISE_PUBLIC') OR EXISTS(SELECT 1 FROM ai_effective_resource_acl WHERE resource_id=? AND action='USE' AND subject_type=? AND subject_id=?)",Boolean.class,dependency.id(),dependency.id(),subject,subjectId));
    }

    /** Never infer that permission to use a resource includes permission to delegate it. */
    private Map<String,Object> delegation(Dependency dependency,long actor){
        var out=new LinkedHashMap<String,Object>();
        out.put("type",dependency.type());out.put("id",dependency.id().toString());out.put("name",dependency.name());
        out.put("key",dependency.type()+":"+dependency.id());
        if("MODEL".equals(dependency.type())){
            permissions.require(actor,"ai:model:admin");var model=models.model(actor,dependency.id());
            out.put("version",model.get("model_version"));out.put("sensitive",false);out.put("scope","模型调用；不包含密钥或供应商配置");return out;
        }
        verify(dependency,actor);
        var row=guard.require(dependency.id(),actor,AiResourceGuard.Action.SHARE);
        if(!guard.owner(row,actor))throw new WorkspaceDenied(403,"DependencyDelegationDenied");
        guard.require(dependency.id(),actor,AiResourceGuard.Action.USE);
        int version=((Number)row.get("published_version")).intValue();
        out.put("version",version);out.put("authVersion",row.get("auth_version"));
        boolean sensitive=!"TOOL".equals(dependency.type());
        String scope="查看和使用此资源；不包含编辑、转授或凭据";
        if("MCP".equals(dependency.type())){
            var enterpriseConnections=jdbc.queryForList("SELECT auth_version FROM ai_mcp_connection WHERE resource_id=? AND scope='ENTERPRISE' AND enabled AND status='READY' AND template_version=?",dependency.id(),version);
            if(enterpriseConnections.size()!=1)throw new WorkspaceDenied(409,"EnterpriseMcpConnectionRequired");
            out.put("connectionAuthVersion",enterpriseConnections.getFirst().get("auth_version"));
            var connections=jdbc.queryForList("SELECT e.business_unit,e.environment,e.tested_status,e.identity_verified,e.connector_type,e.allowed_methods::text,e.verified_identity::text FROM ai_external_connection e JOIN ai_mcp_connection c ON c.id=e.id WHERE c.resource_id=?",dependency.id());
            if(!connections.isEmpty()){
                var c=connections.getFirst();
                if(!"READY".equals(c.get("tested_status")))throw new WorkspaceDenied(409,"ExternalConnectionNotReady");
                if(Objects.toString(c.get("business_unit"),"").isBlank()||("CSWM_IOT".equals(c.get("connector_type"))&&!Boolean.TRUE.equals(c.get("identity_verified"))))throw new WorkspaceDenied(409,"DataScopeUnverified");
                scope="业务单位："+c.get("business_unit")+"；环境："+c.get("environment")+"；已开放只读方法："+c.get("allowed_methods")+"。授权后也可独立调用该连接；不授予凭据或任意数据源访问。";
                out.put("connectionScope",Objects.toString(c.get("verified_identity"),"{}"));
            }
            var config=JsonUtils.parseMap(guard.version(dependency.id(),version,actor,AiResourceGuard.Action.USE).get("config").toString());
            if(!(config.get("toolEffects") instanceof Map<?,?> effects)||effects.values().stream().anyMatch(effect->!"READ".equals(effect)))throw new WorkspaceDenied(409,"McpDelegationRequiresReadOnlyScope");
        }
        if("KNOWLEDGE".equals(dependency.type()))scope="可检索、预览和下载该知识库内有权使用的资料；不限于当前专家";
        out.put("sensitive",sensitive);out.put("scope",scope);return out;
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
            case "MODEL" -> {permissions.require(user,"ai:model:use");permissions.require(user,"ai:session:use");models.model(user,dependency.id());}
            case "SKILL" -> {var resolved=skills.resolve(List.of(dependency.id().toString()),user);tools.resolve(List.of(),resolved,user);}
            case "MCP" -> mcp.resolve(List.of(dependency.id().toString()),user);
            case "TOOL" -> tools.resolve(List.of(dependency.id().toString()),List.of(),user);
            case "KNOWLEDGE" -> knowledge.resolve(List.of(dependency.id().toString()),user);
            default -> throw new WorkspaceDenied(409,"InvalidResourceDependencies");
        }
    }
}
