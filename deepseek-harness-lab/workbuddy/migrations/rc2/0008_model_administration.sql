ALTER TABLE ai_provider ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 2);
ALTER TABLE ai_provider ADD COLUMN secret_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE ai_model ADD COLUMN vision BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_model ADD COLUMN verified_status VARCHAR(20) NOT NULL DEFAULT 'EXPERIMENTAL' CHECK(verified_status IN('VERIFIED','EXPERIMENTAL','DISABLED'));
ALTER TABLE ai_model ADD COLUMN default_parameters JSONB NOT NULL DEFAULT '{}';
ALTER TABLE ai_model ADD COLUMN cost_config JSONB NOT NULL DEFAULT '{}';
CREATE TABLE ai_model_policy (
 id UUID PRIMARY KEY, model_id UUID NOT NULL REFERENCES ai_model(id),
 subject_type VARCHAR(16) NOT NULL CHECK(subject_type IN('ALL','USER','ROLE','DEPARTMENT')),
 subject_id BIGINT NOT NULL DEFAULT 0, created_by BIGINT NOT NULL REFERENCES sys_user(user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(model_id,subject_type,subject_id), CHECK(subject_type<>'ALL' OR subject_id=0)
);
CREATE TABLE ai_model_test (
 id UUID PRIMARY KEY, model_id UUID NOT NULL REFERENCES ai_model(id), provider_id UUID NOT NULL REFERENCES ai_provider(id),
 model_code VARCHAR(160) NOT NULL, model_version BIGINT NOT NULL, provider_version BIGINT NOT NULL,
 actor_user_id BIGINT NOT NULL REFERENCES sys_user(user_id), status VARCHAR(20) NOT NULL,
 request_id VARCHAR(200), latency_ms BIGINT NOT NULL, error_code VARCHAR(80), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_model_test_recent ON ai_model_test(model_id,created_at DESC);
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon)
VALUES(1802000000000001000,'模型管理',0,30,'workspace-models',NULL,'M','0','0',NULL,'server'),
(1802000000000001001,'Provider 配置',1802000000000001000,1,'providers','ai/providers/index','C','0','0','ai:provider:admin','component'),
(1802000000000001002,'模型与授权',1802000000000001000,2,'registry','ai/models/index','C','0','0','ai:model:admin','list');
UPDATE ai_principal_state SET auth_version=auth_version+1;
