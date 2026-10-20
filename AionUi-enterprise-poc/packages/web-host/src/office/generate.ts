import { execFile } from 'node:child_process';

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

def xlsx(data):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb=Workbook()
    wb.remove(wb.active)
    wb.properties.title=data.get('title') or ''
    definitions=data.get('sheets') or []
    if not definitions:
        table=data.get('table') or {'headers':[],'rows':[]}
        definitions=[{'name':'Sheet1','headers':table.get('headers',[]),'rows':table.get('rows',[]),'intro':True}]
    used=set()
    for index,item in enumerate(definitions,1):
        raw=text(item.get('name') or ('Sheet'+str(index)))
        name=''.join('_' if char in '[]:*?/\\' else char for char in raw).strip(" '")[:31] or ('Sheet'+str(index))
        base=name;counter=2
        while name.lower() in used:
            suffix='_'+str(counter);name=base[:31-len(suffix)]+suffix;counter+=1
        used.add(name.lower())
        ws=wb.create_sheet(name)
        row_number=1
        widths={}
        headers=item.get('headers') or []
        rows=item.get('rows') or []
        intro=index==1
        width=max(1,len(headers),max((len(row) for row in rows),default=0))
        def put(row,column,value,bold=False,fill=None,size=None):
            cell=ws.cell(row=row,column=column)
            if isinstance(value,str):
                cell.value=value
                cell.data_type='s'
            else:
                cell.value=value
            cell.alignment=Alignment(vertical='top',wrap_text=True)
            cell.font=Font(name='Microsoft YaHei',bold=bold,size=size)
            if fill: cell.fill=PatternFill('solid',fgColor=fill)
            lengths=[len(part) for part in text(value).splitlines()] or [0]
            widths[column]=max(widths.get(column,0),min(48,max(lengths)))
            return cell
        if intro and data.get('title'):
            put(row_number,1,data['title'],bold=True,size=16)
            if width>1: ws.merge_cells(start_row=row_number,start_column=1,end_row=row_number,end_column=width)
            row_number+=1
        if intro:
            for paragraph in data.get('paragraphs') or []:
                put(row_number,1,paragraph)
                if width>1: ws.merge_cells(start_row=row_number,start_column=1,end_row=row_number,end_column=width)
                row_number+=1
            if (data.get('title') or data.get('paragraphs')) and (headers or rows): row_number+=1
        header_row=None
        if headers:
            header_row=row_number
            for column,value in enumerate(headers,1):
                cell=put(row_number,column,value,bold=True,fill='1F4E78')
                cell.font=Font(name='Microsoft YaHei',bold=True,color='FFFFFF')
            row_number+=1
        for row in rows:
            for column,value in enumerate(row,1): put(row_number,column,value)
            row_number+=1
        if header_row:
            ws.freeze_panes='A'+str(header_row+1)
            ws.auto_filter.ref='A'+str(header_row)+':'+get_column_letter(max(1,len(headers)))+str(max(header_row,row_number-1))
        for column in range(1,width+1): ws.column_dimensions[get_column_letter(column)].width=max(10,widths.get(column,0)+2)
    if not wb.worksheets: wb.create_sheet('Sheet1')
    output=io.BytesIO();wb.save(output);return output.getvalue()

def docx(data):
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt
    document=Document()
    document.core_properties.title=data.get('title') or ''
    for style_name,size in [('Normal',10.5),('Title',22),('Heading 1',16)]:
        style=document.styles[style_name]
        style.font.name='Microsoft YaHei';style.font.size=Pt(size)
        style._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
    def format_paragraph(paragraph,bold=False):
        for run in paragraph.runs:
            run.font.name='Microsoft YaHei';run.font.bold=bold
            run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
    if data.get('title'): format_paragraph(document.add_heading(data['title'],0),True)
    for value in data.get('paragraphs') or []: format_paragraph(document.add_paragraph(value))
    table_data=data.get('table')
    if table_data:
        headers=table_data.get('headers') or [];rows=table_data.get('rows') or []
        columns=max(1,len(headers),max((len(row) for row in rows),default=0))
        table=document.add_table(rows=0,cols=columns);table.style='Table Grid'
        if headers:
            cells=table.add_row().cells
            for index,value in enumerate(headers):
                cells[index].text=value
                shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'D9EAF7');cells[index]._tc.get_or_add_tcPr().append(shade)
                for paragraph in cells[index].paragraphs: format_paragraph(paragraph,True)
        for row in rows:
            cells=table.add_row().cells
            for index,value in enumerate(row):
                cells[index].text=text(value)
                for paragraph in cells[index].paragraphs: format_paragraph(paragraph)
    if not document.paragraphs and not document.tables: document.add_paragraph('')
    output=io.BytesIO();document.save(output);return output.getvalue()

def pptx(data):
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
    sys.stderr.write('OFFICE_GENERATION_FAILED:'+type(error).__name__)
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
  const allowed = new Set(['format', 'title', 'paragraphs', 'table', 'sheets', 'slides']);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail('OFFICE_INPUT_INVALID');
  if (!['xlsx', 'docx', 'pptx', 'pdf'].includes(String(input.format))) fail('OFFICE_FORMAT_INVALID');
  if (input.title !== undefined) string(input.title, 'OFFICE_TITLE_LIMIT_300', MAX_TITLE_LENGTH);
  if (input.paragraphs !== undefined) strings(input.paragraphs, 'OFFICE_PARAGRAPHS_INVALID');
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
export async function generateOfficeArtifact(input: GenerateOfficeArtifactInput): Promise<Buffer> {
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
      ['-c', PYTHON_SCRIPT],
      {
        encoding: 'buffer',
        timeout: 20_000,
        maxBuffer: MAX_OUTPUT_BYTES + 1,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') reject(new Error('OFFICE_PYTHON_UNAVAILABLE'));
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
