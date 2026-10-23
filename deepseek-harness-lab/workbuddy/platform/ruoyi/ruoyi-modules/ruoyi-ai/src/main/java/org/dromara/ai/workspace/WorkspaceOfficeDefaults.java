package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import java.util.*;

/** The enterprise default is a shared reference for employees; other models retain explicit grants. */
@RestController
@RequestMapping("/ai/admin/office-defaults")
@RequiredArgsConstructor
public class WorkspaceOfficeDefaults {
 private final JdbcTemplate jdbc; private final WorkspacePrincipal principals;
 public record Input(UUID modelId,long expectedVersion){}
 @GetMapping public R<?> get(){principals.require("ai:model:admin");return R.ok(jdbc.queryForMap("SELECT model_id::text,version,updated_at FROM ai_office_defaults WHERE singleton"));}
 @PutMapping public R<?> save(@RequestBody Input input){
  long user=principals.require("ai:model:admin").userId();
  if(input.modelId()==null||!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id WHERE m.id=? AND m.enabled AND m.streaming AND m.tools AND p.enabled)",Boolean.class,input.modelId())))throw new WorkspaceDenied(400,"DefaultModelMustSupportStreamingAndTools");
  if(jdbc.update("UPDATE ai_office_defaults SET model_id=?,version=version+1,updated_by=?,updated_at=NOW() WHERE singleton AND version=?",input.modelId(),user,input.expectedVersion())!=1)throw new WorkspaceDenied(409,"VersionConflict");
  jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,'office.default-model.updated',?,'{}'::jsonb)",UUID.randomUUID(),user,input.modelId());
  return get();
 }
}
