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
public class WorkspaceConversationController {
    private final WorkspacePrincipal principals;
    private final WorkspaceModelAccess access;
    private final WorkspaceConversations conversations;
    private final WorkspaceEvents events;
    public record Create(@NotNull UUID modelId,@NotBlank @Size(max=100) String title,@NotNull UUID idempotencyKey,UUID assistantId) {}
    public record Send(@NotBlank @Size(max=12000) String text,@NotNull UUID idempotencyKey) {}
    @GetMapping("/me") public R<Map<String,Object>> me(){var actor=principals.current();return R.ok(Map.of("userId",Long.toString(actor.userId()),"mustChangePassword",actor.mustChangePassword()));}
    @GetMapping("/models/available") public R<?> models(){var actor=principals.require("ai:model:use");access.checkIdentity(actor.userId(),actor.authVersion());return R.ok(access.models(actor.userId()));}
    @GetMapping("/sessions") public R<?> list(@RequestParam(defaultValue="1") int page){var actor=principals.require("ai:session:use");return R.ok(conversations.list(actor.userId(),page));}
    @PostMapping("/sessions") public R<?> create(@Valid @RequestBody Create input){var actor=principals.require("ai:session:use");return R.ok(conversations.create(actor,input.modelId(),input.title(),input.idempotencyKey(),input.assistantId()));}
    @GetMapping("/sessions/{id}") public R<?> history(@PathVariable UUID id){return R.ok(conversations.history(id,principals.require("ai:session:use")));}
    @PostMapping("/sessions/{id}/runs") public R<?> send(@PathVariable UUID id,@Valid @RequestBody Send input){return R.ok(conversations.send(id,principals.require("ai:session:use"),input.text(),input.idempotencyKey()));}
    @PostMapping("/sessions/{id}/resume") public R<?> resume(@PathVariable UUID id){return R.ok(conversations.history(id,principals.require("ai:session:use")));}
    @PostMapping("/sessions/{id}/cancel") public R<?> cancel(@PathVariable UUID id){conversations.cancel(id,principals.require("ai:session:use"));return R.ok();}
    @GetMapping("/sessions/{id}/events") public R<?> events(@PathVariable UUID id,@RequestParam(defaultValue="0") long after){conversations.history(id,principals.require("ai:session:use"));if(after<0)throw new WorkspaceDenied(400,"InvalidSequence");return R.ok(events.after(id,after,500));}
}
