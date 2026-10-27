package org.dromara.ai.workspace;

import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

@Service
public class WorkspaceResources {
    public static final Set<String> TYPES=Set.of("ASSISTANT","SKILL","MCP","TOOL","KNOWLEDGE");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final WorkspacePermissions permissions;
    private final AiResourceGuard guard;
    private final WorkspaceConversations conversations;
    private final WorkspaceAssistantReadiness readiness;
    private final WorkspaceShareSupport shareSupport;
    public WorkspaceResources(JdbcTemplate jdbc,TransactionTemplate tx,WorkspacePermissions permissions,AiResourceGuard guard,WorkspaceConversations conversations,WorkspaceAssistantReadiness readiness,WorkspaceShareSupport shareSupport){this.jdbc=jdbc;this.tx=tx;this.permissions=permissions;this.guard=guard;this.conversations=conversations;this.readiness=readiness;this.shareSupport=shareSupport;}
    static String hash(String content){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException();}}
    private String config(String type,Map<String,Object> data){
        if(data==null)throw new WorkspaceDenied(400,"ConfigurationRequired");
        if(type.equals("ASSISTANT")){
            if(!Set.of("avatar","instruction","modelId","skillIds","mcpIds","toolIds","knowledgeIds").containsAll(data.keySet())||!(data.get("instruction") instanceof String instruction)||instruction.isBlank()||instruction.length()>4000)throw new WorkspaceDenied(400,"InvalidAssistantConfiguration");
            if(data.containsKey("avatar")&&(!(data.get("avatar") instanceof String avatar)||avatar.length()>12))throw new WorkspaceDenied(400,"InvalidAssistantAvatar");
            for(String key:List.of("skillIds","mcpIds","toolIds","knowledgeIds")){Object value=data.get(key);if(value==null)continue;if(!(value instanceof List<?> ids)||ids.size()>(key.equals("toolIds")?16:8)||new HashSet<>(ids).size()!=ids.size())throw new WorkspaceDenied(400,"InvalidAssistantDependencies");for(Object item:ids)try{UUID.fromString(item.toString());}catch(Exception e){throw new WorkspaceDenied(400,"InvalidAssistantDependencies");}}
            try{UUID.fromString(Objects.toString(data.get("modelId")));}catch(Exception e){throw new WorkspaceDenied(400,"ModelRequired");}
        }else if(type.equals("KNOWLEDGE")){if(!data.keySet().equals(Set.of("format"))||!"TEXT_V1".equals(data.get("format")))throw new WorkspaceDenied(400,"UnsupportedKnowledgeFormat");}else if(type.equals("TOOL")){return JsonUtils.toJsonString(WorkspaceToolAccess.configuration(data));}else if(type.equals("MCP")){return JsonUtils.toJsonString(WorkspaceMcpAccess.configuration(data));}else if(type.equals("SKILL")){return JsonUtils.toJsonString(WorkspaceSkills.parse(data));}else if(!data.isEmpty())throw new WorkspaceDenied(400,"ResourceFormatNotEnabledYet");
        return JsonUtils.toJsonString(new TreeMap<>(data));
    }
    private void audit(long actor,String action,UUID resource,Map<String,Object> metadata){jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,?,?,?::jsonb)",UUID.randomUUID(),actor,action,resource,JsonUtils.toJsonString(metadata));}
    public Map<String,Object> create(long actor,String type,String name,String description,boolean enterprise,Map<String,Object> data,UUID key){
        if(!TYPES.contains(type))throw new WorkspaceDenied(400,"InvalidResourceType");permissions.require(actor,"ai:"+type.toLowerCase(Locale.ROOT)+":create");if(enterprise)permissions.require(actor,"ai:resource:enterprise");String json=config(type,data);
        UUID id=tx.execute(status->{
            jdbc.queryForObject("SELECT user_id FROM sys_user WHERE user_id=? FOR UPDATE",Long.class,actor);
            String digest=hash(type+"\n"+name+"\n"+description+"\n"+enterprise+"\n"+json);var old=jdbc.queryForList("SELECT input_hash,result::text FROM ai_command WHERE actor_user_id=? AND operation='resource.create' AND idempotency_key=?",actor,key);
            if(!old.isEmpty()){if(!digest.equals(old.getFirst().get("input_hash")))throw new WorkspaceDenied(409,"IdempotencyConflict");return UUID.fromString(JsonUtils.parseMap(old.getFirst().get("result").toString()).getStr("id"));}
            UUID resource=UUID.randomUUID();jdbc.update("INSERT INTO ai_resource(id,resource_type,owner_type,owner_user_id,name,description,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)",resource,type,enterprise?"ENTERPRISE":"USER",enterprise?null:actor,name,description,actor,actor);
            if(type.equals("KNOWLEDGE"))jdbc.update("INSERT INTO ai_knowledge_base(resource_id) VALUES(?)",resource);
            jdbc.update("INSERT INTO ai_resource_version(resource_id,version,config,content_hash,created_by,metadata) VALUES(?,1,?::jsonb,?,?,?::jsonb)",resource,json,hash(json),actor,JsonUtils.toJsonString(Map.of("name",name,"description",description)));
            jdbc.update("INSERT INTO ai_command(actor_user_id,operation,idempotency_key,input_hash,result) VALUES(?,'resource.create',?,?,?::jsonb)",actor,key,digest,JsonUtils.toJsonString(Map.of("id",resource.toString())));audit(actor,"resource.created",resource,Map.of("type",type));return resource;
        });return get(id,actor);
    }
    public Map<String,Object> get(UUID id,long actor){var row=guard.require(id,actor,AiResourceGuard.Action.VIEW);int version=((Number)(guard.owner(row,actor)||guard.acl(id,actor,AiResourceGuard.Action.EDIT)?row.get("latest_version"):row.get("published_version"))).intValue();var v=guard.version(id,version,actor,AiResourceGuard.Action.VIEW);return dto(row,v,version,actor,true);}
    public Map<String,Object> active(UUID id,long actor){var row=guard.require(id,actor,AiResourceGuard.Action.USE);readiness.requireDependencies(id,row.get("resource_type").toString(),actor);int version=((Number)row.get("published_version")).intValue();var v=guard.version(id,version,actor,AiResourceGuard.Action.USE);return dto(row,v,version,actor,true);}
    public List<Map<String,Object>> versions(UUID id,long actor){var row=guard.require(id,actor,AiResourceGuard.Action.VIEW);if(!guard.owner(row,actor)&&!guard.acl(id,actor,AiResourceGuard.Action.EDIT))throw new WorkspaceDenied(403,"VersionHistoryRequiresEdit");return jdbc.queryForList("SELECT version,review_state,content_hash,created_by::text,created_at::text FROM ai_resource_version WHERE resource_id=? ORDER BY version DESC LIMIT 200",id);}
    public Map<String,Object> version(UUID id,int version,long actor){var row=guard.require(id,actor,AiResourceGuard.Action.VIEW);if(!guard.owner(row,actor)&&!guard.acl(id,actor,AiResourceGuard.Action.EDIT))throw new WorkspaceDenied(403,"VersionHistoryRequiresEdit");return dto(row,guard.version(id,version,actor,AiResourceGuard.Action.VIEW),version,actor,true);}
    private Map<String,Object> dto(Map<String,Object> row,Map<String,Object> version,int number,long actor,boolean content){
        Map<String,Object> value=new LinkedHashMap<>();for(var field:Map.of("resource_type","resourceType","owner_type","ownerType","visibility","visibility","lifecycle_state","lifecycleState","enabled","enabled","name","name","description","description").entrySet())value.put(field.getValue(),row.get(field.getKey()));
        var metadata=JsonUtils.parseMap(version.get("metadata").toString());value.put("name",metadata.get("name"));value.put("description",metadata.get("description"));
        if("ASSISTANT".equals(row.get("resource_type")))value.put("avatar",JsonUtils.parseMap(version.get("config").toString()).getOrDefault("avatar","✦"));value.put("id",row.get("id").toString());value.put("ownerUserId",row.get("owner_user_id")==null?null:row.get("owner_user_id").toString());value.put("version",number);value.put("publishedVersion",row.get("published_version"));value.put("securityDisabled",row.get("security_disabled"));value.put("reviewState",version.get("review_state"));value.put("updatedAt",row.get("updated_at").toString());
        List<String> actions=new ArrayList<>();for(var action:AiResourceGuard.Action.values())if(action!=AiResourceGuard.Action.GOVERN)try{guard.require((UUID)row.get("id"),actor,action);actions.add(action.name());}catch(WorkspaceDenied ignored){}value.put("actions",actions);if(content)value.put("config",JsonUtils.parseMap(version.get("config").toString()));return value;
    }
    public List<Map<String,Object>> list(long actor,String type,String scope,int page){
        if(!TYPES.contains(type)||!Set.of("mine","shared","public","enterprise","available").contains(scope))throw new WorkspaceDenied(400,"InvalidResourceFilter");permissions.require(actor,"ai:"+type.toLowerCase(Locale.ROOT)+":view");
        if(scope.equals("available"))return available(actor,type,page);
        if(scope.equals("enterprise"))permissions.require(actor,"ai:resource:enterprise");String predicate=switch(scope){case "enterprise"->"r.owner_type='ENTERPRISE' AND ? IS NOT NULL";case "mine"->"r.owner_type='USER' AND r.owner_user_id=?";case "public"->"r.visibility='ENTERPRISE_PUBLIC' AND r.lifecycle_state='ACTIVE' AND r.published_version IS NOT NULL AND ? IS NOT NULL";default->"r.published_version IS NOT NULL AND EXISTS(SELECT 1 FROM ai_effective_resource_acl a WHERE a.resource_id=r.id AND a.action='VIEW' AND ((a.subject_type='USER' AND a.subject_id=?) OR (a.subject_type='ROLE' AND a.subject_id IN(SELECT role_id FROM sys_user_role WHERE user_id=?)) OR (a.subject_type='DEPARTMENT' AND a.subject_id=(SELECT dept_id FROM sys_user WHERE user_id=?))))";};
        List<Object> args=new ArrayList<>();args.add(type);args.add(actor);if(scope.equals("shared")){args.add(actor);args.add(actor);}args.add((Math.min(1000,Math.max(1,page))-1)*30);
        var ids=jdbc.queryForList("SELECT r.id FROM ai_resource r WHERE r.lifecycle_state<>'ARCHIVED' AND r.resource_type=? AND "+predicate+" ORDER BY r.updated_at DESC LIMIT 30 OFFSET ?",UUID.class,args.toArray());List<Map<String,Object>> result=new ArrayList<>();for(UUID id:ids)try{var item=get(id,actor);item.remove("config");result.add(item);}catch(WorkspaceDenied ignored){}return result;
    }
    /** Canonical effective catalog. Execution reuses the same guard and published version checks. */
    public List<Map<String,Object>> available(long actor,String type,int page){
        permissions.require(actor,"ai:"+type.toLowerCase(Locale.ROOT)+":use");
        var ids=jdbc.queryForList("SELECT r.id FROM ai_resource r WHERE r.resource_type=? AND r.enabled AND NOT r.security_disabled AND r.lifecycle_state='ACTIVE' AND r.published_version IS NOT NULL AND (r.owner_user_id=? OR (r.owner_type='ENTERPRISE' AND ?) OR r.visibility='ENTERPRISE_PUBLIC' OR EXISTS(SELECT 1 FROM ai_effective_resource_acl a WHERE a.resource_id=r.id AND a.action='USE' AND ((a.subject_type='USER' AND a.subject_id=?) OR (a.subject_type='ROLE' AND EXISTS(SELECT 1 FROM sys_user_role ur JOIN sys_role s ON s.role_id=ur.role_id WHERE ur.user_id=? AND s.role_id=a.subject_id AND s.status='0' AND s.del_flag='0')) OR (a.subject_type='DEPARTMENT' AND EXISTS(SELECT 1 FROM sys_user u JOIN sys_dept d ON d.dept_id=u.dept_id WHERE u.user_id=? AND u.dept_id=a.subject_id AND d.status='0' AND d.del_flag='0'))))) ORDER BY r.updated_at DESC,r.id LIMIT 30 OFFSET ?",UUID.class,type,actor,permissions.has(actor,"ai:resource:enterprise"),actor,actor,actor,(Math.min(1000,Math.max(1,page))-1)*30);
        List<Map<String,Object>> result=new ArrayList<>();
        for(UUID id:ids)try{var item=active(id,actor);item.remove("config");item.put("source",Long.toString(actor).equals(item.get("ownerUserId"))?"PERSONAL":"ORGANIZATION");result.add(item);}catch(WorkspaceDenied ignored){/* Permission can change after selecting the page. */}
        return result;
    }
    public Map<String,Object> edit(UUID id,long actor,int expected,String name,String description,Map<String,Object> data){
        tx.executeWithoutResult(status->{jdbc.queryForList("SELECT id FROM ai_resource WHERE id=? FOR UPDATE",id);var resource=guard.require(id,actor,AiResourceGuard.Action.EDIT);if(((Number)resource.get("latest_version")).intValue()!=expected)throw new WorkspaceDenied(409,"VersionConflict");String json=config(resource.get("resource_type").toString(),data);int next=expected+1;
            jdbc.update("INSERT INTO ai_resource_version(resource_id,version,config,content_hash,created_by,metadata) VALUES(?,?,?::jsonb,?,?,?::jsonb)",id,next,json,hash(json),actor,JsonUtils.toJsonString(Map.of("name",name,"description",description)));
            jdbc.update("UPDATE ai_resource SET latest_version=?,name=?,description=?,updated_by=?,updated_at=NOW() WHERE id=?",next,name,description,actor,id);audit(actor,"resource.version.created",id,Map.of("version",next));
        });return get(id,actor);
    }
    public Map<String,Object> activate(UUID id,long actor,int version){
        boolean[] changed={false};tx.executeWithoutResult(status->{jdbc.queryForList("SELECT id FROM ai_resource WHERE id=? FOR UPDATE",id);var r=guard.require(id,actor,AiResourceGuard.Action.EDIT);if(!guard.owner(r,actor))throw new WorkspaceDenied(403,"OwnerActivationRequired");
            if(!Set.of("ASSISTANT","SKILL","MCP","TOOL","KNOWLEDGE").contains(r.get("resource_type")))throw new WorkspaceDenied(400,"ResourceExecutionNotEnabledYet");
            if(!"SKILL".equals(r.get("resource_type"))&&((Number)r.get("latest_version")).intValue()!=version)throw new WorkspaceDenied(409,"VersionConflict");
            if(r.get("visibility").equals("ENTERPRISE_PUBLIC"))throw new WorkspaceDenied(403,"PublicationReviewRequired");
            guard.version(id,version,actor,AiResourceGuard.Action.EDIT);if("ASSISTANT".equals(r.get("resource_type")))readiness.requireDraft(id,version,actor);changed[0]=!Objects.equals(r.get("published_version"),version);jdbc.update("UPDATE ai_resource SET published_version=?,lifecycle_state='ACTIVE',auth_version=auth_version+CASE WHEN published_version IS DISTINCT FROM ? THEN 1 ELSE 0 END,updated_by=?,updated_at=NOW() WHERE id=?",version,version,actor,id);audit(actor,"resource.version.activated",id,Map.of("version",version));
        });if(changed[0])conversations.revokeResource(id);return active(id,actor);
    }
    public Map<String,Object> share(UUID id,long actor,String subject,long subjectId,Set<String> actions){
        return share(id,actor,subject,subjectId,actions,false);
    }
    private Map<String,Object> share(UUID id,long actor,String subject,long subjectId,Set<String> actions,boolean planned){
        if(!Set.of("USER","ROLE","DEPARTMENT").contains(subject)||actions.isEmpty()||!Set.of("VIEW","USE","EDIT").containsAll(actions)||!actions.contains("VIEW"))throw new WorkspaceDenied(400,"InvalidShareActions");
        boolean[] revoke={false};Map<String,Object> result=tx.execute(status->{jdbc.queryForList("SELECT id FROM ai_resource WHERE id=? FOR UPDATE",id);var r=guard.require(id,actor,AiResourceGuard.Action.SHARE);if(!guard.owner(r,actor))throw new WorkspaceDenied(403,"OwnerSharingRequired");if(r.get("published_version")==null)throw new WorkspaceDenied(400,"ActivateBeforeSharing");
            String table=switch(subject){case "USER"->"sys_user";case "ROLE"->"sys_role";default->"sys_dept";};String column=switch(subject){case "USER"->"user_id";case "ROLE"->"role_id";default->"dept_id";};if(!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM "+table+" WHERE "+column+"=? AND status='0' AND del_flag='0')",Boolean.class,subjectId)))throw new WorkspaceDenied(400,"ShareTargetUnavailable");
            if(!planned&&actions.contains("USE")&&!Boolean.TRUE.equals(shareSupport.preflight(id,actor,subject,subjectId,true).get("ready")))throw new WorkspaceDenied(409,"ShareDependenciesUnavailable");
            String array="{"+String.join(",",new TreeSet<>(actions))+"}";
            var existing=jdbc.queryForList("SELECT id::text,(actions @> ?::text[] AND actions <@ ?::text[]) AS same,NOT(actions <@ ?::text[]) AS reduced FROM ai_resource_share WHERE resource_id=? AND subject_type=? AND subject_id=? AND status='ACTIVE'",array,array,array,id,subject,subjectId);
            if(!existing.isEmpty()){
                UUID share=UUID.fromString(existing.getFirst().get("id").toString());
                if(Boolean.TRUE.equals(existing.getFirst().get("same")))return Map.of("id",share.toString(),"mode","REFERENCE","changed",false);
                revoke[0]=Boolean.TRUE.equals(existing.getFirst().get("reduced"));
                jdbc.update("UPDATE ai_resource_share SET actions=?::text[],shared_by=? WHERE id=?",array,actor,share);
                jdbc.update("DELETE FROM ai_resource_acl WHERE resource_id=? AND subject_type=? AND subject_id=?",id,subject,subjectId);
                for(String action:actions)jdbc.update("INSERT INTO ai_resource_acl(resource_id,subject_type,subject_id,action,granted_by) VALUES(?,?,?,?,?)",id,subject,subjectId,action,actor);
                if(revoke[0])jdbc.update("UPDATE ai_resource SET auth_version=auth_version+1,updated_by=?,updated_at=NOW() WHERE id=?",actor,id);else jdbc.update("UPDATE ai_resource SET updated_by=?,updated_at=NOW() WHERE id=?",actor,id);
                audit(actor,"resource.share.changed",id,Map.of("shareId",share.toString(),"mode","REFERENCE","actions",actions));
                return Map.of("id",share.toString(),"mode","REFERENCE","changed",true);
            }
            UUID share=UUID.randomUUID();jdbc.update("INSERT INTO ai_resource_share(id,resource_id,subject_type,subject_id,actions,shared_by) VALUES(?,?,?,?,?::text[],?)",share,id,subject,subjectId,"{"+String.join(",",new TreeSet<>(actions))+"}",actor);
            for(String action:actions)jdbc.update("INSERT INTO ai_resource_acl(resource_id,subject_type,subject_id,action,granted_by) VALUES(?,?,?,?,?)",id,subject,subjectId,action,actor);
            jdbc.update("UPDATE ai_resource SET visibility=CASE WHEN visibility='PRIVATE' THEN 'SHARED' ELSE visibility END,updated_by=?,updated_at=NOW() WHERE id=?",actor,id);audit(actor,"resource.shared",id,Map.of("shareId",share.toString(),"mode","REFERENCE","actions",actions));return Map.of("id",share.toString(),"mode","REFERENCE","changed",true);
        });
        if(revoke[0])conversations.revokeResource(id);return result;
    }
    /** Parent and minimum dependency grants commit together, or none of them do. */
    public Map<String,Object> shareBatch(UUID id,long actor,List<WorkspaceShareSupport.Target> targets,Set<String> actions,String fingerprint,Set<String> confirmed,UUID idempotencyKey){
        return tx.execute(status->{
            jdbc.queryForObject("SELECT user_id FROM sys_user WHERE user_id=? FOR UPDATE",Long.class,actor);
            var parent=guard.require(id,actor,AiResourceGuard.Action.SHARE);
            if(!guard.owner(parent,actor))throw new WorkspaceDenied(403,"OwnerSharingRequired");
            String digest=hash(id+"\n"+JsonUtils.toJsonString(targets)+"\n"+JsonUtils.toJsonString(new TreeSet<>(actions)));
            var previous=jdbc.queryForList("SELECT input_hash,result::text FROM ai_command WHERE actor_user_id=? AND operation='resource.share.bundle' AND idempotency_key=?",actor,idempotencyKey);
            if(!previous.isEmpty()){
                if(!digest.equals(previous.getFirst().get("input_hash")))throw new WorkspaceDenied(409,"IdempotencyConflict");
                return JsonUtils.parseMap(previous.getFirst().get("result").toString());
            }
            // Serialize all batches for this parent, including identical concurrent submissions.
            jdbc.queryForList("SELECT id FROM ai_resource WHERE id=? FOR UPDATE",id);
            var plan=shareSupport.plan(id,actor,targets,actions.contains("USE"));
            if(!Boolean.TRUE.equals(plan.get("ready")))throw new WorkspaceDenied(409,"ShareDependenciesUnavailable");
            if(!Objects.equals(fingerprint,plan.get("fingerprint")))throw new WorkspaceDenied(409,"SharePlanChanged");
            var additions=(List<Map<String,Object>>)plan.get("additions");
            Set<String> requiredConfirmation=new TreeSet<>();
            for(var addition:additions)if(Boolean.TRUE.equals(addition.get("sensitive")))requiredConfirmation.add(addition.get("key").toString());
            if(!requiredConfirmation.equals(confirmed))throw new WorkspaceDenied(409,"SensitiveDependencyConfirmationRequired");
            List<Map<String,Object>> result=new ArrayList<>();
            for(var target:targets){
                long subjectId=WorkspaceShareSupport.targetId(target);
                var saved=share(id,actor,target.subjectType(),subjectId,actions,true);
                UUID share=UUID.fromString(saved.get("id").toString());
                for(var addition:additions)if(target.subjectType().equals(addition.get("subjectType"))&&target.subjectId().equals(addition.get("subjectId"))){
                    jdbc.update("INSERT INTO ai_resource_share_dependency(share_id,parent_version,parent_dependencies,dependency_type,dependency_id,dependency_version,dependency_auth_version,connection_auth_version,granted_by,confirmed_sensitive) VALUES(?,?,?::jsonb,?,?,?,?,?,?,?) ON CONFLICT(share_id,dependency_type,dependency_id) DO UPDATE SET parent_version=EXCLUDED.parent_version,parent_dependencies=EXCLUDED.parent_dependencies,dependency_version=EXCLUDED.dependency_version,dependency_auth_version=EXCLUDED.dependency_auth_version,connection_auth_version=EXCLUDED.connection_auth_version,granted_by=EXCLUDED.granted_by,confirmed_sensitive=EXCLUDED.confirmed_sensitive",share,plan.get("resourceVersion"),JsonUtils.toJsonString(plan.get("dependencyConfig")),addition.get("type"),UUID.fromString(addition.get("id").toString()),addition.get("version"),addition.getOrDefault("authVersion",0),addition.get("connectionAuthVersion"),actor,Boolean.TRUE.equals(addition.get("sensitive")));
                }
                if(actions.contains("USE")&&!Boolean.TRUE.equals(shareSupport.preflight(id,actor,target.subjectType(),subjectId,true).get("ready")))throw new WorkspaceDenied(409,"ShareDependenciesUnavailable");
                result.add(Map.of("id",saved.get("id"),"subjectType",target.subjectType(),"subjectId",target.subjectId(),"changed",saved.get("changed")));
            }
            audit(actor,"resource.share.bundle",id,Map.of("targets",targets,"resourceVersion",plan.get("resourceVersion"),"grants",additions,"sensitiveConfirmed",confirmed));
            var receipt=Map.<String,Object>of("recipients",result,"linkedGrants",additions.size());
            jdbc.update("INSERT INTO ai_command(actor_user_id,operation,idempotency_key,input_hash,result) VALUES(?,'resource.share.bundle',?,?,?::jsonb)",actor,idempotencyKey,digest,JsonUtils.toJsonString(receipt));
            return receipt;
        });
    }
    public void revoke(UUID id,UUID share,long actor){tx.executeWithoutResult(status->{jdbc.queryForList("SELECT id FROM ai_resource WHERE id=? FOR UPDATE",id);var r=guard.require(id,actor,AiResourceGuard.Action.SHARE);if(!guard.owner(r,actor))throw new WorkspaceDenied(403,"OwnerSharingRequired");var rows=jdbc.queryForList("UPDATE ai_resource_share SET status='REVOKED',revoked_at=NOW() WHERE id=? AND resource_id=? AND status='ACTIVE' RETURNING subject_type,subject_id",share,id);if(rows.isEmpty())return;var recipient=rows.getFirst();jdbc.update("DELETE FROM ai_resource_acl WHERE resource_id=? AND subject_type=? AND subject_id=?",id,recipient.get("subject_type"),recipient.get("subject_id"));jdbc.update("UPDATE ai_resource SET auth_version=auth_version+1,updated_by=?,updated_at=NOW() WHERE id=?",actor,id);audit(actor,"resource.share.revoked",id,Map.of("shareId",share.toString()));});conversations.revokeResource(id);}
    public void enable(UUID id,long actor,boolean enabled,boolean govern,String reason){
        if(govern&&(reason==null||reason.isBlank()))throw new WorkspaceDenied(400,"GovernanceReasonRequired");
        tx.executeWithoutResult(status->{jdbc.queryForList("SELECT id FROM ai_resource WHERE id=? FOR UPDATE",id);var r=guard.require(id,actor,govern?AiResourceGuard.Action.GOVERN:AiResourceGuard.Action.EDIT);if(!govern&&!guard.owner(r,actor))throw new WorkspaceDenied(403,"OwnerEnablementRequired");
            if(govern)jdbc.update("UPDATE ai_resource SET security_disabled=?,auth_version=auth_version+1,updated_by=?,updated_at=NOW() WHERE id=?",!enabled,actor,id);
            else jdbc.update("UPDATE ai_resource SET enabled=?,auth_version=auth_version+CASE WHEN enabled IS DISTINCT FROM ? THEN 1 ELSE 0 END,updated_by=?,updated_at=NOW() WHERE id=?",enabled,enabled,actor,id);audit(actor,govern?"resource.governed":"resource.enabled.changed",id,Map.of("enabled",enabled,"reason",reason==null?"":reason));
        });if(!enabled)conversations.revokeResource(id);
    }
    public void archive(UUID id,long actor){tx.executeWithoutResult(status->{guard.require(id,actor,AiResourceGuard.Action.DELETE);jdbc.update("UPDATE ai_resource SET lifecycle_state='ARCHIVED',enabled=FALSE,auth_version=auth_version+1,updated_by=?,updated_at=NOW() WHERE id=?",actor,id);audit(actor,"resource.archived",id,Map.of());});conversations.revokeResource(id);}
    public List<Map<String,Object>> governance(long actor,int page){permissions.require(actor,"ai:resource:govern");return jdbc.query("SELECT id,resource_type,owner_type,owner_user_id,enabled,lifecycle_state,security_disabled FROM ai_resource ORDER BY updated_at DESC LIMIT 30 OFFSET ?",(r,n)->{Map<String,Object> row=new LinkedHashMap<>();row.put("id",r.getString(1));row.put("resourceType",r.getString(2));row.put("ownerType",r.getString(3));row.put("ownerUserId",r.getString(4));row.put("enabled",r.getBoolean(5));row.put("lifecycleState",r.getString(6));row.put("securityDisabled",r.getBoolean(7));return row;},(Math.min(1000,Math.max(1,page))-1)*30);}
}
