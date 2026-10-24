package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;

@Service
@RequiredArgsConstructor
public class WorkspaceModelAdmin {
    private final JdbcTemplate jdbc;
    private final WorkspaceSecrets secrets;
    private final WorkspaceConversations conversations;
    private final TransactionTemplate tx;
    private static final String PROVIDER_COLUMNS="id,name,provider_type,base_url,protocol,enabled,version,timeout_seconds,retry_count,secret_updated_at,(secret_cipher<>'') AS configured";
    private static final String MODEL_COLUMNS="m.id,m.provider_id,m.code,m.name,m.enabled,m.streaming,m.tools,m.vision,m.context_window,m.max_output_tokens,m.version,m.verified_status,m.default_parameters::text,m.cost_config::text,p.name AS provider_name";
    private void audit(long actor,String action,UUID id){jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,resource_id,metadata) VALUES(?,?,?,?, '{}'::jsonb)",UUID.randomUUID(),actor,action,id);}
    public List<Map<String,Object>> providers(int page){return jdbc.queryForList("SELECT "+PROVIDER_COLUMNS+" FROM ai_provider ORDER BY created_at DESC LIMIT 30 OFFSET ?",offset(page));}
    private int offset(int page){return (Math.max(1,Math.min(1000,page))-1)*30;}
    public Map<String,Object> provider(UUID id){var rows=jdbc.queryForList("SELECT "+PROVIDER_COLUMNS+" FROM ai_provider WHERE id=?",id);if(rows.isEmpty())throw new WorkspaceDenied(404,"ProviderNotFound");return rows.getFirst();}
    public Map<String,Object> saveProvider(UUID id,long actor,WorkspaceModelAdminController.Provider input){
        String url=WorkspaceProviderDestination.validate(input.providerType(),input.baseUrl());
        if(!"OPENAI_CHAT".equals(input.protocol()))throw new WorkspaceDenied(400,"UnsupportedProtocol");
        String cipher=null;if(input.secret()!=null&&!input.secret().isBlank()){if(input.secret().contains("\n")||input.secret().contains("\r"))throw new WorkspaceDenied(400,"InvalidSecret");cipher=secrets.encrypt(input.secret());}
        if(id!=null&&input.enabled()&&cipher==null&&!Boolean.TRUE.equals(provider(id).get("configured")))throw new WorkspaceDenied(400,"ProviderSecretRequired");
        UUID target=id==null?UUID.randomUUID():id;final String encrypted=cipher;
        tx.executeWithoutResult(status->{
            if(id==null){if(encrypted==null)throw new WorkspaceDenied(400,"ProviderSecretRequired");jdbc.update("INSERT INTO ai_provider(id,name,provider_type,base_url,protocol,secret_cipher,enabled,timeout_seconds,retry_count) VALUES(?,?,?,?,?,?,?,?,?)",target,input.name(),input.providerType(),url,input.protocol(),encrypted,input.enabled(),input.timeoutSeconds(),input.retryCount());}
            else{if(jdbc.update("UPDATE ai_provider SET name=?,provider_type=?,base_url=?,protocol=?,secret_cipher=COALESCE(?,secret_cipher),secret_updated_at=CASE WHEN ?::text IS NULL THEN secret_updated_at ELSE NOW() END,enabled=?,timeout_seconds=?,retry_count=?,version=version+1,updated_at=NOW() WHERE id=? AND version=?",input.name(),input.providerType(),url,input.protocol(),encrypted,encrypted,input.enabled(),input.timeoutSeconds(),input.retryCount(),id,input.expectedVersion())!=1)throw new WorkspaceDenied(409,"ProviderVersionConflict");jdbc.update("UPDATE ai_model SET verified_status='EXPERIMENTAL' WHERE provider_id=?",id);}
            audit(actor,"provider.saved",target);
        });if(id!=null)conversations.revokeModels(jdbc.queryForList("SELECT id FROM ai_model WHERE provider_id=?",UUID.class,id));return provider(target);
    }
    public void clearProviderSecret(UUID id,long actor,long version){
        if(jdbc.update("UPDATE ai_provider SET secret_cipher='',enabled=FALSE,version=version+1,secret_updated_at=NOW(),updated_at=NOW() WHERE id=? AND version=?",id,version)!=1)throw new WorkspaceDenied(409,"ProviderVersionConflict");
        conversations.revokeModels(jdbc.queryForList("SELECT id FROM ai_model WHERE provider_id=?",UUID.class,id));audit(actor,"provider.secret.cleared",id);
    }
    public List<Map<String,Object>> models(int page){return jdbc.queryForList("SELECT "+MODEL_COLUMNS+" FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id ORDER BY m.name,m.id LIMIT 30 OFFSET ?",offset(page));}
    public Map<String,Object> model(UUID id){var rows=jdbc.queryForList("SELECT "+MODEL_COLUMNS+" FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id WHERE m.id=?",id);if(rows.isEmpty())throw new WorkspaceDenied(404,"ModelNotFound");return rows.getFirst();}
    public Map<String,Object> saveModel(UUID id,long actor,WorkspaceModelAdminController.Model input){
        provider(input.providerId());if(input.vision())throw new WorkspaceDenied(400,"VisionExecutionNotSupported");
        if(input.maxOutputTokens()>input.contextWindow())throw new WorkspaceDenied(400,"InvalidTokenLimits");
        if(!Set.of("temperature","top_p").containsAll(input.defaultParameters().keySet()))throw new WorkspaceDenied(400,"UnsupportedDefaultParameter");
        for(var entry:input.defaultParameters().entrySet())if(!(entry.getValue() instanceof Number n)||!Double.isFinite(n.doubleValue())||n.doubleValue()<0||n.doubleValue()>(entry.getKey().equals("temperature")?2:1))throw new WorkspaceDenied(400,"InvalidDefaultParameter");
        if(!Set.of("currency","inputPerMillion","outputPerMillion").containsAll(input.costConfig().keySet()))throw new WorkspaceDenied(400,"InvalidCostConfiguration");
        for(var e:input.costConfig().entrySet()){if(e.getKey().equals("currency")){if(!Set.of("USD","CNY").contains(e.getValue()))throw new WorkspaceDenied(400,"InvalidCostCurrency");}else if(!(e.getValue() instanceof Number n)||!Double.isFinite(n.doubleValue())||n.doubleValue()<0||n.doubleValue()>100000)throw new WorkspaceDenied(400,"InvalidCostRate");}
        UUID target=id==null?UUID.randomUUID():id;
        tx.executeWithoutResult(status->{
            if(id==null)jdbc.update("INSERT INTO ai_model(id,provider_id,code,name,enabled,streaming,tools,vision,context_window,max_output_tokens,default_parameters,cost_config) VALUES(?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb)",target,input.providerId(),input.code(),input.name(),input.enabled(),input.streaming(),input.tools(),input.vision(),input.contextWindow(),input.maxOutputTokens(),JsonUtils.toJsonString(input.defaultParameters()),JsonUtils.toJsonString(input.costConfig()));
            else if(jdbc.update("UPDATE ai_model SET provider_id=?,code=?,name=?,enabled=?,streaming=?,tools=?,vision=?,context_window=?,max_output_tokens=?,default_parameters=?::jsonb,cost_config=?::jsonb,version=version+1,verified_status='EXPERIMENTAL' WHERE id=? AND version=?",input.providerId(),input.code(),input.name(),input.enabled(),input.streaming(),input.tools(),input.vision(),input.contextWindow(),input.maxOutputTokens(),JsonUtils.toJsonString(input.defaultParameters()),JsonUtils.toJsonString(input.costConfig()),id,input.expectedVersion())!=1)throw new WorkspaceDenied(409,"ModelVersionConflict");audit(actor,"model.saved",target);
        });if(id!=null)conversations.revokeModels(List.of(id));return model(target);
    }
    public List<Map<String,Object>> policies(UUID model){model(model);return jdbc.queryForList("SELECT p.id,p.subject_type,p.subject_id::text,CASE p.subject_type WHEN 'ALL' THEN '全体员工' WHEN 'USER' THEN (SELECT nick_name || ' · ' || user_name FROM sys_user WHERE user_id=p.subject_id) WHEN 'ROLE' THEN (SELECT role_name FROM sys_role WHERE role_id=p.subject_id) ELSE (SELECT dept_name FROM sys_dept WHERE dept_id=p.subject_id) END AS name FROM ai_model_policy p WHERE p.model_id=? ORDER BY p.created_at DESC LIMIT 100",model);}
    public void grant(UUID model,long actor,String type,String subject){
        model(model);long id;try{id=Long.parseLong(subject);}catch(Exception e){throw new WorkspaceDenied(400,"InvalidGrantSubject");}
        if(!Set.of("ALL","USER","ROLE","DEPARTMENT").contains(type)||id<0||(type.equals("ALL")&&id!=0))throw new WorkspaceDenied(400,"InvalidGrantSubject");
        if(!type.equals("ALL")){String table=switch(type){case "USER"->"sys_user";case "ROLE"->"sys_role";default->"sys_dept";};String col=switch(type){case "USER"->"user_id";case "ROLE"->"role_id";default->"dept_id";};if(!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM "+table+" WHERE "+col+"=? AND status='0' AND del_flag='0')",Boolean.class,id)))throw new WorkspaceDenied(400,"GrantSubjectUnavailable");}
        jdbc.update("INSERT INTO ai_model_policy(id,model_id,subject_type,subject_id,created_by) VALUES(?,?,?,?,?) ON CONFLICT(model_id,subject_type,subject_id) DO NOTHING",UUID.randomUUID(),model,type,id,actor);audit(actor,"model.granted",model);
    }
    public void revoke(UUID model,UUID policy,long actor){jdbc.update("DELETE FROM ai_model_policy WHERE id=? AND model_id=?",policy,model);audit(actor,"model.grant.revoked",model);conversations.revokeModels(List.of(model));}
    public List<Map<String,Object>> tests(UUID model){return jdbc.queryForList("SELECT id,provider_id,model_code,status,request_id,latency_ms,error_code,created_at FROM ai_model_test WHERE model_id=? ORDER BY created_at DESC LIMIT 30",model);}
    public Map<String,Object> test(UUID model,long actor){
        var rows=jdbc.queryForList("SELECT m.*,p.base_url,p.provider_type,p.secret_cipher,p.timeout_seconds,p.version AS provider_version,p.enabled AS provider_enabled FROM ai_model m JOIN ai_provider p ON p.id=m.provider_id WHERE m.id=?",model);if(rows.isEmpty())throw new WorkspaceDenied(404,"ModelNotFound");var m=rows.getFirst();if(!Boolean.TRUE.equals(m.get("enabled"))||!Boolean.TRUE.equals(m.get("provider_enabled")))throw new WorkspaceDenied(400,"ModelDisabled");
        long started=System.nanoTime();String result="FAIL",requestId=null,error="ProviderUnavailable";
        try{
            String type=m.get("provider_type").toString();
            String base=WorkspaceProviderDestination.validate(type,m.get("base_url").toString());
            var payload=probePayload(m.get("code").toString(),type);
            var request=HttpRequest.newBuilder(URI.create(base+"/chat/completions"))
                .timeout(Duration.ofSeconds(30)).header("Authorization","Bearer "+secrets.decrypt(m.get("secret_cipher").toString()))
                .header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JsonUtils.toJsonString(payload))).build();
            var response=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER)
                .build().send(request,HttpResponse.BodyHandlers.ofInputStream());
            byte[] bytes;try(var stream=response.body()){bytes=stream.readNBytes(1_048_577);}
            if(response.statusCode()==200&&bytes.length<=1_048_576){var body=JsonUtils.parseMap(new String(bytes,java.nio.charset.StandardCharsets.UTF_8));if(body.get("choices") instanceof List<?> choices&&!choices.isEmpty()){result="PASS";requestId=response.headers().firstValue("x-request-id").orElse(null);error=null;}}
        }catch(InterruptedException e){Thread.currentThread().interrupt();error="TestInterrupted";}catch(WorkspaceDenied denied){error=denied.getMessage();}catch(Exception ignored){}
        UUID test=UUID.randomUUID();long ms=(System.nanoTime()-started)/1000000;
        jdbc.update("INSERT INTO ai_model_test(id,model_id,provider_id,model_code,model_version,provider_version,actor_user_id,status,request_id,latency_ms,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)",test,model,m.get("provider_id"),m.get("code"),m.get("version"),m.get("provider_version"),actor,result,requestId,ms,error);
        if(result.equals("PASS"))jdbc.update("UPDATE ai_model SET verified_status='VERIFIED' WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM ai_provider p WHERE p.id=ai_model.provider_id AND p.version=?)",model,m.get("version"),m.get("provider_version"));
        audit(actor,"model.tested",model);return tests(model).stream().filter(r->test.equals(r.get("id"))).findFirst().orElseThrow();
    }

    static Map<String,Object> probePayload(String code,String type){
        Map<String,Object> payload=new LinkedHashMap<>();payload.put("model",code);
        payload.put("messages",List.of(Map.of("role","user","content","Reply OK.")));
        payload.put("stream",false);payload.put("max_tokens",8);
        if("ARK".equals(type))payload.put("thinking",Map.of("type","disabled"));
        return payload;
    }
}
