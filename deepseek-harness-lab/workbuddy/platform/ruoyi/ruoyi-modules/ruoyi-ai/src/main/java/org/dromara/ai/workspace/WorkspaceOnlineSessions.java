package org.dromara.ai.workspace;

import cn.dev33.satoken.stp.StpUtil;
import lombok.RequiredArgsConstructor;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.dromara.common.core.domain.R;
import org.dromara.common.core.domain.PageResult;
import org.dromara.common.json.utils.JsonUtils;
import org.dromara.common.satoken.utils.LoginHelper;
import org.springframework.beans.BeanWrapperImpl;
import org.springframework.core.MethodParameter;
import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Online-user administration gets revocation handles, never reusable login credentials. */
@Aspect
@RestControllerAdvice
@RequiredArgsConstructor
public class WorkspaceOnlineSessions implements ResponseBodyAdvice<Object> {
    private record Handle(long actor,String token,long expires){}
    private final Map<String,Handle> handles=new ConcurrentHashMap<>();
    private final WorkspacePrincipal principals;
    private final JdbcTemplate jdbc;
    @Override public boolean supports(MethodParameter method,Class<? extends HttpMessageConverter<?>> converter){return method.getContainingClass().getName().equals("org.dromara.system.controller.monitor.SysUserOnlineController");}
    @Override public Object beforeBodyWrite(Object body,MethodParameter method,MediaType type,Class<? extends HttpMessageConverter<?>> converter,ServerHttpRequest request,ServerHttpResponse response){
        response.getHeaders().setCacheControl("no-store");if(!(body instanceof R<?> result)||!(result.getData() instanceof PageResult<?> page))return body;
        long actor=principals.current().userId(),now=System.currentTimeMillis();handles.entrySet().removeIf(e->e.getValue().expires()<now);List<Map<String,Object>> rows=new ArrayList<>();
        for(Object row:page.getRows()){
            var bean=new BeanWrapperImpl(row);String token=Objects.toString(bean.getPropertyValue("tokenId"),"");
            try{
                String id="sid_"+HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest((actor+":"+token).getBytes(StandardCharsets.UTF_8)));
                if(handles.size()>10000)throw new WorkspaceDenied(429,"TooManySessionHandles");handles.put(id,new Handle(actor,token,now+300000));
                Map<String,Object> copy=new LinkedHashMap<>(JsonUtils.parseMap(JsonUtils.toJsonString(row)));copy.put("tokenId",id);rows.add(copy);
            }catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException();}
        }
        return R.ok(PageResult.build(rows,page.getTotal()));
    }
    @Around("execution(* org.dromara.system.controller.monitor.SysUserOnlineController.forceLogout(..)) || execution(* org.dromara.system.controller.monitor.SysUserOnlineController.remove(..))")
    public Object revoke(ProceedingJoinPoint call){
        long actor=principals.current().userId();String id=Objects.toString(call.getArgs()[0]);Handle handle=handles.get(id);
        if(handle==null||handle.actor()!=actor||handle.expires()<System.currentTimeMillis())throw new WorkspaceDenied(409,"SessionHandleExpiredRefreshList");
        if(call.getSignature().getName().equals("forceLogout"))principals.require("monitor:online:forceLogout");
        else {var user=LoginHelper.getLoginUser(handle.token());if(user==null||user.getUserId()!=actor)throw new WorkspaceDenied(403,"PermissionDenied");}
        StpUtil.kickoutByTokenValue(handle.token());handles.remove(id);
        jdbc.update("INSERT INTO ai_security_event(id,actor_user_id,action,metadata) VALUES(?,?,'identity.session.revoked',?::jsonb)",UUID.randomUUID(),actor,JsonUtils.toJsonString(Map.of("handle",id)));
        return R.ok();
    }
}
