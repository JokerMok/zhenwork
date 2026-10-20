package org.dromara.ai.workspace;

import cn.dev33.satoken.annotation.SaIgnore;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

/** Job-bound read only knowledge access. The service credential alone never grants employee access. */
@SaIgnore
@RestController
@RequiredArgsConstructor
public class WorkspaceBackgroundKnowledgeController {
 private final WorkspaceBackgroundGrants grants;private final ExecutionCredentials execution;
 private final WorkspacePermissions permissions;private final WorkspaceKnowledge knowledge;
 @GetMapping("/internal/rc2/background/grants/{grantId}/knowledge/{base}/search")
 public R<?> search(@PathVariable UUID grantId,@PathVariable UUID base,@RequestParam String query,
   @RequestHeader("Authorization") String service,@RequestHeader("X-Aion-Background-Secret") String secret){
  execution.checkBackgroundService(service);var actor=grants.require(grantId,secret);
  permissions.require(actor.userId(),"ai:knowledge:view");
  var result=knowledge.search(base,actor.userId(),query);
  grants.require(grantId,secret);return R.ok(result);
 }
}
