package org.dromara.ai.workspace;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/ai/skills")
@RequiredArgsConstructor
public class WorkspaceSkillController {
    private final WorkspaceSkillImports imports;
    private final WorkspaceSkillDependencyChecks dependencyChecks;
    private final ExecutionCredentials execution;
    private final WorkspacePrincipal principals;
    public record Preview(@NotBlank @Size(max=201) String repository,@NotBlank @Size(max=200) String ref,@NotBlank @Size(max=400) String path){}
    public record Import(@NotBlank @Size(max=201) String repository,@NotBlank @Pattern(regexp="[0-9a-f]{40}") String commit,@NotBlank @Size(max=400) String path,@NotBlank @Size(max=100) String name,@Size(max=500) String description,@NotNull UUID idempotencyKey){}
    public record Update(@Min(1) int expectedVersion,@NotBlank @Size(max=201) String repository,@NotBlank @Pattern(regexp="[0-9a-f]{40}") String commit,@NotBlank @Size(max=400) String path,@NotBlank @Size(max=100) String name,@Size(max=500) String description){}
    public record DependencyCheck(@Min(1) int resourceVersion,@NotBlank @Pattern(regexp="[0-9a-f]{64}") String packageSha256,
        @NotBlank @Pattern(regexp="sha256:[0-9a-f]{64}") String runtimeFingerprint,@NotBlank String state,
        @NotNull @Size(max=100) List<WorkspaceSkillDependencyChecks.Declaration> declarations) {}
    private long actor(){var actor=principals.current();if(actor.mustChangePassword())throw new WorkspaceDenied(403,"PasswordChangeRequired");return actor.userId();}
    @PostMapping("/import/github/preview") public R<?> preview(@Valid @RequestBody Preview input){return R.ok(imports.preview(actor(),input.repository(),input.ref(),input.path()));}
    @PostMapping("/import/github") public R<?> create(@Valid @RequestBody Import input){return R.ok(imports.create(actor(),input.repository(),input.commit(),input.path(),input.name(),input.description()==null?"":input.description(),input.idempotencyKey()));}
    @PostMapping("/{id}/import/github") public R<?> update(@PathVariable UUID id,@Valid @RequestBody Update input){return R.ok(imports.update(id,actor(),input.expectedVersion(),input.repository(),input.commit(),input.path(),input.name(),input.description()==null?"":input.description()));}
    @PostMapping("/{id}/dependency-checks") public R<?> dependencyCheck(@PathVariable UUID id,
        @RequestHeader("X-ZhenWork-Host-Service") String service,@Valid @RequestBody DependencyCheck input){
        execution.checkBackgroundService(service);
        long actor=principals.require("ai:skill:use").userId();
        return R.ok(dependencyChecks.record(id,actor,input.resourceVersion(),input.packageSha256(),input.runtimeFingerprint(),input.state(),input.declarations()));
    }
    @GetMapping("/{id}/dependency-checks") public R<?> dependencyCheck(@PathVariable UUID id){
        long actor=principals.require("ai:resource:enterprise").userId();
        return R.ok(dependencyChecks.current(id,actor));
    }
}
