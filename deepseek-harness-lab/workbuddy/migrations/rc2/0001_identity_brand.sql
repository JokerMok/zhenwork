CREATE TABLE ai_principal_state (
    user_id BIGINT PRIMARY KEY REFERENCES sys_user(user_id),
    auth_version BIGINT NOT NULL DEFAULT 1,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO ai_principal_state(user_id) SELECT user_id FROM sys_user;

CREATE FUNCTION workspace_user_auth_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO ai_principal_state(user_id) VALUES(NEW.user_id);
    ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.del_flag IS DISTINCT FROM OLD.del_flag
       OR NEW.password IS DISTINCT FROM OLD.password OR NEW.dept_id IS DISTINCT FROM OLD.dept_id THEN
        UPDATE ai_principal_state SET auth_version=auth_version+1 WHERE user_id=NEW.user_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_user_auth_version AFTER INSERT OR UPDATE ON sys_user
    FOR EACH ROW EXECUTE FUNCTION workspace_user_auth_changed();

CREATE FUNCTION workspace_user_role_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('DELETE','UPDATE') THEN
        UPDATE ai_principal_state SET auth_version=auth_version+1 WHERE user_id=OLD.user_id;
    END IF;
    IF TG_OP IN ('INSERT','UPDATE') THEN
        UPDATE ai_principal_state SET auth_version=auth_version+1 WHERE user_id=NEW.user_id;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER workspace_user_role_version AFTER INSERT OR UPDATE OR DELETE ON sys_user_role
    FOR EACH ROW EXECUTE FUNCTION workspace_user_role_changed();

-- Native role/menu changes invalidate existing authorization snapshots. This is
-- an invalidation overlay; the native RuoYi role/menu tables remain authoritative.
CREATE FUNCTION workspace_role_policy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ai_principal_state SET auth_version=auth_version+1;
    RETURN NULL;
END $$;
CREATE TRIGGER workspace_role_policy_version AFTER UPDATE OR DELETE ON sys_role
    FOR EACH STATEMENT EXECUTE FUNCTION workspace_role_policy_changed();
CREATE TRIGGER workspace_role_menu_version AFTER INSERT OR UPDATE OR DELETE ON sys_role_menu
    FOR EACH STATEMENT EXECUTE FUNCTION workspace_role_policy_changed();
CREATE TRIGGER workspace_menu_policy_version AFTER UPDATE OR DELETE ON sys_menu
    FOR EACH STATEMENT EXECUTE FUNCTION workspace_role_policy_changed();

CREATE TABLE ai_brand (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    config JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_by BIGINT REFERENCES sys_user(user_id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ai_brand(config) VALUES ('{"productName":"Enterprise AI Workspace","companyName":"企业工作台","loginTitle":"登录工作台","loginSubtitle":"使用企业账号继续","primaryColor":"#2563eb","logoAssetId":null,"faviconAssetId":null,"supportText":"","copyright":""}');
