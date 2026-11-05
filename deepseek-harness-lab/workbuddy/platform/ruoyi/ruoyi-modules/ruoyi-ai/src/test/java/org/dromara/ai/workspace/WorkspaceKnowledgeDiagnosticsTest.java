package org.dromara.ai.workspace;

import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@Tag("local")
class WorkspaceKnowledgeDiagnosticsTest {
 @BeforeAll static void configureJson(){var context=new org.springframework.context.support.GenericApplicationContext();context.registerBean(tools.jackson.databind.json.JsonMapper.class,()->tools.jackson.databind.json.JsonMapper.builder().build());context.refresh();new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());}

 @Test void reportsAuthorizedHitWithActualLocationAndScores(){
  var fixture=fixture();UUID doc=UUID.randomUUID();when(fixture.jdbc.queryForList(startsWith("SELECT d.id::text"),eq(fixture.base))).thenReturn(List.of(scope(doc,2,2,"READY",3)));
  when(fixture.knowledge.diagnosticMatches(fixture.base,"secret-query",null,null)).thenReturn(List.of(hit(doc,2,"第 3 页",1)));
  var result=fixture.service.diagnose(fixture.base,7," secret-query ",null,null);assertEquals("HIT",result.get("outcome"));var candidate=((List<Map<String,Object>>)result.get("candidates")).getFirst();assertEquals("第 3 页",candidate.get("locationLabel"));assertEquals(true,candidate.get("returned"));
  verify(fixture.access,atLeastOnce()).version(doc,2,7,AiResourceGuard.Action.EDIT);verify(fixture.jdbc).update(startsWith("INSERT INTO ai_security_event"),argThat((Object[] values)->!Arrays.toString(values).contains("secret-query")));
 }

 @Test void distinguishesNoHitFromMissingIndex(){
  var fixture=fixture();UUID doc=UUID.randomUUID();when(fixture.jdbc.queryForList(startsWith("SELECT d.id::text"),eq(fixture.base))).thenReturn(List.of(scope(doc,1,1,"READY",2)));when(fixture.knowledge.diagnosticMatches(fixture.base,"absent",null,null)).thenReturn(List.of());
  var miss=fixture.service.diagnose(fixture.base,7,"absent",null,null);assertEquals("NO_HIT",miss.get("outcome"));assertEquals(List.of("NO_HIT"),miss.get("causes"));
  var noIndex=fixture();when(noIndex.jdbc.queryForList(startsWith("SELECT d.id::text"),eq(noIndex.base))).thenReturn(List.of(scope(doc,2,null,"QUEUED",0)));var unavailable=noIndex.service.diagnose(noIndex.base,7,"absent",null,null);assertEquals("NOT_INDEXED",unavailable.get("outcome"));verifyNoInteractions(noIndex.knowledge);
 }

 @Test void explicitHistoricalVersionDoesNotPretendToBeCurrent(){
  var fixture=fixture();UUID doc=UUID.randomUUID();when(fixture.access.document(doc,7,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("base_id",fixture.base,"latest_version",2,"indexed_version",2));when(fixture.access.version(doc,1,7,AiResourceGuard.Action.EDIT)).thenReturn(Map.of("status","READY"));when(fixture.jdbc.queryForObject(contains("count(*) FROM ai_knowledge_index"),eq(Integer.class),eq(doc),eq(1))).thenReturn(1);when(fixture.knowledge.diagnosticMatches(fixture.base,"legacy",doc,1)).thenReturn(List.of(hit(doc,1,"全文",1)));
  var result=fixture.service.diagnose(fixture.base,7,"legacy",doc,1);var scope=(Map<String,Object>)result.get("scope");assertEquals("VERSION_HISTORY",scope.get("mode"));assertEquals(1,scope.get("version"));var selected=(Map<String,Object>)((List<?>)scope.get("versions")).getFirst();assertEquals(1,selected.get("version"));assertEquals("HISTORY_INDEXED",selected.get("reason"));
 }

 @Test void exposesTheNinthCandidateAndBoundsTheDiagnosticPool(){
  var fixture=fixture();UUID doc=UUID.randomUUID();when(fixture.jdbc.queryForList(startsWith("SELECT d.id::text"),eq(fixture.base))).thenReturn(List.of(scope(doc,1,1,"READY",45)));List<Map<String,Object>> rows=new ArrayList<>();for(int i=0;i<40;i++){var row=hit(doc,1,"section "+i,45);row.put("chunk_index",i);rows.add(row);}when(fixture.knowledge.diagnosticMatches(fixture.base,"many",null,null)).thenReturn(rows);
  var result=fixture.service.diagnose(fixture.base,7,"many",null,null);var summary=(Map<String,Object>)result.get("summary");assertEquals(45,summary.get("matchedCandidates"));assertEquals(8,summary.get("returnedHits"));assertEquals(37,summary.get("filteredByTopK"));assertEquals(5,summary.get("omittedCandidates"));var candidates=(List<Map<String,Object>>)result.get("candidates");assertEquals(40,candidates.size());assertEquals(false,candidates.get(8).get("returned"));assertEquals("FILTERED_TOP_K",candidates.get(8).get("filterStatus"));assertTrue(((List<?>)result.get("causes")).contains("FILTERED_TOP_K"));
 }

 @Test void candidateVersionDenialPreventsDiagnosticDisclosure(){
  var fixture=fixture();UUID allowed=UUID.randomUUID(),denied=UUID.randomUUID();when(fixture.jdbc.queryForList(startsWith("SELECT d.id::text"),eq(fixture.base))).thenReturn(List.of(scope(allowed,1,1,"READY",9)));List<Map<String,Object>> rows=new ArrayList<>();for(int i=0;i<8;i++){var row=hit(allowed,1,"section "+i,9);row.put("chunk_index",i);rows.add(row);}rows.add(hit(denied,1,"denied",9));when(fixture.knowledge.diagnosticMatches(fixture.base,"many",null,null)).thenReturn(rows);doThrow(new WorkspaceDenied(404,"DocumentVersionNotFound")).when(fixture.access).version(denied,1,7,AiResourceGuard.Action.EDIT);
  assertThrows(WorkspaceDenied.class,()->fixture.service.diagnose(fixture.base,7,"many",null,null));verify(fixture.access).version(denied,1,7,AiResourceGuard.Action.EDIT);
 }

 @Test void controllerRequiresEnterprisePermissionBeforeCallingDiagnostics(){
  var principals=mock(WorkspacePrincipal.class);var diagnostics=mock(WorkspaceKnowledgeDiagnostics.class);var controller=new WorkspaceKnowledgeDiagnosticsController(principals,diagnostics);var actor=new WorkspacePrincipal.Actor(7,3,false);when(principals.require("ai:resource:enterprise")).thenReturn(actor);UUID base=UUID.randomUUID();when(diagnostics.diagnose(base,7,"query",null,null)).thenReturn(Map.of());
  controller.diagnose(base,new WorkspaceKnowledgeDiagnosticsController.Request("query",null,null));verify(principals).require("ai:resource:enterprise");verify(diagnostics).diagnose(base,7,"query",null,null);
 }

 @Test void baseEditDenialStopsBeforeScopeOrCandidateQueries(){
  var fixture=fixture();doThrow(new WorkspaceDenied(404,"ResourceNotFound")).when(fixture.access).base(fixture.base,7,AiResourceGuard.Action.EDIT);
  var denied=assertThrows(WorkspaceDenied.class,()->fixture.service.diagnose(fixture.base,7,"query",null,null));assertEquals(404,denied.status);verifyNoInteractions(fixture.jdbc,fixture.knowledge);
 }

 private static Fixture fixture(){JdbcTemplate jdbc=mock(JdbcTemplate.class);WorkspaceKnowledgeAccess access=mock(WorkspaceKnowledgeAccess.class);WorkspaceKnowledge knowledge=mock(WorkspaceKnowledge.class);UUID base=UUID.randomUUID();when(jdbc.queryForObject(startsWith("SELECT current_setting"),eq(String.class))).thenReturn("0.3");return new Fixture(jdbc,access,knowledge,base,new WorkspaceKnowledgeDiagnostics(jdbc,access,knowledge));}
 private static Map<String,Object> scope(UUID doc,int latest,Integer indexed,String status,int chunks){Map<String,Object> row=new HashMap<>();row.put("document_id",doc.toString());row.put("latest_version",latest);row.put("indexed_version",indexed);row.put("version",indexed==null?latest:indexed);row.put("status",status);row.put("chunk_count",chunks);return row;}
 private static Map<String,Object> hit(UUID doc,int version,String location,int total){Map<String,Object> row=new HashMap<>();row.put("document_id",doc.toString());row.put("version",version);row.put("chunk_index",0);row.put("line_start",1);row.put("line_end",4);row.put("location_type","PAGE");row.put("location_label",location);row.put("content","matched content");row.put("title","policy.pdf");row.put("lexical_score",3);row.put("full_text_match",true);row.put("trigram_match",false);row.put("term_match",true);row.put("text_rank",0.8d);row.put("trigram_similarity",0.2d);row.put("candidate_count",total);return row;}
 private record Fixture(JdbcTemplate jdbc,WorkspaceKnowledgeAccess access,WorkspaceKnowledge knowledge,UUID base,WorkspaceKnowledgeDiagnostics service){}
}
