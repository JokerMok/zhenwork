package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class WorkspaceKnowledgeAccessTest {
    @Test
    void deletedDocumentIsNotReturned() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForList(anyString(), any(UUID.class))).thenReturn(List.of());
        var access = new WorkspaceKnowledgeAccess(jdbc, mock(AiResourceGuard.class), mock(WorkspaceFileStore.class));
        WorkspaceDenied denied = assertThrows(WorkspaceDenied.class, () -> access.document(UUID.randomUUID(), 7, AiResourceGuard.Action.VIEW));
        assertEquals(404, denied.status);assertEquals("DocumentNotFound", denied.getMessage());
    }

    @Test
    void revokedRunDocumentStopsReturningKnowledge() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);AiResourceGuard guard = mock(AiResourceGuard.class);
        UUID run = UUID.randomUUID(), base = UUID.randomUUID(), document = UUID.randomUUID();
        Map<String,Object> revoked = new HashMap<>();revoked.put("document_id", document);revoked.put("auth_version", 2L);revoked.put("current_auth", 3L);revoked.put("deleted_at", Instant.now());revoked.put("base_id", base);
        when(jdbc.queryForList(startsWith("SELECT p.document_id"), eq(run))).thenReturn(List.of(revoked));
        when(guard.require(eq(base), eq(7L), eq(AiResourceGuard.Action.USE))).thenReturn(Map.of("resource_type", "KNOWLEDGE"));
        var access = new WorkspaceKnowledgeAccess(jdbc, guard, mock(WorkspaceFileStore.class));
        WorkspaceDenied denied = assertThrows(WorkspaceDenied.class, () -> access.checkRun(run, 7));
        assertEquals(403, denied.status);assertEquals("KnowledgeDocumentRevoked", denied.getMessage());
    }
}
