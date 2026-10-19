package org.dromara.ai.workspace.runtime;

import java.util.Map;
import java.util.UUID;

/** Control-plane contract. Implementations never grant business access themselves. */
public interface AgentRuntime {
    Map<String,Object> createSession(String executionGrant);
    Map<String,Object> resumeSession(String executionGrant);
    Map<String,Object> sendMessage(String executionGrant,String text);
    Map<String,Object> streamEvents(String executionGrant,String lastEventSequence);
    Map<String,Object> cancel(String executionGrant);
    Map<String,Object> approve(String executionGrant,UUID approvalId);
    Map<String,Object> deny(String executionGrant,UUID approvalId);
    Map<String,Object> history(String executionGrant);
    Map<String,Object> health();
    Map<String,Object> shutdown(String executionGrant);
}
