package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import java.util.*;

/** Current Core relay receipts, independent of the historical Harness execution tables. */
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceOfficeUsage {
 private final WorkspacePrincipal principals;private final JdbcTemplate jdbc;
 @GetMapping({"/usage","/admin/core-usage"})
 public R<?> calls(@RequestParam(required=false) Long userId,@RequestParam(required=false) UUID modelId,
  @RequestParam(required=false) String conversationId,@RequestParam(defaultValue="1") int page,
  jakarta.servlet.http.HttpServletRequest request){
  var actor=principals.current();boolean admin=request.getRequestURI().contains("/admin/");
  if(admin||userId!=null&&userId!=actor.userId())principals.require("ai:audit:view");
  long selected=userId==null&&!admin?actor.userId():userId==null?0:userId;
  if(page<1||page>1000||conversationId!=null&&!conversationId.matches("[A-Za-z0-9_-]{1,100}"))throw new WorkspaceDenied(400,"InvalidUsageFilter");
  String sql="""
    SELECT f.id,f.actor_user_id::text AS owner_user_id,f.resource_id::text AS model_id,
     f.metadata->>'callId' AS call_id,f.metadata->>'conversationId' AS conversation_id,
     f.metadata->>'modelCode' AS model_code,f.metadata->>'status' AS status,
     (f.metadata->>'usageReported')::boolean AS usage_reported,
     (f.metadata->>'inputTokens')::bigint AS input_tokens,
     (f.metadata->>'outputTokens')::bigint AS output_tokens,
     (f.metadata->>'estimatedCost')::numeric AS estimated_cost,
     f.metadata->>'currency' AS currency,f.metadata->>'costStatus' AS cost_status,f.created_at
    FROM ai_security_event f WHERE f.action='model.relay.finished'
    """;
  var args=new ArrayList<Object>();
  if(selected!=0){sql+=" AND f.actor_user_id=?";args.add(selected);}
  if(modelId!=null){sql+=" AND f.resource_id=?";args.add(modelId);}
  if(conversationId!=null){sql+=" AND f.metadata->>'conversationId'=?";args.add(conversationId);}
  sql+=" ORDER BY f.created_at DESC,f.id DESC LIMIT 30 OFFSET ?";args.add((page-1)*30);
  return R.ok(jdbc.queryForList(sql,args.toArray()));
 }
}
