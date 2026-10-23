package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.dromara.common.json.utils.JsonUtils;
import java.util.*;
@Service
@RequiredArgsConstructor
public class WorkspaceAssistantReadiness {
 private final AiResourceGuard guard;private final WorkspaceModelAccess models;private final WorkspaceSkills skills;private final WorkspaceMcpAccess mcp;private final WorkspaceToolAccess tools;private final WorkspaceKnowledgeAccess knowledge;
 public void requireDependencies(UUID id,String type,long user){
  if(type.equals("ASSISTANT")&&!Boolean.TRUE.equals(check(id,user).get("ready")))throw new WorkspaceDenied(403,"AssistantDependenciesUnavailable");
  if(type.equals("SKILL")){var resolved=skills.resolve(List.of(id.toString()),user);tools.resolve(List.of(),resolved,user);}
  if(type.equals("TOOL"))tools.resolve(List.of(id.toString()),List.of(),user);
 }
 public Map<String,Object> check(UUID id,long user){var r=guard.require(id,user,AiResourceGuard.Action.USE);if(!"ASSISTANT".equals(r.get("resource_type")))throw new WorkspaceDenied(400,"AssistantRequired");var config=JsonUtils.parseMap(guard.version(id,((Number)r.get("published_version")).intValue(),user,AiResourceGuard.Action.USE).get("config").toString());List<Map<String,Object>> issues=new ArrayList<>();String model=config.get("modelId").toString();try{models.model(user,UUID.fromString(model));}catch(WorkspaceDenied e){issues.add(Map.of("type","MODEL","id",model,"code",e.getMessage()));}
 for(String type:List.of("SKILL","MCP","TOOL","KNOWLEDGE")){String key=type.toLowerCase(Locale.ROOT)+"Ids";for(Object dependency:(List<?>)config.getOrDefault(key,List.of())){String dep=dependency.toString();try{switch(type){case "SKILL"->{var resolved=skills.resolve(List.of(dep),user);tools.resolve(List.of(),resolved,user);}case "MCP"->mcp.resolve(List.of(dep),user);case "TOOL"->tools.resolve(List.of(dep),List.of(),user);case "KNOWLEDGE"->knowledge.resolve(List.of(dep),user);}}catch(WorkspaceDenied e){issues.add(Map.of("type",type,"id",dep,"code",e.getMessage()));}}}return Map.of("ready",issues.isEmpty(),"issues",issues,"modelId",model);}
}
