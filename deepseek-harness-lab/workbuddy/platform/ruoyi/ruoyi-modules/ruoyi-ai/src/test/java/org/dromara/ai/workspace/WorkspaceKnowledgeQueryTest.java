package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Tag;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.mock.web.MockMultipartFile;
import java.util.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

@Tag("local")
class WorkspaceKnowledgeQueryTest {
    @org.junit.jupiter.api.BeforeAll
    static void configureJson() {
        var context=new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(tools.jackson.databind.json.JsonMapper.class,()->tools.jackson.databind.json.JsonMapper.builder().build());context.refresh();
        new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }
    @Test
    void longChineseQuestionProducesTitleAndDistributedNgramTerms() {
        List<String> terms = WorkspaceKnowledge.queryTerms("珠海崇达固废智能解决方案 原件 页码引用");

        assertTrue(terms.contains("珠海崇达固废智能解决方案"));
        assertTrue(terms.contains("固废"));
        assertTrue(terms.contains("原件"));
        assertTrue(terms.contains("页码引用"));
        assertTrue(terms.size() <= 32);
    }

    @Test
    void unspacedNaturalQuestionStillSamplesTermsAcrossTheWholeQuery() {
        List<String> terms = WorkspaceKnowledge.queryTerms("请查找珠海崇达固废智能解决方案原件并给出页码引用");

        assertTrue(terms.contains("珠海"));
        assertTrue(terms.contains("固废"));
        assertTrue(terms.contains("页码"));
        assertTrue(terms.size() <= 32);
    }

    @Test
    void identicalReuploadReusesDocumentWithoutSavingBytesOrQueueingAgain() {
        var jdbc=mock(JdbcTemplate.class);var tx=mock(TransactionTemplate.class);var access=mock(WorkspaceKnowledgeAccess.class);var files=mock(WorkspaceFileStore.class);
        when(tx.execute(any())).thenAnswer(i->((TransactionCallback<?>)i.getArgument(0)).doInTransaction(null));
        UUID base=UUID.randomUUID(),doc=UUID.randomUUID(),file=UUID.randomUUID();
        when(jdbc.queryForList(contains("f.sha256=?"),any(Object[].class))).thenReturn(List.of(Map.of("id",doc.toString(),"version",1,"file_id",file.toString(),"status","READY")));
        var knowledge=new WorkspaceKnowledge(jdbc,tx,access,files,mock(WorkspaceKnowledgeDocumentExtractor.class),mock(WorkspaceConversations.class),mock(WorkspaceEvents.class));
        var result=knowledge.upload(base,null,null,UUID.randomUUID(),7,new MockMultipartFile("file","product.txt","text/plain","same content".getBytes()));
        assertEquals(true,result.get("reused"));assertEquals(doc.toString(),result.get("id"));
        verifyNoInteractions(files);verify(jdbc,never()).update(startsWith("INSERT INTO ai_knowledge_job"),any(Object[].class));
    }

    @Test
    void selectedDocumentCannotBeSearchedThroughAnotherBase() {
        var access=mock(WorkspaceKnowledgeAccess.class);UUID base=UUID.randomUUID(),doc=UUID.randomUUID();
        when(access.document(doc,7,AiResourceGuard.Action.USE)).thenReturn(Map.of("base_id",UUID.randomUUID()));
        var knowledge=new WorkspaceKnowledge(mock(JdbcTemplate.class),mock(TransactionTemplate.class),access,mock(WorkspaceFileStore.class),mock(WorkspaceKnowledgeDocumentExtractor.class),mock(WorkspaceConversations.class),mock(WorkspaceEvents.class));
        assertThrows(WorkspaceDenied.class,()->knowledge.search(base,7,"product",doc,1));
        verify(access,never()).version(any(),anyInt(),anyLong(),any());
    }

    @Test
    void expertCannotBePublishedAgainstAnEmptyKnowledgeBase() {
        UUID base=UUID.randomUUID();var jdbc=mock(JdbcTemplate.class);var guard=mock(AiResourceGuard.class);
        var resource=Map.<String,Object>of("resource_type","KNOWLEDGE","latest_version",1);
        when(guard.require(base,7,AiResourceGuard.Action.PUBLISH)).thenReturn(resource);when(guard.owner(resource,7)).thenReturn(true);
        when(jdbc.queryForList(startsWith("SELECT config::text"),eq(base),eq(1))).thenReturn(List.of(Map.of("config","{\"format\":\"TEXT_V1\"}")));
        when(jdbc.queryForObject(contains("ai_knowledge_document"),eq(Boolean.class),eq(base))).thenReturn(false);
        var publication=new WorkspacePublication(jdbc,mock(TransactionTemplate.class),guard,mock(WorkspacePermissions.class),mock(WorkspaceConversations.class));
        var result=publication.publicationCheck(base,1,7);
        assertEquals(false,result.get("ready"));assertTrue(result.get("issues").toString().contains("KnowledgeIndexNotReady"));
    }
}
