package org.dromara.ai.workspace;

import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xslf.usermodel.XSLFShape;
import org.apache.poi.xslf.usermodel.XSLFTextShape;
import org.apache.poi.xwpf.usermodel.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/** Bounded, local document extraction for the workspace knowledge index. */
@Component
public class WorkspaceKnowledgeDocumentExtractor {
    static final int MAX_TEXT_CHARS = 500_000;
    static final int MAX_PDF_PAGES = 50;
    static final long MAX_IMAGE_PIXELS = 25_000_000L;
    static final int MAX_OFFICE_ITEMS = 100_000;
    private static final Set<String> TEXT = Set.of("txt", "md", "csv", "json");
    private static final Set<String> OFFICE = Set.of("docx", "xlsx", "pptx");
    private static final Set<String> IMAGE = Set.of("png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp");

    public record Descriptor(String extension, String mediaType) {}
    public record Section(String locationType, String locationLabel, String text) {}
    public record Extraction(String mediaType, String method, List<Section> sections, Map<String, Object> metadata) {
        public String fullText() {
            StringBuilder out = new StringBuilder();
            for (Section section : sections) {
                if (!out.isEmpty()) out.append("\n\n");
                out.append("[" ).append(section.locationLabel()).append("]\n").append(section.text());
            }
            return out.toString();
        }
    }

    private final String pdfTextCommand;
    private final String pdfInfoCommand;
    private final String pdfRenderCommand;
    private final String ocrCommand;
    private final String ocrLanguages;

    public WorkspaceKnowledgeDocumentExtractor(
        @Value("${workspace.knowledge.pdftotext:pdftotext}") String pdfTextCommand,
        @Value("${workspace.knowledge.pdfinfo:pdfinfo}") String pdfInfoCommand,
        @Value("${workspace.knowledge.pdftoppm:pdftoppm}") String pdfRenderCommand,
        @Value("${workspace.knowledge.tesseract:tesseract}") String ocrCommand,
        @Value("${workspace.knowledge.ocr-languages:chi_sim+eng}") String ocrLanguages
    ) {
        this.pdfTextCommand = pdfTextCommand;
        this.pdfInfoCommand = pdfInfoCommand;
        this.pdfRenderCommand = pdfRenderCommand;
        this.ocrCommand = ocrCommand;
        this.ocrLanguages = ocrLanguages;
    }

    public Descriptor describe(String filename, byte[] bytes) {
        String extension = extension(filename);
        if (!TEXT.contains(extension) && !OFFICE.contains(extension) && !IMAGE.contains(extension) && !"pdf".equals(extension)) {
            throw new WorkspaceDenied(400, "UnsupportedKnowledgeFileType");
        }
        if (OFFICE.contains(extension) && !startsWith(bytes, new byte[]{'P', 'K'})) throw new WorkspaceDenied(400, "InvalidOfficeDocument");
        if ("pdf".equals(extension) && !startsWith(bytes, "%PDF-".getBytes(StandardCharsets.US_ASCII))) throw new WorkspaceDenied(400, "InvalidPdfDocument");
        return new Descriptor(extension, mediaType(extension));
    }

    public Extraction extract(String filename, byte[] bytes) {
        Descriptor descriptor = describe(filename, bytes);
        try {
            Extraction result = switch (descriptor.extension()) {
                case "txt", "md", "csv", "json" -> text(descriptor, bytes);
                case "docx" -> docx(descriptor, bytes);
                case "xlsx" -> xlsx(descriptor, bytes);
                case "pptx" -> pptx(descriptor, bytes);
                case "pdf" -> pdf(descriptor, bytes);
                default -> image(descriptor, bytes);
            };
            String fullText = result.fullText();
            if (fullText.isBlank()) throw new WorkspaceDenied(400, "DocumentContainsNoExtractableText");
            if (fullText.length() > MAX_TEXT_CHARS) throw new WorkspaceDenied(413, "DocumentTextLimitExceeded");
            return result;
        } catch (WorkspaceDenied e) {
            throw e;
        } catch (Exception e) {
            throw new WorkspaceDenied(400, "DocumentExtractionFailed");
        }
    }

    private Extraction text(Descriptor descriptor, byte[] bytes) {
        String value = decodeUtf8(bytes);
        return extraction(descriptor, "UTF8_TEXT", List.of(new Section("LINE", "全文", value)), Map.of());
    }

