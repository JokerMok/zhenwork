package org.dromara.ai.workspace;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.*;
import java.util.*;
@RestController
@RequestMapping("/ai/admin")
@RequiredArgsConstructor
public class WorkspaceModelAdminController {
    private final WorkspaceModelAdmin service;
    private final WorkspacePrincipal principals;
    public record Provider(@NotBlank @Size(max=100) String name,@NotBlank String providerType,@NotBlank @Size(max=500) String baseUrl,@NotBlank String protocol,@Size(max=4096) String secret,@NotNull Boolean enabled,@Min(5) @Max(120) int timeoutSeconds,@Min(0) @Max(2) int retryCount,Long expectedVersion){}
    public record Model(@NotNull UUID providerId,@NotBlank @Pattern(regexp="[a-zA-Z0-9._:/-]{1,160}") String code,@NotBlank @Size(max=100) String name,@NotNull Boolean enabled,@NotNull Boolean streaming,@NotNull Boolean tools,@NotNull Boolean vision,@Min(1024) @Max(2000000) int contextWindow,@Min(1) @Max(32768) int maxOutputTokens,@NotNull Map<String,Object> defaultParameters,@NotNull Map<String,Object> costConfig,Long expectedVersion){}
    public record Grant(@NotBlank String subjectType,@NotBlank @Pattern(regexp="[0-9]{1,19}") String subjectId){}
    private long providerActor(){return principals.require("ai:provider:admin").userId();}
    private long modelActor(){return principals.require("ai:model:admin").userId();}
    @GetMapping("/providers") public R<?> providers(@RequestParam(defaultValue="1") int page){providerActor();return R.ok(service.providers(page));}
    @GetMapping("/providers/{id}") public R<?> provider(@PathVariable UUID id){providerActor();return R.ok(service.provider(id));}
    @PostMapping("/providers") public R<?> createProvider(@Valid @RequestBody Provider input){return R.ok(service.saveProvider(null,providerActor(),input));}
    @PutMapping("/providers/{id}") public R<?> updateProvider(@PathVariable UUID id,@Valid @RequestBody Provider input){return R.ok(service.saveProvider(id,providerActor(),input));}
    @DeleteMapping("/providers/{id}/secret") public R<?> clearProviderSecret(@PathVariable UUID id,@RequestParam long expectedVersion){service.clearProviderSecret(id,providerActor(),expectedVersion);return R.ok();}
    @GetMapping("/models") public R<?> models(@RequestParam(defaultValue="1") int page){modelActor();return R.ok(service.models(page));}
    @PostMapping("/models") public R<?> createModel(@Valid @RequestBody Model input){return R.ok(service.saveModel(null,modelActor(),input));}
    @PutMapping("/models/{id}") public R<?> updateModel(@PathVariable UUID id,@Valid @RequestBody Model input){return R.ok(service.saveModel(id,modelActor(),input));}
    @GetMapping("/models/{id}/grants") public R<?> grants(@PathVariable UUID id){modelActor();return R.ok(service.policies(id));}
    @PostMapping("/models/{id}/grants") public R<?> grant(@PathVariable UUID id,@Valid @RequestBody Grant input){service.grant(id,modelActor(),input.subjectType(),input.subjectId());return R.ok();}
    @DeleteMapping("/models/{id}/grants/{grant}") public R<?> revoke(@PathVariable UUID id,@PathVariable UUID grant){service.revoke(id,grant,modelActor());return R.ok();}
    @GetMapping("/models/{id}/tests") public R<?> tests(@PathVariable UUID id){modelActor();return R.ok(service.tests(id));}
    @PostMapping("/models/{id}/tests") public R<?> test(@PathVariable UUID id){modelActor();providerActor();return R.ok(service.test(id,modelActor()));}
}
