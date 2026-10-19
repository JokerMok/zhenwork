CREATE TABLE ai_execution_call (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES ai_run(id), owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 kind VARCHAR(8) NOT NULL CHECK(kind IN('MODEL','MCP')), resource_id UUID REFERENCES ai_resource(id),
 model_id UUID REFERENCES ai_model(id), provider_id UUID REFERENCES ai_provider(id),
 status VARCHAR(16) NOT NULL DEFAULT 'STARTED' CHECK(status IN('STARTED','COMPLETED','FAILED','CANCELLED')),
 cost_config JSONB NOT NULL DEFAULT '{}', input_tokens BIGINT CHECK(input_tokens>=0), output_tokens BIGINT CHECK(output_tokens>=0),
 estimated_cost NUMERIC(24,10), currency VARCHAR(3), duration_ms BIGINT, provider_ttfb_ms BIGINT, first_token_ms BIGINT,
 http_status INTEGER, finish_hash CHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
);
CREATE INDEX ai_execution_call_recent ON ai_execution_call(created_at DESC,id);
CREATE INDEX ai_execution_call_owner ON ai_execution_call(owner_user_id,created_at DESC);
CREATE INDEX ai_execution_call_run ON ai_execution_call(run_id,created_at);
CREATE INDEX ai_event_audit ON ai_event(created_at DESC,event_id) WHERE event_type LIKE 'tool.%' OR event_type LIKE 'approval.%';
CREATE INDEX ai_file_owner ON ai_file(owner_user_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ai_run_recent ON ai_run(created_at DESC,id);
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon)
VALUES(1802000000000003000,'运行与审计',0,32,'workspace-operations',NULL,'M','0','0',NULL,'monitor'),
(1802000000000003001,'运行管理',1802000000000003000,1,'runs','ai/operations/index','C','0','0','ai:operations:view','monitor'),
(1802000000000003002,'AI 审计与用量',1802000000000003000,2,'audit','ai/audit/index','C','0','0','ai:audit:view','log');
