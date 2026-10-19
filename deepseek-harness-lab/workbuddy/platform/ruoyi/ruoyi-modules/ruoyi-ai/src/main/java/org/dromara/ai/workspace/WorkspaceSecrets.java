package org.dromara.ai.workspace;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;

/** AES-256-GCM, key stored outside the database and never exposed by browser APIs. */
@Service
public class WorkspaceSecrets {
    private final SecretKeySpec key;
    public WorkspaceSecrets(@Value("${workspace.secret-key-file}") String file) throws Exception {
        byte[] raw=Files.readAllBytes(Path.of(file));if(raw.length!=32)throw new IllegalStateException("SecretKeyMustBe32Bytes");key=new SecretKeySpec(raw,"AES");
    }
    public String encrypt(String secret) {
        try {byte[] iv=new byte[12];new SecureRandom().nextBytes(iv);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key,new GCMParameterSpec(128,iv));cipher.updateAAD("workspace-provider-v1".getBytes(StandardCharsets.UTF_8));
            return "v1."+Base64.getEncoder().encodeToString(iv)+"."+Base64.getEncoder().encodeToString(cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8)));
        }catch(Exception e){throw new WorkspaceDenied(503,"SecretServiceUnavailable");}
    }
    public String decrypt(String encrypted) {
        try {String[] p=encrypted.split("\\.");if(p.length!=3||!p[0].equals("v1"))throw new Exception();Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.getDecoder().decode(p[1])));cipher.updateAAD("workspace-provider-v1".getBytes(StandardCharsets.UTF_8));return new String(cipher.doFinal(Base64.getDecoder().decode(p[2])),StandardCharsets.UTF_8);}
        catch(Exception e){throw new WorkspaceDenied(503,"SecretServiceUnavailable");}
    }
}
