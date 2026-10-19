-- A web-host-held capability for one employee's server-side scheduled job.
-- Only a digest is stored; disabling the employee or changing auth_version
-- invalidates every outstanding grant without depending on a browser cookie.
CREATE TABLE ai_background_grant (
    id UUID PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
    auth_version BIGINT NOT NULL,
    job_id VARCHAR(100) NOT NULL,
    secret_sha256 CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ai_background_grant_active_job
    ON ai_background_grant(owner_user_id, job_id) WHERE revoked_at IS NULL;
CREATE INDEX ai_background_grant_owner_recent
    ON ai_background_grant(owner_user_id, created_at DESC);
