CREATE OR REPLACE FUNCTION workspace_user_auth_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO ai_principal_state(user_id,must_change_password) VALUES(NEW.user_id,TRUE);
    ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.del_flag IS DISTINCT FROM OLD.del_flag
       OR NEW.password IS DISTINCT FROM OLD.password OR NEW.dept_id IS DISTINCT FROM OLD.dept_id THEN
        UPDATE ai_principal_state SET auth_version=auth_version+1 WHERE user_id=NEW.user_id;
    END IF;
    RETURN NEW;
END $$;

-- No active example object store or shared default password in a product instance.
UPDATE sys_oss_config SET status='N',access_key='',secret_key='' WHERE config_key IN ('minio','qiniu','aliyun','qcloud','image');
UPDATE sys_config SET config_value='',remark='每位新用户必须设置独立临时密码' WHERE config_key='sys.user.initPassword';
UPDATE sys_config SET config_value='false' WHERE config_key='sys.oss.previewListResource';
UPDATE sys_client SET timeout=43200,active_timeout=1800 WHERE client_key='pc';

INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon)
VALUES (1802000000000000001,'系统设置',0,90,'workspace-settings',NULL,'M','0','0',NULL,'system'),
       (1802000000000000002,'企业品牌',1802000000000000001,1,'brand','ai/branding/index','C','0','0','ai:brand:admin','edit');
-- Disable unrelated demo, generator, Snail AI and external-link navigation.
UPDATE sys_menu SET status='1' WHERE component LIKE 'demo/%' OR component LIKE 'workflow/%'
    OR component LIKE 'tool/gen/%' OR path LIKE '%snail%' OR path LIKE 'http%'
    OR menu_name IN ('测试菜单','AI会话','PLUS官网','代码生成','工作流');
