package org.dromara.ai.workspace;

import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.*;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class WorkspaceKnowledgeDocumentExtractorTest {
    @TempDir Path folder;

    private WorkspaceKnowledgeDocumentExtractor extractor(String pdfText, String pdfInfo, String pdfRender, String ocr) {
        return new WorkspaceKnowledgeDocumentExtractor(pdfText, pdfInfo, pdfRender, ocr, "eng");
    }

    @Test
    void extractsRealOfficeDocumentsWithSourceLocations() throws Exception {
        var extractor = extractor("missing", "missing", "missing", "missing");
        var output = new ByteArrayOutputStream();
        try (var document = new XWPFDocument()) {
            document.createParagraph().createRun().setText("word evidence");
            document.write(output);
        }
        var word = extractor.extract("evidence.docx", output.toByteArray());
        assertEquals("PARAGRAPH", word.sections().getFirst().locationType());
        assertTrue(word.fullText().contains("word evidence"));

        output.reset();
        try (var workbook = new XSSFWorkbook()) {
            workbook.createSheet("Facts").createRow(0).createCell(0).setCellValue("sheet evidence");
            workbook.write(output);
        }
        var sheet = extractor.extract("evidence.xlsx", output.toByteArray());
        assertEquals("SHEET", sheet.sections().getFirst().locationType());
        assertEquals("工作表 Facts", sheet.sections().getFirst().locationLabel());
        assertTrue(sheet.fullText().contains("A1=sheet evidence"));

        output.reset();
        try (var slides = new XMLSlideShow()) {
            slides.createSlide().createTextBox().setText("slide evidence");
            slides.write(output);
        }
        var slide = extractor.extract("evidence.pptx", output.toByteArray());
        assertEquals("SLIDE", slide.sections().getFirst().locationType());
        assertEquals("幻灯片 1", slide.sections().getFirst().locationLabel());
        assertTrue(slide.fullText().contains("slide evidence"));
    }

    @Test
    void scannedPdfUsesOcrAndKeepsPageLocationWhenNativeToolsExist() throws Exception {
        assumeTrue(commandAvailable("pdfinfo"));
        assumeTrue(commandAvailable("pdftoppm"));
        assumeTrue(commandAvailable("tesseract"));
        Path image = folder.resolve("scan.png"), output = folder.resolve("scan");
        BufferedImage source = new BufferedImage(1600, 360, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = source.createGraphics();
        graphics.setColor(Color.WHITE);graphics.fillRect(0, 0, source.getWidth(), source.getHeight());
        graphics.setColor(Color.BLACK);graphics.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 72));graphics.drawString("OCR EVIDENCE 4827", 80, 210);graphics.dispose();
        ImageIO.write(source, "png", image.toFile());
        Process create = new ProcessBuilder("tesseract", image.toString(), output.toString(), "-l", "eng", "pdf").redirectErrorStream(true).start();
        assumeTrue(create.waitFor() == 0);
        byte[] pdf = Files.readAllBytes(folder.resolve("scan.pdf"));
        var result = extractor("missing-pdftotext", "pdfinfo", "pdftoppm", "tesseract").extract("scan.pdf", pdf);
        assertEquals("PDF_OCR_TESSERACT", result.method());
        assertEquals("PAGE", result.sections().getFirst().locationType());
        assertEquals("第 1 页", result.sections().getFirst().locationLabel());
        assertTrue(result.fullText().toUpperCase(Locale.ROOT).contains("EVIDENCE"));
    }

    @Test
    void missingNativeDependenciesReturnExplicitCodes() throws Exception {
        BufferedImage source = new BufferedImage(100, 100, BufferedImage.TYPE_INT_RGB);
        var output = new ByteArrayOutputStream();ImageIO.write(source, "png", output);
        var unavailable = extractor("missing-pdftotext", "missing-pdfinfo", "missing-pdftoppm", "missing-tesseract");
        assertEquals("OcrUnavailable", assertThrows(WorkspaceDenied.class, () -> unavailable.extract("scan.png", output.toByteArray())).getMessage());
        assertEquals("PdfInfoUnavailable", assertThrows(WorkspaceDenied.class, () -> unavailable.extract("scan.pdf", "%PDF-1.4\n".getBytes())).getMessage());
    }

    private static boolean commandAvailable(String command) {
        try { return new ProcessBuilder(command, "tesseract".equals(command) ? "--version" : "-v").redirectErrorStream(true).start().waitFor() == 0; }
        catch (Exception ignored) { return false; }
    }
}
