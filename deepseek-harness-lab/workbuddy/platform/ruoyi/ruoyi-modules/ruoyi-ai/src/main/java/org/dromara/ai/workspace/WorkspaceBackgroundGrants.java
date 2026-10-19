package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

/** Revocable, job-scoped authorization held by the enterprise web host only. */
@Service
@RequiredArgsConstructor
public class WorkspaceBackgroundGrants {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final WorkspacePrincipal principals;
    private final WorkspacePermissions permissions;

    public record Issued(UUID id, String jobId, String secret) {}
    public record Authorized(long userId, long authVersion, String jobId) {}

    private static String validJobId(String jobId) {
        if (jobId == null || !jobId.matches("cron_[A-Za-z0-9_-]{8,80}"))
            throw new WorkspaceDenied(400, "InvalidBackgroundJob");
        return jobId;
    }

    private static String digest(String secret) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(secret.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public Issued issue(WorkspacePrincipal.Actor actor, String jobId) {
        validJobId(jobId);
        principals.requireActiveVersion(actor.userId(), actor.authVersion());
        permissions.require(actor.userId(), "ai:session:use");
        byte[] random = new byte[32];
        RANDOM.nextBytes(random);
        String secret = HexFormat.of().formatHex(random);
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            jdbc.update("UPDATE ai_background_grant SET revoked_at=NOW() WHERE owner_user_id=? AND job_id=? AND revoked_at IS NULL",
                actor.userId(), jobId);
            jdbc.update("INSERT INTO ai_background_grant(id,owner_user_id,auth_version,job_id,secret_sha256) VALUES(?,?,?,?,?)",
                id, actor.userId(), actor.authVersion(), jobId, digest(secret));
        });
        audit(actor.userId(), "background.grant.issued", id, jobId);
        return new Issued(id, jobId, secret);
    }

    public void revoke(long userId, String jobId) {
        validJobId(jobId);
        int changed = jdbc.update("UPDATE ai_background_grant SET revoked_at=NOW() WHERE owner_user_id=? AND job_id=? AND revoked_at IS NULL",
            userId, jobId);
        if (changed != 0) audit(userId, "background.grant.revoked", null, jobId);
    }

    public Authorized require(UUID id, String secret) {
        if (id == null || secret == null || !secret.matches("[0-9a-f]{64}"))
            throw new WorkspaceDenied(401, "BackgroundAuthorizationRevoked");
        var rows = jdbc.queryForList("SELECT owner_user_id,auth_version,job_id,secret_sha256 FROM ai_background_grant WHERE id=? AND revoked_at IS NULL", id);
        if (rows.size() != 1) throw new WorkspaceDenied(401, "BackgroundAuthorizationRevoked");
        Map<String, Object> row = rows.getFirst();
        byte[] expected = row.get("secret_sha256").toString().getBytes(StandardCharsets.US_ASCII);
        byte[] actual = digest(secret).getBytes(StandardCharsets.US_ASCII);
        if (!MessageDigest.isEqual(expected, actual))
            throw new WorkspaceDenied(401, "BackgroundAuthorizationRevoked");
        long userId = ((Number) row.get("owner_user_id")).longValue();
        long authVersion = ((Number) row.get("auth_version")).longValue();
        principals.requireActiveVersion(userId, authVersion);
        permissions.require(userId, "ai:session:use");
        return new Authorized(userId, authVersion, row.get("job_id").toString());
    }

    private void audit(long userId, String action, UUID grantId, String jobId) {
        jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,metadata) VALUES(?,?,?,?::jsonb)",
            UUID.randomUUID(), userId, action, JsonUtils.toJsonString(Map.of(
                "jobId", jobId, "grantId", grantId == null ? "" : grantId.toString())));
    }
}
