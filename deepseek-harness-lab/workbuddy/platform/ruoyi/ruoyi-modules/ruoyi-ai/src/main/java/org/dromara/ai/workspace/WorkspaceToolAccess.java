package org.dromara.ai.workspace;
import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.util.*;
@Service
@RequiredArgsConstructor
public class WorkspaceToolAccess {
 private final JdbcTemplate jdbc;private final AiResourceGuard guard;
 public static Map<String,Object> configuration(Map<String,Object> input){
  if(!Set.of("toolType","precision","businessRule").containsAll(input.keySet())||!Set.of("CALCULATOR","TEXT_DOCUMENT").contains(input.get("toolType")))throw new WorkspaceDenied(400,"UnsupportedToolType");
  int precision=4;if(input.containsKey("precision"))try{precision=Integer.parseInt(input.get("precision").toString());}catch(Exception e){throw new WorkspaceDenied(400,"InvalidToolPrecision");}
  if(precision<0||precision>8)throw new WorkspaceDenied(400,"InvalidToolPrecision");
  Map<String,Object> result=new LinkedHashMap<>();result.put("toolType",input.get("toolType"));result.put("precision",precision);
  if(input.containsKey("businessRule")){
   if(!"CALCULATOR".equals(input.get("toolType"))||!(input.get("businessRule") instanceof Map<?,?> raw))throw new WorkspaceDenied(400,"InvalidBusinessRule");
   result.put("businessRule",businessRule(raw));
  }return result;
 }
 private static Map<String,Object> businessRule(Map<?,?> raw){
  Set<String> keys=Set.of("kind","meaning","scope","grain","timeField","period","duplicateRule","precision","unitFactors","includeNodes","nodeAliases","sourceAliases","categoryAliases","organizationAliases","allowedOrganizations","statusAliases","summaryRows","reversal","negative");
  if(!raw.keySet().equals(keys)||!"WASTE_MONTHLY".equals(raw.get("kind"))||!"business_record_id".equals(raw.get("grain"))||!"business_date".equals(raw.get("timeField"))||!"calendar_month_Asia_Shanghai".equals(raw.get("period"))||!Set.of("identical_first","block").contains(raw.get("duplicateRule"))||!"exclude_with_warning".equals(raw.get("summaryRows"))||!"block".equals(raw.get("reversal"))||!"block".equals(raw.get("negative")))throw new WorkspaceDenied(400,"InvalidBusinessRule");
  for(String key:List.of("meaning","scope"))if(!(raw.get(key) instanceof String v)||v.isBlank()||v.length()>1000)throw new WorkspaceDenied(400,"BusinessRuleMeaningAndScopeRequired");
  if(!(raw.get("precision") instanceof Number n)||n.doubleValue()!=n.intValue()||n.intValue()<0||n.intValue()>6)throw new WorkspaceDenied(400,"InvalidBusinessRulePrecision");
  for(String key:List.of("unitFactors","nodeAliases","sourceAliases","categoryAliases","organizationAliases","statusAliases")){
   if(!(raw.get(key) instanceof Map<?,?> values)||values.size()>200||(!Set.of("organizationAliases","statusAliases").contains(key)&&values.isEmpty()))throw new WorkspaceDenied(400,"BusinessRuleMappingRequired");
   for(var entry:values.entrySet()){
    if(!(entry.getKey() instanceof String k)||k.isBlank()||k.length()>120||!(entry.getValue() instanceof String v)||v.isBlank()||v.length()>120)throw new WorkspaceDenied(400,"InvalidBusinessRuleMapping");
    if(key.equals("unitFactors"))try{if(!v.matches("[0-9]{1,8}(\\.[0-9]{1,12})?")||new java.math.BigDecimal(v).signum()<=0)throw new IllegalArgumentException();}catch(Exception e){throw new WorkspaceDenied(400,"InvalidBusinessUnitFactor");}
    if(key.equals("statusAliases")&&!Set.of("active","cancelled","reversal").contains(v))throw new WorkspaceDenied(400,"InvalidBusinessStatus");
   }
  }
  var factors=(Map<?,?>)raw.get("unitFactors");if(!"1".equals(factors.get("kg")))throw new WorkspaceDenied(400,"BusinessBaseUnitKgRequired");
  for(String key:List.of("includeNodes","allowedOrganizations")){
   if(!(raw.get(key) instanceof List<?> values)||values.size()>200||(key.equals("includeNodes")&&values.isEmpty()))throw new WorkspaceDenied(400,"InvalidBusinessRuleFilter");
   Map<?,?> aliases=(Map<?,?>)raw.get(key.equals("includeNodes")?"nodeAliases":"organizationAliases");
   for(Object value:values)if(!(value instanceof String v)||v.isBlank()||v.length()>120||!aliases.containsValue(v))throw new WorkspaceDenied(400,"BusinessRuleFilterNotMapped");
  }
  Map<String,Object> result=new LinkedHashMap<>();for(String key:keys)result.put(key,raw.get(key));return result;
 }

