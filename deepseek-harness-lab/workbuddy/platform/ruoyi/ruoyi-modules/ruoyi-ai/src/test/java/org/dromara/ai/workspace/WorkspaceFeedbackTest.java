package org.dromara.ai.workspace;

import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorkspaceFeedbackTest {
    @Test
    void employeeSubmissionUsesTheRealSessionPrincipal() {
        var principals = mock(WorkspacePrincipal.class);
        var feedback = mock(WorkspaceFeedback.class);
        var execution = mock(ExecutionCredentials.class);
        var controller = new WorkspaceFeedbackController(principals, feedback, execution);
        var actor = new WorkspacePrincipal.Actor(17L, 3L, false);
        var input = new WorkspaceFeedback.Create(
            "task-1", UUID.randomUUID(), "other", "short note", "completed",
            List.of("create_office_document"), List.of(UUID.randomUUID()));
        when(principals.require("ai:session:use")).thenReturn(actor);
        when(feedback.create(17L, input)).thenReturn(Map.of("status", "NEW"));

        controller.create("Bearer host-service", input);

        verify(execution).checkBackgroundService("Bearer host-service");
        verify(principals).require("ai:session:use");
        verify(feedback).create(17L, input);
    }

    @Test
    void provenanceCaptureRequiresHostServiceAndEmployeePrincipal() {
        var principals = mock(WorkspacePrincipal.class);
        var feedback = mock(WorkspaceFeedback.class);
        var execution = mock(ExecutionCredentials.class);
        var controller = new WorkspaceFeedbackController(principals, feedback, execution);
        var input = new WorkspaceFeedback.Capture("task-1", UUID.randomUUID(), UUID.randomUUID());
        when(principals.require("ai:session:use"))
            .thenReturn(new WorkspacePrincipal.Actor(17L, 3L, false));
        when(feedback.capture(17L, input)).thenReturn(Map.of("captured", true));

        controller.capture("Bearer host-service", input);

        verify(execution).checkBackgroundService("Bearer host-service");
        verify(principals).require("ai:session:use");
        verify(feedback).capture(17L, input);
    }

    @Test
    void categoryOnlyFeedbackStoresAnEmptyNoteAndHostMetadata() {
        var jdbc = mock(JdbcTemplate.class);
        var tx = mock(TransactionTemplate.class);
        when(tx.execute(any())).thenAnswer(invocation ->
            ((TransactionCallback<?>) invocation.getArgument(0)).doInTransaction(null));
        when(jdbc.queryForList(anyString(), any(Object[].class))).thenReturn(List.of());
        when(jdbc.queryForMap("SELECT * FROM ai_feedback WHERE id=?", any(UUID.class)))
            .thenReturn(Map.of("note", "", "actual_task_state", "completed"));
        var feedback = new WorkspaceFeedback(
            jdbc,
            tx,
            mock(AiResourceGuard.class),
            mock(WorkspaceModelAccess.class),
            mock(WorkspaceSkills.class),
            mock(WorkspaceMcpAccess.class),
            mock(WorkspaceToolAccess.class));
        var input = new WorkspaceFeedback.Create(
            "task-1", UUID.randomUUID(), "correct", null, "completed", List.of(), List.of());

        feedback.create(17L, input);

        var arguments = org.mockito.ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(contains("INSERT INTO ai_feedback"), arguments.capture());
        assertEquals("", arguments.getValue()[8]);
        assertEquals("completed", arguments.getValue()[9]);
        assertEquals("[]", arguments.getValue()[10]);
        assertEquals("[]", arguments.getValue()[11]);
    }

    @Test
    void adminReadsAreGatedByTheExistingAuditPermission() {
        var principals = mock(WorkspacePrincipal.class);
        var feedback = mock(WorkspaceFeedback.class);
        var controller = new WorkspaceFeedbackController(
            principals, feedback, mock(ExecutionCredentials.class));
        when(principals.require("ai:audit:view"))
            .thenReturn(new WorkspacePrincipal.Actor(1L, 1L, false));
        when(feedback.list("NEW", null, 1)).thenReturn(List.of());

        controller.list("NEW", null, 1);

        verify(principals).require("ai:audit:view");
        verify(feedback).list("NEW", null, 1);
    }

    @Test
    void adminRecheckUsesTheAuthorizedAdminActor() {
        var principals = mock(WorkspacePrincipal.class);
        var feedback = mock(WorkspaceFeedback.class);
        var controller = new WorkspaceFeedbackController(
            principals, feedback, mock(ExecutionCredentials.class));
        var actor = new WorkspacePrincipal.Actor(9L, 2L, false);
        var id = UUID.randomUUID();
        var input = new WorkspaceFeedback.Recheck(
            "Recalculate the affected total", "42", "42", "check-43", "PASSED");
        when(principals.require("ai:audit:view")).thenReturn(actor);
        when(feedback.recheck(9L, id, input)).thenReturn(Map.of("status", "RESOLVED"));

        controller.recheck(id, input);

        verify(principals).require("ai:audit:view");
        verify(feedback).recheck(9L, id, input);
    }

    @Test
    void statusProgressionDoesNotAllowClosingAnUnprocessedCase() {
        assertTrue(WorkspaceFeedback.transition("NEW", "IN_PROGRESS"));
        assertTrue(WorkspaceFeedback.transition("IN_PROGRESS", "RESOLVED"));
        assertTrue(WorkspaceFeedback.transition("RESOLVED", "CLOSED"));
        assertFalse(WorkspaceFeedback.transition("NEW", "CLOSED"));
        assertFalse(WorkspaceFeedback.transition("IN_PROGRESS", "CLOSED"));
    }

    @Test
    void aLaterFailedRecheckPreventsCloseEvenWhenAnEarlierCheckPassed() {
        var jdbc = mock(JdbcTemplate.class);
        var tx = mock(TransactionTemplate.class);
        when(tx.execute(any())).thenAnswer(invocation ->
            ((TransactionCallback<?>) invocation.getArgument(0)).doInTransaction(null));
        var feedback = new WorkspaceFeedback(
            jdbc,
            tx,
            mock(AiResourceGuard.class),
            mock(WorkspaceModelAccess.class),
            mock(WorkspaceSkills.class),
            mock(WorkspaceMcpAccess.class),
            mock(WorkspaceToolAccess.class));
        UUID id = UUID.randomUUID();
        when(jdbc.queryForList("SELECT * FROM ai_feedback WHERE id=? FOR UPDATE", id)).thenReturn(List.of(Map.ofEntries(
            Map.entry("status", "RESOLVED"),
            Map.entry("record_version", 4),
            Map.entry("resolution_revision", 2),
            Map.entry("badcase_description", "Observed mismatch"),
            Map.entry("root_cause", "Manually confirmed mapping defect"),
            Map.entry("cause_evidence", "check-42"),
            Map.entry("expected_result", "Expected mapped total"),
            Map.entry("resolution", "Corrected the mapping"))));
        when(jdbc.queryForObject(contains("ORDER BY checked_at DESC,id DESC LIMIT 1"),
            org.mockito.ArgumentMatchers.eq(Boolean.class), org.mockito.ArgumentMatchers.eq(id),
            org.mockito.ArgumentMatchers.eq(2))).thenReturn(false);
        var input = new WorkspaceFeedback.Update(
            "CLOSED", "Observed mismatch", "Manually confirmed mapping defect", "check-42",
            "Expected mapped total", "Corrected the mapping", 4);

        WorkspaceDenied denied = assertThrows(WorkspaceDenied.class, () -> feedback.update(9L, id, input));

        assertEquals("FeedbackRecheckRequired", denied.getMessage());
        verify(jdbc, never()).update(contains("UPDATE ai_feedback"), any(Object[].class));
    }
}
