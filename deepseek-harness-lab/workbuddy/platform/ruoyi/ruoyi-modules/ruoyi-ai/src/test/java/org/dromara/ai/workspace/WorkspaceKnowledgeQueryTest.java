package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class WorkspaceKnowledgeQueryTest {
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
}
