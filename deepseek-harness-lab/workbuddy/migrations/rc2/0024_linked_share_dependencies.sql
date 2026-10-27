-- Additive only. Linked minimum grants never overwrite independent ACL/policy rows.
CREATE TABLE ai_resource_share_dependency (
    share_id uuid NOT NULL REFERENCES ai_resource_share(id),
    parent_version integer NOT NULL,
    parent_dependencies jsonb NOT NULL DEFAULT '{}'::jsonb,
    dependency_type text NOT NULL CHECK (dependency_type IN ('MODEL','SKILL','TOOL','MCP','KNOWLEDGE')),
    dependency_id uuid NOT NULL,
    dependency_version integer NOT NULL,
    dependency_auth_version bigint NOT NULL,
    connection_auth_version bigint,
    granted_by bigint NOT NULL,
    confirmed_sensitive boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (share_id, dependency_type, dependency_id)
);
CREATE INDEX ai_share_dependency_lookup ON ai_resource_share_dependency(dependency_id,dependency_type);
CREATE VIEW ai_active_share_dependency AS
SELECT d.*, s.subject_type, s.subject_id
FROM ai_resource_share_dependency d
JOIN ai_resource_share s ON s.id=d.share_id
JOIN ai_resource r ON r.id=s.resource_id
JOIN ai_resource_version pv ON pv.resource_id=r.id AND pv.version=r.published_version
WHERE s.status='ACTIVE' AND s.actions @> ARRAY['USE']::text[]
  AND r.enabled AND NOT r.security_disabled AND r.lifecycle_state='ACTIVE'
  AND d.parent_dependencies=CASE r.resource_type
    WHEN 'ASSISTANT' THEN jsonb_build_object('modelId',pv.config->'modelId','skillIds',COALESCE(pv.config->'skillIds','[]'::jsonb),'mcpIds',COALESCE(pv.config->'mcpIds','[]'::jsonb),'toolIds',COALESCE(pv.config->'toolIds','[]'::jsonb),'knowledgeIds',COALESCE(pv.config->'knowledgeIds','[]'::jsonb))
    WHEN 'SKILL' THEN jsonb_build_object('dependencies',COALESCE(pv.config#>'{manifest,dependencies}','[]'::jsonb),'requiredTools',COALESCE(pv.config#>'{manifest,requiredTools}','[]'::jsonb))
    ELSE '{}'::jsonb END
  AND ((d.dependency_type='MODEL' AND EXISTS(SELECT 1 FROM ai_model m WHERE m.id=d.dependency_id AND m.version=d.dependency_version))
    OR (d.dependency_type<>'MODEL' AND EXISTS(SELECT 1 FROM ai_resource x WHERE x.id=d.dependency_id AND x.published_version=d.dependency_version AND x.auth_version=d.dependency_auth_version)))
  AND (d.connection_auth_version IS NULL OR EXISTS(SELECT 1 FROM ai_mcp_connection c WHERE c.resource_id=d.dependency_id AND c.scope='ENTERPRISE' AND c.auth_version=d.connection_auth_version AND c.enabled AND c.status='READY'));
CREATE VIEW ai_effective_resource_acl AS
SELECT resource_id,subject_type,subject_id,action,granted_by FROM ai_resource_acl
UNION
SELECT d.dependency_id,d.subject_type,d.subject_id,a.action,d.granted_by
FROM ai_active_share_dependency d CROSS JOIN (VALUES ('VIEW'),('USE')) AS a(action)
WHERE d.dependency_type <> 'MODEL';
CREATE VIEW ai_effective_model_policy AS
SELECT model_id,subject_type,subject_id FROM ai_model_policy
UNION
SELECT dependency_id,subject_type,subject_id FROM ai_active_share_dependency WHERE dependency_type='MODEL';
