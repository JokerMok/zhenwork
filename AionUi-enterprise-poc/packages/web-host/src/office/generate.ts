import { execFile } from 'node:child_process';
import { WORKBOOK_SUPPORT_PYTHON } from './workbook/script.js';
import { OFFICE_PRESENTATION_PYTHON } from './delivery/presentationScript.js';
import { safeOfficeSourceUrl, type OfficeSource, type OfficeReport, type OfficeSection, type OfficeProvenance } from './delivery/presentation.js';

export type OfficeCell = string | number | null;
export type OfficeTable = { headers: string[]; rows: OfficeCell[][] };
export type OfficeSheet = { name?: string; headers?: string[]; rows: OfficeCell[][] };
export type OfficeSlide = { title: string; bullets?: string[]; paragraphs?: string[] };
export type GenerateOfficeArtifactInput = {
  format: 'xlsx' | 'docx' | 'pptx' | 'pdf';
  title?: string;
  paragraphs?: string[];
  table?: OfficeTable;
  sheets?: OfficeSheet[];
  slides?: OfficeSlide[];
  sources?: OfficeSource[];
  report?: OfficeReport;
  sections?: OfficeSection[];
  provenance?: OfficeProvenance;
};

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 1000;
const MAX_COLUMNS = 40;
const MAX_SLIDES = 30;
const MAX_SHEETS = 30;
const MAX_PARAGRAPHS = 200;
const MAX_ITEMS_PER_SLIDE = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_PYTHON = '/opt/zhenwork-office/bin/python';

const PYTHON_SCRIPT = String.raw`import io,json,sys

MAX_OUTPUT=10*1024*1024

def text(value):
    return '' if value is None else str(value)

`;
const PYTHON_LAYOUT = OFFICE_PRESENTATION_PYTHON;
const PYTHON_TAIL = String.raw`def pptx(data):
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Inches,Pt
    presentation=Presentation();presentation.slide_width=Inches(13.333);presentation.slide_height=Inches(7.5)
    presentation.core_properties.title=data.get('title') or ''
    def add_slide(title,paragraphs,bullets):
        slide=presentation.slides.add_slide(presentation.slide_layouts[6])
        title_box=slide.shapes.add_textbox(Inches(.75),Inches(.48),Inches(11.85),Inches(.72))
        title_frame=title_box.text_frame;title_frame.clear();title_frame.text=title or ''
        for run in title_frame.paragraphs[0].runs:
            run.font.name='Microsoft YaHei';run.font.size=Pt(26);run.font.bold=True;run.font.color.rgb=RGBColor(31,78,120)
        body=slide.shapes.add_textbox(Inches(.9),Inches(1.45),Inches(11.5),Inches(5.25)).text_frame
        body.clear();body.word_wrap=True
        entries=[(value,False) for value in paragraphs]+[(value,True) for value in bullets]
        if not entries: entries=[('',False)]
        for index,(value,bullet) in enumerate(entries):
            paragraph=body.paragraphs[0] if index==0 else body.add_paragraph()
            paragraph.text=('\u2022 ' if bullet else '')+value;paragraph.space_after=Pt(10)
            for run in paragraph.runs: run.font.name='Microsoft YaHei';run.font.size=Pt(18)
    slides=data.get('slides') or []
    if slides and data.get('title'): add_slide(data['title'],[],[])
    if slides:
        for item in slides: add_slide(item.get('title') or '',item.get('paragraphs') or [],item.get('bullets') or [])
    else: add_slide(data.get('title') or '',data.get('paragraphs') or [],[])
    output=io.BytesIO();presentation.save(output);return output.getvalue()

def pdf(data):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4,landscape
    from reportlab.lib.styles import ParagraphStyle,getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import LongTable,Paragraph,SimpleDocTemplate,Spacer,TableStyle
    from xml.sax.saxutils import escape
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    table_data=data.get('table');columns=0
    if table_data: columns=max(1,len(table_data.get('headers') or []),max((len(row) for row in table_data.get('rows') or []),default=0))
    pagesize=landscape(A4) if columns>6 else A4
    output=io.BytesIO();document=SimpleDocTemplate(output,pagesize=pagesize,leftMargin=14*mm,rightMargin=14*mm,topMargin=14*mm,bottomMargin=14*mm,title=data.get('title') or '')
    styles=getSampleStyleSheet()
    normal=ParagraphStyle('CJKBody',parent=styles['BodyText'],fontName='STSong-Light',fontSize=10.5,leading=16,wordWrap='CJK',spaceAfter=7)
    heading=ParagraphStyle('CJKTitle',parent=normal,fontSize=20,leading=27,alignment=TA_CENTER,spaceAfter=14)
    cell_style=ParagraphStyle('CJKCell',parent=normal,fontSize=8 if columns>8 else 9,leading=11,spaceAfter=0)
    markup=lambda value: escape(text(value)).replace('\n','<br/>')
    story=[]
    if data.get('title'): story.append(Paragraph(markup(data['title']),heading))
    for value in data.get('paragraphs') or []: story.extend([Paragraph(markup(value),normal),Spacer(1,2*mm)])
    if table_data:
        headers=table_data.get('headers') or [];rows=table_data.get('rows') or []
        matrix=[]
        if headers: matrix.append([Paragraph(markup(value),cell_style) for value in headers]+[Paragraph('',cell_style)]*(columns-len(headers)))
        for row in rows: matrix.append([Paragraph(markup(value),cell_style) for value in row]+[Paragraph('',cell_style)]*(columns-len(row)))
        if matrix:
            available=pagesize[0]-28*mm
            table=LongTable(matrix,colWidths=[available/columns]*columns,repeatRows=1 if headers else 0,splitByRow=1)
            commands=[('GRID',(0,0),(-1,-1),.35,colors.HexColor('#9AA9B8')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4)]
            if headers: commands.extend([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#D9EAF7')),('FONTNAME',(0,0),(-1,0),'STSong-Light')])
            table.setStyle(TableStyle(commands));story.append(table)
    if not story: story.append(Paragraph('&#160;',normal))
    document.build(story);return output.getvalue()

try:
    raw=sys.stdin.buffer.read(65537)
    if len(raw)>65536: raise ValueError('INPUT_LIMIT_64KB')
    value=json.loads(raw.decode('utf-8'))
    generators={'xlsx':xlsx,'docx':docx,'pptx':pptx,'pdf':pdf}
    result=generators[value['format']](value)
    if not result or len(result)>MAX_OUTPUT: raise ValueError('OUTPUT_LIMIT_10MB')
    sys.stdout.buffer.write(result)
except Exception as error:
    allowed={'CALCULATION_CYCLE','CALCULATION_MISSING_VALUE','CALCULATION_UNIT_MISMATCH','CALCULATION_ZERO_DIVISOR'}
    category=str(error) if isinstance(error,ValueError) and str(error) in allowed else error.code if isinstance(error,WorkbookError) else type(error).__name__
    sys.stderr.write('OFFICE_GENERATION_FAILED:'+category)
    sys.exit(2)
`;

