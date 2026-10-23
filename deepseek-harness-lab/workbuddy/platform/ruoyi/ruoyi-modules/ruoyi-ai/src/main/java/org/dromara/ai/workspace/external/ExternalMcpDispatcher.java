package org.dromara.ai.workspace.external;

import lombok.RequiredArgsConstructor;
import org.dromara.ai.workspace.WorkspaceDenied;
import org.dromara.ai.workspace.WorkspaceMcpAccess;
import org.dromara.ai.workspace.connectors.*;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

/** In-process MCP server for fixed enterprise query adapters. */
@Service
@RequiredArgsConstructor
public class ExternalMcpDispatcher {
    private final ExternalConnectionService connections;
    private final WorkspaceMcpAccess access;

    public ResponseEntity<byte[]> exchange(UUID id,long user,long authVersion,Map<String,Object> request,Runnable recheck){
        String method=Objects.toString(request.get("method"),"");
        Object rpcId=request.get("id");
        if("notifications/initialized".equals(method)){authorizeReturn(id,user,recheck);return ResponseEntity.accepted().header(HttpHeaders.CACHE_CONTROL,"no-store").body(new byte[0]);}
        if("initialize".equals(method)){authorizeReturn(id,user,recheck);return response(rpcId,Map.of("protocolVersion","2025-03-26","capabilities",Map.of("tools",Map.of("listChanged",false)),"serverInfo",Map.of("name","ZhenWork External Query","version","1")));}
        if("ping".equals(method)){authorizeReturn(id,user,recheck);return response(rpcId,Map.of());}
        ExternalConnectionService.RuntimeConnection runtime=connections.runtime(id,user,authVersion);
        ConnectorCatalog catalog=connections.catalog(runtime.type());
        Map<String,ConnectorMethod> methods=new LinkedHashMap<>();
        for(ConnectorMethod item:catalog.methods())if(runtime.allowedMethods().contains(item.name())&&"VERIFIED".equals(item.contractStatus()))methods.put(item.name(),item);
        if("tools/list".equals(method)){
            List<Map<String,Object>> tools=new ArrayList<>();
            for(ConnectorMethod item:methods.values()){
                Map<String,Object> tool=new LinkedHashMap<>();tool.put("name",item.name());tool.put("title",item.title());tool.put("description",runtime.name()+"；业务单位："+runtime.businessUnit()+"；环境："+runtime.environment()+"。"+description(item));tool.put("inputSchema",toolSchema(runtime,item));tool.put("outputSchema",envelopeSchema(item.outputSchema()));tool.put("annotations",Map.of("readOnlyHint",item.readOnly(),"destructiveHint",false,"idempotentHint",true,"openWorldHint",false));tools.add(tool);
            }
            authorizeReturn(id,user,recheck);
            return response(rpcId,Map.of("tools",tools));
        }
        if(!"tools/call".equals(method))throw new WorkspaceDenied(400,"McpMethodNotAllowed");
        long started=System.nanoTime();String toolName="unknown";
        try{
            if(!(request.get("params") instanceof Map<?,?> raw)||!raw.keySet().stream().allMatch(k->Set.of("name","arguments","_meta").contains(k.toString())))throw new ToolFailure("InvalidToolArguments");
            ConnectorMethod selected=methods.get(Objects.toString(raw.get("name"),""));if(selected==null)throw new ToolFailure("McpToolNotAllowed");toolName=selected.name();
            Map<String,Object> arguments=map(raw.get("arguments"));validate(arguments,toolSchema(runtime,selected));if(runtime.type()==ConnectorType.CSWM_IOT&&"ledger".equals(selected.name()))arguments.put("qyid",runtime.verifiedIdentity().get("enterpriseId"));enforceIdentity(runtime,arguments);
            String boundIdentity=runtime.type()==ConnectorType.CSWM_IOT?Objects.toString(runtime.verifiedIdentity().get("enterpriseId"),""):runtime.businessUnit();
            if(boundIdentity.isBlank())throw new ToolFailure("ExternalIdentityNotVerified");
            ConnectorQueryResult result=connections.connector(runtime.type()).query(runtime.baseUrl(),new ConnectorCredential(runtime.credential(),boundIdentity),toolName,arguments);
            recheck.run();access.owned(id,user);connections.runtime(id,user,authVersion);
            Object data=sanitize(result.data(),runtime.credential());Object metadata=sanitize(result.metadata(),runtime.credential());
            Map<String,Object> source=new LinkedHashMap<>();if(metadata instanceof Map<?,?> safe)for(var entry:safe.entrySet())source.put(entry.getKey().toString(),entry.getValue());source.put("connectionId",runtime.id().toString());source.put("connectionName",runtime.name());source.put("businessUnit",runtime.businessUnit());source.put("environment",runtime.environment());source.put("queryScope",sanitize(arguments,runtime.credential()));source.put("unit",selected.unit());source.put("timeSemantics",selected.timeSemantics());source.putIfAbsent("queriedAt",Instant.now().toString());Map<String,Object> envelope=new LinkedHashMap<>();envelope.put("data",data);envelope.put("source",source);
            connections.recordCall(runtime,user,toolName,"SUCCEEDED",null,elapsed(started));
            Map<String,Object> value=new LinkedHashMap<>();value.put("content",List.of(Map.of("type","text","text",JsonUtils.toJsonString(envelope))));value.put("structuredContent",envelope);value.put("isError",false);value.put("_meta",source);return response(rpcId,value);
        }catch(WorkspaceDenied denied){
            connections.recordCall(runtime,user,toolName,"REVOKED",safeCode(denied.getMessage()),elapsed(started));throw denied;
        }catch(ConnectorException exception){
            String code=safeCode(exception.code);connections.recordCall(runtime,user,toolName,"FAILED",code,elapsed(started));return response(rpcId,toolError(code,Objects.toString(sanitize(exception.getMessage(),runtime.credential()),"上游查询失败")));
        }catch(ToolFailure failure){
            connections.recordCall(runtime,user,toolName,"FAILED",failure.code,elapsed(started));return response(rpcId,toolError(failure.code));
        }catch(Exception exception){
            connections.recordCall(runtime,user,toolName,"FAILED","ExternalQueryFailed",elapsed(started));return response(rpcId,toolError("ExternalQueryFailed"));
        }
    }

