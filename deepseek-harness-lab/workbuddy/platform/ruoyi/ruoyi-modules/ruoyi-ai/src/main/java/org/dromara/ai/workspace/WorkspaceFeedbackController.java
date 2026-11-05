package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.dromara.common.core.domain.R;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class WorkspaceFeedbackController {
    private final WorkspacePrincipal principals;
    private final WorkspaceFeedback feedback;
    private final ExecutionCredentials execution;

    @PostMapping("/me/feedback/provenance")
    public R<?> capture(
        @RequestHeader("X-ZhenWork-Host-Service") String serviceAuthorization,
        @RequestBody WorkspaceFeedback.Capture input
    ) {
        execution.checkBackgroundService(serviceAuthorization);
        long user = principals.require("ai:session:use").userId();
        return R.ok(feedback.capture(user, input));
    }

    @GetMapping("/me/feedback")
    public R<?> mine(@RequestParam String taskId, @RequestParam UUID attemptId) {
        long user = principals.require("ai:session:use").userId();
        return R.ok(feedback.mine(user, taskId, attemptId));
    }

    @PostMapping("/me/feedback")
    public R<?> create(
        @RequestHeader("X-ZhenWork-Host-Service") String serviceAuthorization,
        @RequestBody WorkspaceFeedback.Create input
    ) {
        execution.checkBackgroundService(serviceAuthorization);
        long user = principals.require("ai:session:use").userId();
        return R.ok(feedback.create(user, input));
    }

    @GetMapping("/admin/feedback")
    public R<?> list(
        @RequestParam(required = false) String status,
        @RequestParam(required = false) String category,
        @RequestParam(defaultValue = "1") int page
    ) {
        principals.require("ai:audit:view");
        return R.ok(feedback.list(status, category, page));
    }

    @GetMapping("/admin/feedback/{id}")
    public R<?> detail(@PathVariable UUID id) {
        principals.require("ai:audit:view");
        return R.ok(feedback.detail(id));
    }

    @PatchMapping("/admin/feedback/{id}")
    public R<?> update(@PathVariable UUID id, @RequestBody WorkspaceFeedback.Update input) {
        long actor = principals.require("ai:audit:view").userId();
        return R.ok(feedback.update(actor, id, input));
    }

    @PostMapping("/admin/feedback/{id}/rechecks")
    public R<?> recheck(@PathVariable UUID id, @RequestBody WorkspaceFeedback.Recheck input) {
        long actor = principals.require("ai:audit:view").userId();
        return R.ok(feedback.recheck(actor, id, input));
    }
}
