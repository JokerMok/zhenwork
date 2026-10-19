-- R4 minimum real chain. Providers and grants are authoritative here, never in the execution service.
CREATE TABLE ai_provider (
 id UUID PRIMARY KEY, name VARCHAR(100) NOT NULL, provider_type VARCHAR(40) NOT NULL,
 base_url TEXT NOT NULL, protocol VARCHAR(40) NOT NULL DEFAULT 'OPENAI_CHAT',
 secret_cipher TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 version BIGINT NOT NULL DEFAULT 1, timeout_seconds INTEGER NOT NULL DEFAULT 120,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE ai_model (
 id UUID PRIMARY KEY, provider_id UUID NOT NULL REFERENCES ai_provider(id), code VARCHAR(160) NOT NULL,
 name VARCHAR(100) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, streaming BOOLEAN NOT NULL DEFAULT TRUE,
 tools BOOLEAN NOT NULL DEFAULT TRUE, context_window INTEGER NOT NULL DEFAULT 32000,
 max_output_tokens INTEGER NOT NULL DEFAULT 2048, version BIGINT NOT NULL DEFAULT 1,
 UNIQUE(provider_id,code), CHECK(max_output_tokens BETWEEN 1 AND 32768)
);
CREATE TABLE ai_model_grant (
 model_id UUID NOT NULL REFERENCES ai_model(id), user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 PRIMARY KEY(model_id,user_id)
);
CREATE TABLE ai_session (
 id UUID PRIMARY KEY, owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 model_id UUID NOT NULL REFERENCES ai_model(id), title VARCHAR(100) NOT NULL,
 next_sequence BIGINT NOT NULL DEFAULT 0, runtime_initialized BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ
);
CREATE INDEX ai_session_owner_recent ON ai_session(owner_user_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE ai_run (
 id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES ai_session(id), owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 idempotency_key UUID NOT NULL, input_hash CHAR(64) NOT NULL, user_text TEXT NOT NULL,
 status VARCHAR(32) NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','CANCELLED')),
 auth_version BIGINT NOT NULL, model_version BIGINT NOT NULL, provider_version BIGINT NOT NULL,
 error_code VARCHAR(80), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
 UNIQUE(owner_user_id,idempotency_key)
);
CREATE UNIQUE INDEX ai_run_one_active_user ON ai_run(owner_user_id) WHERE status IN ('QUEUED','RUNNING','WAITING_APPROVAL');
CREATE INDEX ai_run_session ON ai_run(session_id,created_at);
CREATE TABLE ai_message (
 id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES ai_session(id), run_id UUID NOT NULL REFERENCES ai_run(id),
 role VARCHAR(16) NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(run_id,role)
);
CREATE INDEX ai_message_session ON ai_message(session_id,created_at,id);
CREATE TABLE ai_event (
 event_id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES ai_session(id), run_id UUID REFERENCES ai_run(id),
 sequence BIGINT NOT NULL, event_type VARCHAR(80) NOT NULL, payload JSONB NOT NULL,
 protocol_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(session_id,sequence)
);
CREATE TABLE ai_runtime (
 owner_user_id BIGINT PRIMARY KEY REFERENCES sys_user(user_id), instance_id UUID NOT NULL,
 state VARCHAR(32) NOT NULL, image_digest VARCHAR(80) NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,menu_type,visible,status,perms)
VALUES(1802000000000000010,'AI 模型使用',0,100,'ai-model-use','F','1','0','ai:model:use'),
(1802000000000000011,'AI 会话使用',0,101,'ai-session-use','F','1','0','ai:session:use');
INSERT INTO sys_role_menu(role_id,menu_id)
SELECT role_id,menu_id FROM sys_role CROSS JOIN sys_menu WHERE role_key='workspace_employee'
AND menu_id IN (1802000000000000010,1802000000000000011);
