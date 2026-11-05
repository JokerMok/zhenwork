package org.dromara.ai.workspace;

import org.dromara.common.json.utils.JsonUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@org.junit.jupiter.api.Tag("local")
class WorkspaceSkillImportsTest {
    private static final String COMMIT="a".repeat(40),ROOT="b".repeat(40),SKILLS="c".repeat(40),TREE="d".repeat(40);
    private static final String SOURCE="""
        ---
        name: github-receipt
        description: Produce a pinned receipt.
        version: 2.1.0
        license: MIT
        ---
        Produce a receipt from authorized inputs.
        """;
    private static final String SKILL_SHA=gitBlob(SOURCE),LICENSE_SHA=gitBlob("MIT License\n"),REQ_SHA=gitBlob("Pillow>=10\n");

    @BeforeAll static void json(){
        var context=new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(tools.jackson.databind.json.JsonMapper.class,()->tools.jackson.databind.json.JsonMapper.builder().build());
        context.refresh();new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }

    @Test void previewPinsCommitAndImportAndUpdateUseTrustedResourceEntrypoints(){
        WorkspaceResources resources=mock(WorkspaceResources.class);
        WorkspacePermissions permissions=mock(WorkspacePermissions.class);AiResourceGuard guard=mock(AiResourceGuard.class);
        when(guard.require(any(),anyLong(),eq(AiResourceGuard.Action.EDIT))).thenReturn(Map.of("resource_type","SKILL","latest_version",3));
        when(resources.createImportedSkill(anyLong(),anyString(),anyString(),anyMap(),anyMap(),any())).thenReturn(Map.of("id","created"));
        when(resources.editImportedSkill(any(),anyLong(),anyInt(),anyString(),anyString(),anyMap(),anyMap())).thenReturn(Map.of("id","updated"));
        WorkspaceSkillImports imports=new WorkspaceSkillImports(resources,permissions,guard,fixture(true));
        var preview=imports.preview(7,"acme/skills","main","skills/receipt");
        var origin=(Map<?,?>)preview.get("origin");
        assertEquals(COMMIT,origin.get("commit"));assertEquals("2.1.0",origin.get("version"));
        assertEquals("DECLARED_AND_FILE",((Map<?,?>)origin.get("license")).get("status"));
        assertEquals(64,origin.get("packageSha256").toString().length());
        assertEquals(List.of("requirements.txt"),preview.get("dependencyFiles"));
        UUID key=UUID.randomUUID();assertEquals("created",imports.create(7,"acme/skills",COMMIT,"skills/receipt","Receipt","",key).get("id"));
        UUID id=UUID.randomUUID();assertEquals("updated",imports.update(id,7,3,"acme/skills",COMMIT,"skills/receipt","Receipt","next").get("id"));
        verify(resources).createImportedSkill(eq(7L),eq("Receipt"),eq(""),anyMap(),argThat(o->COMMIT.equals(o.get("commit"))),eq(key));
        verify(resources).editImportedSkill(eq(id),eq(7L),eq(3),eq("Receipt"),eq("next"),anyMap(),argThat(o->COMMIT.equals(o.get("commit"))));
    }

    @Test void missingLicenseAndMutableCommitAreRejected(){
        var imports=new WorkspaceSkillImports(mock(WorkspaceResources.class),mock(WorkspacePermissions.class),mock(AiResourceGuard.class),fixture(false));
        assertEquals("SkillLicenseRequired",assertThrows(WorkspaceDenied.class,()->imports.preview(1,"acme/skills","main","skills/receipt")).getMessage());
        assertEquals("PinnedGitHubCommitRequired",assertThrows(WorkspaceDenied.class,()->imports.create(1,"acme/skills","main","skills/receipt","n","d",UUID.randomUUID())).getMessage());
    }

