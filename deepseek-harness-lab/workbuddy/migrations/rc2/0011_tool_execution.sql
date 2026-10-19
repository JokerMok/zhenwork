CREATE TABLE ai_tool_type (
 code VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 requires_approval BOOLEAN NOT NULL, version BIGINT NOT NULL DEFAULT 1, updated_by BIGINT REFERENCES sys_user(user_id),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ai_tool_type(code,name,requires_approval) VALUES('CALCULATOR','精确计算',FALSE),('TEXT_DOCUMENT','生成文本文件',TRUE);
CREATE TABLE ai_tool_approval (
 id UUID PRIMARY KEY,run_id UUID NOT NULL REFERENCES ai_run(id),resource_id UUID NOT NULL REFERENCES ai_resource(id),
 call_id VARCHAR(200) NOT NULL,args_hash CHAR(64) NOT NULL,arguments JSONB NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','APPROVED','DENIED','CONSUMED','EXPIRED','CANCELLED')),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '120 seconds',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),decided_at TIMESTAMPTZ,
 UNIQUE(run_id,call_id)
);
CREATE TABLE ai_artifact (
 id UUID PRIMARY KEY,owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),run_id UUID NOT NULL REFERENCES ai_run(id),
 filename VARCHAR(120) NOT NULL,media_type VARCHAR(80) NOT NULL,byte_size BIGINT NOT NULL,sha256 CHAR(64) NOT NULL,storage_key UUID NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),deleted_at TIMESTAMPTZ
);
CREATE INDEX ai_artifact_owner ON ai_artifact(owner_user_id,created_at DESC);
CREATE TABLE ai_tool_execution (
 run_id UUID NOT NULL REFERENCES ai_run(id),call_id VARCHAR(200) NOT NULL,resource_id UUID NOT NULL REFERENCES ai_resource(id),
 args_hash CHAR(64) NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(run_id,call_id)
);
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon)
VALUES(1802000000000002000,'AI 资源管理',0,31,'workspace-resources',NULL,'M','0','0',NULL,'component'),
(1802000000000002001,'工具类型',1802000000000002000,1,'tool-types','ai/tool-types/index','C','0','0','ai:tool:admin','tool');
UPDATE ai_principal_state SET auth_version=auth_version+1;
