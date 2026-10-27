package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@Tag("local")
class WorkspaceResourcesShareTest {
    @BeforeAll static void json(){WorkspaceShareSupportTest.configureJsonMapper();}
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
        when(jdbc.queryForList(contains("FROM ai_resource_share"),any(Object[].class))).thenReturn(List.of(Map.of("id",share.toString(),"same",true,"reduced",false)));

        var result=resources.share(resource,owner,"USER",recipient,Set.of("VIEW"));

        assertEquals(share.toString(),result.get("id"));
        assertEquals(false,result.get("changed"));
        verify(jdbc,never()).update(anyString(),any(Object[].class));
        verifyNoInteractions(conversations,support);
    }
    @Test
    void stalePlanOrMissingSensitiveConsentDoesNotWriteAnyGrant() {
        var jdbc=mock(JdbcTemplate.class);var tx=mock(TransactionTemplate.class);var permissions=mock(WorkspacePermissions.class);
        var guard=mock(AiResourceGuard.class);var conversations=mock(WorkspaceConversations.class);var readiness=mock(WorkspaceAssistantReadiness.class);var support=mock(WorkspaceShareSupport.class);
        var resources=new WorkspaceResources(jdbc,tx,permissions,guard,conversations,readiness,support);
        UUID resource=UUID.randomUUID();long owner=7L;
        var parent=Map.<String,Object>of("resource_type","ASSISTANT");
        var targets=List.of(new WorkspaceShareSupport.Target("USER","9"));
        when(tx.execute(any())).thenAnswer(invocation->((TransactionCallback<?>)invocation.getArgument(0)).doInTransaction(null));
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(parent);when(guard.owner(parent,owner)).thenReturn(true);
        when(support.plan(resource,owner,targets,true)).thenReturn(Map.of("ready",true,"fingerprint","current","additions",List.of(Map.of("key","MCP:private","sensitive",true))));
        var stale=assertThrows(WorkspaceDenied.class,()->resources.shareBatch(resource,owner,targets,Set.of("VIEW","USE"),"stale",Set.of("MCP:private"),UUID.randomUUID()));
        assertEquals("SharePlanChanged",stale.getMessage());
        var unconfirmed=assertThrows(WorkspaceDenied.class,()->resources.shareBatch(resource,owner,targets,Set.of("VIEW","USE"),"current",Set.of(),UUID.randomUUID()));
        assertEquals("SensitiveDependencyConfirmationRequired",unconfirmed.getMessage());
        verify(jdbc,never()).update(anyString(),any(Object[].class));
    }

    @Test
    void replayReturnsThePersistedReceiptWithoutRegrantingDependencies() {
        var jdbc=mock(JdbcTemplate.class);var tx=mock(TransactionTemplate.class);var permissions=mock(WorkspacePermissions.class);
        var guard=mock(AiResourceGuard.class);var conversations=mock(WorkspaceConversations.class);var readiness=mock(WorkspaceAssistantReadiness.class);var support=mock(WorkspaceShareSupport.class);
        var resources=new WorkspaceResources(jdbc,tx,permissions,guard,conversations,readiness,support);
        UUID resource=UUID.randomUUID(),command=UUID.randomUUID();long owner=7L;
        var parent=Map.<String,Object>of("resource_type","ASSISTANT");var targets=List.of(new WorkspaceShareSupport.Target("USER","9"));var actions=Set.of("VIEW","USE");
        String digest=WorkspaceResources.hash(resource+"\n"+org.dromara.common.json.utils.JsonUtils.toJsonString(targets)+"\n"+org.dromara.common.json.utils.JsonUtils.toJsonString(new TreeSet<>(actions)));
        when(tx.execute(any())).thenAnswer(invocation->((TransactionCallback<?>)invocation.getArgument(0)).doInTransaction(null));
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(parent);when(guard.owner(parent,owner)).thenReturn(true);
        when(jdbc.queryForList(contains("operation='resource.share.bundle'"),eq(owner),eq(command))).thenReturn(List.of(Map.of("input_hash",digest,"result","{\"linkedGrants\":2,\"recipients\":[]}")));
        var receipt=resources.shareBatch(resource,owner,targets,actions,"old-confirmed-plan",Set.of(),command);
        assertEquals(2,receipt.get("linkedGrants"));verifyNoInteractions(support);verify(jdbc,never()).update(anyString(),any(Object[].class));
    }

}
