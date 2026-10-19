package org.dromara.ai.workspace;

import jakarta.annotation.PreDestroy;
import org.dromara.common.json.utils.JsonUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.*;
import org.springframework.web.socket.*;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import java.util.*;
import java.util.concurrent.*;

/** Replay and live delivery use the same durable cursor; polling leaves no subscribe/replay gap. */
@Configuration
@EnableWebSocket
public class WorkspaceWebSocket implements WebSocketConfigurer {
    private final WorkspacePrincipal principals;
    private final WorkspaceConversations conversations;
    private final WorkspaceEvents events;
    private final WorkspaceModelAccess access;
    private final String origin;
    private final Map<String,WebSocketSession> sockets=new ConcurrentHashMap<>();
    private final ScheduledExecutorService pump=Executors.newSingleThreadScheduledExecutor();
    public WorkspaceWebSocket(WorkspacePrincipal principals,WorkspaceConversations conversations,WorkspaceEvents events,WorkspaceModelAccess access,@Value("${workspace.public-origin}") String origin){
        this.principals=principals;this.conversations=conversations;this.events=events;this.access=access;this.origin=origin;
        pump.scheduleWithFixedDelay(this::deliver,100,100,TimeUnit.MILLISECONDS);
    }
    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry){
        registry.addHandler(new TextWebSocketHandler(){
            @Override public void afterConnectionEstablished(WebSocketSession session){session.setTextMessageSizeLimit(4096);sockets.put(session.getId(),new org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator(session,5000,1024*1024));}
            @Override protected void handleTextMessage(WebSocketSession session,TextMessage message)throws Exception{session.close(CloseStatus.POLICY_VIOLATION);}
            @Override public void afterConnectionClosed(WebSocketSession session,CloseStatus status){sockets.remove(session.getId());}
        },"/ws").setAllowedOrigins(origin).addInterceptors(new HandshakeInterceptor(){
            public boolean beforeHandshake(ServerHttpRequest request,ServerHttpResponse response,WebSocketHandler handler,Map<String,Object> attributes){
                try{
                    if(!origin.equals(request.getHeaders().getOrigin()))throw new WorkspaceDenied(403,"OriginDenied");
                    var query=UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams();
                    if(query.get("sessionId")==null||query.get("sessionId").size()!=1||query.containsKey("token")||query.containsKey("Authorization")||query.containsKey("__Host-workspace-rc2"))throw new WorkspaceDenied(403,"InvalidSocketRequest");
                    UUID id=UUID.fromString(query.getFirst("sessionId"));long sequence=Long.parseLong(Optional.ofNullable(query.getFirst("lastEventSequence")).orElse("0"));if(sequence<0)throw new IllegalArgumentException();
                    if(!(request instanceof ServletServerHttpRequest servlet))throw new IllegalArgumentException();
                    String token=null;var cookies=servlet.getServletRequest().getCookies();if(cookies!=null)for(var cookie:cookies)if(cookie.getName().equals("__Host-workspace-rc2"))token=cookie.getValue();
                    var actor=principals.fromToken(token);access.checkIdentity(actor.userId(),actor.authVersion());var owned=conversations.authorizeSession(id,actor);access.model(actor.userId(),(UUID)owned.get("model_id"));
                    if(sequence>((Number)owned.get("next_sequence")).longValue())throw new IllegalArgumentException();
                    long count=sockets.values().stream().filter(s->Long.valueOf(actor.userId()).equals(s.getAttributes().get("owner"))).count();if(count>=5)throw new IllegalArgumentException();
                    attributes.put("token",token);attributes.put("owner",actor.userId());attributes.put("session",id);attributes.put("sequence",sequence);return true;
                }catch(Exception e){response.setStatusCode(HttpStatus.FORBIDDEN);return false;}
            }
            public void afterHandshake(ServerHttpRequest request,ServerHttpResponse response,WebSocketHandler handler,Exception exception){}
        });
    }
    private void deliver(){
        for(var socket:sockets.values())try{
            if(!socket.isOpen()){sockets.remove(socket.getId());continue;}
            var attributes=socket.getAttributes();var actor=principals.fromToken((String)attributes.get("token"));UUID session=(UUID)attributes.get("session");access.checkIdentity(actor.userId(),actor.authVersion());var owned=conversations.authorizeSession(session,actor);access.model(actor.userId(),(UUID)owned.get("model_id"));
            for(var event:events.after(session,(Long)attributes.get("sequence"),100)){
                socket.sendMessage(new TextMessage(JsonUtils.toJsonString(event)));attributes.put("sequence",Long.parseLong(event.get("sequence").toString()));
            }
        }catch(Exception e){try{socket.close(CloseStatus.POLICY_VIOLATION);}catch(Exception ignored){}sockets.remove(socket.getId());}
    }
    @PreDestroy public void close(){pump.shutdownNow();for(var socket:sockets.values())try{socket.close(CloseStatus.GOING_AWAY);}catch(Exception ignored){}}
}
