package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Same-origin authorization probe used only by the loopback Caddy forward-auth hop. */
@RestController
@RequiredArgsConstructor
public class WorkspaceMonitorAccessController {
    private final WorkspacePrincipal principals;

    @GetMapping("/internal/monitor/access")
    public ResponseEntity<Void> access() {
        principals.require("monitor:admin:list");
        return ResponseEntity.noContent().build();
    }
}