    @Test void authorizationAndCurrentVersionAreCheckedBeforeGitHub(){
        WorkspacePermissions denied=mock(WorkspacePermissions.class);doThrow(new WorkspaceDenied(403,"PermissionDenied")).when(denied).require(7,"ai:skill:create");
        int[] calls={0};WorkspaceSkillImports.GitHubTransport transport=path->{calls[0]++;return fixture(true).get(path);};
        var unauthorized=new WorkspaceSkillImports(mock(WorkspaceResources.class),denied,mock(AiResourceGuard.class),transport);
        assertThrows(WorkspaceDenied.class,()->unauthorized.preview(7,"acme/skills","main","skills/receipt"));assertEquals(0,calls[0]);
        AiResourceGuard guard=mock(AiResourceGuard.class);when(guard.require(any(),eq(8L),eq(AiResourceGuard.Action.EDIT))).thenReturn(Map.of("resource_type","SKILL","latest_version",4));
        var current=new WorkspaceSkillImports(mock(WorkspaceResources.class),mock(WorkspacePermissions.class),guard,transport);
        assertEquals("VersionConflict",assertThrows(WorkspaceDenied.class,()->current.update(UUID.randomUUID(),8,3,"acme/skills",COMMIT,"skills/receipt","n","d")).getMessage());assertEquals(0,calls[0]);
    }

    @Test void blobContentMustMatchItsGitObjectId(){
        var normal=fixture(true);WorkspaceSkillImports.GitHubTransport tampered=path->path.endsWith("/git/blobs/"+SKILL_SHA)
            ? new WorkspaceSkillImports.GitHubResponse(200,JsonUtils.toJsonString(blob(SKILL_SHA,SOURCE.replace("Produce","Xroduce"))).getBytes(StandardCharsets.UTF_8)) : normal.get(path);
        var imports=new WorkspaceSkillImports(mock(WorkspaceResources.class),mock(WorkspacePermissions.class),mock(AiResourceGuard.class),tampered);
        assertEquals("InvalidGitHubResponse",assertThrows(WorkspaceDenied.class,()->imports.preview(1,"acme/skills","main","skills/receipt")).getMessage());
    }

    private WorkspaceSkillImports.GitHubTransport fixture(boolean license){
        return path->{
            String source=license?SOURCE:SOURCE.replace("license: MIT\n","");String skillSha=gitBlob(source);
            Object body;
            if(path.endsWith("/commits/main")||path.endsWith("/commits/"+COMMIT))body=Map.of("sha",COMMIT,"commit",Map.of("tree",Map.of("sha",ROOT)));
            else if(path.endsWith("/git/trees/"+ROOT))body=Map.of("sha",ROOT,"truncated",false,"tree",List.of(Map.of("path","skills","type","tree","mode","040000","sha",SKILLS)));
            else if(path.endsWith("/git/trees/"+SKILLS))body=Map.of("sha",SKILLS,"truncated",false,"tree",List.of(Map.of("path","receipt","type","tree","mode","040000","sha",TREE)));
            else if(path.endsWith("/git/trees/"+TREE+"?recursive=1")){
                List<Map<String,Object>> entries=new ArrayList<>();entries.add(entry("SKILL.md",skillSha,source));entries.add(entry("requirements.txt",REQ_SHA,"Pillow>=10\n"));if(license)entries.add(entry("LICENSE",LICENSE_SHA,"MIT License\n"));body=Map.of("sha",TREE,"truncated",false,"tree",entries);
            }else if(path.endsWith("/git/blobs/"+skillSha))body=blob(skillSha,source);
            else if(path.endsWith("/git/blobs/"+REQ_SHA))body=blob(REQ_SHA,"Pillow>=10\n");
            else if(path.endsWith("/git/blobs/"+LICENSE_SHA))body=blob(LICENSE_SHA,"MIT License\n");
            else return new WorkspaceSkillImports.GitHubResponse(404,new byte[0]);
            return new WorkspaceSkillImports.GitHubResponse(200,JsonUtils.toJsonString(body).getBytes(StandardCharsets.UTF_8));
        };
    }
    private Map<String,Object> entry(String path,String sha,String content){return Map.of("path",path,"type","blob","mode","100644","sha",sha,"size",content.getBytes(StandardCharsets.UTF_8).length);}
    private Map<String,Object> blob(String sha,String content){byte[] bytes=content.getBytes(StandardCharsets.UTF_8);return Map.of("sha",sha,"encoding","base64","size",bytes.length,"content",Base64.getEncoder().encodeToString(bytes));}
    private static String gitBlob(String content){try{byte[] bytes=content.getBytes(StandardCharsets.UTF_8);var digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+bytes.length+'\0').getBytes(StandardCharsets.UTF_8));return HexFormat.of().formatHex(digest.digest(bytes));}catch(Exception e){throw new IllegalStateException(e);}}
}
