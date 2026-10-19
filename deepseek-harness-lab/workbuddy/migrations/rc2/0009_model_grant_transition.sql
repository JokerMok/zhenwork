UPDATE ai_provider SET provider_type='ARK' WHERE provider_type='VOLCENGINE_ARK';
INSERT INTO ai_model_policy(id,model_id,subject_type,subject_id,created_by)
SELECT md5(g.model_id::text || ':' || g.user_id::text)::uuid,g.model_id,'USER',g.user_id,g.user_id FROM ai_model_grant g
ON CONFLICT(model_id,subject_type,subject_id) DO NOTHING;
ALTER TABLE ai_model_grant RENAME TO ai_model_grant_r4_archive;
REVOKE INSERT,UPDATE,DELETE ON ai_model_grant_r4_archive FROM workspace_rc2_app;
