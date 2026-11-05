package org.dromara.ai.workspace;

import cn.dev33.satoken.stp.StpUtil;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.*;
import java.util.UUID;

/** Generates a preview only; existing resource version APIs remain the sole save path. */
@RestController
@RequestMapping("/ai/resources")
@RequiredArgsConstructor
public class WorkspacePersonalSkillController {
    private final WorkspacePrincipal principals;
    private final WorkspacePersonalSkillDraft drafts;
    public record Request(@Min(1) int expectedVersion, @NotBlank @Size(max=2000) String instruction) {}
    @PostMapping("/{id}/personal-draft")
    public R<?> draft(@PathVariable UUID id, @Valid @RequestBody Request input) {
        var actor=principals.require("ai:skill:edit");
        var token=StpUtil.getTokenValue();
        return R.ok(drafts.generate(id,input.expectedVersion(),input.instruction(),actor.userId(),actor.authVersion(),()->principals.fromToken(token)));
    }
}
