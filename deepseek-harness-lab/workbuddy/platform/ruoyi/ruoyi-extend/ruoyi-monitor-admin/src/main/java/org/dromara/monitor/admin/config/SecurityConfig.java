package org.dromara.monitor.admin.config;

import de.codecentric.boot.admin.server.config.AdminServerProperties;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.HeadersConfigurer;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.SavedRequestAwareAuthenticationSuccessHandler;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;

/**
 * admin 监控 安全配置
 *
 * @author Lion Li
 */
@EnableWebSecurity
@Configuration
public class SecurityConfig {

    private static final String TRUSTED_PROXY_HEADER = "X-ZhenWork-Monitor-Authorization";

    /**
     * 监控后台上下文路径。
     */
    private final String adminContextPath;

    /** Fixed-length digest of the proxy-only credential injected by Caddy. */
    private final byte[] trustedProxyTokenDigest;

    /** A blank deployment value must never authenticate. */
    private final boolean trustedProxyTokenConfigured;

    /**
     * 创建监控后台安全配置。
     *
     * @param adminServerProperties 监控后台配置
     */
    public SecurityConfig(
        AdminServerProperties adminServerProperties,
        @Value("${zhenwork.monitor.proxy-token:}") String trustedProxyToken
    ) {
        this.adminContextPath = adminServerProperties.getContextPath();
        this.trustedProxyTokenConfigured = !trustedProxyToken.isBlank();
        this.trustedProxyTokenDigest = sha256(trustedProxyToken);
    }

    /**
     * 配置监控后台的安全过滤链。
     *
     * @param httpSecurity Spring Security 配置对象
     * @return 安全过滤链
     * @throws Exception 构建过滤链异常
     */
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity httpSecurity) throws Exception {
        SavedRequestAwareAuthenticationSuccessHandler successHandler = new SavedRequestAwareAuthenticationSuccessHandler();
        successHandler.setTargetUrlParameter("redirectTo");
        successHandler.setDefaultTargetUrl(adminContextPath + "/");
        PathPatternRequestMatcher.Builder mvc = PathPatternRequestMatcher.withDefaults();
        return httpSecurity
            .headers((header) ->
                header.frameOptions(HeadersConfigurer.FrameOptionsConfig::sameOrigin))
            .authorizeHttpRequests((authorize) ->
                authorize.requestMatchers(
                        mvc.matcher(adminContextPath + "/assets/**"),
                        mvc.matcher(adminContextPath + "/login")
                    ).permitAll()
                    .anyRequest().authenticated())
            .formLogin((formLogin) ->
                formLogin.loginPage(adminContextPath + "/login").successHandler(successHandler))
            .logout((logout) ->
                logout.logoutUrl(adminContextPath + "/logout"))
            .httpBasic(Customizer.withDefaults())
            .csrf((csrf) -> csrf
                .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler())
                .ignoringRequestMatchers(
                    mvc.matcher(HttpMethod.POST, adminContextPath + "/instances"),
                    mvc.matcher(HttpMethod.DELETE, adminContextPath + "/instances/*")
                ))
            .addFilterBefore(trustedProxyAuthentication(), UsernamePasswordAuthenticationFilter.class)
            .addFilterAfter(csrfCookieFilter(), BasicAuthenticationFilter.class)
            .build();
    }

    /**
     * Accept the authenticated Admin session only after Caddy has completed the
     * RC2 forward-auth check. The monitor server is loopback-only; requiring a
     * loopback peer prevents an external client from asserting this header.
     */
    private OncePerRequestFilter trustedProxyAuthentication() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
                if (hasTrustedProxyToken(request) && isLoopback(request.getRemoteAddr())) {
                    var authentication = UsernamePasswordAuthenticationToken.authenticated(
                        "zhenwork-admin-session", null, List.of(new SimpleGrantedAuthority("ROLE_ADMIN")));
                    SecurityContextHolder.getContext().setAuthentication(authentication);
                }
                chain.doFilter(request, response);
            }
        };
    }

    private OncePerRequestFilter csrfCookieFilter() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
                CsrfToken token = (CsrfToken) request.getAttribute(CsrfToken.class.getName());
                if (token != null) {
                    token.getToken();
                }
                chain.doFilter(request, response);
            }
        };
    }

    private boolean hasTrustedProxyToken(HttpServletRequest request) {
        String supplied = request.getHeader(TRUSTED_PROXY_HEADER);
        return trustedProxyTokenConfigured
            && MessageDigest.isEqual(trustedProxyTokenDigest, sha256(supplied == null ? "" : supplied));
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private boolean isLoopback(String address) {
        try {
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (Exception ignored) {
            return false;
        }
    }

}