function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function string(value: unknown, code: string, maximum = MAX_TEXT_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) fail(code);
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 32 && point !== 9 && point !== 10 && point !== 13) fail(code);
  }
}
function strings(value: unknown, code: string, maximum = MAX_PARAGRAPHS): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(code);
  for (const item of value) string(item, code);
}

function validateRows(value: unknown, state: { rows: number }, code: string): asserts value is OfficeCell[][] {
  if (!Array.isArray(value)) fail(code);
  state.rows += value.length;
  if (state.rows > MAX_ROWS) fail('OFFICE_ROW_LIMIT_1000');
  for (const row of value) {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) fail('OFFICE_COLUMN_LIMIT_40');
    for (const cell of row) {
      if (cell === null) continue;
      if (typeof cell === 'string') {
        string(cell, 'OFFICE_CELL_TEXT_LIMIT_8000');
        continue;
      }
      if (typeof cell === 'number' && Number.isFinite(cell)) continue;
      if (record(cell) && 'formula' in cell) fail('OFFICE_FORMULAS_NOT_SUPPORTED');
      fail('OFFICE_CELL_VALUE_INVALID');
    }
  }
}

function validateTable(value: unknown, state: { rows: number }, optionalHeaders = false): void {
  if (!record(value)) fail('OFFICE_TABLE_INVALID');
  const allowed = optionalHeaders ? ['name', 'headers', 'rows'] : ['headers', 'rows'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('OFFICE_TABLE_INVALID');
  if ('name' in value && value.name !== undefined) string(value.name, 'OFFICE_SHEET_NAME_INVALID', 100);
  if (!optionalHeaders || value.headers !== undefined) {
    strings(value.headers, 'OFFICE_HEADERS_INVALID', MAX_COLUMNS);
    if (value.headers.length > MAX_COLUMNS) fail('OFFICE_COLUMN_LIMIT_40');
  }
  validateRows(value.rows, state, 'OFFICE_ROWS_INVALID');
}

function validate(input: unknown): asserts input is GenerateOfficeArtifactInput {
  if (!record(input)) fail('OFFICE_INPUT_INVALID');
  const allowed = new Set(['format', 'title', 'paragraphs', 'table', 'sheets', 'slides', 'sources', 'report', 'sections', 'provenance']);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail('OFFICE_INPUT_INVALID');
  if (!['xlsx', 'docx', 'pptx', 'pdf'].includes(String(input.format))) fail('OFFICE_FORMAT_INVALID');
  if (input.title !== undefined) string(input.title, 'OFFICE_TITLE_LIMIT_300', MAX_TITLE_LENGTH);
  if (input.paragraphs !== undefined) strings(input.paragraphs, 'OFFICE_PARAGRAPHS_INVALID');
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || input.sources.length > 32) fail('OFFICE_SOURCE_LIMIT_32');
    for (const source of input.sources) {
      if (!record(source)) fail('OFFICE_SOURCE_INVALID');
      for (const key of ['id', 'title', 'version', 'location']) string(source[key], 'OFFICE_SOURCE_INVALID', 1000);
      strings(source.quotes, 'OFFICE_SOURCE_QUOTES_INVALID', 32);
      for (const key of ['url', 'originalUrl']) if (source[key] !== undefined && safeOfficeSourceUrl(source[key]) !== source[key]) fail('OFFICE_SOURCE_URL_INVALID');
    }
  }
  if (input.sections !== undefined) {
    if (!Array.isArray(input.sections) || input.sections.length > 32) fail('OFFICE_SECTION_LIMIT_32');
    for (const section of input.sections) { if (!record(section)) fail('OFFICE_SECTION_INVALID');string(section.heading, 'OFFICE_SECTION_INVALID', 300);strings(section.paragraphs, 'OFFICE_SECTION_INVALID'); }
  }
  if (input.report !== undefined) {
    if (!record(input.report) || !Array.isArray(input.report.findings) || input.report.findings.length < 1 || input.report.findings.length > 32) fail('OFFICE_REPORT_INVALID');
    if (!['research', 'compliance'].includes(String(input.report.purpose))) fail('OFFICE_REPORT_INVALID');
    string(input.report.scope, 'OFFICE_REPORT_INVALID', 2000);string(input.report.conclusion, 'OFFICE_REPORT_INVALID', 2000);
    const findingCount = input.report.findings.length;
    const sourceIds = new Set((input.sources as OfficeSource[] | undefined)?.map(source => source.id));
    for (const finding of input.report.findings) {
      if (!record(finding) || !sourceIds.has(String(finding.source)) || (finding.requirement && !sourceIds.has(String(finding.requirement)))) fail('OFFICE_REPORT_SOURCE_INVALID');
      for (const key of ['topic', 'assessment', 'analysis', 'missing']) string(finding[key], 'OFFICE_REPORT_INVALID', 2000);
      if (finding.metric !== undefined) {
        const metric = finding.metric;if (!record(metric)) fail('OFFICE_REPORT_METRIC_INVALID');
        for (const key of ['object', 'parameter', 'unit']) string(metric[key], 'OFFICE_REPORT_METRIC_INVALID', 300);
        if (metric.value != null && (typeof metric.value !== 'number' || !Number.isFinite(metric.value))) fail('OFFICE_REPORT_METRIC_INVALID');
        if (metric.calculation !== undefined) {
          const calc = metric.calculation;if (!record(calc) || !['sum', 'difference', 'ratio'].includes(String(calc.operation)) || !Array.isArray(calc.rows) || calc.rows.length < 1 || calc.rows.length > 32 || !calc.rows.every(index => Number.isInteger(index) && index > 0 && index <= findingCount) || (calc.operation !== 'sum' && calc.rows.length !== 2)) fail('OFFICE_REPORT_CALCULATION_INVALID');
        }
      }
    }
  }
  if (input.provenance !== undefined && (!record(input.provenance) || /"(?:password|cookie|authorization|access_token|refresh_token|apiKey|secret)"\s*:/i.test(JSON.stringify(input.provenance)))) fail('OFFICE_PROVENANCE_INVALID');
  const state = { rows: 0 };
  if (input.table !== undefined) validateTable(input.table, state);
  if (input.sheets !== undefined) {
    if (!Array.isArray(input.sheets) || input.sheets.length > MAX_SHEETS) fail('OFFICE_SHEET_LIMIT_30');
    for (const sheet of input.sheets) validateTable(sheet, state, true);
  }
  if (input.slides !== undefined) {
    if (!Array.isArray(input.slides)) fail('OFFICE_SLIDES_INVALID');
    const effectiveSlides = input.slides.length + (input.title && input.slides.length ? 1 : 0);
    if (effectiveSlides > MAX_SLIDES) fail('OFFICE_SLIDE_LIMIT_30');
    for (const slide of input.slides) {
      if (!record(slide) || Object.keys(slide).some((key) => !['title', 'bullets', 'paragraphs'].includes(key)))
        fail('OFFICE_SLIDE_INVALID');
      string(slide.title, 'OFFICE_SLIDE_TITLE_INVALID', MAX_TITLE_LENGTH);
      if (slide.bullets !== undefined) strings(slide.bullets, 'OFFICE_SLIDE_BULLETS_INVALID', MAX_ITEMS_PER_SLIDE);
      if (slide.paragraphs !== undefined)
        strings(slide.paragraphs, 'OFFICE_SLIDE_PARAGRAPHS_INVALID', MAX_ITEMS_PER_SLIDE);
    }
  }
}

