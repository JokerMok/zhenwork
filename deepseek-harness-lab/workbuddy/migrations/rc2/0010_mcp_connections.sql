CREATE TABLE ai_mcp_connection (
 id UUID PRIMARY KEY, resource_id UUID NOT NULL REFERENCES ai_resource(id),
 owner_user_id BIGINT REFERENCES sys_user(user_id), scope VARCHAR(16) NOT NULL CHECK(scope IN('PERSONAL','ENTERPRISE')),
 template_version INTEGER NOT NULL, secret_cipher TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 auth_version BIGINT NOT NULL DEFAULT 1, version BIGINT NOT NULL DEFAULT 1,
 status VARCHAR(24) NOT NULL DEFAULT 'NOT_TESTED' CHECK(status IN('NOT_TESTED','READY','ERROR')),
 tools_snapshot JSONB NOT NULL DEFAULT '[]', last_error VARCHAR(80), tested_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by BIGINT NOT NULL REFERENCES sys_user(user_id),
 CHECK((scope='PERSONAL' AND owner_user_id IS NOT NULL) OR (scope='ENTERPRISE' AND owner_user_id IS NULL)),
 FOREIGN KEY(resource_id,template_version) REFERENCES ai_resource_version(resource_id,version)
);
CREATE UNIQUE INDEX ai_mcp_personal_connection ON ai_mcp_connection(resource_id,owner_user_id) WHERE scope='PERSONAL';
CREATE UNIQUE INDEX ai_mcp_enterprise_connection ON ai_mcp_connection(resource_id) WHERE scope='ENTERPRISE';
CREATE TABLE ai_run_connection (
 run_id UUID NOT NULL REFERENCES ai_run(id),connection_id UUID NOT NULL REFERENCES ai_mcp_connection(id),
 auth_version BIGINT NOT NULL,PRIMARY KEY(run_id,connection_id)
);
CREATE TABLE ai_mcp_test (
 id UUID PRIMARY KEY,connection_id UUID NOT NULL REFERENCES ai_mcp_connection(id),actor_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 status VARCHAR(20) NOT NULL,latency_ms BIGINT NOT NULL,tool_count INTEGER NOT NULL DEFAULT 0,error_code VARCHAR(80),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_mcp_test_recent ON ai_mcp_test(connection_id,created_at DESC);
