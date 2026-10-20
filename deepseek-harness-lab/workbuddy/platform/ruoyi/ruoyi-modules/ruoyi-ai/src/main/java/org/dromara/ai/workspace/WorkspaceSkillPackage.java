package org.dromara.ai.workspace;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Validates immutable companion files stored with one Skill resource version. */
final class WorkspaceSkillPackage {
    private static final int MAX_FILES = 200;
    private static final int MAX_FILE_BYTES = 20 * 1024 * 1024;
    private static final int MAX_PACKAGE_BYTES = 30 * 1024 * 1024;
    private static final Set<String> ROOT_FILES = Set.of(
        "requirements.txt", "requirements.lock", "pyproject.toml", "uv.lock",
        "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
        "README.md", "CHANGELOG.md", "USAGE.md", "VERSION", "LICENSE", "LICENSE.md");
    private static final Set<String> DIRECTORIES = Set.of(
        "scripts", "templates", "references", "examples", "assets", "docs", "tests");

    private WorkspaceSkillPackage() {}

    static List<Map<String,Object>> files(Object raw) {
        if (raw == null) return List.of();
        if (!(raw instanceof List<?> input) || input.size() > MAX_FILES)
            throw new WorkspaceDenied(400, "InvalidSkillPackage");
        List<Map<String,Object>> result = new ArrayList<>();
        Set<String> paths = new HashSet<>();
        int total = 0;
        for (Object value : input) {
            if (!(value instanceof Map<?,?> file) ||
                !Set.of("path", "content", "encoding", "executable", "sha256").containsAll(file.keySet()))
                throw new WorkspaceDenied(400, "InvalidSkillPackage");
            String path = Objects.toString(file.get("path"), "");
            String content = Objects.toString(file.get("content"), "");
            String encoding = Objects.toString(file.containsKey("encoding") ? file.get("encoding") : "utf8", "");
            boolean executable = Boolean.TRUE.equals(file.get("executable"));
            if (!validPath(path) || !paths.add(path) || !Set.of("utf8", "base64").contains(encoding) ||
                file.containsKey("executable") && !(file.get("executable") instanceof Boolean) ||
                !path.contains("/") && !"utf8".equals(encoding) ||
                executable && !path.startsWith("scripts/") || path.startsWith("scripts/") && !"utf8".equals(encoding))
                throw new WorkspaceDenied(400, "InvalidSkillPackage");
            byte[] bytes;
            try {
                bytes = "base64".equals(encoding) ? Base64.getDecoder().decode(content) : content.getBytes(StandardCharsets.UTF_8);
                if ("base64".equals(encoding) && !Base64.getEncoder().encodeToString(bytes).equals(content) ||
                    "utf8".equals(encoding) && content.indexOf('\0') >= 0) throw new IllegalArgumentException();
            } catch (IllegalArgumentException e) {
                throw new WorkspaceDenied(400, "InvalidSkillFileEncoding");
            }
            int size = bytes.length;
            if (size > MAX_FILE_BYTES || (total += size) > MAX_PACKAGE_BYTES)
                throw new WorkspaceDenied(400, "SkillPackageTooLarge");
            String digest = sha256(bytes);
            if (file.containsKey("sha256") && !digest.equals(file.get("sha256")))
                throw new WorkspaceDenied(400, "InvalidSkillFileHash");
            Map<String,Object> normalized = new LinkedHashMap<>();
            normalized.put("path", path);
            normalized.put("content", content);
            normalized.put("encoding", encoding);
            normalized.put("executable", executable);
            normalized.put("sha256", digest);
            result.add(Collections.unmodifiableMap(normalized));
        }
        result.sort(Comparator.comparing(file -> file.get("path").toString()));
        return List.copyOf(result);
    }

    private static boolean validPath(String path) {
        if (path.isBlank() || path.length() > 400 || path.startsWith("/") || path.endsWith("/") ||
            path.indexOf('\\') >= 0 || path.codePoints().anyMatch(Character::isISOControl)) return false;
        String[] parts = path.split("/", -1);
        if (Arrays.stream(parts).anyMatch(part -> part.isBlank() || ".".equals(part) || "..".equals(part) ||
            part.matches(".*[<>:\"|?*].*") || part.endsWith(".") || part.endsWith(" "))) return false;
        return parts.length == 1 ? ROOT_FILES.contains(path) : DIRECTORIES.contains(parts[0]);
    }

    private static String sha256(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(content));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