 public List<Map<String,Object>> resolve(Object input,List<Map<String,Object>> skills,long user){Set<UUID> ids=new LinkedHashSet<>();add(ids,input);for(var skill:skills)add(ids,skill.get("requiredTools"));if(ids.size()>16)throw new WorkspaceDenied(400,"TooManyTools");List<Map<String,Object>> result=new ArrayList<>();for(UUID id:ids){var r=guard.require(id,user,AiResourceGuard.Action.USE);if(!"TOOL".equals(r.get("resource_type")))throw new WorkspaceDenied(400,"ToolResourceRequired");int version=((Number)r.get("published_version")).intValue();var config=JsonUtils.parseMap(guard.version(id,version,user,AiResourceGuard.Action.USE).get("config").toString());var type=jdbc.queryForMap("SELECT * FROM ai_tool_type WHERE code=?",config.get("toolType"));if(!Boolean.TRUE.equals(type.get("enabled")))throw new WorkspaceDenied(403,"ToolTypeDisabled");Map<String,Object> item=new LinkedHashMap<>();item.put("id",id.toString());item.put("version",version);item.put("authVersion",r.get("auth_version"));item.put("type",type.get("code"));item.put("typeVersion",type.get("version"));item.put("requiresApproval",type.get("requires_approval"));item.put("precision",config.get("precision"));item.put("name","tool_"+id.toString().replace("-",""));result.add(item);}return result;}
 public Map<String,Object> calculate(long user,UUID resource,Map<String,Object> args){
  var tool=resolve(List.of(resource.toString()),List.of(),user).getFirst();
  if(!"CALCULATOR".equals(tool.get("type"))||!Boolean.FALSE.equals(tool.get("requiresApproval")))throw new WorkspaceDenied(403,"ReadOnlyCalculatorRequired");
  var result=calculate(tool,args);resolve(List.of(resource.toString()),List.of(),user);
  jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,'tool.calculated',?,jsonb_build_object('type','CALCULATOR','argsHash',?::text))",UUID.randomUUID(),user,resource,WorkspaceTools.hash(JsonUtils.toJsonString(new TreeMap<>(args))));
  return result;
 }
 public static Map<String,Object> calculate(Map<String,Object> tool,Map<String,Object> args){
  if(args==null||!args.keySet().equals(Set.of("operation","a","b"))||!(args.get("operation") instanceof String operation)||!Set.of("add","subtract","multiply","divide").contains(operation)||!(args.get("a") instanceof String a)||!(args.get("b") instanceof String b)||!a.matches("-?[0-9]{1,30}(\\.[0-9]{1,12})?")||!b.matches("-?[0-9]{1,30}(\\.[0-9]{1,12})?"))throw new WorkspaceDenied(400,"InvalidCalculatorArguments");
  java.math.BigDecimal left=new java.math.BigDecimal(a),right=new java.math.BigDecimal(b);
  try{java.math.BigDecimal value=switch(args.get("operation").toString()){case "add"->left.add(right);case "subtract"->left.subtract(right);case "multiply"->left.multiply(right);default->left.divide(right,((Number)tool.get("precision")).intValue(),java.math.RoundingMode.HALF_UP);};return Map.of("value",value.stripTrailingZeros().toPlainString(),"rounding","HALF_UP","precision",tool.get("precision"));}
  catch(ArithmeticException e){throw new WorkspaceDenied(400,"DivisionByZero");}
 }
 private static void add(Set<UUID> ids,Object input){if(input==null)return;if(!(input instanceof List<?> list)||list.size()>16)throw new WorkspaceDenied(400,"InvalidToolDependencies");for(Object value:list)try{ids.add(UUID.fromString(value.toString()));}catch(Exception e){throw new WorkspaceDenied(400,"InvalidToolDependencies");}}
 public void check(Map<String,Object> snapshot){for(var t:(List<Map<String,Object>>)snapshot.getOrDefault("workspaceTools",List.of())){var rows=jdbc.queryForList("SELECT enabled,version FROM ai_tool_type WHERE code=?",t.get("type"));if(rows.isEmpty()||!Boolean.TRUE.equals(rows.getFirst().get("enabled"))||!rows.getFirst().get("version").toString().equals(t.get("typeVersion").toString()))throw new WorkspaceDenied(403,"ToolTypeAuthorizationChanged");}}
 public void checkHistory(UUID session){for(String snapshot:jdbc.queryForList("SELECT config_snapshot::text FROM ai_run WHERE session_id=? AND jsonb_exists(config_snapshot,'workspaceTools')",String.class,session))check(JsonUtils.parseMap(snapshot));}
 public Map<String,Object> selected(Map<String,Object> run,UUID resource){var config=JsonUtils.parseMap(run.get("config_snapshot").toString());check(config);for(var t:(List<Map<String,Object>>)config.getOrDefault("workspaceTools",List.of()))if(resource.toString().equals(t.get("id")))return t;throw new WorkspaceDenied(403,"ToolNotSelected");}
}
