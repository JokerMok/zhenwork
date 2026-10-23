package org.dromara.ai.workspace.external;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.WorkspacePrincipal;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/ai/external")
@RequiredArgsConstructor
public class ExternalConnectionController {
    private final ExternalConnectionService service;
    private final WorkspacePrincipal principals;
    public record Verify(@Min(1) long expectedVersion) {}
    public record Expert(Long expectedVersion,java.util.List<UUID> connectionIds) {}
    private long actor(){return principals.require("ai:resource:enterprise").userId();}
    @GetMapping("/connectors") public R<?> catalogs(){long actor=actor();return R.ok(service.catalogs(actor));}
    @GetMapping("/connections") public R<?> list(){long actor=actor();return R.ok(service.list(actor));}
    @PostMapping("/connections") public R<?> create(@RequestBody ExternalConnectionService.Save input){long actor=actor();return R.ok(service.create(actor,input));}
    @PutMapping("/connections/{id}") public R<?> update(@PathVariable UUID id,@RequestBody ExternalConnectionService.Save input){long actor=actor();return R.ok(service.update(id,actor,input));}
    @PostMapping("/connections/{id}/verify") public R<?> verify(@PathVariable UUID id,@Valid @RequestBody Verify input){long actor=actor();return R.ok(service.verify(id,input.expectedVersion(),actor));}
    @GetMapping("/connections/{id}/calls") public R<?> calls(@PathVariable UUID id,@RequestParam(defaultValue="1") int page){long actor=actor();return R.ok(service.calls(id,actor,page));}
    @PostMapping("/connections/{id}/expert") public R<?> expert(@PathVariable UUID id,@RequestBody(required=false) Expert input){long actor=actor();return R.ok(service.expert(id,input==null?null:input.expectedVersion(),input==null?null:input.connectionIds(),actor));}
}