    static Map<String,Object> toolSchema(ExternalConnectionService.RuntimeConnection runtime,ConnectorMethod method){
        if(runtime.type()!=ConnectorType.CSWM_IOT||!"ledger".equals(method.name()))return method.inputSchema();
        Map<String,Object> schema=new LinkedHashMap<>(method.inputSchema());
        Map<String,Object> properties=map(schema.get("properties"));properties.remove("qyid");schema.put("properties",properties);
        if(schema.get("required") instanceof Collection<?> required)schema.put("required",required.stream().filter(key->!"qyid".equals(key)).toList());
        return schema;
    }

    private static String description(ConnectorMethod method){return method.title()+"。单位："+method.unit()+"；时间口径："+method.timeSemantics()+"；环境说明："+method.environmentNotes();}
    private void authorizeReturn(UUID id,long user,Runnable recheck){recheck.run();access.owned(id,user);}
    private static Map<String,Object> envelopeSchema(Map<String,Object> data){return Map.of("type","object","properties",Map.of("data",data,"source",Map.of("type","object","additionalProperties",true)),"required",List.of("data","source"),"additionalProperties",false);}
    private static Map<String,Object> toolError(String code,String message){return Map.of("content",List.of(Map.of("type","text","text",JsonUtils.toJsonString(Map.of("code",code,"message",message.substring(0,Math.min(400,message.length())))))),"isError",true);}
    private static Map<String,Object> toolError(String code){return Map.of("content",List.of(Map.of("type","text","text",code)),"isError",true);}
    private static ResponseEntity<byte[]> response(Object id,Object result){Map<String,Object> frame=new LinkedHashMap<>();frame.put("jsonrpc","2.0");frame.put("id",id);frame.put("result",result);return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL,"no-store").contentType(MediaType.APPLICATION_JSON).body(JsonUtils.toJsonString(frame).getBytes(StandardCharsets.UTF_8));}
    @SuppressWarnings("unchecked") private static Map<String,Object> map(Object raw){if(raw==null)return new LinkedHashMap<>();if(!(raw instanceof Map<?,?> source))throw new ToolFailure("InvalidToolArguments");Map<String,Object> out=new LinkedHashMap<>();source.forEach((k,v)->out.put(k.toString(),v));return out;}
    static void validate(Map<String,Object> value,Map<String,Object> schema){
        Object rawProperties=schema.get("properties");Map<String,Object> properties=rawProperties instanceof Map<?,?> p?map(p):Map.of();
        if(Boolean.FALSE.equals(schema.get("additionalProperties"))&&!properties.keySet().containsAll(value.keySet()))throw new ToolFailure("InvalidToolArguments");
        if(schema.get("required") instanceof Collection<?> required)for(Object key:required)if(!value.containsKey(key.toString()))throw new ToolFailure("InvalidToolArguments");
        for(var entry:value.entrySet()){Object raw=properties.get(entry.getKey());if(raw instanceof Map<?,?> child)validateValue(entry.getValue(),map(child));}
    }
    private static void validateValue(Object value,Map<String,Object> schema){
        if(value==null){if(!Boolean.TRUE.equals(schema.get("nullable")))throw new ToolFailure("InvalidToolArguments");return;}
        String type=Objects.toString(schema.get("type"),"");boolean valid=switch(type){case "string"->value instanceof String;case "integer"->value instanceof Byte||value instanceof Short||value instanceof Integer||value instanceof Long;case "number"->value instanceof Number;case "boolean"->value instanceof Boolean;case "array"->value instanceof Collection<?>;case "object"->value instanceof Map<?,?>;default->true;};if(!valid)throw new ToolFailure("InvalidToolArguments");
        if(schema.get("enum") instanceof Collection<?> choices&&!choices.contains(value))throw new ToolFailure("InvalidToolArguments");
        if(value instanceof Map<?,?> child)validate(map(child),schema);
    }
    static void enforceIdentity(ExternalConnectionService.RuntimeConnection connection,Map<String,Object> arguments){
        if(connection.type()!=ConnectorType.CSWM_IOT)return;Object expected=connection.verifiedIdentity().get("enterpriseId");if(expected==null||!Boolean.TRUE.equals(connection.verifiedIdentity().get("matched")))throw new ToolFailure("ExternalIdentityNotVerified");
        for(String key:List.of("entId","enterpriseId","companyId","qyid"))if(arguments.containsKey(key)&&!expected.toString().equals(Objects.toString(arguments.get(key))))throw new ToolFailure("ExternalIdentityMismatch");
    }
    static Object sanitize(Object raw,String credential){
        if(raw instanceof Map<?,?> source){Map<String,Object> out=new LinkedHashMap<>();for(var entry:source.entrySet()){String key=entry.getKey().toString();if(key.matches("(?i).*(token|secret|credential|authorization|password|cookie|api.?key).*") )continue;out.put(key,sanitize(entry.getValue(),credential));}return out;}
        if(raw instanceof Collection<?> source)return source.stream().map(v->sanitize(v,credential)).toList();
        if(raw instanceof Object[] source)return Arrays.stream(source).map(v->sanitize(v,credential)).toList();
        if(raw instanceof String text&&credential!=null&&!credential.isEmpty()&&text.contains(credential))return text.replace(credential,"[redacted]");return raw;
    }
    private static long elapsed(long started){return Math.max(0,(System.nanoTime()-started)/1_000_000);}
    private static String safeCode(String code){return code!=null&&code.matches("[A-Za-z][A-Za-z0-9_]{0,79}")?code:"ExternalQueryFailed";}
    private static final class ToolFailure extends RuntimeException{private final String code;private ToolFailure(String code){this.code=code;}}
}
