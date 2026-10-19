package org.dromara.ai.workspace;

import org.dromara.ai.workspace.runtime.*;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

@Service
public class WorkspaceConversations {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final WorkspaceModelAccess access;
    private final WorkspaceEvents events;
    private final AgentRuntime runtime;
    private final ExecutionCredentials credentials;
    private final AiResourceGuard resources;
    private final WorkspaceSkills skills;
    private final WorkspaceMcpAccess mcp;
    private final WorkspaceToolAccess tools;
    private final WorkspaceKnowledgeAccess knowledge;
    private final ExecutorService workers=Executors.newVirtualThreadPerTaskExecutor();
    public WorkspaceConversations(JdbcTemplate jdbc,TransactionTemplate tx,WorkspaceModelAccess access,WorkspaceEvents events,AgentRuntime runtime,ExecutionCredentials credentials,AiResourceGuard resources,WorkspaceSkills skills,WorkspaceMcpAccess mcp,WorkspaceToolAccess tools,WorkspaceKnowledgeAccess knowledge) {
        this.jdbc=jdbc;this.tx=tx;this.access=access;this.events=events;this.runtime=runtime;this.credentials=credentials;this.resources=resources;this.skills=skills;this.mcp=mcp;this.tools=tools;this.knowledge=knowledge;
    }
    private static String hash(String input) {
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));}
        catch(Exception e){throw new IllegalStateException();}
    }
    public Map<String,Object> owned(UUID session,long owner) {
        var rows=jdbc.queryForList("SELECT * FROM ai_session WHERE id=? AND owner_user_id=? AND deleted_at IS NULL",session,owner);
        if(rows.size()!=1)throw new WorkspaceDenied(404,"SessionNotFound");return rows.getFirst();
    }
    public Map<String,Object> create(WorkspacePrincipal.Actor actor,UUID model,String title,UUID key,UUID assistant) {
        access.checkIdentity(actor.userId(),actor.authVersion());access.model(actor.userId(),model);
        if(assistant!=null){var resource=resources.require(assistant,actor.userId(),AiResourceGuard.Action.USE);if(!"ASSISTANT".equals(resource.get("resource_type")))throw new WorkspaceDenied(400,"AssistantRequired");var config=org.dromara.common.json.utils.JsonUtils.parseMap(resources.version(assistant,((Number)resource.get("published_version")).intValue(),actor.userId(),AiResourceGuard.Action.USE).get("config").toString());if(!model.toString().equals(config.get("modelId")))throw new WorkspaceDenied(400,"AssistantModelMismatch");}
        return tx.execute(status->{
            jdbc.queryForObject("SELECT user_id FROM sys_user WHERE user_id=? FOR UPDATE",Long.class,actor.userId());
            String digest=hash(model+"\n"+title+"\n"+assistant);var old=jdbc.queryForList("SELECT input_hash,result::text FROM ai_command WHERE actor_user_id=? AND operation='session.create' AND idempotency_key=?",actor.userId(),key);
            if(!old.isEmpty()){if(!digest.equals(old.getFirst().get("input_hash")))throw new WorkspaceDenied(409,"IdempotencyConflict");return JsonUtils.parseMap(old.getFirst().get("result").toString());}
            UUID id=UUID.randomUUID();jdbc.update("INSERT INTO ai_session(id,owner_user_id,model_id,title,assistant_resource_id) VALUES(?,?,?,?,?)",id,actor.userId(),model,title,assistant);
            Map<String,Object> result=Map.of("id",id.toString());events.append(id,null,UUID.randomUUID(),"session.started",Map.of("title",title,"modelId",model.toString()));
            jdbc.update("INSERT INTO ai_command(actor_user_id,operation,idempotency_key,input_hash,result) VALUES(?,'session.create',?,?,?::jsonb)",actor.userId(),key,digest,JsonUtils.toJsonString(result));return result;
        });
    }
    public List<Map<String,Object>> list(long owner,int page) {
        return jdbc.query("SELECT id,title,model_id,updated_at FROM ai_session WHERE owner_user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30 OFFSET ?",(r,n)->Map.<String,Object>of("id",r.getString(1),"title",r.getString(2),"modelId",r.getString(3),"updatedAt",r.getTimestamp(4).toInstant().toString()),owner,(Math.min(1000,Math.max(1,page))-1)*30);
    }
    public Map<String,Object> authorizeSession(UUID session,WorkspacePrincipal.Actor actor) {
        access.checkIdentity(actor.userId(),actor.authVersion());var s=owned(session,actor.userId());access.model(actor.userId(),(UUID)s.get("model_id"));
        if(s.get("assistant_resource_id")!=null)resources.require((UUID)s.get("assistant_resource_id"),actor.userId(),AiResourceGuard.Action.USE);
        skills.checkHistory(session,actor.userId());mcp.checkHistory(session,actor.userId());tools.checkHistory(session);knowledge.checkHistory(session,actor.userId());
        if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM rc2_legacy_session WHERE session_id=? AND knowledge_blocked)",Boolean.class,session)))throw new WorkspaceDenied(403,"LegacyKnowledgeContextUnresolved");
        for(UUID base:jdbc.queryForList("SELECT base_id FROM rc2_legacy_session_knowledge WHERE session_id=?",UUID.class,session))knowledge.base(base,actor.userId(),AiResourceGuard.Action.USE);
        for(var doc:jdbc.queryForList("SELECT document_id,version FROM rc2_legacy_session_document WHERE session_id=?",session))knowledge.version((UUID)doc.get("document_id"),((Number)doc.get("version")).intValue(),actor.userId(),AiResourceGuard.Action.USE);
        for(UUID file:jdbc.queryForList("SELECT file_id FROM rc2_legacy_session_file WHERE session_id=?",UUID.class,session))knowledge.file(file,actor.userId());
        return s;
    }
    public void revokeModels(List<UUID> models) {
        for(UUID model:models)for(UUID id:jdbc.queryForList("SELECT r.id FROM ai_run r JOIN ai_session s ON s.id=r.session_id WHERE s.model_id=? AND r.status IN('QUEUED','RUNNING','WAITING_APPROVAL')",UUID.class,model)){
            String token=grant(run(id));finish(id,"CANCELLED","ModelAuthorizationOrConfigurationChanged");workers.submit(()->{try{runtime.cancel(token);}catch(Exception ignored){}});
        }
    }
    public String activeGrant(UUID id){String token=grant(run(id));checkGrant(token,true);return token;}
    public void abortRun(UUID session,WorkspacePrincipal.Actor actor,String code){cancel(session,actor);}
    public void revokeToolType(String code){for(UUID id:jdbc.queryForList("SELECT id FROM ai_run WHERE status IN('QUEUED','RUNNING','WAITING_APPROVAL') AND EXISTS(SELECT 1 FROM jsonb_array_elements(config_snapshot->'workspaceTools') AS t WHERE t->>'type'=?)",UUID.class,code)){String token=grant(run(id));finish(id,"CANCELLED","ToolTypeAuthorizationChanged");workers.submit(()->{try{runtime.cancel(token);}catch(Exception ignored){}});}}
    public void revokeDocument(UUID document){revokeDependency("ai_run_document","document_id",document,"KnowledgeDocumentRevoked");}
    public void revokeFile(UUID file){revokeDependency("ai_run_file","file_id",file,"AttachmentRevoked");}
    private void revokeDependency(String table,String column,UUID resource,String error){for(UUID id:jdbc.queryForList("SELECT r.id FROM ai_run r JOIN "+table+" p ON p.run_id=r.id WHERE p."+column+"=? AND r.status IN('QUEUED','RUNNING','WAITING_APPROVAL')",UUID.class,resource)){String token=grant(run(id));finish(id,"CANCELLED",error);workers.submit(()->{try{runtime.cancel(token);}catch(Exception ignored){}});}}
    public void revokeConnection(UUID connection){
        for(UUID id:jdbc.queryForList("SELECT r.id FROM ai_run r JOIN ai_run_connection p ON p.run_id=r.id WHERE p.connection_id=? AND r.status IN('QUEUED','RUNNING','WAITING_APPROVAL')",UUID.class,connection)){String token=grant(run(id));finish(id,"CANCELLED","McpConnectionRevoked");workers.submit(()->{try{runtime.cancel(token);}catch(Exception ignored){}});}
    }
    public void revokeResource(UUID resource) {
        for(UUID id:jdbc.queryForList("SELECT r.id FROM ai_run r JOIN ai_run_resource p ON p.run_id=r.id WHERE p.resource_id=? AND r.status IN('QUEUED','RUNNING','WAITING_APPROVAL')",UUID.class,resource)){
            String token=grant(run(id));finish(id,"CANCELLED","ResourceAuthorizationRevoked");workers.submit(()->{try{runtime.cancel(token);}catch(Exception ignored){}});
        }
    }
    public Map<String,Object> history(UUID session,WorkspacePrincipal.Actor actor) {
        return tx.execute(status->{jdbc.queryForList("SELECT id FROM ai_session WHERE id=? FOR SHARE",session);return historySnapshot(session,actor);});
    }
    private Map<String,Object> historySnapshot(UUID session,WorkspacePrincipal.Actor actor) {
        var s=authorizeSession(session,actor);
        var legacy=jdbc.queryForList("SELECT snapshot::text FROM rc2_legacy_session WHERE session_id=?",session);
        if(!legacy.isEmpty()){
            var snapshot=JsonUtils.parseMap(legacy.getFirst().get("snapshot").toString());List<Map<String,Object>> rows=new ArrayList<>();int index=0;
            for(var message:(List<Map<String,Object>>)snapshot.getOrDefault("messages",List.of())){String role=Objects.toString(message.get("role"),"");if(!Set.of("user","assistant").contains(role))continue;Object value=message.get("content");String content=value instanceof String?(String)value:"";if(value instanceof List<?> parts){StringBuilder text=new StringBuilder();for(Object part:parts)if(part instanceof Map<?,?> item&&"text".equals(item.get("type")))text.append(Objects.toString(item.get("text"),""));content=text.toString();}rows.add(Map.of("id",Objects.toString(message.get("id"),"legacy-"+(index++)),"role",role,"content",content));}
            var result=new LinkedHashMap<String,Object>();result.put("sessionId",session.toString());result.put("title",s.get("title"));result.put("modelId",s.get("model_id").toString());result.put("messages",rows);result.put("readOnly",true);result.put("migrationNotice","这是迁移的 RC1 历史会话，仅供查阅。继续工作请新建任务；旧 Runtime 上下文不会自动执行。");result.put("lastEventSequence","0");for(String key:List.of("runs","toolEvents","citations","attachments","approvals","artifacts"))result.put(key,List.of());return result;
        }
        var messages=jdbc.query("SELECT id,run_id,role,content FROM ai_message WHERE session_id=? ORDER BY created_at,id LIMIT 500",(r,n)->Map.<String,Object>of("id",r.getString(1),"runId",r.getString(2),"role",r.getString(3),"content",r.getString(4)),session);
        var runs=jdbc.query("SELECT id,status,error_code FROM ai_run WHERE session_id=? ORDER BY created_at DESC LIMIT 1",(r,n)->{Map<String,Object> x=new LinkedHashMap<>();x.put("id",r.getString(1));x.put("status",r.getString(2));x.put("errorCode",r.getString(3));return x;},session);
        var toolEvents=jdbc.query("SELECT event_type,payload::text FROM ai_event WHERE session_id=? AND event_type IN('tool.started','tool.completed','tool.failed') ORDER BY sequence DESC LIMIT 100",(r,n)->Map.<String,Object>of("type",r.getString(1),"payload",JsonUtils.parseMap(r.getString(2))),session);Collections.reverse(toolEvents);
        var approvals=jdbc.queryForList("SELECT a.id::text,a.status,a.arguments->>'filename' AS filename,a.arguments->>'content' AS content,a.expires_at::text AS expires_at FROM ai_tool_approval a JOIN ai_run r ON r.id=a.run_id WHERE r.session_id=? ORDER BY a.created_at",session);var artifacts=jdbc.queryForList("SELECT a.id::text AS \"artifactId\",a.filename,a.byte_size FROM ai_artifact a JOIN ai_run r ON r.id=a.run_id WHERE r.session_id=? AND a.deleted_at IS NULL ORDER BY a.created_at",session);
        var citations=jdbc.queryForList("SELECT c.id::text,c.reference,c.version,i.line_start,i.line_end,f.filename AS title FROM ai_knowledge_citation c JOIN ai_run r ON r.id=c.run_id JOIN ai_knowledge_index i ON i.document_id=c.document_id AND i.version=c.version AND i.chunk_index=c.chunk_index JOIN ai_knowledge_document_version v ON v.document_id=c.document_id AND v.version=c.version JOIN ai_file f ON f.id=v.file_id WHERE r.session_id=? ORDER BY c.created_at LIMIT 100",session);
        Map<String,Object> result=new LinkedHashMap<>();result.put("approvals",approvals);result.put("artifacts",artifacts);result.put("sessionId",session.toString());result.put("title",s.get("title"));result.put("modelId",s.get("model_id").toString());result.put("messages",messages);result.put("lastEventSequence",s.get("next_sequence").toString());result.put("runs",runs);result.put("toolEvents",toolEvents);result.put("citations",citations);result.put("attachments",knowledge.attachments(session,actor.userId()));return result;
    }
    public Map<String,Object> send(UUID session,WorkspacePrincipal.Actor actor,String text,UUID key) {
        Map<String,Object> result=tx.execute(status->{
            jdbc.queryForObject("SELECT user_id FROM sys_user WHERE user_id=? FOR UPDATE",Long.class,actor.userId());
            access.checkIdentity(actor.userId(),actor.authVersion());var s=owned(session,actor.userId());if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM rc2_legacy_session WHERE session_id=?)",Boolean.class,session)))throw new WorkspaceDenied(409,"LegacySessionReadOnly");skills.checkHistory(session,actor.userId());mcp.checkHistory(session,actor.userId());tools.checkHistory(session);knowledge.checkHistory(session,actor.userId());
            UUID assistant=(UUID)s.get("assistant_resource_id");Map<String,Object> resource=null,assistantConfig=null;UUID selectedModel=(UUID)s.get("model_id");
            if(assistant!=null){resource=resources.require(assistant,actor.userId(),AiResourceGuard.Action.USE);assistantConfig=JsonUtils.parseMap(resources.version(assistant,((Number)resource.get("published_version")).intValue(),actor.userId(),AiResourceGuard.Action.USE).get("config").toString());selectedModel=UUID.fromString(assistantConfig.get("modelId").toString());}
            var model=new LinkedHashMap<>(access.model(actor.userId(),selectedModel));
            List<Map<String,Object>> resolvedMcps=assistantConfig==null?List.of():mcp.resolve(assistantConfig.get("mcpIds"),actor.userId());model.put("mcps",resolvedMcps);if(!resolvedMcps.isEmpty()&&!Boolean.TRUE.equals(model.get("tools")))throw new WorkspaceDenied(403,"ModelToolCallingRequired");
            List<Map<String,Object>> resolvedSkills=List.of();if(assistantConfig!=null){model.put("system_prompt",assistantConfig.get("instruction"));resolvedSkills=skills.resolve(assistantConfig.get("skillIds"),actor.userId());if(!resolvedSkills.isEmpty()&&!Boolean.TRUE.equals(model.get("tools")))throw new WorkspaceDenied(403,"ModelToolCallingRequired");model.put("skills",resolvedSkills);}
            List<Map<String,Object>> resolvedTools=tools.resolve(assistantConfig==null?null:assistantConfig.get("toolIds"),resolvedSkills,actor.userId());if(!resolvedTools.isEmpty()&&!Boolean.TRUE.equals(model.get("tools")))throw new WorkspaceDenied(403,"ModelToolCallingRequired");model.put("workspaceTools",resolvedTools);
            List<Map<String,Object>> resolvedKnowledge=knowledge.resolve(assistantConfig==null?null:assistantConfig.get("knowledgeIds"),actor.userId()),attachments=knowledge.attachments(session,actor.userId());if((!resolvedKnowledge.isEmpty()||!attachments.isEmpty())&&!Boolean.TRUE.equals(model.get("tools")))throw new WorkspaceDenied(403,"ModelToolCallingRequired");model.put("knowledge",resolvedKnowledge);model.put("attachments",attachments);
            String digest=hash(session+"\n"+text);var old=jdbc.queryForList("SELECT id,input_hash FROM ai_run WHERE owner_user_id=? AND idempotency_key=?",actor.userId(),key);
            if(!old.isEmpty()){if(!digest.equals(old.getFirst().get("input_hash")))throw new WorkspaceDenied(409,"IdempotencyConflict");return Map.<String,Object>of("runId",old.getFirst().get("id").toString(),"reused",true);}
            if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_run WHERE owner_user_id=? AND status IN('QUEUED','RUNNING','WAITING_APPROVAL'))",Boolean.class,actor.userId())))throw new WorkspaceDenied(409,"RunAlreadyActive");
            UUID id=UUID.randomUUID();jdbc.update("INSERT INTO ai_run(id,session_id,owner_user_id,idempotency_key,input_hash,user_text,status,auth_version,model_version,provider_version,config_snapshot) VALUES(?,?,?,?,?,?,'QUEUED',?,?,?,?::jsonb)",id,session,actor.userId(),key,digest,text,actor.authVersion(),model.get("model_version"),model.get("provider_version"),JsonUtils.toJsonString(model));
            jdbc.update("UPDATE ai_session SET model_id=? WHERE id=?",selectedModel,session);
            if(assistant!=null)jdbc.update("INSERT INTO ai_run_resource(run_id,resource_id,version,auth_version) VALUES(?,?,?,?)",id,assistant,resource.get("published_version"),resource.get("auth_version"));
            for(var skill:resolvedSkills)jdbc.update("INSERT INTO ai_run_resource(run_id,resource_id,version,auth_version) VALUES(?,?,?,?)",id,UUID.fromString(skill.get("id").toString()),skill.get("version"),skill.get("authVersion"));
            for(var tool:resolvedTools)jdbc.update("INSERT INTO ai_run_resource(run_id,resource_id,version,auth_version) VALUES(?,?,?,?)",id,UUID.fromString(tool.get("id").toString()),tool.get("version"),tool.get("authVersion"));
            for(var item:resolvedMcps){jdbc.update("INSERT INTO ai_run_resource(run_id,resource_id,version,auth_version) VALUES(?,?,?,?)",id,UUID.fromString(item.get("id").toString()),item.get("version"),item.get("authVersion"));jdbc.update("INSERT INTO ai_run_connection(run_id,connection_id,auth_version) VALUES(?,?,?)",id,UUID.fromString(item.get("connectionId").toString()),item.get("connectionAuthVersion"));}
            for(var kb:resolvedKnowledge){jdbc.update("INSERT INTO ai_run_resource(run_id,resource_id,version,auth_version) VALUES(?,?,?,?)",id,UUID.fromString(kb.get("id").toString()),kb.get("version"),kb.get("authVersion"));for(var doc:(List<Map<String,Object>>)kb.get("documents"))jdbc.update("INSERT INTO ai_run_document(run_id,document_id,version,auth_version) VALUES(?,?,?,?)",id,UUID.fromString(doc.get("id").toString()),doc.get("version"),doc.get("auth_version"));}
            for(var file:attachments)jdbc.update("INSERT INTO ai_run_file(run_id,file_id,auth_version) VALUES(?,?,?)",id,UUID.fromString(file.get("id").toString()),file.get("auth_version"));
            UUID message=UUID.randomUUID();jdbc.update("INSERT INTO ai_message(id,session_id,run_id,role,content) VALUES(?,?,?,'user',?)",message,session,id,text);
            events.append(session,id,UUID.randomUUID(),"run.started",Map.of("status","QUEUED"));events.append(session,id,UUID.randomUUID(),"message.started",Map.of("messageId",message.toString(),"role","user","content",text));
            return Map.<String,Object>of("runId",id.toString(),"reused",false);
        });
        if(Boolean.FALSE.equals(result.get("reused")))workers.submit(()->execute(UUID.fromString(result.get("runId").toString())));return result;
    }
    private Map<String,Object> run(UUID id){var rows=jdbc.queryForList("SELECT r.*,s.model_id,s.runtime_initialized FROM ai_run r JOIN ai_session s ON s.id=r.session_id WHERE r.id=? AND s.deleted_at IS NULL",id);if(rows.size()!=1)throw new WorkspaceDenied(404,"RunNotFound");return rows.getFirst();}
    public Map<String,Object> checkGrant(String grant,boolean activeRequired) {
        var claims=credentials.verify(grant,"run.execute");UUID runId=UUID.fromString(claims.get("runId").toString());var r=run(runId);
        if(!r.get("session_id").toString().equals(claims.get("sessionId")) || !r.get("owner_user_id").toString().equals(claims.get("userId")) || !r.get("auth_version").toString().equals(claims.get("authorizationVersion")))throw new WorkspaceDenied(403,"InvalidExecutionGrant");
        if(activeRequired&&!Set.of("QUEUED","RUNNING","WAITING_APPROVAL").contains(r.get("status")))throw new WorkspaceDenied(403,"RunNotActive");
        long owner=((Number)r.get("owner_user_id")).longValue();access.checkIdentity(owner,((Number)r.get("auth_version")).longValue());var currentModel=access.model(owner,(UUID)r.get("model_id"));
        if(!currentModel.get("model_version").equals(r.get("model_version"))||!currentModel.get("provider_version").equals(r.get("provider_version")))throw new WorkspaceDenied(403,"ModelConfigurationChanged");
        for(var pin:jdbc.queryForList("SELECT resource_id,version,auth_version FROM ai_run_resource WHERE run_id=?",runId))resources.pinned((UUID)pin.get("resource_id"),((Number)pin.get("version")).intValue(),((Number)pin.get("auth_version")).longValue(),owner);
        mcp.checkRun(runId,owner);knowledge.checkRun(runId,owner);tools.check(JsonUtils.parseMap(r.get("config_snapshot").toString()));return r;
    }
    private String grant(Map<String,Object> r){return credentials.issue(Map.of("scope","run.execute","userId",r.get("owner_user_id").toString(),"sessionId",r.get("session_id").toString(),"runId",r.get("id").toString(),"authorizationVersion",r.get("auth_version").toString(),"resources",Map.of("modelId",r.get("model_id").toString(),"resourceVersions",jdbc.queryForList("SELECT resource_id::text,version FROM ai_run_resource WHERE run_id=?",r.get("id")))));}
    private void execute(UUID id) {
        try {
            var r=run(id);String grant=grant(r);checkGrant(grant,true);
            jdbc.update("UPDATE ai_run SET status='RUNNING' WHERE id=? AND status='QUEUED'",id);
            if(Boolean.TRUE.equals(r.get("runtime_initialized")))runtime.resumeSession(grant);else runtime.createSession(grant);
            jdbc.update("UPDATE ai_session SET runtime_initialized=TRUE WHERE id=?",r.get("session_id"));
            var result=runtime.sendMessage(grant,r.get("user_text").toString());
            finish(id,"COMPLETED".equals(result.get("status"))?"COMPLETED":"FAILED","COMPLETED".equals(result.get("status"))?null:"RuntimeError");
        }catch(Exception e){finish(id,"FAILED",e instanceof WorkspaceDenied?"PermissionOrRuntimeUnavailable":"RuntimeError");}
    }
    public void accept(String grant,UUID event,String type,Map<String,Object> payload) {
        if(!Set.of("message.started","message.delta","message.completed","tool.started","tool.completed","tool.failed","runtime.error").contains(type))throw new WorkspaceDenied(400,"InvalidRuntimeEvent");
        if(JsonUtils.toJsonString(payload).length()>300000)throw new WorkspaceDenied(400,"EventTooLarge");
        tx.executeWithoutResult(status->{var r=checkGrant(grant,true);UUID session=(UUID)r.get("session_id"),id=(UUID)r.get("id");
            jdbc.queryForObject("SELECT id FROM ai_run WHERE id=? FOR UPDATE",UUID.class,id);
            if(!Set.of("QUEUED","RUNNING","WAITING_APPROVAL").contains(run(id).get("status")))throw new WorkspaceDenied(409,"RunNotActive");
            if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_event WHERE event_id=?)",Boolean.class,event)))return;
            events.append(session,id,event,type,payload);
            if(type.equals("message.started") && "assistant".equals(payload.get("role")))jdbc.update("INSERT INTO ai_message(id,session_id,run_id,role,content) VALUES(?,?,?,'assistant','') ON CONFLICT(run_id,role) DO NOTHING",UUID.fromString(payload.get("messageId").toString()),session,id);
            if(type.equals("message.delta"))jdbc.update("UPDATE ai_message SET content=content||? WHERE run_id=? AND role='assistant' AND id=?",payload.get("delta").toString(),id,UUID.fromString(payload.get("messageId").toString()));
            if(type.equals("message.completed"))jdbc.update("INSERT INTO ai_message(id,session_id,run_id,role,content) VALUES(?,?,?,'assistant',?) ON CONFLICT(run_id,role) DO UPDATE SET content=EXCLUDED.content",UUID.fromString(payload.get("messageId").toString()),session,id,payload.get("content").toString());
        });
    }
    private void finish(UUID id,String state,String error) {
        tx.executeWithoutResult(status->{var r=run(id);jdbc.queryForObject("SELECT id FROM ai_run WHERE id=? FOR UPDATE",UUID.class,id);
            if(jdbc.update("UPDATE ai_run SET status=?,error_code=?,finished_at=NOW() WHERE id=? AND status IN('QUEUED','RUNNING','WAITING_APPROVAL')",state,error,id)==0)return;
            jdbc.update("UPDATE ai_tool_approval SET status=CASE WHEN expires_at<NOW() THEN 'EXPIRED' ELSE 'CANCELLED' END,decided_at=NOW() WHERE run_id=? AND status IN('PENDING','APPROVED')",id);
            events.append((UUID)r.get("session_id"),id,UUID.randomUUID(),"run."+state.toLowerCase(Locale.ROOT),error==null?Map.of():Map.of("code",error));
        });
    }
    public void cancel(UUID session,WorkspacePrincipal.Actor actor) {
        owned(session,actor.userId());var rows=jdbc.queryForList("SELECT id FROM ai_run WHERE session_id=? AND status IN('QUEUED','RUNNING','WAITING_APPROVAL')",session);
        for(var row:rows){UUID id=(UUID)row.get("id");String grant=grant(run(id));finish(id,"CANCELLED",null);workers.submit(()->{try{runtime.cancel(grant);}catch(Exception ignored){}});}
    }
    @EventListener(ApplicationReadyEvent.class)
    public void recover(){for(UUID id:jdbc.queryForList("SELECT id FROM ai_run WHERE status IN('QUEUED','RUNNING','WAITING_APPROVAL')",UUID.class))finish(id,"FAILED","ControlPlaneRestarted");}
    @PreDestroy public void close(){workers.shutdownNow();}
}
