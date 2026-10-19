package org.dromara.ai.workspace.runtime;

import org.dromara.ai.workspace.WorkspaceDenied;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;

/** Dedicated service authentication and short-lived, explicitly scoped execution grants. */
@Service
public class ExecutionCredentials {
    private final byte[] key;
    private final String serviceToken;
    private final String backgroundServiceToken;
    public ExecutionCredentials(@Value("${workspace.execution-key-file}") String file) throws Exception {
        key=Files.readAllBytes(Path.of(file));
        if(key.length!=32)throw new IllegalStateException("ExecutionKeyMustBe32Bytes");
        serviceToken=Base64.getUrlEncoder().withoutPadding().encodeToString(sign("workspace-rc2-service-v1"));
        backgroundServiceToken=Base64.getUrlEncoder().withoutPadding().encodeToString(sign("workspace-rc2-background-v1"));
    }
    private byte[] sign(String value) {
        try {Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(key,"HmacSHA256"));return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));}
        catch(Exception e){throw new IllegalStateException("ExecutionSignatureUnavailable");}
    }
    public String serviceToken(){return serviceToken;}
    public void checkBackgroundService(String header) {
        if(header==null || !MessageDigest.isEqual(("Bearer "+backgroundServiceToken).getBytes(StandardCharsets.UTF_8),header.getBytes(StandardCharsets.UTF_8)))
            throw new WorkspaceDenied(403,"BackgroundServiceAuthenticationRequired");
    }
    public void checkService(String header) {
        if(header==null || !MessageDigest.isEqual(("Bearer "+serviceToken).getBytes(StandardCharsets.UTF_8),header.getBytes(StandardCharsets.UTF_8)))throw new WorkspaceDenied(403,"ServiceAuthenticationRequired");
    }
    public String issue(Map<String,Object> claims) {
        var payload=new java.util.LinkedHashMap<>(claims);payload.put("iss","workspace-ruoyi");payload.put("aud","deepseek-execution");
        payload.put("exp",Instant.now().getEpochSecond()+300);payload.put("jti",java.util.UUID.randomUUID().toString());
        String encoded=Base64.getUrlEncoder().withoutPadding().encodeToString(JsonUtils.toJsonString(payload).getBytes(StandardCharsets.UTF_8));
        return encoded+"."+Base64.getUrlEncoder().withoutPadding().encodeToString(sign(encoded));
    }
    public Map<String,Object> verify(String token,String scope) {
        try {
            String[] parts=token.split("\\.",-1);if(parts.length!=2 || !MessageDigest.isEqual(sign(parts[0]),Base64.getUrlDecoder().decode(parts[1])))throw new Exception();
            Map<String,Object> claims=JsonUtils.parseMap(new String(Base64.getUrlDecoder().decode(parts[0]),StandardCharsets.UTF_8));
            if(!"workspace-ruoyi".equals(claims.get("iss")) || !"deepseek-execution".equals(claims.get("aud"))
                || Long.parseLong(claims.get("exp").toString())<=Instant.now().getEpochSecond() || !scope.equals(claims.get("scope")))throw new Exception();
            return claims;
        } catch(Exception e){throw new WorkspaceDenied(403,"InvalidExecutionGrant");}
    }
}
