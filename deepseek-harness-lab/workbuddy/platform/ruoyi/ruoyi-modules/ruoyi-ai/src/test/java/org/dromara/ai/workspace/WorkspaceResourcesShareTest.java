package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class WorkspaceResourcesShareTest {
    @Test
    void duplicateShareWithSameActionsIsANoOp() {
        var jdbc=mock(JdbcTemplate.class);var tx=mock(TransactionTemplate.class);var permissions=mock(WorkspacePermissions.class);
        var guard=mock(AiResourceGuard.class);var conversations=mock(WorkspaceConversations.class);var readiness=mock(WorkspaceAssistantReadiness.class);var support=mock(WorkspaceShareSupport.class);
        var resources=new WorkspaceResources(jdbc,tx,permissions,guard,conversations,readiness,support);
        UUID resource=UUID.randomUUID(),share=UUID.randomUUID();long owner=7L,recipient=9L;
        var row=Map.<String,Object>of("published_version",1);
        when(tx.execute(any())).thenAnswer(invocation->((TransactionCallback<?>)invocation.getArgument(0)).doInTransaction(null));
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(row);
        when(guard.owner(row,owner)).thenReturn(true);
        when(jdbc.queryForObject(contains("FROM sys_user"),eq(Boolean.class),eq(recipient))).thenReturn(true);
        when(jdbc.queryForList(contains("FROM ai_resource_share"),any(),any(),any(),eq(resource),eq("USER"),eq(recipient))).thenReturn(List.of(Map.of("id",share.toString(),"same",true,"reduced",false)));

        var result=resources.share(resource,owner,"USER",recipient,Set.of("VIEW"));

        assertEquals(share.toString(),result.get("id"));
        assertEquals(false,result.get("changed"));
        verify(jdbc,never()).update(anyString(),any(Object[].class));
        verifyNoInteractions(conversations,support);
    }
}
