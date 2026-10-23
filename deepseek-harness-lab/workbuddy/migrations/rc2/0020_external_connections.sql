CREATE TABLE ai_external_connection (
 id UUID PRIMARY KEY REFERENCES ai_mcp_connection(id),
 connector_type VARCHAR(32) NOT NULL CHECK(connector_type IN('UFEI_DASHBOARD','CSWM_IOT')),
 name VARCHAR(100) NOT NULL,
 business_unit VARCHAR(200) NOT NULL,
 environment VARCHAR(64) NOT NULL,
 base_url VARCHAR(500) NOT NULL,
 credential_cipher TEXT,
 identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
 verified_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
 allowed_methods TEXT[] NOT NULL,
 tested_status VARCHAR(24) NOT NULL DEFAULT 'NOT_TESTED' CHECK(tested_status IN('NOT_TESTED','READY','ERROR')),
 last_error VARCHAR(80),
 expert_resource_id UUID REFERENCES ai_resource(id),
 version BIGINT NOT NULL DEFAULT 1,
 created_by BIGINT NOT NULL REFERENCES sys_user(user_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_external_connection_updated ON ai_external_connection(updated_at DESC);

CREATE TABLE ai_external_call (
 id UUID PRIMARY KEY,
 connection_id UUID NOT NULL REFERENCES ai_external_connection(id),
 actor_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 business_unit VARCHAR(200) NOT NULL,
 method VARCHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL CHECK(status IN('SUCCEEDED','FAILED','REVOKED')),
 error_code VARCHAR(80),
 duration_ms BIGINT NOT NULL,
 connection_version BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_external_call_recent ON ai_external_call(connection_id,created_at DESC);

INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon)
VALUES(1802000000000002006,'外部数据连接',1802000000000002000,6,'connections','ai/connections/index','C','0','0','ai:resource:enterprise','connection');
INSERT INTO sys_role_menu(role_id,menu_id)
SELECT role_id,1802000000000002006 FROM sys_role_menu WHERE menu_id=1802000000000002002
ON CONFLICT DO NOTHING;
