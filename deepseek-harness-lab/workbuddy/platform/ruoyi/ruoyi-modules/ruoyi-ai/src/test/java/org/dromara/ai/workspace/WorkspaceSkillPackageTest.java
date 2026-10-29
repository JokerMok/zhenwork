package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

@org.junit.jupiter.api.Tag("local")
class WorkspaceSkillPackageTest {
    @org.junit.jupiter.api.BeforeAll
    static void configureJsonMapper() {
        var context = new org.springframework.context.support.GenericApplicationContext();
        context.registerBean(tools.jackson.databind.json.JsonMapper.class,
            () -> tools.jackson.databind.json.JsonMapper.builder().build());
        context.refresh();
        new cn.hutool.extra.spring.SpringUtil().postProcessBeanFactory(context.getBeanFactory());
    }

    private static final String SOURCE = """
        ---
        name: office-report
        description: Create a report from workspace files.
        version: 1.2.0
        ---
        Read the references and run the packaged script when needed.
        """;

    @Test
    void completePackageIsNormalizedIntoTheVersionedSkillConfiguration() {
        var config = WorkspaceSkills.parse(Map.of("source", SOURCE, "files", List.of(
            Map.of("path", "templates/report.md", "content", "# Report\n"),
            Map.of("path", "assets/报销模板.xlsx", "content", "UEsDBA==", "encoding", "base64"),
            Map.of("path", "scripts/build.sh", "content", "#!/bin/sh\n", "executable", true),
            Map.of("path", "references/policy.md", "content", "Use current policy.\n")
        )));
        assertEquals("SKILL_PACKAGE_V1", config.get("format"));
        var files = (List<?>) config.get("files");
        assertEquals(4, files.size());
        assertEquals("assets/报销模板.xlsx", ((Map<?,?>) files.getFirst()).get("path"));
        assertEquals("base64", ((Map<?,?>) files.getFirst()).get("encoding"));
        assertEquals(64, ((Map<?,?>) files.getFirst()).get("sha256").toString().length());
    }

    @Test
    void packageRejectsTraversalAndExecutableTemplates() {
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkills.parse(Map.of("source", SOURCE,
            "files", List.of(Map.of("path", "scripts/../secret", "content", "x")))));
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkills.parse(Map.of("source", SOURCE,
            "files", List.of(Map.of("path", "templates/report.md", "content", "x", "executable", true)))));
    }
    private static List<Map<String,Object>> presentation(String extraPath, String extraContent) throws Exception {
        var output = new java.io.ByteArrayOutputStream();
        try (var zip = new java.util.zip.ZipOutputStream(output)) {
            var parts = new LinkedHashMap<String,String>();
            parts.put("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
            parts.put("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/></p:presentation>");
            if (extraPath != null) parts.put(extraPath, extraContent);
            for (var part : parts.entrySet()) {
                zip.putNextEntry(new java.util.zip.ZipEntry(part.getKey()));
                zip.write(part.getValue().getBytes(java.nio.charset.StandardCharsets.UTF_8)); zip.closeEntry();
            }
        }
        return List.of(Map.of("path", "references/presentation.json", "content", "{\"name\":\"QA\",\"version\":\"1.0.0\",\"templatePath\":\"templates/qa.pptx\"}"),
            Map.of("path", "templates/qa.pptx", "content", Base64.getEncoder().encodeToString(output.toByteArray()), "encoding", "base64"));
    }

    @Test
    void presentationTemplateIsValidatedAtSaveTime() throws Exception {
        assertEquals(2, WorkspaceSkillPackage.files(presentation(null, null)).size());
        assertEquals(2, WorkspaceSkillPackage.files(presentation("ppt/printerSettings/printerSettings1.bin", "passive-printer-settings")).size());
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkillPackage.files(presentation("ppt/vbaProject.bin", "macro")));
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkillPackage.files(presentation("ppt/_rels/presentation.xml.rels",
            "<Relationships><Relationship TargetMode=\"External\" Target=\"https://invalid.example/font\"/></Relationships>")));
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkillPackage.files(presentation("evil.xml",
            "<!DOCTYPE root [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><root>&x;</root>")));
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkillPackage.files(presentation("ppt/presentation.xml",
            "<presentation><sldSz cx=\"9144000\" cy=\"6858000\"/></presentation>")));
        assertThrows(WorkspaceDenied.class, () -> WorkspaceSkillPackage.files(List.of(Map.of("path", "references/presentation.json",
            "content", "{\"name\":\"QA\",\"version\":\"1\",\"templatePath\":\"templates/missing.pptx\"}"))));
    }
}
