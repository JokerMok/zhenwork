package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceToolController {
 private final WorkspaceToolAccess access;private final WorkspacePrincipal principals;private final WorkspaceTools tools;private final JdbcTemplate jdbc;private final WorkspaceConversations conversations;
 public record TypeChange(boolean enabled,long expectedVersion){} public record Decision(boolean approve){}
 @PostMapping("/tools/{resource}/calculate") public R<?> calculate(@PathVariable UUID resource,@RequestBody Map<String,Object> args){return R.ok(access.calculate(principals.require("ai:tool:view").userId(),resource,args));}
 @GetMapping("/tool-types") public R<?> available(){principals.require("ai:tool:view");return R.ok(jdbc.queryForList("SELECT code,name,requires_approval FROM ai_tool_type WHERE enabled ORDER BY code"));}
 @GetMapping("/admin/tool-types") public R<?> types(){principals.require("ai:tool:admin");return R.ok(jdbc.queryForList("SELECT code,name,enabled,requires_approval,version FROM ai_tool_type ORDER BY code"));}
 @PutMapping("/admin/tool-types/{code}") public R<?> update(@PathVariable String code,@RequestBody TypeChange input){long actor=principals.require("ai:tool:admin").userId();if(jdbc.update("UPDATE ai_tool_type SET enabled=?,version=version+1,updated_by=?,updated_at=NOW() WHERE code=? AND version=?",input.enabled(),actor,code,input.expectedVersion())!=1)throw new WorkspaceDenied(409,"VersionConflict");conversations.revokeToolType(code);jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,metadata) VALUES(?,?,'tool.type.updated',jsonb_build_object('type',?::text,'enabled',?::boolean))",UUID.randomUUID(),actor,code,input.enabled());return R.ok();}
 @PostMapping("/sessions/{session}/approvals/{id}") public R<?> decide(@PathVariable UUID session,@PathVariable UUID id,@RequestBody Decision input){return R.ok(tools.decide(session,id,principals.current(),input.approve()));}
 @GetMapping("/artifacts/{id}/download") public ResponseEntity<byte[]> download(@PathVariable UUID id){var a=tools.artifact(id,principals.current());return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(a.get("filename").toString(),StandardCharsets.UTF_8).build().toString()).header("X-Content-Type-Options","nosniff").header(HttpHeaders.CACHE_CONTROL,"no-store").contentType(MediaType.TEXT_PLAIN).body(tools.bytes(a));}
}
