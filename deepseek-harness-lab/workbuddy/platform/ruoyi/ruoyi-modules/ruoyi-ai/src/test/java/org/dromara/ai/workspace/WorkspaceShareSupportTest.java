package org.dromara.ai.workspace;

import org.dromara.common.json.utils.JsonUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeAll;
import tools.jackson.databind.json.JsonMapper;
import org.junit.jupiter.api.Tag;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@Tag("local")
class WorkspaceShareSupportTest {
    @BeforeAll
    static void configureJsonMapper() {
        var context=new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(JsonMapper.class,()->JsonMapper.builder().build());
        context.refresh();
        new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }

    private final JdbcTemplate jdbc=mock(JdbcTemplate.class);
    private final AiResourceGuard guard=mock(AiResourceGuard.class);
    private final WorkspacePermissions permissions=mock(WorkspacePermissions.class);
    private final WorkspaceModelAccess models=mock(WorkspaceModelAccess.class);
    private final WorkspaceSkills skills=mock(WorkspaceSkills.class);
    private final WorkspaceMcpAccess mcp=mock(WorkspaceMcpAccess.class);
    private final WorkspaceToolAccess tools=mock(WorkspaceToolAccess.class);
    private final WorkspaceKnowledgeAccess knowledge=mock(WorkspaceKnowledgeAccess.class);
    private final WorkspaceShareSupport support=new WorkspaceShareSupport(jdbc,guard,permissions,models,skills,mcp,tools,knowledge);

