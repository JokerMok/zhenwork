-- Turn the existing top-level System Tools directory into a real landing page.
-- A child-only fix leaves /tool itself on the noRedirect Layout route and can
-- still render blank. The disabled code-generator child deliberately stays
-- disabled and is not exposed by this change.
UPDATE sys_menu
SET component='tool/index', menu_type='C', perms='monitor:admin:list'
WHERE menu_id=1761400000000000003;

-- Spring Boot Admin access remains an existing super-admin permission. Keep
-- that role mapped to the converted page without granting it to employees or
-- auditors.
INSERT INTO sys_role_menu(role_id,menu_id)
SELECT role_id,1761400000000000003 FROM sys_role
WHERE role_key='superadmin'
ON CONFLICT DO NOTHING;

UPDATE ai_principal_state SET auth_version=auth_version+1;
