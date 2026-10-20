package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class WorkspaceSkillPackageTest {
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
}
