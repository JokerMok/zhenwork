package org.dromara.ai.workspace;

import org.dromara.common.json.utils.JsonUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;

/** Imports one complete Skill directory from an immutable GitHub commit. */
@Service
public class WorkspaceSkillImports {
    private static final String API = "https://api.github.com";
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
    private static final int MAX_LICENSE_BYTES = 256 * 1024;
    private static final Set<String> DEPENDENCY_FILES = Set.of(
        "requirements.txt", "requirements.lock", "pyproject.toml", "uv.lock",
        "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock");
    private final WorkspaceResources resources;
    private final WorkspacePermissions permissions;
    private final AiResourceGuard guard;
    private final GitHubTransport transport;

    record GitHubResponse(int status, byte[] body) {}
    interface GitHubTransport { GitHubResponse get(String path); }

    @Autowired
    public WorkspaceSkillImports(WorkspaceResources resources,WorkspacePermissions permissions,AiResourceGuard guard,@Value("${ai.github.token:}") String token) {
        this(resources,permissions,guard,httpTransport(token));
    }
    WorkspaceSkillImports(WorkspaceResources resources,WorkspacePermissions permissions,AiResourceGuard guard,GitHubTransport transport) {
        this.resources=resources;this.permissions=permissions;this.guard=guard;this.transport=transport;
    }

    public Map<String,Object> preview(long actor,String repository,String ref,String path) {
        requireCreate(actor);
        Loaded loaded=load(repository,resolve(repository,ref),path);
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("name",((Map<?,?>)loaded.parsed().get("manifest")).get("name"));
        result.put("description",((Map<?,?>)loaded.parsed().get("manifest")).get("description"));
        result.put("manifest",loaded.parsed().get("manifest"));
        result.put("origin",loaded.origin());
        result.put("files",fileSummary((List<Map<String,Object>>)loaded.parsed().get("files")));
        result.put("dependencyFiles",((List<Map<String,Object>>)loaded.parsed().get("files")).stream()
            .map(f->f.get("path").toString()).filter(DEPENDENCY_FILES::contains).toList());
        return Collections.unmodifiableMap(result);
    }

    public Map<String,Object> create(long actor,String repository,String commit,String path,String name,String description,UUID key) {
        requireCreate(actor);
        Loaded loaded=load(repository,pinned(commit),path);
        return resources.createImportedSkill(actor,name,description,loaded.data(),loaded.origin(),key);
    }

    public Map<String,Object> update(UUID id,long actor,int expected,String repository,String commit,String path,String name,String description) {
        var resource=guard.require(id,actor,AiResourceGuard.Action.EDIT);
        if(!"SKILL".equals(resource.get("resource_type")))throw new WorkspaceDenied(400,"SkillResourceRequired");
        if(((Number)resource.get("latest_version")).intValue()!=expected)throw new WorkspaceDenied(409,"VersionConflict");
        Loaded loaded=load(repository,pinned(commit),path);
        return resources.editImportedSkill(id,actor,expected,name,description,loaded.data(),loaded.origin());
    }

    private Loaded load(String repository,String commit,String skillPath) {
        Repository repo=repository(repository);String path=skillPath(skillPath);
        Map<String,Object> commitBody=json(get("/repos/"+segment(repo.owner())+"/"+segment(repo.name())+"/commits/"+commit));
        String returned=hex(commitBody.get("sha"));
        if(!commit.equals(returned))throw new WorkspaceDenied(409,"GitHubCommitChanged");
        Object rawCommit=commitBody.get("commit");
        if(!(rawCommit instanceof Map<?,?> c)||!(c.get("tree") instanceof Map<?,?> t))throw new WorkspaceDenied(502,"InvalidGitHubResponse");
        String tree=hex(t.get("sha"));
        for(String part:path.split("/"))tree=childTree(repo,tree,part);
        Map<String,Object> treeBody=json(get("/repos/"+segment(repo.owner())+"/"+segment(repo.name())+"/git/trees/"+tree+"?recursive=1"));
        if(!tree.equals(hex(treeBody.get("sha"))))throw new WorkspaceDenied(502,"InvalidGitHubResponse");
        if(Boolean.TRUE.equals(treeBody.get("truncated")))throw new WorkspaceDenied(409,"GitHubTreeTruncated");
        if(!(treeBody.get("tree") instanceof List<?> entries)||entries.size()>201)throw new WorkspaceDenied(400,"InvalidSkillPackage");
        String source=null,skillBlob=null;List<Map<String,Object>> files=new ArrayList<>();
        for(Object raw:entries) {
            if(!(raw instanceof Map<?,?> entry))throw new WorkspaceDenied(502,"InvalidGitHubResponse");
            String type=Objects.toString(entry.get("type"),"");
            if("tree".equals(type))continue;
            if(!"blob".equals(type))throw new WorkspaceDenied(400,"UnsupportedGitHubEntry");
            String relative=Objects.toString(entry.get("path"),"");
            String mode=Objects.toString(entry.get("mode"),"");
            if(!Set.of("100644","100755").contains(mode))throw new WorkspaceDenied(400,"UnsupportedGitHubEntry");
            byte[] bytes=blob(repo,hex(entry.get("sha")),entry.get("size"));
            if("SKILL.md".equals(relative)) {
                if(source!=null)throw new WorkspaceDenied(400,"InvalidSkillPackage");
                source=utf8(bytes,"InvalidSkillMarkdown");skillBlob=hex(entry.get("sha"));continue;
            }
            String text=tryUtf8(bytes);boolean executable="100755".equals(mode);
            Map<String,Object> file=new LinkedHashMap<>();file.put("path",relative);
            if(text!=null){file.put("content",text);file.put("encoding","utf8");}
            else{file.put("content",Base64.getEncoder().encodeToString(bytes));file.put("encoding","base64");}
            file.put("executable",executable);file.put("sha256",WorkspaceSkillPackage.sha256(bytes));files.add(file);
        }
        if(source==null)throw new WorkspaceDenied(400,"SkillMarkdownRequired");
        Map<String,Object> data=Map.of("source",source,"files",files);
        Map<String,Object> parsed=WorkspaceSkills.parse(data);
        Map<String,Object> license=license((Map<String,Object>)parsed.get("manifest"),(List<Map<String,Object>>)parsed.get("files"));
        Map<String,Object> origin=new LinkedHashMap<>();origin.put("provider","GITHUB");origin.put("repository",repo.owner()+"/"+repo.name());origin.put("commit",commit);origin.put("tree",tree);origin.put("path",path);origin.put("skillBlob",skillBlob);origin.put("version",((Map<?,?>)parsed.get("manifest")).get("version"));origin.put("license",license);origin.put("packageSha256",parsed.get("packageSha256"));
        return new Loaded(data,parsed,Collections.unmodifiableMap(origin));
    }

