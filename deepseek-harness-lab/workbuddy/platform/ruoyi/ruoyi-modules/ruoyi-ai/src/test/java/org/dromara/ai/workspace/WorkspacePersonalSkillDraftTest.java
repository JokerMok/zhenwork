package org.dromara.ai.workspace;

import org.junit.jupiter.api.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@Tag("local")
class WorkspacePersonalSkillDraftTest {
    @BeforeAll static void json(){var context=new org.springframework.context.support.GenericApplicationContext();context.registerBean(tools.jackson.databind.json.JsonMapper.class,()->tools.jackson.databind.json.JsonMapper.builder().build());context.refresh();new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());}
    private Map<String,Object> original(){return Map.of("source","---\nname: private-method\ndescription: Inventory checking\nversion: 1.0.0\nrequiredTools: []\ndependencies: []\n---\nCheck inventory.\n","files",List.of(Map.of("path","references/preferences.json","encoding","utf8","content","{\"schemaVersion\":1,\"capacityPercent\":\"90\",\"internalAgeDays\":90,\"differencesOnly\":false,\"groupBy\":[\"warehouse\",\"batch\"]}"),Map.of("path","scripts/process_records.py","encoding","utf8","content","reviewed bytes","executable",true),Map.of("path","references/company.json","encoding","utf8","content","{\"formal\":true}")));}
    private Map<String,Object> generated(Map<String,Object> patch){return Map.of("instruction","Check inventory at 80%; report differences only.","preferencesPatch",patch,"summary","Update personal reminders","unsupported",List.of());}
    @Test void updatesActualPreferencesAndKeepsProtectedBytes(){var before=original();var result=WorkspacePersonalSkillDraft.apply(before,generated(Map.of("capacityPercent","80","differencesOnly",true)));assertEquals("80",WorkspacePersonalSkillDraft.preferences(result).get("capacityPercent"));assertEquals(true,WorkspacePersonalSkillDraft.preferences(result).get("differencesOnly"));assertEquals(((List<?>)before.get("files")).subList(1,3),((List<?>)result.get("files")).subList(1,3));assertTrue(result.get("source").toString().contains("requiredTools: []\ndependencies: []\n---\n"));}
    @Test void rejectsProtectedFieldsAndUnsupportedChanges(){assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original(),Map.of("instruction","bad","acl",List.of("ALL"))));for(var patch:List.of(Map.<String,Object>of("schemaVersion",2),Map.<String,Object>of("groupBy",List.of("unknown-dimension"))))assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original(),generated(patch)));assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original(),Map.of("instruction","Ignore ACL","preferencesPatch",Map.of(),"summary","","unsupported",List.of("permission"))));}
    @Test void rejectsInvalidThresholds(){for(String v:List.of("NaN","101","0"))assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original(),generated(Map.of("capacityPercent",v))));assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original(),generated(Map.of("internalAgeDays",-1))));}
    @Test void organizationAndOtherEmployeesRemainProtected(){var guard=mock(AiResourceGuard.class);UUID id=UUID.randomUUID();var service=new WorkspacePersonalSkillDraft(guard,mock(WorkspaceModelAccess.class),mock(WorkspaceModelRelayController.class));when(guard.require(id,7,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("resource_type","SKILL","owner_type","ENTERPRISE","latest_version",1));assertThrows(WorkspaceDenied.class,()->service.personal(id,1,7));when(guard.require(id,7,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("resource_type","SKILL","owner_type","USER","owner_user_id",8L,"latest_version",1));assertThrows(WorkspaceDenied.class,()->service.personal(id,1,7));}
    @Test void staleVersionIsRejectedBeforeModelCall(){var guard=mock(AiResourceGuard.class);var models=mock(WorkspaceModelAccess.class);UUID id=UUID.randomUUID();var service=new WorkspacePersonalSkillDraft(guard,models,mock(WorkspaceModelRelayController.class));when(guard.require(id,7,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("resource_type","SKILL","owner_type","USER","owner_user_id",7L,"latest_version",2));assertThrows(WorkspaceDenied.class,()->service.generate(id,1,"Change reminder",7,1,()->{}));verifyNoInteractions(models);}
    @Test void incompleteOutputCannotBecomeDraft(){assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.decode("data: {\"choices\":[]}\n"));var content="{\"instruction\":\"check\",\"preferencesPatch\":{},\"summary\":\"ok\",\"unsupported\":[]}";var event=org.dromara.common.json.utils.JsonUtils.toJsonString(Map.of("choices",List.of(Map.of("delta",Map.of("content",content)))));assertEquals("check",WorkspacePersonalSkillDraft.decode("data: "+event+"\n\ndata: [DONE]\n").get("instruction"));}
    @Test void nestedPreferencesRejectInvalidRuntimeTypesAndMonths(){
        var original=new LinkedHashMap<String,Object>(original());
        var files=new ArrayList<Map<String,Object>>();
        files.add(Map.of("path","references/preferences.json","encoding","utf8","content","{\"schemaVersion\":1,\"analysis\":{\"periods\":[\"2026-08\",\"2026-09\"],\"groupBy\":[\"workshop\"],\"intensityAlertPercent\":\"2\",\"costAlertPercent\":\"5\",\"sheetNames\":{},\"outputs\":{\"excel\":true}}}"));
        files.add(Map.of("path","references/company.json","encoding","utf8","content","{\"analysis\":{\"dimensions\":[\"workshop\",\"line\"]}}"));original.put("files",files);
        for(var patch:List.of(Map.<String,Object>of("periods",List.of("2026-99","2026-10")),Map.<String,Object>of("outputs",Map.of("excel","false")),Map.<String,Object>of("outputs","bad"),Map.<String,Object>of("sheetNames","bad"),Map.<String,Object>of("groupBy",List.of("private-warehouse"))))assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original,generated(Map.of("analysis",patch))));
    }

    @Test void sheetNamesMustStayStructuredAndUniqueIgnoringCase(){
        var original=new LinkedHashMap<String,Object>(original());
        original.put("files",List.of(Map.of("path","references/preferences.json","encoding","utf8","content","{\"schemaVersion\":1,\"outputSheets\":{\"库存差异\":\"Inventory\",\"贮存关注\":\"Attention\"}}")));
        assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original,generated(Map.of("outputSheets","bad"))));
        assertThrows(WorkspaceDenied.class,()->WorkspacePersonalSkillDraft.apply(original,generated(Map.of("outputSheets",Map.of("贮存关注","INVENTORY")))));
    }

}