function hasVisibleText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasVisibleRows(rows: OfficeCell[][]): boolean {
  return rows.some((row) => row.some((cell) => typeof cell === 'number' || hasVisibleText(cell)));
}

function hasVisibleTable(table: OfficeTable | OfficeSheet | undefined): boolean {
  return Boolean(table && (table.headers?.some(hasVisibleText) || hasVisibleRows(table.rows)));
}

function hasVisibleContent(input: GenerateOfficeArtifactInput): boolean {
  if (input.report?.findings.length || input.sections?.some(section => section.paragraphs.some(hasVisibleText)) || input.sources?.length) return true;
  const titleOrParagraph = hasVisibleText(input.title) || Boolean(input.paragraphs?.some(hasVisibleText));
  if (input.format === 'xlsx') {
    return titleOrParagraph || hasVisibleTable(input.table) || Boolean(input.sheets?.some(hasVisibleTable));
  }
  if (input.format === 'pptx') {
    if (!input.slides?.length) return titleOrParagraph;
    return (
      hasVisibleText(input.title) ||
      input.slides.some(
        (slide) =>
          hasVisibleText(slide.title) ||
          Boolean(slide.paragraphs?.some(hasVisibleText)) ||
          Boolean(slide.bullets?.some(hasVisibleText))
      )
    );
  }
  return titleOrParagraph || hasVisibleTable(input.table);
}