    private String childTree(Repository repo,String tree,String part) {
        Map<String,Object> body=json(get("/repos/"+segment(repo.owner())+"/"+segment(repo.name())+"/git/trees/"+tree));
        if(!tree.equals(hex(body.get("sha"))))throw new WorkspaceDenied(502,"InvalidGitHubResponse");
        if(Boolean.TRUE.equals(body.get("truncated"))||!(body.get("tree") instanceof List<?> entries))throw new WorkspaceDenied(409,"GitHubTreeTruncated");
        for(Object raw:entries)if(raw instanceof Map<?,?> entry&&"tree".equals(entry.get("type"))&&part.equals(entry.get("path")))return hex(entry.get("sha"));
        throw new WorkspaceDenied(404,"GitHubPathNotFound");
    }

    private byte[] blob(Repository repo,String sha,Object expectedSize) {
        Map<String,Object> body=json(get("/repos/"+segment(repo.owner())+"/"+segment(repo.name())+"/git/blobs/"+sha));
        if(!sha.equals(hex(body.get("sha")))||!"base64".equals(body.get("encoding"))||!(body.get("content") instanceof String content))throw new WorkspaceDenied(502,"InvalidGitHubResponse");
        byte[] bytes;try{bytes=Base64.getMimeDecoder().decode(content);}catch(IllegalArgumentException e){throw new WorkspaceDenied(502,"InvalidGitHubResponse");}
        if(expectedSize instanceof Number size&&size.longValue()!=bytes.length || !sha.equals(gitBlobSha(bytes)))throw new WorkspaceDenied(502,"InvalidGitHubResponse");
        return bytes;
    }

