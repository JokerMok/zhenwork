package org.dromara.ai.workspace.runtime;

import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.*;
import org.dromara.common.core.domain.R;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@SaIgnore
@RestController
@RequestMapping("/internal/rc2")
@RequiredArgsConstructor
public class ExecutionController {
    private final WorkspaceConversations conversations;
    private final WorkspaceSecrets secrets;
    private final WorkspaceMcpAccess mcp;
    private final WorkspaceTools tools;
    private final WorkspaceKnowledge knowledge;
    private final WorkspaceFileController files;
    private final JdbcTemplate jdbc;
    private final WorkspaceUsage usage;
    public record Grant(String executionGrant){}
    public record KnowledgeRequest(String executionGrant,String query,UUID fileId){}
    public record ToolRequest(String executionGrant,UUID resourceId,String callId,Map<String,Object> arguments,UUID approvalId,String argsHash){}
    public record McpGrant(String executionGrant,UUID resourceId){}
    public record Event(String executionGrant,UUID eventId,String type,Map<String,Object> payload){}
    @PostMapping("/call-start") public R<?> callStart(@RequestBody WorkspaceUsage.Start input){return R.ok(usage.start(input));}
    @PostMapping("/call-finish") public R<?> callFinish(@RequestBody WorkspaceUsage.Finish input){usage.finish(input);return R.ok();}
    @PostMapping("/check") public R<?> check(@RequestBody Grant input){var r=conversations.checkGrant(input.executionGrant(),true);return R.ok(Map.of("userId",r.get("owner_user_id").toString(),"sessionId",r.get("session_id").toString(),"runId",r.get("id").toString(),"config",JsonUtils.parseMap(r.get("config_snapshot").toString())));}
    @PostMapping("/provider") public R<?> provider(@RequestBody Grant input){var r=conversations.checkGrant(input.executionGrant(),true);var config=JsonUtils.parseMap(r.get("config_snapshot").toString());String cipher=jdbc.queryForObject("SELECT secret_cipher FROM ai_provider WHERE id=? AND version=? AND enabled",String.class,UUID.fromString(config.get("provider_id").toString()),Long.parseLong(config.get("provider_version").toString()));var data=new LinkedHashMap<String,Object>(config);data.put("secret",secrets.decrypt(cipher));return R.ok(data);}
    @PostMapping("/mcp") public R<?> mcp(@RequestBody McpGrant input){var r=conversations.checkGrant(input.executionGrant(),true);var config=JsonUtils.parseMap(r.get("config_snapshot").toString());for(var item:(List<Map<String,Object>>)config.getOrDefault("mcps",List.of()))if(input.resourceId().toString().equals(item.get("id")))return R.ok(mcp.secretPlan(UUID.fromString(item.get("connectionId").toString()),Long.parseLong(item.get("connectionAuthVersion").toString()),((Number)r.get("owner_user_id")).longValue()));throw new WorkspaceDenied(403,"McpNotSelected");}
    @PostMapping("/approvals") public R<?> approval(@RequestBody ToolRequest input){return R.ok(tools.request(input.executionGrant(),input.approvalId(),input.resourceId(),input.callId(),input.arguments(),input.argsHash()));}
    @PostMapping("/tool-execute") public R<?> execute(@RequestBody ToolRequest input){return R.ok(tools.execute(input.executionGrant(),input.resourceId(),input.callId(),input.arguments(),input.approvalId()));}
    @PostMapping("/knowledge-search") public R<?> knowledge(@RequestBody KnowledgeRequest input){return R.ok(knowledge.retrieve(input.executionGrant(),input.query()));}
    @PostMapping("/attachment-read") public R<?> attachment(@RequestBody KnowledgeRequest input){return R.ok(files.readAttachment(input.executionGrant(),input.fileId()));}
    @PostMapping("/events") public R<?> event(@RequestBody Event input){conversations.accept(input.executionGrant(),input.eventId(),input.type(),input.payload());return R.ok();}
}
