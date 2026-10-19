package org.dromara.ai.workspace;

import cn.dev33.satoken.stp.StpUtil;
import lombok.RequiredArgsConstructor;
import org.dromara.common.core.domain.R;
import org.springframework.beans.BeanWrapperImpl;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

import java.util.Map;

/** Keep native authentication and replace browser-readable bearer storage with an HttpOnly cookie. */
@RestControllerAdvice
@RequiredArgsConstructor
public class WorkspaceAuthResponse implements ResponseBodyAdvice<Object> {
    private final WorkspacePrincipal principals;
    @Override
    public boolean supports(MethodParameter method,Class<? extends HttpMessageConverter<?>> converter) {
        return method.getContainingClass().getName().equals("org.dromara.web.controller.AuthController")
            && method.getMethod()!=null && (method.getMethod().getName().equals("login") || method.getMethod().getName().equals("logout"));
    }
    @Override
    public Object beforeBodyWrite(Object body,MethodParameter method,MediaType type,
        Class<? extends HttpMessageConverter<?>> converter,ServerHttpRequest request,ServerHttpResponse response) {
        if(!(body instanceof R<?> result) || result.getCode()!=200)return body;
        boolean login=method.getMethod().getName().equals("login");
        response.getHeaders().set(HttpHeaders.CACHE_CONTROL,"no-store");
        if(!login){response.getHeaders().set(HttpHeaders.SET_COOKIE,cookie("",0));return body;}
        var actor=principals.bindLogin();
        var value=new BeanWrapperImpl(result.getData());
        response.getHeaders().set(HttpHeaders.SET_COOKIE,cookie(StpUtil.getTokenValue(),43200));
        // The marker is deliberately not a credential; native Vue guards only need login state.
        return R.ok(Map.of("access_token","cookie-session","expire_in",43200,"client_id",value.getPropertyValue("clientId"),
            "mustChangePassword",actor.mustChangePassword()));
    }
    private String cookie(String value,long seconds) {
        return ResponseCookie.from("__Host-workspace-rc2",value).httpOnly(true).secure(true)
            .sameSite("Strict").path("/").maxAge(seconds).build().toString();
    }
}
