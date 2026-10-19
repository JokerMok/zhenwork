package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.*;
import java.math.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Content-free, control-issued call receipts. A receipt can record cost after cancellation, never execute. */
@Service
@RequiredArgsConstructor
public class WorkspaceUsage {
 private final JdbcTemplate jdbc; private final TransactionTemplate tx;
 private final WorkspaceConversations conversations; private final ExecutionCredentials credentials;
 public record Start(String executionGrant,UUID callId,String kind,UUID resourceId){}
 public record Finish(String receipt,String status,Long inputTokens,Long outputTokens,Long durationMs,Long providerTtfbMs,Long firstTokenMs,Integer httpStatus){}
 public Map<String,Object> start(Start input){
  if(input.callId()==null||!Set.of("MODEL","MCP").contains(Objects.toString(input.kind(),"")))throw new WorkspaceDenied(400,"InvalidCall");
  var r=conversations.checkGrant(input.executionGrant(),true);var config=JsonUtils.parseMap(r.get("config_snapshot").toString());
  if("MCP".equals(input.kind())&&((List<Map<String,Object>>)config.getOrDefault("mcps",List.of())).stream().noneMatch(m->Objects.toString(m.get("id")).equals(Objects.toString(input.resourceId()))))throw new WorkspaceDenied(403,"McpNotSelected");
  if("MODEL".equals(input.kind())&&input.resourceId()!=null)throw new WorkspaceDenied(400,"InvalidCall");
  jdbc.update("INSERT INTO ai_execution_call(id,run_id,owner_user_id,kind,resource_id,model_id,provider_id,cost_config) VALUES(?,?,?,?,?,?,?,?::jsonb) ON CONFLICT(id) DO NOTHING",input.callId(),r.get("id"),r.get("owner_user_id"),input.kind(),input.resourceId(),r.get("model_id"),UUID.fromString(config.get("provider_id").toString()),Objects.toString(config.get("cost_config"),"{}"));
  var row=jdbc.queryForMap("SELECT run_id,kind,resource_id FROM ai_execution_call WHERE id=?",input.callId());
  if(!row.get("run_id").equals(r.get("id"))||!row.get("kind").equals(input.kind())||!Objects.equals(row.get("resource_id"),input.resourceId()))throw new WorkspaceDenied(409,"CallConflict");
  return Map.of("id",input.callId(),"receipt",credentials.issue(Map.of("scope","usage.record","callId",input.callId().toString())));
 }
 private static void range(Long n,long max){if(n!=null&&(n<0||n>max))throw new WorkspaceDenied(400,"InvalidUsage");}
 public void finish(Finish input){
  var claims=credentials.verify(input.receipt(),"usage.record");UUID id=UUID.fromString(claims.get("callId").toString());
  if(!Set.of("COMPLETED","FAILED","CANCELLED").contains(Objects.toString(input.status(),"")))throw new WorkspaceDenied(400,"InvalidUsage");
  range(input.inputTokens(),1000000000);range(input.outputTokens(),1000000000);range(input.durationMs(),300000);range(input.providerTtfbMs(),300000);range(input.firstTokenMs(),300000);
  if(input.httpStatus()!=null&&(input.httpStatus()<100||input.httpStatus()>599))throw new WorkspaceDenied(400,"InvalidUsage");
  String fingerprint;try{fingerprint=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JsonUtils.toJsonString(Arrays.asList(input.status(),input.inputTokens(),input.outputTokens(),input.durationMs(),input.providerTtfbMs(),input.firstTokenMs(),input.httpStatus())).getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}
  tx.executeWithoutResult(txStatus->{var row=jdbc.queryForMap("SELECT status,finish_hash,cost_config::text FROM ai_execution_call WHERE id=? FOR UPDATE",id);
   if(!"STARTED".equals(row.get("status"))){if(!fingerprint.equals(row.get("finish_hash")))throw new WorkspaceDenied(409,"UsageConflict");return;}
   var rates=JsonUtils.parseMap(row.get("cost_config").toString());BigDecimal cost=null;String currency=null;
   if(input.inputTokens()!=null&&input.outputTokens()!=null&&rates.containsKey("inputPerMillion")&&rates.containsKey("outputPerMillion")&&Set.of("CNY","USD").contains(Objects.toString(rates.get("currency"),""))){currency=rates.get("currency").toString();cost=new BigDecimal(rates.get("inputPerMillion").toString()).multiply(BigDecimal.valueOf(input.inputTokens())).add(new BigDecimal(rates.get("outputPerMillion").toString()).multiply(BigDecimal.valueOf(input.outputTokens()))).divide(BigDecimal.valueOf(1000000),10,RoundingMode.HALF_UP);}
   jdbc.update("UPDATE ai_execution_call SET status=?,input_tokens=?,output_tokens=?,estimated_cost=?,currency=?,duration_ms=?,provider_ttfb_ms=?,first_token_ms=?,http_status=?,finish_hash=?,finished_at=NOW() WHERE id=?",input.status(),input.inputTokens(),input.outputTokens(),cost,currency,input.durationMs(),input.providerTtfbMs(),input.firstTokenMs(),input.httpStatus(),fingerprint,id);
  });
 }
}
