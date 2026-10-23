package org.dromara.ai.workspace.external;

import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.*;
import org.dromara.ai.workspace.connectors.*;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Array;
import java.time.Instant;
import java.util.*;

/** Owns enterprise connector metadata. Credentials never enter MCP resource configuration. */
@Service
@RequiredArgsConstructor
public class ExternalConnectionService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final WorkspacePermissions permissions;
    private final WorkspaceSecrets secrets;
    private final WorkspaceConversations conversations;
    private final WorkspaceResources resources;
    private final ExternalQueryConnectorRegistry connectors;

    public record Save(ConnectorType type, String name, String businessUnit, String environment,
                       String baseUrl, String credential, Boolean clearCredential,
                       List<String> allowedMethods, boolean enabled, Long expectedVersion) {}
    public record RuntimeConnection(UUID id, UUID resourceId, ConnectorType type, String name,
                                    String businessUnit, String environment, String baseUrl, String credential, List<String> allowedMethods,
                                    Map<String,Object> verifiedIdentity, long version) {}

    public List<Map<String,Object>> catalogs(long actor) {
        admin(actor);
        List<Map<String,Object>> result=new ArrayList<>();
        for(ConnectorCatalog catalog:connectors.catalogs()){
            Map<String,Object> item=new LinkedHashMap<>();item.put("type",catalog.type());item.put("displayName",catalog.type()==ConnectorType.CSWM_IOT?"国家危险废物平台":catalog.displayName());item.put("environments",catalog.environments());
            List<Map<String,Object>> methods=new ArrayList<>();for(ConnectorMethod method:catalog.methods()){Map<String,Object> value=new LinkedHashMap<>();value.put("name",method.name());value.put("title",method.title());value.put("path",method.path());value.put("readOnly",method.readOnly());value.put("inputSchema",method.inputSchema());value.put("outputSchema",method.outputSchema());value.put("returnFields",method.returnFields());value.put("unit",method.unit());value.put("timeSemantics",method.timeSemantics());value.put("environmentNotes",method.environmentNotes());value.put("status",method.contractStatus());value.put("available","VERIFIED".equals(method.contractStatus()));value.put("safeCause","VERIFIED".equals(method.contractStatus())?null:"ConnectorContractUnverified");methods.add(value);}item.put("methods",methods);result.add(item);
        }
        return result;
    }

    public List<Map<String,Object>> list(long actor) {
        admin(actor);
        return jdbc.queryForList("SELECT e.*,c.resource_id,c.enabled,c.tested_at FROM ai_external_connection e JOIN ai_mcp_connection c ON c.id=e.id ORDER BY e.updated_at DESC")
            .stream().map(this::dto).toList();
    }

    public Map<String,Object> create(long actor, Save input) {
        admin(actor);
        Validated validated=validate(input, false);
        UUID id=tx.execute(status -> {
            UUID resource=UUID.randomUUID();
            UUID connection=UUID.randomUUID();
            String config=config(validated.methods());
            jdbc.update("INSERT INTO ai_resource(id,resource_type,owner_type,owner_user_id,name,description,lifecycle_state,enabled,latest_version,published_version,created_by,updated_by) VALUES(?,'MCP','ENTERPRISE',NULL,?,'Enterprise external query connection','ACTIVE',TRUE,1,1,?,?)",
                resource,input.name().trim(),actor,actor);
            jdbc.update("INSERT INTO ai_resource_version(resource_id,version,config,content_hash,created_by,metadata) VALUES(?,1,?::jsonb,?,?,?::jsonb)",
                resource,config,hash(config),actor,JsonUtils.toJsonString(Map.of("name",input.name().trim(),"description","Enterprise external query connection")));
            String cipher=credential(input.credential())==null?null:secrets.encrypt(input.credential());
            jdbc.update("INSERT INTO ai_mcp_connection(id,resource_id,owner_user_id,scope,template_version,secret_cipher,enabled,status,tools_snapshot,created_by) VALUES(?, ?,NULL,'ENTERPRISE',1,NULL,?,'NOT_TESTED','[]'::jsonb,?)",
                connection,resource,input.enabled()&&cipher!=null,actor);
            jdbc.update("INSERT INTO ai_external_connection(id,connector_type,name,business_unit,environment,base_url,credential_cipher,allowed_methods,created_by) VALUES(?,?,?,?,?,?,?,?::text[],?)",
                connection,input.type().name(),input.name().trim(),input.businessUnit().trim(),input.environment(),validated.baseUrl(),cipher,toPgArray(validated.methods()),actor);
            audit(actor,"external.connection.created",resource,connection);
            return connection;
        });
        return getAdmin(id,actor);
    }

    public Map<String,Object> update(UUID id,long actor,Save input) {
        admin(actor);
        Validated validated=validate(input, true);
        boolean[] revoke={false};
        tx.executeWithoutResult(transaction -> {
            Map<String,Object> old=lockAdmin(id,actor);
            if(input.expectedVersion()==null||number(old,"version")!=input.expectedVersion())throw new WorkspaceDenied(409,"VersionConflict");
            if(!old.get("connector_type").toString().equals(input.type().name()))throw new WorkspaceDenied(400,"ConnectorTypeImmutable");
            String supplied=credential(input.credential());
            if(Boolean.TRUE.equals(input.clearCredential())&&supplied!=null)throw new WorkspaceDenied(400,"InvalidCredentialChange");
            String cipher=Boolean.TRUE.equals(input.clearCredential())?null:supplied==null?(String)old.get("credential_cipher"):secrets.encrypt(supplied);
            boolean credentialChanged=Boolean.TRUE.equals(input.clearCredential())||supplied!=null;
            boolean identityChanged=credentialChanged||!Objects.equals(old.get("business_unit"),input.businessUnit().trim())
                ||!Objects.equals(old.get("environment"),input.environment())||!Objects.equals(old.get("base_url"),validated.baseUrl());
            List<String> previous=array(old.get("allowed_methods"));
            boolean methodsChanged=!previous.equals(validated.methods());
            boolean templateChanged=methodsChanged||!Objects.equals(old.get("name"),input.name().trim());
            boolean nextEnabled=Boolean.TRUE.equals(input.clearCredential())||cipher==null?false:input.enabled();
            boolean enabledChanged=!Objects.equals(old.get("enabled"),nextEnabled);
            int template=((Number)old.get("template_version")).intValue();
            if(templateChanged){
                int next=template+1;String config=config(validated.methods());
                jdbc.update("INSERT INTO ai_resource_version(resource_id,version,config,content_hash,created_by,metadata) VALUES(?,?,?::jsonb,?,?,?::jsonb)",old.get("resource_id"),next,config,hash(config),actor,JsonUtils.toJsonString(Map.of("name",input.name().trim(),"description","Enterprise external query connection")));
                jdbc.update("UPDATE ai_resource SET latest_version=?,published_version=?,auth_version=auth_version+1,name=?,updated_by=?,updated_at=NOW() WHERE id=?",next,next,input.name().trim(),actor,old.get("resource_id"));
                template=next;
            } else jdbc.update("UPDATE ai_resource SET name=?,updated_by=?,updated_at=NOW() WHERE id=?",input.name().trim(),actor,old.get("resource_id"));
            String status=identityChanged?"NOT_TESTED":old.get("tested_status").toString();
            jdbc.update("UPDATE ai_external_connection SET name=?,business_unit=?,environment=?,base_url=?,credential_cipher=?,identity_verified=CASE WHEN ? THEN FALSE ELSE identity_verified END,verified_identity=CASE WHEN ? THEN '{}'::jsonb ELSE verified_identity END,allowed_methods=?::text[],tested_status=?,last_error=CASE WHEN ? THEN NULL ELSE last_error END,version=version+1,updated_at=NOW() WHERE id=?",
                input.name().trim(),input.businessUnit().trim(),input.environment(),validated.baseUrl(),cipher,identityChanged,identityChanged,toPgArray(validated.methods()),status,identityChanged,id);
            jdbc.update("UPDATE ai_mcp_connection SET template_version=?,enabled=?,status=?,auth_version=auth_version+CASE WHEN ? THEN 1 ELSE 0 END,version=version+1,tools_snapshot='[]'::jsonb,last_error=NULL,updated_at=NOW() WHERE id=?",
                template,nextEnabled,status,(identityChanged||templateChanged||enabledChanged),id);
            revoke[0]=identityChanged||templateChanged||enabledChanged;
            audit(actor,"external.connection.updated",(UUID)old.get("resource_id"),id);
        });
        if(revoke[0]){conversations.revokeConnection(id);conversations.revokeResource(resourceId(id));}
        return getAdmin(id,actor);
    }

    public Map<String,Object> verify(UUID id,long expectedVersion,long actor) {
        admin(actor);
        Map<String,Object> snapshot=getAdminRow(id,actor);
        if(number(snapshot,"version")!=expectedVersion)throw new WorkspaceDenied(409,"VersionConflict");
        long started=System.nanoTime();
        ConnectorValidationResult validation;
        String cipher=(String)snapshot.get("credential_cipher");
        if(cipher==null) validation=new ConnectorValidationResult(false,"ExternalCredentialRequired","Credential required",Map.of());
        else if(array(snapshot.get("allowed_methods")).isEmpty()) validation=new ConnectorValidationResult(false,"NoVerifiedConnectorMethods","No verified connector methods",Map.of());
        else try {
            validation=connectors.require(ConnectorType.valueOf(snapshot.get("connector_type").toString())).validate(
                snapshot.get("base_url").toString(),new ConnectorCredential(secrets.decrypt(cipher),snapshot.get("business_unit").toString()));
        } catch(ConnectorException e) {
            validation=new ConnectorValidationResult(false,safeCode(e.code),"Connector validation failed",Map.of());
        } catch(Exception e) {
            validation=new ConnectorValidationResult(false,"ExternalValidationFailed","Connector validation failed",Map.of());
        }
        String safe=safeCode(validation.code());
        boolean ready=validation.valid();
        Map<String,Object> identity=identity(validation.metadata(),snapshot.get("connector_type").toString(),ready);
        tx.executeWithoutResult(status->{Map<String,Object> current=lockAdmin(id,actor);if(number(current,"version")!=expectedVersion)throw new WorkspaceDenied(409,"VersionConflict");
            jdbc.update("UPDATE ai_external_connection SET tested_status=?,last_error=?,identity_verified=?,verified_identity=?::jsonb,version=version+1,updated_at=NOW() WHERE id=?",ready?"READY":"ERROR",ready?null:safe,Boolean.TRUE.equals(identity.get("matched")),JsonUtils.toJsonString(identity),id);
            jdbc.update("UPDATE ai_mcp_connection SET status=?,last_error=?,tested_at=NOW(),auth_version=auth_version+1,version=version+1,updated_at=NOW() WHERE id=?",ready?"READY":"ERROR",ready?null:safe,id);
            jdbc.update("INSERT INTO ai_mcp_test(id,connection_id,actor_user_id,status,latency_ms,tool_count,error_code) VALUES(?,?,?,?,?,?,?)",UUID.randomUUID(),id,actor,ready?"PASS":"FAIL",(System.nanoTime()-started)/1_000_000,array(current.get("allowed_methods")).size(),ready?null:safe);audit(actor,"external.connection.verified",(UUID)current.get("resource_id"),id);
        });
        conversations.revokeConnection(id);
        return getAdmin(id,actor);
    }

    public List<Map<String,Object>> calls(UUID id,long actor,int page) {
        getAdminRow(id,actor);
        return jdbc.queryForList("SELECT id::text,actor_user_id::text AS \"actorUserId\",business_unit AS \"businessUnit\",method,status,error_code AS \"errorCode\",duration_ms AS \"durationMs\",connection_version AS \"connectionVersion\",created_at::text AS \"createdAt\" FROM ai_external_call WHERE connection_id=? ORDER BY created_at DESC LIMIT 30 OFFSET ?",id,(Math.min(1000,Math.max(1,page))-1)*30);
    }

    public Map<String,Object> expert(UUID id,Long expectedVersion,List<UUID> requested,long actor) {
        admin(actor);
        return tx.execute(status -> {
            Map<String,Object> row=lockAdmin(id,actor);
            if(expectedVersion!=null&&number(row,"version")!=expectedVersion)throw new WorkspaceDenied(409,"VersionConflict");
            List<UUID> ids=requested==null||requested.isEmpty()?List.of(id):List.copyOf(requested);if(ids.size()>8||new HashSet<>(ids).size()!=ids.size()||!ids.contains(id))throw new WorkspaceDenied(400,"InvalidExpertConnections");
            List<String> resourceIds=new ArrayList<>();for(UUID connectionId:ids){Map<String,Object> selected=getAdminRow(connectionId,actor);if(!Boolean.TRUE.equals(selected.get("enabled"))||!"READY".equals(selected.get("tested_status")))throw new WorkspaceDenied(409,"ExternalConnectionNotReady");resourceIds.add(selected.get("resource_id").toString());}
            UUID existing=(UUID)row.get("expert_resource_id");
            if(!Boolean.TRUE.equals(row.get("enabled"))||!"READY".equals(row.get("tested_status")))throw new WorkspaceDenied(409,"ExternalConnectionNotReady");
            UUID model=jdbc.queryForObject("SELECT model_id FROM ai_office_defaults WHERE singleton",UUID.class);
            if(model==null)throw new WorkspaceDenied(409,"OfficeDefaultModelRequired");
            String name=expertName(row.get("name").toString());
            Map<String,Object> config=new LinkedHashMap<>();
            config.put("avatar","⌁");
            config.put("instruction","使用用户所用语言回答。固定业务事实必须调用所绑定的查询工具；同一问题内方法和参数相同的查询只调用一次；不同条件分别查询。多个问题分别发起对应查询，跨系统比较前先对齐单位、时间和统计口径。计算、比例和汇总使用可用的办公 Python 或结构化数据汇总工具，不以文字心算代替。回答标明来源、环境、单位、queriedAt，并在上游提供时标明 sourcePeriod。上游不支持的日期、企业或条件应明确说明，不得猜测；单项失败时保留其他成功结果并说明局部失败。");
            config.put("modelId",model.toString());config.put("skillIds",List.of());config.put("mcpIds",List.of(row.get("resource_id").toString()));config.put("toolIds",List.of());config.put("knowledgeIds",List.of());
            config.put("mcpIds",resourceIds);
            UUID assistant;boolean reused=existing!=null;
            if(existing==null){UUID key=UUID.nameUUIDFromBytes(("external-expert:"+id).getBytes(StandardCharsets.UTF_8));Map<String,Object> created=resources.create(actor,"ASSISTANT",name,"Enterprise external query expert",true,config,key);assistant=UUID.fromString(created.get("id").toString());resources.activate(assistant,actor,((Number)created.get("version")).intValue());jdbc.update("UPDATE ai_external_connection SET expert_resource_id=?,updated_at=NOW() WHERE id=? AND expert_resource_id IS NULL",assistant,id);audit(actor,"external.expert.created",assistant,id);}else{assistant=existing;Map<String,Object> current=resources.get(assistant,actor);Map<String,Object> currentConfig=(Map<String,Object>)current.get("config");if(!Objects.equals(currentConfig.get("mcpIds"),resourceIds)){Map<String,Object> edited=resources.edit(assistant,actor,((Number)current.get("version")).intValue(),name,"Enterprise external query expert",config);resources.activate(assistant,actor,((Number)edited.get("version")).intValue());audit(actor,"external.expert.updated",assistant,id);}}
            return expertDto(assistant,name,reused,ids,resourceIds);
        });
    }

    public RuntimeConnection runtime(UUID id,long user,long expectedAuthVersion) {
        var rows=jdbc.queryForList("SELECT e.*,c.resource_id,c.enabled,c.status,c.auth_version FROM ai_external_connection e JOIN ai_mcp_connection c ON c.id=e.id WHERE e.id=?",id);
        if(rows.size()!=1)throw new WorkspaceDenied(404,"ExternalConnectionNotFound");
        Map<String,Object> row=rows.getFirst();
        if(!Boolean.TRUE.equals(row.get("enabled"))||!"READY".equals(row.get("status"))||!"READY".equals(row.get("tested_status"))||number(row,"auth_version")!=expectedAuthVersion)throw new WorkspaceDenied(403,"McpConnectionRevoked");
        String cipher=(String)row.get("credential_cipher");if(cipher==null)throw new WorkspaceDenied(403,"ExternalCredentialRequired");
        return new RuntimeConnection(id,(UUID)row.get("resource_id"),ConnectorType.valueOf(row.get("connector_type").toString()),row.get("name").toString(),row.get("business_unit").toString(),row.get("environment").toString(),row.get("base_url").toString(),secrets.decrypt(cipher),array(row.get("allowed_methods")),JsonUtils.parseMap(row.get("verified_identity").toString()),number(row,"version"));
    }

    public ConnectorCatalog catalog(ConnectorType type){return connectors.require(type).catalog();}
    public ExternalQueryConnector connector(ConnectorType type){return connectors.require(type);}
    public void recordCall(RuntimeConnection c,long actor,String method,String status,String errorCode,long durationMs){jdbc.update("INSERT INTO ai_external_call(id,connection_id,actor_user_id,business_unit,method,status,error_code,duration_ms,connection_version) VALUES(?,?,?,?,?,?,?,?,?)",UUID.randomUUID(),c.id(),actor,c.businessUnit(),method,status,errorCode,durationMs,c.version());}

    private void admin(long actor){permissions.require(actor,"ai:resource:enterprise");}
    private Map<String,Object> getAdmin(UUID id,long actor){return dto(getAdminRow(id,actor));}
    private Map<String,Object> getAdminRow(UUID id,long actor){admin(actor);var rows=jdbc.queryForList("SELECT e.*,c.resource_id,c.enabled,c.status,c.auth_version,c.template_version,c.tested_at FROM ai_external_connection e JOIN ai_mcp_connection c ON c.id=e.id WHERE e.id=?",id);if(rows.size()!=1)throw new WorkspaceDenied(404,"ExternalConnectionNotFound");return rows.getFirst();}
    private Map<String,Object> lockAdmin(UUID id,long actor){admin(actor);var rows=jdbc.queryForList("SELECT e.*,c.resource_id,c.enabled,c.status,c.auth_version,c.template_version,c.tested_at FROM ai_external_connection e JOIN ai_mcp_connection c ON c.id=e.id WHERE e.id=? FOR UPDATE OF e,c",id);if(rows.size()!=1)throw new WorkspaceDenied(404,"ExternalConnectionNotFound");return rows.getFirst();}
    private UUID resourceId(UUID id){return jdbc.queryForObject("SELECT resource_id FROM ai_mcp_connection WHERE id=?",UUID.class,id);}

    private Map<String,Object> dto(Map<String,Object> row){
        List<String> expertResources=expertResources(row.get("expert_resource_id"));Map<String,Object> out=new LinkedHashMap<>();out.put("id",row.get("id").toString());out.put("resourceId",row.get("resource_id").toString());out.put("type",row.get("connector_type"));out.put("name",row.get("name"));out.put("businessUnit",row.get("business_unit"));out.put("environment",row.get("environment"));out.put("baseUrl",row.get("base_url"));out.put("credentialConfigured",row.get("credential_cipher")!=null);out.put("verifiedIdentity",JsonUtils.parseMap(row.get("verified_identity").toString()));out.put("testedStatus",row.get("tested_status"));out.put("lastError",row.get("last_error"));out.put("testedAt",row.get("tested_at")==null?null:row.get("tested_at").toString());out.put("enabled",row.get("enabled"));out.put("allowedMethods",array(row.get("allowed_methods")));out.put("assistantId",row.get("expert_resource_id")==null?null:row.get("expert_resource_id").toString());out.put("expertResourceIds",expertResources);out.put("expertConnectionIds",connectionIds(expertResources));out.put("version",row.get("version"));out.put("updatedAt",row.get("updated_at").toString());return out;
    }
    private List<String> expertResources(Object assistant){if(!(assistant instanceof UUID id))return List.of();try{String json=jdbc.queryForObject("SELECT v.config::text FROM ai_resource r JOIN ai_resource_version v ON v.resource_id=r.id AND v.version=r.latest_version WHERE r.id=?",String.class,id);Object value=JsonUtils.parseMap(json).get("mcpIds");return value instanceof List<?> list?list.stream().map(Object::toString).toList():List.of();}catch(Exception e){return List.of();}}
    private List<String> connectionIds(List<String> resources){if(resources.isEmpty())return List.of();List<UUID> ids=new ArrayList<>();for(String value:resources)try{ids.add(UUID.fromString(value));}catch(Exception ignored){}if(ids.isEmpty())return List.of();String placeholders=String.join(",",Collections.nCopies(ids.size(),"?"));return jdbc.queryForList("SELECT id::text FROM ai_mcp_connection WHERE resource_id IN ("+placeholders+")",String.class,ids.toArray());}
    static String expertName(String connectionName){
        int end=Math.min(90,connectionName.length());
        if(end>0&&end<connectionName.length()&&Character.isHighSurrogate(connectionName.charAt(end-1)))end--;
        return connectionName.substring(0,end)+" 查询专家";
    }
    private Map<String,Object> expertDto(UUID id,String connectionName,boolean reused,List<UUID> connectionIds,List<String> resourceIds){return Map.of("assistantId",id.toString(),"name",connectionName,"reused",reused,"boundConnectionIds",connectionIds.stream().map(UUID::toString).toList(),"boundResourceIds",resourceIds);}
    private record Validated(String baseUrl,List<String> methods){}
    private Validated validate(Save input,boolean update){
        if(input==null||input.type()==null||blank(input.name())||input.name().trim().length()>100||blank(input.businessUnit())||input.businessUnit().trim().length()>200||blank(input.environment())||blank(input.baseUrl())||input.baseUrl().length()>500||input.allowedMethods()==null||new HashSet<>(input.allowedMethods()).size()!=input.allowedMethods().size())throw new WorkspaceDenied(400,"InvalidExternalConnection");
        if(Boolean.TRUE.equals(input.clearCredential())&&!update)throw new WorkspaceDenied(400,"InvalidCredentialChange");
        String supplied=credential(input.credential());
        ConnectorCatalog catalog=connectors.require(input.type()).catalog();
        boolean environment=catalog.environments().stream().anyMatch(e->e.name().equals(input.environment())&&e.baseUrl().equals(input.baseUrl()));
        if(!environment)throw new WorkspaceDenied(400,"ExternalEndpointNotAllowed");
        Set<String> verified=new HashSet<>();for(ConnectorMethod method:catalog.methods())if("VERIFIED".equals(method.contractStatus()))verified.add(method.name());
        if(!verified.containsAll(input.allowedMethods()))throw new WorkspaceDenied(400,"ExternalMethodNotVerified");
        return new Validated(input.baseUrl(),List.copyOf(input.allowedMethods()));
    }
    private static String credential(String value){if(value==null||value.isBlank())return null;if(value.length()>4096||value.chars().anyMatch(c->c=='\r'||c=='\n'||c==0))throw new WorkspaceDenied(400,"InvalidExternalCredential");return value;}
    private static boolean blank(String value){return value==null||value.isBlank();}
    private static String config(List<String> methods){Map<String,Object> effects=new TreeMap<>();methods.forEach(m->effects.put(m,"READ"));return JsonUtils.toJsonString(Map.of("transport","STREAMABLE_HTTP","endpoint","","managedProfile","external-query","authType","NONE","allowedTools",methods,"toolEffects",effects,"timeoutSeconds",60));}
    private static String hash(String content){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}}
    private static String toPgArray(List<String> values){return "{"+String.join(",",values)+"}";}
    private static long number(Map<String,Object> row,String key){return ((Number)row.get(key)).longValue();}
    private static List<String> array(Object raw){try{if(raw instanceof Array a)raw=a.getArray();if(raw instanceof Object[] values)return Arrays.stream(values).map(Object::toString).toList();if(raw instanceof Collection<?> values)return values.stream().map(Object::toString).toList();return List.of();}catch(Exception e){throw new WorkspaceDenied(503,"ExternalConnectionStateUnavailable");}}
    private static String safeCode(String code){return code!=null&&code.matches("[A-Za-z][A-Za-z0-9_]{0,79}")?code:"ExternalValidationFailed";}
    private static Map<String,Object> identity(Map<String,Object> metadata,String type,boolean valid){
        if(!"CSWM_IOT".equals(type)||metadata==null)return Map.of();
        Map<String,Object> out=new LinkedHashMap<>();for(String key:List.of("matched","enterpriseId","name","creditCode","verifiedAt","environment"))if(metadata.get(key) instanceof String||metadata.get(key) instanceof Boolean)out.put(key,metadata.get(key));
        out.putIfAbsent("matched",false);if(valid)out.putIfAbsent("verifiedAt",Instant.now().toString());return out;
    }
    private void audit(long actor,String action,UUID resource,UUID connection){jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,?,?,?::jsonb)",UUID.randomUUID(),actor,action,resource,JsonUtils.toJsonString(Map.of("connectionId",connection.toString())));}
}