    private void requireCreate(long actor){permissions.require(actor,"ai:skill:create");permissions.require(actor,"ai:resource:enterprise");}
    private String gitBlobSha(byte[] bytes){try{var digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+bytes.length+'\0').getBytes(StandardCharsets.UTF_8));return HexFormat.of().formatHex(digest.digest(bytes));}catch(Exception e){throw new IllegalStateException(e);}}

    private Map<String,Object> license(Map<String,Object> manifest,List<Map<String,Object>> files) {
        String declared=Objects.toString(manifest.get("license"),"");
        var file=files.stream().filter(f->Set.of("LICENSE","LICENSE.md").contains(f.get("path"))).findFirst();
        if(declared.isBlank()&&file.isEmpty())throw new WorkspaceDenied(400,"SkillLicenseRequired");
        Map<String,Object> result=new LinkedHashMap<>();if(!declared.isBlank())result.put("declared",declared);
        if(file.isPresent()) {
            var value=file.get();if(!"utf8".equals(value.get("encoding"))||value.get("content").toString().getBytes(StandardCharsets.UTF_8).length>MAX_LICENSE_BYTES)throw new WorkspaceDenied(400,"InvalidSkillLicense");
            result.put("path",value.get("path"));result.put("sha256",value.get("sha256"));
        }
        result.put("status",file.isPresent()?(declared.isBlank()?"FILE_ONLY":"DECLARED_AND_FILE"):"DECLARED_ONLY");
        return Collections.unmodifiableMap(result);
    }

    private List<Map<String,Object>> fileSummary(List<Map<String,Object>> files) {
        return files.stream().map(file->{Map<String,Object> item=new LinkedHashMap<>();item.put("path",file.get("path"));item.put("sha256",file.get("sha256"));item.put("encoding",file.get("encoding"));item.put("executable",file.get("executable"));item.put("size",decoded(file).length);return Collections.unmodifiableMap(item);}).toList();
    }
    private byte[] decoded(Map<String,Object> file){return "base64".equals(file.get("encoding"))?Base64.getDecoder().decode(file.get("content").toString()):file.get("content").toString().getBytes(StandardCharsets.UTF_8);}

    private String resolve(String repository,String ref){repository(repository);if(ref==null||ref.isBlank()||ref.length()>200||ref.codePoints().anyMatch(Character::isISOControl))throw new WorkspaceDenied(400,"InvalidGitHubRef");Repository repo=repository(repository);Map<String,Object> body=json(get("/repos/"+segment(repo.owner())+"/"+segment(repo.name())+"/commits/"+refPath(ref)));return hex(body.get("sha"));}
    private String pinned(String value){if(value==null||!value.matches("[0-9a-f]{40}"))throw new WorkspaceDenied(400,"PinnedGitHubCommitRequired");return value;}
    private Repository repository(String value){if(value==null||!value.matches("[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}"))throw new WorkspaceDenied(400,"InvalidGitHubRepository");String[] parts=value.split("/",2);if(Set.of(".","..").contains(parts[0])||Set.of(".","..").contains(parts[1]))throw new WorkspaceDenied(400,"InvalidGitHubRepository");return new Repository(parts[0],parts[1]);}
    private String skillPath(String value){if(value==null||value.isBlank()||value.length()>400||value.startsWith("/")||value.endsWith("/")||value.indexOf('\\')>=0||value.codePoints().anyMatch(Character::isISOControl)||Arrays.stream(value.split("/",-1)).anyMatch(p->p.isBlank()||Set.of(".","..").contains(p)||!p.matches("[A-Za-z0-9._-]+")))throw new WorkspaceDenied(400,"InvalidGitHubPath");return value;}
    private String hex(Object value){String text=Objects.toString(value,"");if(!text.matches("[0-9a-f]{40}"))throw new WorkspaceDenied(502,"InvalidGitHubResponse");return text;}
    private String segment(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20");}
    private String refPath(String value){return Arrays.stream(value.split("/",-1)).map(this::segment).reduce((a,b)->a+"/"+b).orElseThrow();}
    private Map<String,Object> json(byte[] bytes){try{Map<String,Object> result=JsonUtils.parseMap(new String(bytes,StandardCharsets.UTF_8));if(result==null)throw new IllegalArgumentException();return result;}catch(Exception e){throw new WorkspaceDenied(502,"InvalidGitHubResponse");}}
    private byte[] get(String path){GitHubResponse response=transport.get(path);if(response.body()==null||response.body().length>MAX_RESPONSE_BYTES)throw new WorkspaceDenied(502,"InvalidGitHubResponse");if(response.status()>=200&&response.status()<300)return response.body();if(response.status()==401||response.status()==403)throw new WorkspaceDenied(502,"GitHubAuthorizationFailed");if(response.status()==404)throw new WorkspaceDenied(404,"GitHubNotFound");if(response.status()==429)throw new WorkspaceDenied(503,"GitHubRateLimited");throw new WorkspaceDenied(502,"GitHubRequestFailed");}
    private String utf8(byte[] bytes,String code){String value=tryUtf8(bytes);if(value==null)throw new WorkspaceDenied(400,code);return value;}
    private String tryUtf8(byte[] bytes){try{return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();}catch(CharacterCodingException e){return null;}}

    private static GitHubTransport httpTransport(String token){
        HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
        return path->{try{HttpRequest.Builder request=HttpRequest.newBuilder(URI.create(API+path)).timeout(Duration.ofSeconds(15)).header("Accept","application/vnd.github+json").header("X-GitHub-Api-Version","2022-11-28").header("User-Agent","ZhenWork-Skill-Import");if(token!=null&&!token.isBlank())request.header("Authorization","Bearer "+token);var response=client.send(request.GET().build(),HttpResponse.BodyHandlers.ofInputStream());try(var input=response.body()){byte[] body=input.readNBytes(MAX_RESPONSE_BYTES+1);if(body.length>MAX_RESPONSE_BYTES)throw new WorkspaceDenied(502,"InvalidGitHubResponse");return new GitHubResponse(response.statusCode(),body);}}catch(WorkspaceDenied denied){throw denied;}catch(Exception e){throw new WorkspaceDenied(502,"GitHubRequestFailed");}};
    }

    private record Repository(String owner,String name){}
    private record Loaded(Map<String,Object> data,Map<String,Object> parsed,Map<String,Object> origin){}
}
