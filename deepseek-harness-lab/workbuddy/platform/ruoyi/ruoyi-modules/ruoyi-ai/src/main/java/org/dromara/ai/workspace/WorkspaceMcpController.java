package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import java.util.*;
@RestController
@RequestMapping("/ai/mcp/connections")
@RequiredArgsConstructor
public class WorkspaceMcpController {
 private final WorkspacePrincipal principals;private final WorkspacePermissions permissions;private final AiResourceGuard guard;private final WorkspaceMcpAccess access;private final WorkspaceSecrets secrets;private final WorkspaceConversations conversations;private final WorkspaceMcpRelayController relay;private final JdbcTemplate jdbc;private final TransactionTemplate tx;
 public record Save(UUID resourceId,String scope,int templateVersion,String secret,boolean enabled,Long expectedVersion){}
 private long actor(){return principals.require("ai:mcp:use").userId();}
 private Map<String,Object> manageable(UUID id,long user){var c=access.owned(id,user);if("ENTERPRISE".equals(c.get("scope"))){permissions.require(user,"ai:resource:enterprise");guard.require((UUID)c.get("resource_id"),user,AiResourceGuard.Action.EDIT);}return c;}
 private Map<String,Object> dto(Map<String,Object> c){Map<String,Object> d=new LinkedHashMap<>();for(String key:List.of("id","resource_id","scope","template_version","enabled","version","status","last_error","tested_at","updated_at")){Object v=c.get(key);d.put(key,v instanceof UUID||v instanceof java.sql.Timestamp?v.toString():v);}d.put("secretConfigured",c.get("secret_cipher")!=null);d.put("tools",JsonUtils.parseArray(c.get("tools_snapshot").toString(),Map.class));return d;}
 @GetMapping public R<?> list(@RequestParam UUID resourceId){return R.ok(listForUser(resourceId,actor()));}
 List<Map<String,Object>> listForUser(UUID resourceId,long user){guard.require(resourceId,user,AiResourceGuard.Action.USE);return jdbc.queryForList("SELECT * FROM ai_mcp_connection WHERE resource_id=? AND (owner_user_id=? OR scope='ENTERPRISE') ORDER BY scope",resourceId,user).stream().map(this::dto).toList();}
 @PostMapping public R<?> create(@RequestBody Save input){return R.ok(save(null,actor(),input));}
 @PutMapping("/{id}") public R<?> update(@PathVariable UUID id,@RequestBody Save input){return R.ok(save(id,actor(),input));}
 private Map<String,Object> save(UUID id,long user,Save input){
  if(input.resourceId()==null||input.scope()==null||!Set.of("PERSONAL","ENTERPRISE").contains(input.scope())||input.secret()!=null&&(input.secret().length()>4096||input.secret().chars().anyMatch(c->c<33||c>126)))throw new WorkspaceDenied(400,"InvalidMcpConnection");
  UUID result=tx.execute(status->{jdbc.queryForObject("SELECT user_id FROM sys_user WHERE user_id=? FOR UPDATE",Long.class,user);var r=guard.require(input.resourceId(),user,AiResourceGuard.Action.USE);if(((Number)r.get("published_version")).intValue()!=input.templateVersion())throw new WorkspaceDenied(409,"McpTemplateVersionConflict");var config=access.template(input.resourceId(),input.templateVersion(),user);
   if(input.scope().equals("ENTERPRISE")){permissions.require(user,"ai:resource:enterprise");guard.require(input.resourceId(),user,AiResourceGuard.Action.EDIT);if(!"ENTERPRISE".equals(r.get("owner_type")))throw new WorkspaceDenied(400,"EnterpriseTemplateRequired");}
   Map<String,Object> old=null;if(id!=null){jdbc.queryForList("SELECT id FROM ai_mcp_connection WHERE id=? FOR UPDATE",id);old=manageable(id,user);if(!old.get("resource_id").equals(input.resourceId())||!old.get("scope").equals(input.scope())||input.expectedVersion()==null||((Number)old.get("version")).longValue()!=input.expectedVersion())throw new WorkspaceDenied(409,"VersionConflict");}
   String cipher=input.secret()==null||input.secret().isEmpty()?(old==null?null:(String)old.get("secret_cipher")):secrets.encrypt(input.secret());if("NONE".equals(config.get("authType")))cipher=null;if("BEARER".equals(config.get("authType"))&&cipher==null)throw new WorkspaceDenied(400,"McpCredentialRequired");
   if(old==null){if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_mcp_connection WHERE resource_id=? AND scope=? AND (owner_user_id=? OR owner_user_id IS NULL))",Boolean.class,input.resourceId(),input.scope(),user)))throw new WorkspaceDenied(409,"McpConnectionAlreadyExists");UUID next=UUID.randomUUID();jdbc.update("INSERT INTO ai_mcp_connection(id,resource_id,owner_user_id,scope,template_version,secret_cipher,enabled,created_by) VALUES(?,?,?,?,?,?,?,?)",next,input.resourceId(),input.scope().equals("PERSONAL")?user:null,input.scope(),input.templateVersion(),cipher,input.enabled(),user);return next;}
   jdbc.update("UPDATE ai_mcp_connection SET template_version=?,secret_cipher=?,enabled=?,version=version+1,auth_version=auth_version+1,status='NOT_TESTED',tools_snapshot='[]',last_error=NULL,updated_at=NOW() WHERE id=?",input.templateVersion(),cipher,input.enabled(),id);return id;
  });if(id!=null)conversations.revokeConnection(id);audit(user,"mcp.connection.saved",input.resourceId(),result);return dto(access.owned(result,user));
 }
 @PostMapping("/{id}/tests") public R<?> test(@PathVariable UUID id){long user=actor();var c=manageable(id,user);var plan=access.secretPlan(id,((Number)c.get("auth_version")).longValue(),user);long started=System.nanoTime();String error=null;List<?> tools=List.of();
  try{tools=relay.probe(plan);}catch(WorkspaceDenied denied){error=denied.getMessage();}catch(Exception e){error="McpConnectionTestFailed";}
  long elapsed=(System.nanoTime()-started)/1000000;UUID test=UUID.randomUUID();jdbc.update("INSERT INTO ai_mcp_test(id,connection_id,actor_user_id,status,latency_ms,tool_count,error_code) VALUES(?,?,?,?,?,?,?)",test,id,user,error==null?"PASS":"FAIL",elapsed,tools.size(),error);
  int changed=jdbc.update("UPDATE ai_mcp_connection SET status=?,tools_snapshot=?::jsonb,last_error=?,tested_at=NOW() WHERE id=? AND version=?",error==null?"READY":"ERROR",JsonUtils.toJsonString(tools),error,id,c.get("version"));if(changed==0)throw new WorkspaceDenied(409,"VersionConflict");if(error!=null)conversations.revokeConnection(id);audit(user,"mcp.connection.tested",(UUID)c.get("resource_id"),id);return R.ok(Map.of("id",test.toString(),"status",error==null?"PASS":"FAIL","latencyMs",elapsed,"toolCount",tools.size(),"connection",dto(access.owned(id,user))));
 }
 @GetMapping("/{id}/tests") public R<?> tests(@PathVariable UUID id){manageable(id,actor());return R.ok(jdbc.queryForList("SELECT id::text,status,latency_ms,tool_count,error_code,created_at::text FROM ai_mcp_test WHERE connection_id=? ORDER BY created_at DESC LIMIT 30",id));}
 private void audit(long user,String action,UUID resource,UUID connection){jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,?,?,?::jsonb)",UUID.randomUUID(),user,action,resource,JsonUtils.toJsonString(Map.of("connectionId",connection.toString())));}
}
