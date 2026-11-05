package org.dromara.ai.workspace;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@Tag("local")
class WorkspaceResourcePagingTest {
    @Test void authorizationFilteringDoesNotHideTheNextPage() {
        var jdbc = mock(JdbcTemplate.class);
        var guard = mock(AiResourceGuard.class);
        var permissions = mock(WorkspacePermissions.class);
        var resources = new WorkspaceResources(jdbc,null,permissions,guard,null,null,null);
        var ids = IntStream.range(0,31).mapToObj(i -> UUID.randomUUID()).toList();
        when(jdbc.queryForList(contains("LIMIT 31"), eq(UUID.class), eq("SKILL"), eq(7L), eq(0))).thenReturn(ids);
        when(guard.require(any(UUID.class), eq(7L), eq(AiResourceGuard.Action.VIEW)))
            .thenThrow(new WorkspaceDenied(404,"ResourceNotFound"));

        var first = resources.listPage(7L,"SKILL","enterprise",1);

        assertTrue(first.items().isEmpty());
        assertTrue(first.hasMore());
        verify(guard,never()).require(ids.getLast(),7L,AiResourceGuard.Action.VIEW);
        verify(permissions).require(7L,"ai:resource:enterprise");
    }

    @Test void dependencyLookupUsesTheExistingViewGuard() {
        var jdbc = mock(JdbcTemplate.class);
        var guard = mock(AiResourceGuard.class);
        var permissions = mock(WorkspacePermissions.class);
        var resources = new WorkspaceResources(jdbc,null,permissions,guard,null,null,null);
        var hidden = UUID.randomUUID();
        when(guard.require(hidden,7L,AiResourceGuard.Action.VIEW))
            .thenThrow(new WorkspaceDenied(404,"ResourceNotFound"));

        assertTrue(resources.dependencyOptions(7L,List.of(hidden,hidden)).isEmpty());
        verify(guard).require(hidden,7L,AiResourceGuard.Action.VIEW);
        verify(permissions).require(7L,"ai:resource:enterprise");
        verifyNoInteractions(jdbc);
    }
}
