package org.dromara.ai.workspace;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.Set;

@Configuration
public class WorkspaceWebSecurity implements WebMvcConfigurer {
    private final WorkspacePrincipal principals;
    private final String origin;
    private final org.dromara.ai.workspace.runtime.ExecutionCredentials execution;
    public WorkspaceWebSecurity(WorkspacePrincipal principals,org.dromara.ai.workspace.runtime.ExecutionCredentials execution,@Value("${workspace.public-origin}") String origin) {
        this.principals=principals;this.origin=origin;this.execution=execution;
    }
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request,HttpServletResponse response,Object handler) {
                String uri=request.getRequestURI();
                if(uri.startsWith("/internal/rc2/background/")){
                    execution.checkBackgroundService(request.getHeader("Authorization"));
                    return true;
                }
                if(uri.startsWith("/internal/rc2/")){
                    execution.checkService(request.getHeader("Authorization"));
                    return true;
                }
                if(!Set.of("GET","HEAD","OPTIONS").contains(request.getMethod()) && !origin.equals(request.getHeader("Origin")))
                    throw new WorkspaceDenied(403,"OriginDenied");
                if(uri.equals("/auth/login") || uri.equals("/auth/logout") || uri.equals("/auth/code")
                    || uri.equals("/ai/brand") && request.getMethod().equals("GET") || uri.equals("/ai/bootstrap") || uri.matches("/ai/brand/assets/[a-f0-9-]{36}") && Set.of("GET","HEAD").contains(request.getMethod())) return true;
                if(handler instanceof org.springframework.web.method.HandlerMethod) {
                    var actor=principals.current();
                    if(actor.mustChangePassword() && !Set.of("/ai/me","/system/user/getInfo","/system/user/profile","/system/user/profile/updatePwd","/system/menu/getRouters").contains(uri))
                        throw new WorkspaceDenied(403,"PasswordChangeRequired");
                }
                return true;
            }
        }).addPathPatterns("/**").excludePathPatterns("/error","/actuator/**","/static/**").order(-20);
    }
}
