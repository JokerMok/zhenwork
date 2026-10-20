package org.dromara.ai.workspace;
import java.net.URI;
import java.util.Set;
/** Early structural validation. The gateway resolves and pins public DNS for every actual request. */
public final class WorkspaceProviderDestination {
    private WorkspaceProviderDestination(){}
    public static String validate(String type,String value){
        if(!Set.of("ARK","OPENAI","DEEPSEEK","CUSTOM_OPENAI").contains(type))throw new WorkspaceDenied(400,"UnsupportedProviderType");
        try{
            URI u=URI.create(value);String host=u.getHost();
            if(!"https".equals(u.getScheme())||host==null||!host.matches("[a-zA-Z0-9.-]+")||!host.contains(".")||u.getRawUserInfo()!=null||u.getRawQuery()!=null||u.getRawFragment()!=null||(u.getPort()!=-1&&u.getPort()!=443)||!u.getPath().matches("/[a-zA-Z0-9/_-]*"))throw new IllegalArgumentException();
            String normalized=value.replaceAll("/+$","");
            if(type.equals("ARK")&&!normalized.equals("https://ark.cn-beijing.volces.com/api/v3"))throw new IllegalArgumentException();
            if(type.equals("OPENAI")&&!normalized.equals("https://api.openai.com/v1"))throw new IllegalArgumentException();
            if(type.equals("DEEPSEEK")&&!normalized.equals("https://api.deepseek.com/v1"))throw new IllegalArgumentException();
            if(host.matches("[0-9.]+")||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal"))throw new IllegalArgumentException();
            for(var address:java.net.InetAddress.getAllByName(host)) {
                if(address.isAnyLocalAddress()||address.isLoopbackAddress()||address.isLinkLocalAddress()||address.isSiteLocalAddress()||address.isMulticastAddress())throw new IllegalArgumentException();
                byte[] raw=address.getAddress();
                if(raw.length==4){int a=raw[0]&255,b=raw[1]&255;if(a==0||a>=224||(a==100&&b>=64&&b<=127)||(a==198&&(b==18||b==19)))throw new IllegalArgumentException();}
            }
            return normalized;
        }catch(Exception e){throw new WorkspaceDenied(400,"InvalidPublicProviderEndpoint");}
    }
}
