package org.dromara.ai.workspace;

import cn.dev33.satoken.stp.StpUtil;
import lombok.RequiredArgsConstructor;
import org.dromara.common.satoken.utils.LoginHelper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Native RuoYi identity plus a persistent revocation version, never a second RBAC. */
@Service
@RequiredArgsConstructor
public class WorkspacePrincipal {
    private final JdbcTemplate jdbc;
    public record Actor(long userId, long authVersion, boolean mustChangePassword) {}

    private Actor load(long id) {
        var rows = jdbc.query("SELECT s.auth_version,s.must_change_password FROM ai_principal_state s JOIN sys_user u ON u.user_id=s.user_id WHERE s.user_id=? AND u.status='0' AND u.del_flag='0'",
            (r,n) -> new Actor(id,r.getLong(1),r.getBoolean(2)), id);
        if (rows.size()!=1) throw new WorkspaceDenied(401,"SessionRevoked");
        return rows.getFirst();
    }

    /** Recheck a delegated background job after its browser session has ended. */
    public void requireActiveVersion(long userId, long authVersion) {
        Actor actor = load(userId);
        if (actor.mustChangePassword() || actor.authVersion() != authVersion)
            throw new WorkspaceDenied(401, "BackgroundAuthorizationRevoked");
    }

    public Actor bindLogin() {
        StpUtil.checkLogin();
        Actor actor=load(LoginHelper.getUserId());
        StpUtil.getTokenSession().set("workspaceAuthVersion",actor.authVersion());
        return actor;
    }

    public Actor current() {
        StpUtil.checkLogin();
        Actor actor=load(LoginHelper.getUserId());
        Object snapshot=StpUtil.getTokenSession().get("workspaceAuthVersion");
        if(snapshot==null || !Long.toString(actor.authVersion()).equals(snapshot.toString()))
            throw new WorkspaceDenied(401,"SessionRevoked");
        return actor;
    }

    public Actor fromToken(String token) {
        if(token==null || StpUtil.getLoginIdByToken(token)==null)throw new WorkspaceDenied(401,"SessionRevoked");
        var user=LoginHelper.getLoginUser(token);
        if(user==null)throw new WorkspaceDenied(401,"SessionRevoked");
        Actor actor=load(user.getUserId());
        Object snapshot=StpUtil.getTokenSessionByToken(token).get("workspaceAuthVersion");
        if(snapshot==null || !Long.toString(actor.authVersion()).equals(snapshot.toString()) || actor.mustChangePassword())throw new WorkspaceDenied(401,"SessionRevoked");
        return actor;
    }

    public Actor require(String permission) {
        Actor actor=current();
        if(actor.mustChangePassword())throw new WorkspaceDenied(403,"PasswordChangeRequired");
        StpUtil.checkPermission(permission);
        return actor;
    }
}
