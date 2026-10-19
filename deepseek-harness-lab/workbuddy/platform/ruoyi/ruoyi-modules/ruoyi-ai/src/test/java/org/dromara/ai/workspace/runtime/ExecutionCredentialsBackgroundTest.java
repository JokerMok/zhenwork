package org.dromara.ai.workspace.runtime;

import org.dromara.ai.workspace.WorkspaceDenied;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ExecutionCredentialsBackgroundTest {
    @TempDir Path directory;

    private static String token(byte[] key, String context) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return "Bearer " + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(mac.doFinal(context.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void backgroundTokenCannotAuthorizeOtherExecutionEndpoints() throws Exception {
        byte[] key = new byte[32];
        new java.security.SecureRandom().nextBytes(key);
        Path file = directory.resolve("execution-key");
        Files.write(file, key);
        ExecutionCredentials credentials = new ExecutionCredentials(file.toString());
        String background = token(key, "workspace-rc2-background-v1");
        String execution = token(key, "workspace-rc2-service-v1");
        assertDoesNotThrow(() -> credentials.checkBackgroundService(background));
        assertDoesNotThrow(() -> credentials.checkService(execution));
        assertThrows(WorkspaceDenied.class, () -> credentials.checkBackgroundService(execution));
        assertThrows(WorkspaceDenied.class, () -> credentials.checkService(background));
    }
}
