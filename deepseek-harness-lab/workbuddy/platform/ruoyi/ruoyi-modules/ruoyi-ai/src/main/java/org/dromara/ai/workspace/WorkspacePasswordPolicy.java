package org.dromara.ai.workspace;

import lombok.RequiredArgsConstructor;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.dromara.common.core.domain.R;
import org.dromara.common.json.utils.JsonUtils;
import org.dromara.common.satoken.utils.LoginHelper;
import org.springframework.beans.BeanWrapperImpl;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;

/** Password guard around native APIs keeps upstream DTOs unchanged. */
@Aspect
@Component
@RequiredArgsConstructor
public class WorkspacePasswordPolicy {
    private final JdbcTemplate jdbc;
    @Around("execution(* org.dromara.web.controller.AuthController.login(..)) || "
        + "execution(* org.dromara.system.controller.system.SysUserController.add(..)) || "
        + "execution(* org.dromara.system.controller.system.SysUserController.edit(..)) || "
        + "execution(* org.dromara.system.controller.system.SysUserController.resetPwd(..)) || "
        + "execution(* org.dromara.system.controller.system.SysProfileController.updatePwd(..))")
    public Object password(ProceedingJoinPoint call) throws Throwable {
        String operation=call.getSignature().getName();
        Object argument=call.getArgs()[0];
        BeanWrapperImpl bean=null;
        String password;
        if(operation.equals("login")) password=JsonUtils.parseMap((String)argument).getStr("password");
        else {bean=new BeanWrapperImpl(argument);password=(String)bean.getPropertyValue(operation.equals("updatePwd")?"newPassword":"password");}
        if(!operation.equals("edit") || password!=null && !password.isEmpty()) {
            if(password==null || password.length()<12 || password.length()>30 || password.getBytes(StandardCharsets.UTF_8).length>72)
                throw new WorkspaceDenied(400,"PasswordMustBe12To30CharactersAndAtMost72Bytes");
        }
        Long current=operation.equals("updatePwd")?LoginHelper.getUserId():null;
        Object response=call.proceed();
        if(response instanceof R<?> result && result.getCode()==200) {
            if(operation.equals("updatePwd"))jdbc.update("UPDATE ai_principal_state SET must_change_password=FALSE WHERE user_id=?",current);
            else if(operation.equals("resetPwd"))jdbc.update("UPDATE ai_principal_state SET must_change_password=TRUE WHERE user_id=?",bean.getPropertyValue("userId"));
        }
        return response;
    }
}
