package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

@RestController
@RequestMapping("/ai/knowledge")
@RequiredArgsConstructor
public class WorkspaceKnowledgeDiagnosticsController {
 private final WorkspacePrincipal principals;private final WorkspaceKnowledgeDiagnostics diagnostics;
 public record Request(String query,UUID documentId,Integer version){}
 @PostMapping("/{base}/retrieval-diagnostics")
 public R<?> diagnose(@PathVariable UUID base,@RequestBody Request input){var actor=principals.require("ai:resource:enterprise");return R.ok(diagnostics.diagnose(base,actor.userId(),input.query(),input.documentId(),input.version()));}
}
