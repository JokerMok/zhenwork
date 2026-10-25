package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class WorkspaceAssistantReadinessTest {
    @Test
    void assistantCannotMakeAnUnavailableDependencyUsable() {
        var readiness = spy(new WorkspaceAssistantReadiness(null,null,null,null,null,null));
        UUID id = UUID.randomUUID();
        doReturn(Map.of("ready",false)).when(readiness).check(id,42L);
        assertThrows(WorkspaceDenied.class,()->readiness.requireDependencies(id,"ASSISTANT",42L));
    }
    @Test
    void standaloneSkillRetainsItsRequiredToolAuthorization() {
        var skills=mock(WorkspaceSkills.class);var tools=mock(WorkspaceToolAccess.class);
        var readiness=new WorkspaceAssistantReadiness(null,null,skills,null,tools,null);
        UUID id=UUID.randomUUID();var resolved=List.<Map<String,Object>>of(Map.of("id",id.toString()));
        when(skills.resolve(List.of(id.toString()),42L)).thenReturn(resolved);
        when(tools.resolve(List.of(),resolved,42L)).thenThrow(new WorkspaceDenied(403,"PermissionDenied"));
        assertThrows(WorkspaceDenied.class,()->readiness.requireDependencies(id,"SKILL",42L));
    }
    @Test
    void disabledToolTypesAreNotInheritedAsUsableTools() {
        var tools=mock(WorkspaceToolAccess.class);var readiness=new WorkspaceAssistantReadiness(null,null,null,null,tools,null);
        UUID id=UUID.randomUUID();
        when(tools.resolve(List.of(id.toString()),List.of(),42L)).thenThrow(new WorkspaceDenied(403,"ToolTypeDisabled"));
        assertThrows(WorkspaceDenied.class,()->readiness.requireDependencies(id,"TOOL",42L));
    }
    @Test
    void activationCannotBypassDraftDependencyReadiness() {
        var readiness=spy(new WorkspaceAssistantReadiness(null,null,null,null,null,null));UUID id=UUID.randomUUID();
        doReturn(Map.of("ready",false)).when(readiness).checkDraft(id,2,42L);
        assertThrows(WorkspaceDenied.class,()->readiness.requireDraft(id,2,42L));
    }
}
