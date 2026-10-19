CREATE TABLE ai_resource (
 id UUID PRIMARY KEY, resource_type VARCHAR(20) NOT NULL CHECK(resource_type IN('ASSISTANT','SKILL','MCP','TOOL','KNOWLEDGE')),
 owner_type VARCHAR(20) NOT NULL CHECK(owner_type IN('USER','ENTERPRISE')), owner_user_id BIGINT REFERENCES sys_user(user_id),
 name VARCHAR(100) NOT NULL, description VARCHAR(500) NOT NULL DEFAULT '',
 visibility VARCHAR(30) NOT NULL DEFAULT 'PRIVATE' CHECK(visibility IN('PRIVATE','SHARED','ENTERPRISE_PUBLIC')),
 lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK(lifecycle_state IN('DRAFT','ACTIVE','ARCHIVED')),
 enabled BOOLEAN NOT NULL DEFAULT TRUE, auth_version BIGINT NOT NULL DEFAULT 1,
 latest_version INTEGER NOT NULL DEFAULT 1, published_version INTEGER,
 created_by BIGINT NOT NULL REFERENCES sys_user(user_id), updated_by BIGINT NOT NULL REFERENCES sys_user(user_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((owner_type='USER' AND owner_user_id IS NOT NULL) OR (owner_type='ENTERPRISE' AND owner_user_id IS NULL))
);
CREATE INDEX ai_resource_owner ON ai_resource(owner_user_id,resource_type,updated_at DESC);
CREATE INDEX ai_resource_public ON ai_resource(resource_type,updated_at DESC) WHERE visibility='ENTERPRISE_PUBLIC';
CREATE TABLE ai_resource_version (
 resource_id UUID NOT NULL REFERENCES ai_resource(id), version INTEGER NOT NULL,
 schema_version INTEGER NOT NULL DEFAULT 1, config JSONB NOT NULL, content_hash CHAR(64) NOT NULL,
 review_state VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED' CHECK(review_state IN('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
 created_by BIGINT NOT NULL REFERENCES sys_user(user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(resource_id,version)
);
ALTER TABLE ai_resource ADD CONSTRAINT ai_resource_latest_version_fk FOREIGN KEY(id,latest_version) REFERENCES ai_resource_version(resource_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_resource ADD CONSTRAINT ai_resource_published_version_fk FOREIGN KEY(id,published_version) REFERENCES ai_resource_version(resource_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION workspace_resource_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.config IS DISTINCT FROM OLD.config OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
 OR NEW.version IS DISTINCT FROM OLD.version OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
 OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.created_by IS DISTINCT FROM OLD.created_by
 OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Resource versions are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_resource_version_immutable BEFORE UPDATE OR DELETE ON ai_resource_version FOR EACH ROW EXECUTE FUNCTION workspace_resource_version_immutable();
CREATE TABLE ai_resource_acl (
 resource_id UUID NOT NULL REFERENCES ai_resource(id), subject_type VARCHAR(20) NOT NULL CHECK(subject_type IN('USER','ROLE','DEPARTMENT')),
 subject_id BIGINT NOT NULL, action VARCHAR(20) NOT NULL CHECK(action IN('VIEW','USE','EDIT','SHARE','PUBLISH','DELETE','GOVERN')),
 granted_by BIGINT NOT NULL REFERENCES sys_user(user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(resource_id,subject_type,subject_id,action)
);
CREATE INDEX ai_resource_acl_subject ON ai_resource_acl(subject_type,subject_id,resource_id);
CREATE TABLE ai_resource_share (
 id UUID PRIMARY KEY, resource_id UUID NOT NULL REFERENCES ai_resource(id), subject_type VARCHAR(20) NOT NULL,
 subject_id BIGINT NOT NULL, actions TEXT[] NOT NULL, share_mode VARCHAR(20) NOT NULL DEFAULT 'REFERENCE' CHECK(share_mode='REFERENCE'),
 status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','REVOKED')),
 shared_by BIGINT NOT NULL REFERENCES sys_user(user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ai_resource_active_share ON ai_resource_share(resource_id,subject_type,subject_id) WHERE status='ACTIVE';
CREATE TABLE ai_resource_review (
 id UUID PRIMARY KEY, resource_id UUID NOT NULL, version INTEGER NOT NULL, requested_by BIGINT NOT NULL REFERENCES sys_user(user_id),
 reviewed_by BIGINT REFERENCES sys_user(user_id), state VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','APPROVED','REJECTED')),
 reason VARCHAR(1000), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ,
 FOREIGN KEY(resource_id,version) REFERENCES ai_resource_version(resource_id,version)
);
ALTER TABLE ai_session ADD COLUMN assistant_resource_id UUID REFERENCES ai_resource(id);
CREATE TABLE ai_run_resource (
 run_id UUID NOT NULL REFERENCES ai_run(id), resource_id UUID NOT NULL, version INTEGER NOT NULL, auth_version BIGINT NOT NULL,
 PRIMARY KEY(run_id,resource_id), FOREIGN KEY(resource_id,version) REFERENCES ai_resource_version(resource_id,version)
);
CREATE INDEX ai_run_resource_resource ON ai_run_resource(resource_id,run_id);
CREATE TABLE ai_security_event (
 id UUID PRIMARY KEY, actor_user_id BIGINT REFERENCES sys_user(user_id), action VARCHAR(80) NOT NULL,
 resource_id UUID, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_security_event_time ON ai_security_event(created_at DESC);
-- Native RuoYi qualifications remain the single RBAC source.
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,menu_type,visible,status,perms)
SELECT 1802000000000000100+row_number() OVER(),type||' '||action,0,110,'ai-'||type||'-'||action,'F','1','0','ai:'||type||':'||action
FROM unnest(ARRAY['assistant','skill','mcp','tool','knowledge']) type
CROSS JOIN unnest(ARRAY['view','use','create','edit','delete']) action;
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,menu_type,visible,status,perms)
VALUES(1802000000000000201,'资源共享',0,111,'ai-resource-share','F','1','0','ai:resource:share'),
(1802000000000000202,'资源发布申请',0,112,'ai-resource-publish','F','1','0','ai:resource:publish'),
(1802000000000000203,'资源治理',0,113,'ai-resource-govern','F','1','0','ai:resource:govern'),
(1802000000000000204,'企业资源创建',0,114,'ai-resource-enterprise','F','1','0','ai:resource:enterprise'),
(1802000000000000205,'资源审核',0,115,'ai-resource-review','F','1','0','ai:resource:review');
INSERT INTO sys_role_menu(role_id,menu_id)
SELECT role_id,menu_id FROM sys_role CROSS JOIN sys_menu WHERE role_key='workspace_employee'
AND(menu_id BETWEEN 1802000000000000101 AND 1802000000000000125 OR menu_id IN(1802000000000000201,1802000000000000202));
