package org.dromara.ai.workspace;

import org.dromara.common.json.utils.JsonUtils;
import org.dromara.ai.workspace.runtime.ExecutionCredentials;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@org.junit.jupiter.api.Tag("local")
class WorkspaceSkillDependencyChecksTest {
    private static final String HASH="a".repeat(64);
    private static final String RUNTIME="sha256:"+"b".repeat(64);

    @BeforeAll static void json(){
        var context=new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(tools.jackson.databind.json.JsonMapper.class,()->tools.jackson.databind.json.JsonMapper.builder().build());
        context.refresh();new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }

    @Test void trustedReceiptIsBoundToUsePublishedVersionAndExactPackage(){
        UUID id=UUID.randomUUID();JdbcTemplate jdbc=mock(JdbcTemplate.class);AiResourceGuard guard=mock(AiResourceGuard.class);
        when(guard.require(id,7,AiResourceGuard.Action.USE)).thenReturn(Map.of("resource_type","SKILL","published_version",2));
        when(guard.version(id,2,7,AiResourceGuard.Action.USE)).thenReturn(Map.of("config",JsonUtils.toJsonString(Map.of("packageSha256",HASH))));
        var checks=new WorkspaceSkillDependencyChecks(jdbc,guard);
        var declarations=List.of(new WorkspaceSkillDependencyChecks.Declaration("python","pillow",">=10","requirements.txt","10.2","READY"));
        var result=checks.record(id,7,2,HASH,RUNTIME,"READY",declarations);
        assertEquals(id.toString(),result.get("resourceId"));assertEquals(2,result.get("resourceVersion"));
        assertEquals(RUNTIME,result.get("runtimeFingerprint"));
        verify(jdbc).update(contains("skill.dependency.checked"),any(),eq(7L),eq(id),contains(HASH));

        when(guard.require(id,7,AiResourceGuard.Action.USE)).thenReturn(Map.of("resource_type","SKILL","published_version",3));
        assertEquals("DependencyCheckVersionChanged",assertThrows(WorkspaceDenied.class,
            ()->checks.record(id,7,2,HASH,RUNTIME,"READY",declarations)).getMessage());
        when(guard.require(id,7,AiResourceGuard.Action.USE)).thenReturn(Map.of("resource_type","SKILL","published_version",2));
        assertEquals("DependencyCheckPackageChanged",assertThrows(WorkspaceDenied.class,
            ()->checks.record(id,7,2,"b".repeat(64),RUNTIME,"READY",declarations)).getMessage());
        assertEquals("InvalidRuntimeFingerprint",assertThrows(WorkspaceDenied.class,
            ()->checks.record(id,7,2,HASH,"repository:tag","READY",declarations)).getMessage());
    }

    @Test void aggregateStateCannotContradictDeclarationAndCurrentReadUsesEditVersion(){
        UUID id=UUID.randomUUID();JdbcTemplate jdbc=mock(JdbcTemplate.class);AiResourceGuard guard=mock(AiResourceGuard.class);
        when(guard.require(id,9,AiResourceGuard.Action.USE)).thenReturn(Map.of("resource_type","SKILL","published_version",4));
        when(guard.version(id,4,9,AiResourceGuard.Action.USE)).thenReturn(Map.of("config",JsonUtils.toJsonString(Map.of("packageSha256",HASH))));
        var checks=new WorkspaceSkillDependencyChecks(jdbc,guard);
        var missing=List.of(new WorkspaceSkillDependencyChecks.Declaration("node","demo","^1","package.json",null,"MISSING"));
        assertEquals("InvalidDependencyCheck",assertThrows(WorkspaceDenied.class,
            ()->checks.record(id,9,4,HASH,RUNTIME,"READY",missing)).getMessage());

        when(guard.require(id,9,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("resource_type","SKILL","latest_version",4));
        when(guard.version(id,4,9,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("config",JsonUtils.toJsonString(Map.of("packageSha256",HASH))));
        when(jdbc.queryForList(anyString(),eq(id),eq("4"),eq(HASH))).thenReturn(List.of(Map.of(
            "id",UUID.randomUUID().toString(),"metadata",JsonUtils.toJsonString(Map.of("resourceVersion",4,"packageSha256",HASH,"runtimeFingerprint",RUNTIME,"state","MISSING","declarations",List.of())),"created_at","2026-11-05T12:00:00Z")));
        var current=checks.current(id,9);
        assertEquals("MISSING",current.get("state"));assertEquals(4,current.get("resourceVersion"));
        verify(guard).require(id,9,AiResourceGuard.Action.EDIT);
    }

    @Test void controllerSeparatesHostServiceWriteFromEnterpriseEditorRead(){
        UUID id=UUID.randomUUID();WorkspaceSkillDependencyChecks checks=mock(WorkspaceSkillDependencyChecks.class);
        ExecutionCredentials execution=mock(ExecutionCredentials.class);WorkspacePrincipal principals=mock(WorkspacePrincipal.class);
        when(principals.require("ai:resource:enterprise")).thenReturn(new WorkspacePrincipal.Actor(11,1,false));
        var controller=new WorkspaceSkillController(mock(WorkspaceSkillImports.class),checks,execution,principals);
        var declarations=List.of(new WorkspaceSkillDependencyChecks.Declaration("node","demo","1.0.0","package.json","1.0.0","READY"));
        when(principals.require("ai:skill:use")).thenReturn(new WorkspacePrincipal.Actor(12,1,false));
        controller.dependencyCheck(id,"Bearer host",new WorkspaceSkillController.DependencyCheck(3,HASH,RUNTIME,"READY",declarations));
        verify(execution).checkBackgroundService("Bearer host");verify(principals).require("ai:skill:use");
        verify(checks).record(id,12,3,HASH,RUNTIME,"READY",declarations);
        controller.dependencyCheck(id);
        verify(principals).require("ai:resource:enterprise");verify(checks).current(id,11);
    }
}