/** Generate a real Office/PDF artifact in memory from bounded structured data. */
export async function generateOfficeArtifact(input: GenerateOfficeArtifactInput, signal?: AbortSignal): Promise<Buffer> {
  let payload: string;
  try {
    payload = JSON.stringify(input);
  } catch {
    fail('OFFICE_INPUT_INVALID');
  }
  if (!payload || Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) fail('OFFICE_INPUT_LIMIT_64KB');
  validate(input);
  if (!hasVisibleContent(input)) fail('OFFICE_CONTENT_REQUIRED');
  const configured = process.env.ZHENWORK_OFFICE_PYTHON?.trim();
  const python = configured || DEFAULT_PYTHON;
  if (!python.startsWith('/') || python.includes('\0')) fail('OFFICE_PYTHON_PATH_INVALID');
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-c', WORKBOOK_SUPPORT_PYTHON + PYTHON_SCRIPT + PYTHON_LAYOUT + PYTHON_TAIL],
      {
        signal, killSignal: 'SIGKILL',
        encoding: 'buffer',
        timeout: 20_000,
        maxBuffer: MAX_OUTPUT_BYTES + 1,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (signal?.aborted) reject(new Error('OFFICE_GENERATION_CANCELLED'));
          else if (code === 'ENOENT') reject(new Error('OFFICE_PYTHON_UNAVAILABLE'));
          else if ((error as Error & { killed?: boolean }).killed) reject(new Error('OFFICE_GENERATION_TIMEOUT'));
          else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error('OFFICE_OUTPUT_LIMIT_10MB'));
          else {
            const safe = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
            const category = /^OFFICE_GENERATION_FAILED:([A-Za-z_][A-Za-z0-9_]{0,79})(?:\r?\n|$)/.exec(safe)?.[1];
            reject(new Error(category ? `OFFICE_GENERATION_FAILED:${category}` : 'OFFICE_GENERATION_FAILED'));
          }
          return;
        }
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (!bytes.length) reject(new Error('OFFICE_GENERATION_EMPTY'));
        else if (bytes.length > MAX_OUTPUT_BYTES) reject(new Error('OFFICE_OUTPUT_LIMIT_10MB'));
        else resolve(bytes);
      }
    );
    child.stdin?.once('error', () => reject(new Error('OFFICE_GENERATION_FAILED')));
    child.stdin?.end(payload, 'utf8');
  });
}