    private Extraction docx(Descriptor descriptor, byte[] bytes) throws IOException {
        List<String> lines = new ArrayList<>();
        int paragraph = 0, table = 0, items = 0;
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(bytes))) {
            for (IBodyElement element : document.getBodyElements()) {
                if (++items > MAX_OFFICE_ITEMS) throw new WorkspaceDenied(413, "DocumentStructureLimitExceeded");
                if (element instanceof XWPFParagraph p) {
                    String value = normalize(p.getText());
                    if (!value.isBlank()) lines.add("P" + (++paragraph) + ": " + value);
                } else if (element instanceof XWPFTable t) {
                    table++;
                    int row = 0;
                    for (XWPFTableRow r : t.getRows()) {
                        if (++items > MAX_OFFICE_ITEMS) throw new WorkspaceDenied(413, "DocumentStructureLimitExceeded");
                        List<String> cells = new ArrayList<>();
                        for (XWPFTableCell cell : r.getTableCells()) cells.add(normalize(cell.getText()));
                        if (cells.stream().anyMatch(s -> !s.isBlank())) lines.add("T" + table + "R" + (++row) + ": " + String.join(" | ", cells));
                    }
                }
            }
        }
        return extraction(descriptor, "APACHE_POI", List.of(new Section("PARAGRAPH", "正文段落和表格", String.join("\n", lines))), Map.of("paragraphs", paragraph, "tables", table));
    }

    private Extraction xlsx(Descriptor descriptor, byte[] bytes) throws IOException {
        List<Section> sections = new ArrayList<>();
        int items = 0;
        try (Workbook workbook = WorkbookFactory.create(new ByteArrayInputStream(bytes))) {
            DataFormatter formatter = new DataFormatter(Locale.ROOT);
            FormulaEvaluator evaluator = workbook.getCreationHelper().createFormulaEvaluator();
            for (Sheet sheet : workbook) {
                List<String> lines = new ArrayList<>();
                for (Row row : sheet) {
                    if (++items > MAX_OFFICE_ITEMS) throw new WorkspaceDenied(413, "DocumentStructureLimitExceeded");
                    List<String> cells = new ArrayList<>();
                    for (Cell cell : row) {
                        if (++items > MAX_OFFICE_ITEMS) throw new WorkspaceDenied(413, "DocumentStructureLimitExceeded");
                        String value;
                        try { value = normalize(formatter.formatCellValue(cell, evaluator)); }
                        catch (RuntimeException ignored) { value = normalize(formatter.formatCellValue(cell)); }
                        if (!value.isBlank()) cells.add(cell.getAddress().formatAsString() + "=" + value);
                    }
                    if (!cells.isEmpty()) lines.add("Row " + (row.getRowNum() + 1) + ": " + String.join(" | ", cells));
                }
                if (!lines.isEmpty()) sections.add(new Section("SHEET", "工作表 " + safeLabel(sheet.getSheetName()), String.join("\n", lines)));
            }
        }
        return extraction(descriptor, "APACHE_POI", sections, Map.of("sheets", sections.size()));
    }

    private Extraction pptx(Descriptor descriptor, byte[] bytes) throws IOException {
        List<Section> sections = new ArrayList<>();
        int items = 0;
        try (XMLSlideShow show = new XMLSlideShow(new ByteArrayInputStream(bytes))) {
            for (int index = 0; index < show.getSlides().size(); index++) {
                if (++items > MAX_OFFICE_ITEMS) throw new WorkspaceDenied(413, "DocumentStructureLimitExceeded");
                List<String> lines = new ArrayList<>();
                for (XSLFShape shape : show.getSlides().get(index).getShapes()) {
                    if (++items > MAX_OFFICE_ITEMS) throw new WorkspaceDenied(413, "DocumentStructureLimitExceeded");
                    if (shape instanceof XSLFTextShape textShape) {
                        String value = normalize(textShape.getText());
                        if (!value.isBlank()) lines.add(value);
                    }
                }
                if (!lines.isEmpty()) sections.add(new Section("SLIDE", "幻灯片 " + (index + 1), String.join("\n", lines)));
            }
        }
        return extraction(descriptor, "APACHE_POI", sections, Map.of("slides", sections.size()));
    }

    private Extraction pdf(Descriptor descriptor, byte[] bytes) throws IOException {
        Path folder = Files.createTempDirectory("zhenwork-knowledge-pdf-");
        try {
            Path input = folder.resolve("input.pdf"), output = folder.resolve("text.txt");
            Files.write(input, bytes);
            CommandResult info = command(Duration.ofSeconds(10), folder, pdfInfoCommand, input.toString());
            if (!info.started()) throw new WorkspaceDenied(503, "PdfInfoUnavailable");
            int pageCount = parsePdfPages(info.output());
            if (pageCount < 1) throw new WorkspaceDenied(400, "InvalidPdfDocument");
            if (pageCount > MAX_PDF_PAGES) throw new WorkspaceDenied(413, "PdfPageLimitExceeded");
            CommandResult textResult = command(Duration.ofSeconds(60), folder, pdfTextCommand, "-layout", "-enc", "UTF-8", input.toString(), output.toString());
            if (textResult.started() && textResult.exitCode() == 0 && Files.exists(output)) {
                String extracted = limitedUtf8(output);
                List<Section> pages = pageSections(extracted);
                if (pages.stream().anyMatch(p -> !p.text().isBlank())) return extraction(descriptor, "PDFTOTEXT", pages, Map.of("pages", pages.size(), "ocr", false));
            }
            return pdfOcr(descriptor, input, folder, pageCount, textResult.started());
        } finally {
            removeTree(folder);
        }
    }

    private Extraction pdfOcr(Descriptor descriptor, Path input, Path folder, int pages, boolean textExtractorPresent) throws IOException {
        Path prefix = folder.resolve("page");
        CommandResult render = command(Duration.ofSeconds(120), folder, pdfRenderCommand, "-png", "-r", "150", "-f", "1", "-l", Integer.toString(pages), input.toString(), prefix.toString());
        if (!render.started()) throw new WorkspaceDenied(503, "ScannedPdfOcrUnavailable");
        if (render.exitCode() != 0) throw new WorkspaceDenied(400, "PdfRenderFailed");
        List<Path> images;
        try (Stream<Path> stream = Files.list(folder)) { images = stream.filter(p -> p.getFileName().toString().matches("page-\\d+\\.png")).sorted(Comparator.comparingInt(WorkspaceKnowledgeDocumentExtractor::pageNumber)).toList(); }
        if (images.size() != pages) throw new WorkspaceDenied(400, "PdfRenderIncomplete");
        List<Section> sections = new ArrayList<>();
        for (int i = 0; i < images.size(); i++) sections.add(new Section("PAGE", "第 " + (i + 1) + " 页", ocr(images.get(i), folder)));
        return extraction(descriptor, "PDF_OCR_TESSERACT", sections, Map.of("pages", pages, "ocr", true, "languages", ocrLanguages));
    }

    private Extraction image(Descriptor descriptor, byte[] bytes) throws IOException {
        Path folder = Files.createTempDirectory("zhenwork-knowledge-image-");
        try {
            Path input = folder.resolve("input." + descriptor.extension());
            Files.write(input, bytes);
            int width, height;
            try (var stream = ImageIO.createImageInputStream(input.toFile())) {
                Iterator<ImageReader> readers = ImageIO.getImageReaders(stream);
                if (!readers.hasNext()) throw new WorkspaceDenied(400, "InvalidKnowledgeImage");
                ImageReader reader = readers.next();
                try { reader.setInput(stream, true, true);width = reader.getWidth(0);height = reader.getHeight(0); }
                finally { reader.dispose(); }
            }
            if ((long) width * height > MAX_IMAGE_PIXELS) throw new WorkspaceDenied(413, "ImagePixelLimitExceeded");
            String text = ocr(input, folder);
            return extraction(descriptor, "IMAGE_OCR_TESSERACT", List.of(new Section("IMAGE", "图片", text)), Map.of("width", width, "height", height, "languages", ocrLanguages));
        } finally {
            removeTree(folder);
        }
    }

    private String ocr(Path input, Path folder) throws IOException {
        Path output = folder.resolve("ocr-" + UUID.randomUUID() + ".txt");
        CommandResult result = commandToFile(Duration.ofSeconds(90), folder, output, ocrCommand, input.toString(), "stdout", "-l", ocrLanguages, "--psm", "6");
        if (!result.started()) throw new WorkspaceDenied(503, "OcrUnavailable");
        if (result.exitCode() != 0) {
            if (result.output().contains("Failed loading language") || result.output().contains("Error opening data file")) throw new WorkspaceDenied(503, "OcrLanguageUnavailable");
            throw new WorkspaceDenied(400, "OcrFailed");
        }
        String value = limitedUtf8(output).trim();
        if (value.isBlank()) throw new WorkspaceDenied(400, "DocumentContainsNoExtractableText");
        return value;
    }

    private Extraction extraction(Descriptor descriptor, String method, List<Section> sections, Map<String, Object> metadata) {
        List<Section> clean = sections.stream().map(s -> new Section(s.locationType(), safeLabel(s.locationLabel()), normalizeLines(s.text()))).filter(s -> !s.text().isBlank()).toList();
        return new Extraction(descriptor.mediaType(), method, clean, metadata);
    }

    private static List<Section> pageSections(String value) {
        String[] values = value.split("\\f", -1);
        List<Section> pages = new ArrayList<>();
        for (int index = 0; index < values.length; index++) if (!values[index].isBlank() || index < values.length - 1) pages.add(new Section("PAGE", "第 " + (index + 1) + " 页", values[index]));
        return pages;
    }

    private static int parsePdfPages(String output) {
        for (String line : output.split("\\R")) if (line.toLowerCase(Locale.ROOT).startsWith("pages:")) try { return Integer.parseInt(line.substring(line.indexOf(':') + 1).trim()); } catch (NumberFormatException ignored) {}
        return -1;
    }

    private static int pageNumber(Path path) {
        String value = path.getFileName().toString();
        try { return Integer.parseInt(value.substring(value.indexOf('-') + 1, value.lastIndexOf('.'))); } catch (RuntimeException e) { return Integer.MAX_VALUE; }
    }

    private record CommandResult(boolean started, int exitCode, String output) {}

    private static CommandResult command(Duration timeout, Path folder, String... values) throws IOException {
        Path log = folder.resolve("command-" + UUID.randomUUID() + ".log");
        return commandInternal(timeout, folder, null, log, values);
    }

    private static CommandResult commandToFile(Duration timeout, Path folder, Path stdout, String... values) throws IOException {
        Path log = folder.resolve("command-" + UUID.randomUUID() + ".log");
        return commandInternal(timeout, folder, stdout, log, values);
    }

    private static CommandResult commandInternal(Duration timeout, Path folder, Path stdout, Path log, String... values) throws IOException {
        Process process;
        try {
            ProcessBuilder builder = new ProcessBuilder(values).directory(folder.toFile()).redirectError(log.toFile());
            builder.redirectOutput(stdout == null ? ProcessBuilder.Redirect.appendTo(log.toFile()) : ProcessBuilder.Redirect.to(stdout.toFile()));
            process = builder.start();
        } catch (IOException e) {
            return new CommandResult(false, -1, "");
        }
        boolean completed;
        try { completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); process.destroyForcibly(); throw new WorkspaceDenied(503, "DocumentExtractionInterrupted"); }
        if (!completed) { process.destroyForcibly(); throw new WorkspaceDenied(503, "DocumentExtractionTimeout"); }
        String output = Files.exists(log) ? limitedUtf8(log) : "";
        return new CommandResult(true, process.exitValue(), output);
    }

    private static String limitedUtf8(Path path) throws IOException {
        long size = Files.size(path);
        if (size > 2_000_000) throw new WorkspaceDenied(413, "DocumentTextLimitExceeded");
        return decodeUtf8(Files.readAllBytes(path));
    }

    private static String decodeUtf8(byte[] bytes) {
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            if (text.indexOf('\0') >= 0) throw new CharacterCodingException();
            return text.startsWith("\uFEFF") ? text.substring(1) : text;
        } catch (CharacterCodingException e) {
            throw new WorkspaceDenied(400, "Utf8TextRequired");
        }
    }

    private static String extension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String mediaType(String extension) {
        return switch (extension) {
            case "txt" -> "text/plain; charset=utf-8";
            case "md" -> "text/markdown; charset=utf-8";
            case "csv" -> "text/csv; charset=utf-8";
            case "json" -> "application/json";
            case "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            case "pdf" -> "application/pdf";
            case "jpg", "jpeg" -> "image/jpeg";
            case "tif", "tiff" -> "image/tiff";
            default -> "image/" + extension;
        };
    }

    private static boolean startsWith(byte[] value, byte[] prefix) {
        if (value.length < prefix.length) return false;
        for (int index = 0; index < prefix.length; index++) if (value[index] != prefix[index]) return false;
        return true;
    }

    private static String normalize(String value) { return value == null ? "" : value.replace('\u0000', ' ').replaceAll("[\\t ]+", " ").trim(); }
    private static String normalizeLines(String value) { return value == null ? "" : value.replace("\r\n", "\n").replace('\r', '\n').replace('\u0000', ' ').trim(); }
    private static String safeLabel(String value) { String result = normalize(value); return result.length() <= 180 ? result : result.substring(0, 180); }

    private static void removeTree(Path folder) {
        if (folder == null) return;
        try (Stream<Path> paths = Files.walk(folder)) { paths.sorted(Comparator.reverseOrder()).forEach(path -> { try { Files.deleteIfExists(path); } catch (IOException ignored) {} }); }
        catch (IOException ignored) {}
    }
}