    @Test
    void initialShareChecksRecipientDependenciesWithoutRequiringParentUse() {
        UUID resource=UUID.randomUUID(),model=UUID.randomUUID();long owner=7L,recipient=9L;
        var parent=Map.<String,Object>of("resource_type","ASSISTANT","published_version",1);
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(parent);
        when(guard.owner(parent,owner)).thenReturn(true);
        when(jdbc.queryForList("SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'",String.class,recipient)).thenReturn(List.of("小陈"));
        when(jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",resource,1)).thenReturn(List.of(Map.of("config",JsonUtils.toJsonString(Map.of("modelId",model.toString())))));
        when(models.model(owner,model)).thenReturn(Map.of("name","企业默认模型"));
        when(models.model(recipient,model)).thenThrow(new WorkspaceDenied(403,"ModelPermissionDenied"));

        var result=support.preflight(resource,owner,"USER",recipient,true);

        assertEquals(false,result.get("ready"));
        assertEquals(1,result.get("checkedUsers"));
        var issue=((List<Map<String,Object>>)result.get("issues")).getFirst();
        assertEquals("MODEL",issue.get("type"));
        assertEquals("企业默认模型",issue.get("name"));
        assertEquals("ModelPermissionDenied",issue.get("code"));
        verify(guard,never()).require(resource,recipient,AiResourceGuard.Action.USE);
    }

    @Test
    void emptyDynamicTargetReportsDependenciesAsUnchecked() {
        UUID resource=UUID.randomUUID(),model=UUID.randomUUID();long owner=7L,role=12L;
        var parent=Map.<String,Object>of("resource_type","ASSISTANT","published_version",1);
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(parent);
        when(guard.owner(parent,owner)).thenReturn(true);
        when(jdbc.queryForList("SELECT role_name FROM sys_role WHERE role_id=? AND status='0' AND del_flag='0'",String.class,role)).thenReturn(List.of("产品角色"));
        when(jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",resource,1)).thenReturn(List.of(Map.of("config",JsonUtils.toJsonString(Map.of("modelId",model.toString())))));
        when(models.model(owner,model)).thenReturn(Map.of("name","企业默认模型"));
        when(jdbc.queryForList(contains("FROM sys_user_role"),eq(Long.class),eq(role),eq(WorkspaceShareSupport.MAX_GROUP_MEMBERS+1))).thenReturn(List.of());

        var result=support.preflight(resource,owner,"ROLE",role,true);

        assertEquals(false,result.get("ready"));
        assertEquals(0,result.get("checkedUsers"));
        assertEquals(true,result.get("dynamicSubject"));
        assertEquals(false,result.get("futureMembersChecked"));
        var issue=((List<Map<String,Object>>)result.get("issues")).getFirst();
        assertEquals("NoActiveMembersToVerify",issue.get("code"));
    }

    @Test
    void resourceUseQualificationIsCheckedWithoutRequiringParentAcl() {
        UUID resource=UUID.randomUUID();long owner=7L,recipient=9L;
        var parent=Map.<String,Object>of("resource_type","TOOL","published_version",1,"name","文本工具");
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(parent);
        when(guard.owner(parent,owner)).thenReturn(true);
        when(guard.qualification("TOOL",AiResourceGuard.Action.USE)).thenReturn("ai:tool:use");
        when(jdbc.queryForList("SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'",String.class,recipient)).thenReturn(List.of("小陈"));
        doThrow(new WorkspaceDenied(403,"PermissionDenied")).when(permissions).require(recipient,"ai:tool:use");

        var result=support.preflight(resource,owner,"USER",recipient,true);

        assertEquals(false,result.get("ready"));
        var issue=((List<Map<String,Object>>)result.get("issues")).getFirst();
        assertEquals("TOOL",issue.get("type"));
        assertEquals("文本工具",issue.get("name"));
        assertEquals("PermissionDenied",issue.get("code"));
        verify(guard,never()).require(resource,recipient,AiResourceGuard.Action.USE);
    }

    @Test
    void malformedAssistantModelIsAReadableDomainFailure() {
        UUID resource=UUID.randomUUID();long owner=7L,recipient=9L;
        var parent=Map.<String,Object>of("resource_type","ASSISTANT","published_version",1);
        when(guard.require(resource,owner,AiResourceGuard.Action.SHARE)).thenReturn(parent);
        when(guard.owner(parent,owner)).thenReturn(true);
        when(jdbc.queryForList("SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'",String.class,recipient)).thenReturn(List.of("小陈"));
        when(jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",resource,1)).thenReturn(List.of(Map.of("config","{}")));

        var denied=assertThrows(WorkspaceDenied.class,()->support.preflight(resource,owner,"USER",recipient,true));

        assertEquals("InvalidResourceDependencies",denied.getMessage());
    }
    @Test
    void missingDelegableModelIsPlannedWithoutCopyingASecretOrChangingAnyGrant() {
        UUID resource=UUID.randomUUID(),model=UUID.randomUUID();long actor=7L,user=9L;
        var row=Map.<String,Object>of("resource_type","ASSISTANT","published_version",1,"auth_version",1L);
        when(guard.require(resource,actor,AiResourceGuard.Action.SHARE)).thenReturn(row);
        when(guard.owner(row,actor)).thenReturn(true);
        when(jdbc.queryForList("SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'",String.class,user)).thenReturn(List.of("新员工"));
        when(jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",resource,1)).thenReturn(List.of(Map.of("config",JsonUtils.toJsonString(Map.of("modelId",model.toString())))));
        when(models.model(actor,model)).thenReturn(Map.of("name","组织模型","model_version",4));
        when(models.model(user,model)).thenThrow(new WorkspaceDenied(403,"ModelPermissionDenied"));
        var plan=support.plan(resource,actor,List.of(new WorkspaceShareSupport.Target("USER",Long.toString(user))),true);
        assertEquals(true,plan.get("ready"));
        var additions=(List<Map<String,Object>>)plan.get("additions");
        assertEquals(false,additions.getFirst().get("sensitive"));
        assertFalse(JsonUtils.toJsonString(plan).contains("api_key"));
        verify(jdbc,never()).update(anyString(),any(Object[].class));
    }

    @Test
    void authorityToUseAModelDoesNotImplyAuthorityToDelegateIt() {
        UUID resource=UUID.randomUUID(),model=UUID.randomUUID();long actor=7L,user=9L;
        var row=Map.<String,Object>of("resource_type","ASSISTANT","published_version",1,"auth_version",1L);
        when(guard.require(resource,actor,AiResourceGuard.Action.SHARE)).thenReturn(row);
        when(guard.owner(row,actor)).thenReturn(true);
        when(jdbc.queryForList("SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'",String.class,user)).thenReturn(List.of("新员工"));
        when(jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",resource,1)).thenReturn(List.of(Map.of("config",JsonUtils.toJsonString(Map.of("modelId",model.toString())))));
        when(models.model(actor,model)).thenReturn(Map.of("name","组织模型"));
        when(models.model(user,model)).thenThrow(new WorkspaceDenied(403,"ModelPermissionDenied"));
        doThrow(new WorkspaceDenied(403,"PermissionDenied")).when(permissions).require(actor,"ai:model:admin");
        var plan=support.plan(resource,actor,List.of(new WorkspaceShareSupport.Target("USER",Long.toString(user))),true);
        assertEquals(false,plan.get("ready"));
        assertTrue(((List<?>)plan.get("additions")).isEmpty());
        verify(jdbc,never()).update(anyString(),any(Object[].class));
    }

    @Test
    void confirmedBusinessScopeIsRequiredBeforePlanningNationalPlatformAccess() {
        UUID resource=UUID.randomUUID(),model=UUID.randomUUID(),connection=UUID.randomUUID();long actor=7L,user=9L;
        var row=Map.<String,Object>of("resource_type","ASSISTANT","published_version",1,"auth_version",1L);
        var dependency=Map.<String,Object>of("resource_type","MCP","published_version",2,"auth_version",5L,"name","国家平台");
        when(guard.require(resource,actor,AiResourceGuard.Action.SHARE)).thenReturn(row);
        when(guard.owner(row,actor)).thenReturn(true);
        when(guard.require(eq(connection),eq(actor),any())).thenReturn(dependency);
        when(guard.owner(dependency,actor)).thenReturn(true);
        when(jdbc.queryForList("SELECT nick_name FROM sys_user WHERE user_id=? AND status='0' AND del_flag='0'",String.class,user)).thenReturn(List.of("新员工"));
        when(jdbc.queryForList("SELECT config::text FROM ai_resource_version WHERE resource_id=? AND version=?",resource,1)).thenReturn(List.of(Map.of("config",JsonUtils.toJsonString(Map.of("modelId",model.toString(),"mcpIds",List.of(connection.toString()))))));
        when(models.model(actor,model)).thenReturn(Map.of("name","模型"));
        when(mcp.resolve(List.of(connection.toString()),user)).thenThrow(new WorkspaceDenied(404,"ResourceNotFound"));
        when(jdbc.queryForList(contains("SELECT auth_version FROM ai_mcp_connection"),eq(connection),eq(2))).thenReturn(List.of(Map.of("auth_version",3L)));
        when(jdbc.queryForList(contains("e.business_unit"),eq(connection))).thenReturn(List.of(Map.of("business_unit","待确认单位","connector_type","CSWM_IOT","tested_status","READY","identity_verified",false)));
        var plan=support.plan(resource,actor,List.of(new WorkspaceShareSupport.Target("USER",Long.toString(user))),true);
        assertEquals(false,plan.get("ready"));
        assertEquals("DataScopeUnverified",((List<Map<String,Object>>)plan.get("issues")).getFirst().get("code"));
    }

}
