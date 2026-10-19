package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.AgentRuntime;
import org.dromara.common.core.domain.R;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import java.util.*;

/** Explicit projections only: no prompts, titles, payloads, credentials, or approval arguments in admin views. */
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceOperationsController {
 private final WorkspacePrincipal principals;private final JdbcTemplate jdbc;private final AgentRuntime runtime;
 private int offset(int page){if(page<1||page>1000)throw new WorkspaceDenied(400,"InvalidPage");return (page-1)*30;}
 @GetMapping("/admin/audit") public R<?> audit(@RequestParam(defaultValue="calls") String category,@RequestParam(defaultValue="1") int page){
  principals.require("ai:audit:view");int offset=offset(page);
  String sql=switch(category){
   case "calls" -> "SELECT id,run_id,owner_user_id::text,kind,resource_id,model_id,provider_id,CASE WHEN status='STARTED' AND created_at<NOW()-INTERVAL '10 minutes' THEN 'INCOMPLETE' ELSE status END AS status,input_tokens,output_tokens,estimated_cost,currency,duration_ms,provider_ttfb_ms,first_token_ms,http_status,created_at,finished_at FROM ai_execution_call ORDER BY created_at DESC,id DESC";
   case "legacy-usage" -> "SELECT id,owner_user_id::text,session_id,model_code,input_tokens,output_tokens,usage_reported,result,created_at FROM rc2_legacy_usage ORDER BY created_at DESC,id DESC";
   case "legacy-audit" -> "SELECT source_key AS sequence,payload->>'action' AS action,payload->>'result' AS result,payload->>'request_id' AS request_id,payload->>'created_at' AS created_at,payload->>'prev_hash' AS prev_hash,payload->>'hash' AS hash FROM rc2_legacy_record WHERE source_table='audit_events' ORDER BY source_key::bigint DESC";
   case "tools" -> "SELECT e.event_id AS id,e.run_id,s.owner_user_id::text,e.event_type AS action,e.created_at FROM ai_event e JOIN ai_session s ON s.id=e.session_id WHERE e.event_type IN('tool.started','tool.completed','tool.failed','approval.requested','approval.decided','artifact.created') ORDER BY e.created_at DESC,e.event_id DESC";
   case "security" -> "SELECT id,actor_user_id::text,action,resource_id,created_at FROM ai_security_event ORDER BY created_at DESC,id DESC";
   case "model-relay" -> "SELECT id,actor_user_id::text,action,resource_id AS model_id,metadata->>'callId' AS call_id,metadata->>'modelCode' AS model_code,metadata->>'status' AS status,(metadata->>'usageReported')::boolean AS usage_reported,(metadata->>'inputTokens')::bigint AS input_tokens,(metadata->>'outputTokens')::bigint AS output_tokens,metadata->>'costStatus' AS cost_status,created_at FROM ai_security_event WHERE action IN('model.relay.started','model.relay.finished') ORDER BY created_at DESC,id DESC";
   case "mcp-relay" -> "SELECT id,actor_user_id::text,resource_id,metadata->>'connectionId' AS connection_id,metadata->>'method' AS method,metadata->>'toolName' AS tool_name,(metadata->>'status')::integer AS status,created_at FROM ai_security_event WHERE action='mcp.relay' ORDER BY created_at DESC,id DESC";
   case "knowledge" -> "SELECT id,actor_user_id::text,action,resource_id,created_at FROM ai_security_event WHERE action LIKE 'knowledge.%' OR action LIKE 'document.%' OR action LIKE 'citation.%' ORDER BY created_at DESC,id DESC";
   case "files" -> "SELECT id,actor_user_id::text,action,resource_id,created_at FROM ai_security_event WHERE action LIKE 'file.%' OR action LIKE 'artifact.%' ORDER BY created_at DESC,id DESC";
   default -> throw new WorkspaceDenied(400,"InvalidAuditCategory");};
  return R.ok(jdbc.queryForList(sql+" LIMIT 30 OFFSET ?",offset));
 }
 @GetMapping("/admin/usage") public R<?> usage(@RequestParam(defaultValue="30") int days){
  principals.require("ai:audit:view");if(days<1||days>90)throw new WorkspaceDenied(400,"InvalidPeriod");
  return R.ok(jdbc.queryForList("SELECT date_trunc('day',created_at) AS day,currency,count(*) AS calls,count(*) FILTER(WHERE status='STARTED') AS incomplete_calls,count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL) AS unknown_token_calls,count(*) FILTER(WHERE estimated_cost IS NULL) AS unknown_cost_calls,sum(input_tokens) AS known_input_tokens,sum(output_tokens) AS known_output_tokens,sum(estimated_cost) AS known_estimated_cost FROM ai_execution_call WHERE kind='MODEL' AND created_at>=NOW()-make_interval(days=>?) GROUP BY 1,2 ORDER BY 1 DESC,2",days));
 }
 @GetMapping("/admin/operations") public R<?> operations(@RequestParam(defaultValue="runs") String category,@RequestParam(defaultValue="1") int page){
  principals.require("ai:operations:view");int offset=offset(page);String sql=switch(category){
   case "runs" -> "SELECT id,session_id,owner_user_id::text,status,error_code,created_at,finished_at FROM ai_run ORDER BY created_at DESC,id DESC";
   case "sessions" -> "SELECT id,owner_user_id::text,model_id,runtime_initialized,created_at,updated_at,deleted_at FROM ai_session ORDER BY updated_at DESC,id DESC";
   case "approvals" -> "SELECT a.id,a.run_id,a.resource_id,r.owner_user_id::text,CASE WHEN a.status='PENDING' AND a.expires_at<NOW() THEN 'EXPIRED' ELSE a.status END AS status,a.created_at,a.expires_at,a.decided_at FROM ai_tool_approval a JOIN ai_run r ON r.id=a.run_id ORDER BY a.created_at DESC,a.id DESC";
   default -> throw new WorkspaceDenied(400,"InvalidOperationCategory");};return R.ok(jdbc.queryForList(sql+" LIMIT 30 OFFSET ?",offset));
 }
 @GetMapping("/admin/health") public R<?> health(){principals.require("ai:operations:view");var result=new LinkedHashMap<String,Object>();try{result.put("database",Integer.valueOf(1).equals(jdbc.queryForObject("SELECT 1",Integer.class))?"READY":"UNAVAILABLE");}catch(Exception e){result.put("database","UNAVAILABLE");}try{var h=runtime.health();result.put("execution",Boolean.TRUE.equals(h.get("ready"))?"READY":"UNAVAILABLE");result.put("runtimes",h.getOrDefault("runtimes",List.of()));result.put("gateway",h.getOrDefault("gateway","UNKNOWN"));}catch(Exception e){result.put("execution","UNAVAILABLE");result.put("gateway","UNKNOWN");}result.put("checkedAt",java.time.Instant.now().toString());return R.ok(result);}
 @GetMapping("/me/files") public R<?> files(@RequestParam(defaultValue="1") int page){long user=principals.require("ai:session:use").userId();return R.ok(jdbc.queryForList("SELECT id,filename,byte_size,created_at,'UPLOAD' AS kind,purpose FROM ai_file WHERE owner_user_id=? AND deleted_at IS NULL AND purpose<>'BRAND' UNION ALL SELECT id,filename,byte_size,created_at,'ARTIFACT' AS kind,'GENERATED' AS purpose FROM ai_artifact WHERE owner_user_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?",user,user,offset(page)));}
 @GetMapping("/me/approvals") public R<?> approvals(@RequestParam(defaultValue="1") int page){long user=principals.require("ai:session:use").userId();return R.ok(jdbc.queryForList("SELECT a.id,r.session_id,a.run_id,CASE WHEN a.status='PENDING' AND a.expires_at<NOW() THEN 'EXPIRED' ELSE a.status END AS status,a.created_at,a.expires_at FROM ai_tool_approval a JOIN ai_run r ON r.id=a.run_id WHERE r.owner_user_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 30 OFFSET ?",user,offset(page)));}
}
