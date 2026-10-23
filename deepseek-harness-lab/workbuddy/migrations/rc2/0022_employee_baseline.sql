-- Repair qualifications only; no credentials, private settings, files or resource grants are copied.
INSERT INTO sys_user_role(user_id,role_id)
SELECT u.user_id,r.role_id FROM sys_user u CROSS JOIN sys_role r
WHERE u.user_type='sys_user' AND u.del_flag='0' AND r.role_key='workspace_employee'
AND r.status='0' AND r.del_flag='0'
AND NOT EXISTS(SELECT 1 FROM sys_user_role ur WHERE ur.user_id=u.user_id AND ur.role_id=r.role_id);
INSERT INTO ai_principal_state(user_id)
SELECT user_id FROM sys_user ON CONFLICT(user_id) DO NOTHING;
