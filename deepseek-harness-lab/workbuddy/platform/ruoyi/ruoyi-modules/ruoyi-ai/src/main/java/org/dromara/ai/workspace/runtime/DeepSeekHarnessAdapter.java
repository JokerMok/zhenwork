package org.dromara.ai.workspace.runtime;

import org.dromara.ai.workspace.WorkspaceDenied;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;

/** The only RC2 adapter. Its wire contract contains normalized Workspace events, never Harness events. */
@Service
public class DeepSeekHarnessAdapter implements AgentRuntime {
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final URI endpoint;
    private final ExecutionCredentials credentials;
    public DeepSeekHarnessAdapter(@Value("${workspace.execution-url}") String endpoint,ExecutionCredentials credentials) {
        this.endpoint=URI.create(endpoint);this.credentials=credentials;
    }
    private Map<String,Object> call(String method,String grant,Map<String,Object> args) {
        var body=new java.util.LinkedHashMap<>(args);body.put("method",method);body.put("executionGrant",grant);
        try {
            var request=HttpRequest.newBuilder(endpoint.resolve("/command")).timeout(Duration.ofSeconds(method.equals("health")?5:300))
                .header("Authorization","Bearer "+credentials.serviceToken()).header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JsonUtils.toJsonString(body))).build();
            var response=client.send(request,HttpResponse.BodyHandlers.ofString());
            if(response.statusCode()!=200)throw new WorkspaceDenied(503,"RuntimeUnavailable");
            return JsonUtils.parseMap(response.body());
        }catch(InterruptedException e){Thread.currentThread().interrupt();throw new WorkspaceDenied(503,"RuntimeInterrupted");}
        catch(java.io.IOException e){throw new WorkspaceDenied(503,"RuntimeUnavailable");}
    }
    public Map<String,Object> createSession(String grant){return call("createSession",grant,Map.of());}
    public Map<String,Object> resumeSession(String grant){return call("resumeSession",grant,Map.of());}
    public Map<String,Object> sendMessage(String grant,String text){return call("sendMessage",grant,Map.of("text",text));}
    public Map<String,Object> streamEvents(String grant,String sequence){return call("streamEvents",grant,Map.of("lastEventSequence",sequence));}
    public Map<String,Object> cancel(String grant){return call("cancel",grant,Map.of());}
    public Map<String,Object> approve(String grant,UUID id){return call("approve",grant,Map.of("approvalId",id.toString()));}
    public Map<String,Object> deny(String grant,UUID id){return call("deny",grant,Map.of("approvalId",id.toString()));}
    public Map<String,Object> history(String grant){return call("history",grant,Map.of());}
    public Map<String,Object> health(){return call("health","",Map.of());}
    public Map<String,Object> shutdown(String grant){return call("shutdown",grant,Map.of());}
}
