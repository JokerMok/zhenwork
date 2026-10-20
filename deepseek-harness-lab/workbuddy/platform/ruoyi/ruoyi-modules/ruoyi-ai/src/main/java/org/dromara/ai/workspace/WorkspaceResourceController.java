package org.dromara.ai.workspace;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceResourceController {
    private final WorkspaceResources resources;
    private final WorkspacePublication publication;
    private final WorkspaceAssistantReadiness readiness;
    private final WorkspacePrincipal principals;
    public record Create(@NotBlank String resourceType,@NotBlank @Size(max=100) String name,@Size(max=500) String description,Boolean enterprise,@NotNull Map<String,Object> config,@NotNull UUID idempotencyKey){}
    public record Edit(@Min(1) int expectedVersion,@NotBlank @Size(max=100) String name,@Size(max=500) String description,@NotNull Map<String,Object> config){}
    public record Activate(@Min(1) int version){}
    public record Share(@NotBlank String subjectType,@NotBlank @Pattern(regexp="[0-9]{1,19}") String subjectId,@NotEmpty Set<String> actions){}
    public record ReviewDecision(boolean approve,@NotBlank @Size(max=1000) String reason){}
    public record Enable(boolean enabled,@Size(max=1000) String reason){}
    private long subject(String value){try{return Long.parseLong(value);}catch(NumberFormatException e){throw new WorkspaceDenied(400,"InvalidShareSubject");}}
    private long actor(){var actor=principals.current();if(actor.mustChangePassword())throw new WorkspaceDenied(403,"PasswordChangeRequired");return actor.userId();}
    @PostMapping("/resources") public R<?> create(@Valid @RequestBody Create input){return R.ok(resources.create(actor(),input.resourceType(),input.name(),Objects.toString(input.description(),""),Boolean.TRUE.equals(input.enterprise()),input.config(),input.idempotencyKey()));}
    @GetMapping("/resources") public R<?> list(@RequestParam(defaultValue="ASSISTANT") String type,@RequestParam(defaultValue="mine") String scope,@RequestParam(defaultValue="1") int page){return R.ok(resources.list(actor(),type,scope,page));}
    @GetMapping("/resources/{id}") public R<?> get(@PathVariable UUID id,@RequestParam(defaultValue="false") boolean active){return R.ok(active?resources.active(id,actor()):resources.get(id,actor()));}
    @GetMapping("/resources/{id}/versions") public R<?> versions(@PathVariable UUID id){return R.ok(resources.versions(id,actor()));}
    @GetMapping("/resources/{id}/versions/{version}") public R<?> version(@PathVariable UUID id,@PathVariable @Min(1) int version){return R.ok(resources.version(id,version,actor()));}
    @GetMapping("/resources/{id}/readiness") public R<?> readiness(@PathVariable UUID id){return R.ok(readiness.check(id,actor()));}
    @GetMapping("/resources/{id}/publication-check") public R<?> publicationCheck(@PathVariable UUID id,@RequestParam int version){return R.ok(publication.publicationCheck(id,version,actor()));}
    @PutMapping("/resources/{id}") public R<?> edit(@PathVariable UUID id,@Valid @RequestBody Edit input){return R.ok(resources.edit(id,actor(),input.expectedVersion(),input.name(),Objects.toString(input.description(),""),input.config()));}
    @PostMapping("/resources/{id}/activate") public R<?> activate(@PathVariable UUID id,@Valid @RequestBody Activate input){return R.ok(resources.activate(id,actor(),input.version()));}
    @PostMapping("/resources/{id}/shares") public R<?> share(@PathVariable UUID id,@Valid @RequestBody Share input){return R.ok(resources.share(id,actor(),input.subjectType(),subject(input.subjectId()),input.actions()));}
    @DeleteMapping("/resources/{id}/shares/{share}") public R<?> revoke(@PathVariable UUID id,@PathVariable UUID share){resources.revoke(id,share,actor());return R.ok();}
    @GetMapping("/resources/{id}/shares") public R<?> shares(@PathVariable UUID id){return R.ok(publication.shares(id,actor()));}
    @GetMapping("/share-targets") public R<?> targets(@RequestParam String type,@RequestParam String query){return R.ok(publication.targets(type,query,actor()));}
    @PostMapping("/resources/{id}/publication") public R<?> submit(@PathVariable UUID id,@Valid @RequestBody Activate input){return R.ok(publication.submit(id,input.version(),actor()));}
    @DeleteMapping("/resources/{id}/publication") public R<?> unpublish(@PathVariable UUID id){publication.unpublish(id,actor());return R.ok();}
    @GetMapping("/resources/{id}/reviews") public R<?> ownReviews(@PathVariable UUID id){return R.ok(publication.ownReviews(id,actor()));}
    @GetMapping("/admin/reviews") public R<?> reviews(@RequestParam(defaultValue="1") int page){return R.ok(publication.reviews(actor(),page));}
    @GetMapping("/admin/reviews/{id}") public R<?> review(@PathVariable UUID id){return R.ok(publication.review(id,actor()));}
    @GetMapping("/admin/reviews/{id}/documents/{document}") public R<?> reviewDocument(@PathVariable UUID id,@PathVariable UUID document){return R.ok(publication.reviewDocument(id,document,actor()));}
    @PostMapping("/admin/reviews/{id}/decision") public R<?> decide(@PathVariable UUID id,@Valid @RequestBody ReviewDecision input){publication.decide(id,actor(),input.approve(),input.reason());return R.ok();}
    @PutMapping("/resources/{id}/enabled") public R<?> enable(@PathVariable UUID id,@Valid @RequestBody Enable input){resources.enable(id,actor(),input.enabled(),false,input.reason());return R.ok();}
    @DeleteMapping("/resources/{id}") public R<?> archive(@PathVariable UUID id){resources.archive(id,actor());return R.ok();}
    @GetMapping("/govern/resources") public R<?> governance(@RequestParam(defaultValue="1") int page){return R.ok(resources.governance(actor(),page));}
    @PutMapping("/govern/resources/{id}/enabled") public R<?> govern(@PathVariable UUID id,@Valid @RequestBody Enable input){resources.enable(id,actor(),input.enabled(),true,input.reason());return R.ok();}
}
