package org.dromara.ai.workspace;

import java.nio.charset.StandardCharsets;
import java.io.*;
import java.util.zip.*;
import javax.xml.stream.*;
import javax.imageio.ImageIO;
import org.dromara.common.json.utils.JsonUtils;
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
        validatePresentationTemplate(result);
        return List.copyOf(result);
    }

    /** Validate passive presentation assets at save time, before any immutable version is stored. */
    private static void validatePresentationTemplate(List<Map<String,Object>> files) {
        var manifest = files.stream().filter(f -> "references/presentation.json".equals(f.get("path"))).findFirst();
        if (manifest.isEmpty()) return;
        try {
            var file = manifest.get();
            String source = file.get("content").toString();
            if (!"utf8".equals(file.get("encoding")) || source.length() > 8000) throw new IOException();
            Map<String,Object> config = JsonUtils.parseMap(source);
            if (config == null || !Set.of("name", "version", "primary", "accent", "font", "titleSize", "bodySize",
                "default", "templatePath", "logoPath").containsAll(config.keySet()) ||
                !(config.get("name") instanceof String name) || name.isBlank() || name.length() > 100 ||
                !(config.get("version") instanceof String version) || version.isBlank() || version.length() > 40)
                throw new IOException();
            for (String key : List.of("templatePath", "logoPath")) {
                if (!config.containsKey(key)) continue;
                if (!(config.get(key) instanceof String path) || !path.startsWith("templates/") || !validPath(path)) throw new IOException();
                var asset = files.stream().filter(f -> path.equals(f.get("path"))).findFirst().orElseThrow();
                if (!"base64".equals(asset.get("encoding")) || Boolean.TRUE.equals(asset.get("executable"))) throw new IOException();
                byte[] bytes = Base64.getDecoder().decode(asset.get("content").toString());
                if (bytes.length == 0 || bytes.length > 1024 * 1024) throw new IOException();
                if ("templatePath".equals(key)) {
                    if (!path.toLowerCase(Locale.ROOT).endsWith(".pptx")) throw new IOException();
                    validatePresentationZip(bytes);
                } else {
                    if (!path.toLowerCase(Locale.ROOT).matches(".*\\.(png|jpe?g)")) throw new IOException();
                    try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
                        var readers = ImageIO.getImageReaders(stream);
                        if (!readers.hasNext()) throw new IOException();
                        var reader = readers.next();
                        try {
                            reader.setInput(stream);
                            if (!Set.of("png", "jpeg", "jpg").contains(reader.getFormatName().toLowerCase(Locale.ROOT)) ||
                                reader.getWidth(0) <= 0 || reader.getHeight(0) <= 0 ||
                                (long)reader.getWidth(0) * reader.getHeight(0) > 12_000_000) throw new IOException();
                        } finally { reader.dispose(); }
                    }
                }
            }
        } catch (Exception e) { throw new WorkspaceDenied(400, "InvalidPresentationTemplate"); }
    }

    private static void validatePresentationZip(byte[] bytes) throws Exception {
        var xml = XMLInputFactory.newFactory();
        xml.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        xml.setProperty("javax.xml.stream.isSupportingExternalEntities", false);
        xml.setXMLResolver((publicId, systemId, base, namespace) -> { throw new XMLStreamException("External XML denied"); });
        Set<String> names = new HashSet<>();
        int total = 0, slides = 0;
        boolean presentation = false, contentTypes = false, size = false;
        try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                String path = entry.getName(), lower = path.toLowerCase(Locale.ROOT);
                if (names.size() >= 4000 || !names.add(path) || path.startsWith("/") || path.contains("\\") ||
                    Arrays.asList(path.split("/", -1)).contains("..") || lower.contains("vbaproject") ||
                    lower.contains("activex") || lower.contains("/embeddings/") || lower.contains("oleobject") ||
                    lower.endsWith(".bin") && !path.matches("ppt/printerSettings/printerSettings[0-9]+\\.bin") || lower.endsWith(".js") || lower.endsWith(".vbs")) throw new IOException();
                if (entry.isDirectory()) continue;
                var output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count, part = 0;
                while ((count = zip.read(buffer)) != -1) {
                    part += count; total += count;
                    if (part > 20 * 1024 * 1024 || total > 80 * 1024 * 1024) throw new IOException();
                    output.write(buffer, 0, count);
                }
                if (lower.endsWith(".bin") && part > 64 * 1024) throw new IOException();
                presentation |= "ppt/presentation.xml".equals(path);
                contentTypes |= "[Content_Types].xml".equals(path);
                if (!lower.endsWith(".xml") && !lower.endsWith(".rels")) continue;
                var reader = xml.createXMLStreamReader(new ByteArrayInputStream(output.toByteArray()));
                try {
                    while (reader.hasNext()) {
                        int event = reader.next();
                        if (event == XMLStreamConstants.DTD || event == XMLStreamConstants.ENTITY_REFERENCE) throw new IOException();
                        if (event != XMLStreamConstants.START_ELEMENT) continue;
                        String local = reader.getLocalName();
                        if ("Relationship".equals(local) && "External".equalsIgnoreCase(reader.getAttributeValue(null, "TargetMode"))) throw new IOException();
                        if ("Override".equals(local) || "Default".equals(local)) {
                            String type = Objects.toString(reader.getAttributeValue(null, "ContentType"), "").toLowerCase(Locale.ROOT);
                            if (type.contains("macroenabled") || type.contains("vba") || type.contains("oleobject") || type.contains("activex")) throw new IOException();
                        }
                        if ("ppt/presentation.xml".equals(path)) {
                            if ("sldId".equals(local) && ++slides > 30) throw new IOException();
                            if ("sldSz".equals(local)) {
                                long cx = Long.parseLong(reader.getAttributeValue(null, "cx")), cy = Long.parseLong(reader.getAttributeValue(null, "cy"));
                                size = cx > 0 && cy > 0 && cx <= 100_000_000 && cy <= 100_000_000 && Math.abs((double)cx / cy - 16.0 / 9) < .01;
                            }
                        }
                    }
                } finally { reader.close(); }
            }
        }
        if (!presentation || !contentTypes || !size) throw new IOException();
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
