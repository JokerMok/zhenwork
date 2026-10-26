import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type ReadOfficeDocumentOptions = { start?: number; limit?: number };

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_PYTHON = '/opt/zhenwork-office/bin/python';
const SUPPORTED = new Map<string, string>([
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.pdf', 'pdf'],
  ['.txt', 'txt'],
  ['.csv', 'csv'],
  ['.md', 'md'],
  ['.json', 'json'],
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.webp', 'image'],
  ['.tif', 'image'],
  ['.tiff', 'image'],
  ['.bmp', 'image'],
]);
const LEGACY = new Set(['.doc', '.xls', '.ppt']);

const PYTHON_SCRIPT = String.raw`import datetime,hashlib,io,json,math,os,re,subprocess,sys,tempfile,zipfile

MAX_INPUT=50*1024*1024
MAX_EXPANDED=200*1024*1024
MAX_OUTPUT=256*1024
TEXT_BUDGET=96*1024
ROW_LIMIT=100
COLUMN_LIMIT=40
TEXT_CHUNK=16000

class OfficeExpansionLimit(Exception): pass
class OfficePartLimit(Exception): pass
class OfficeOutputLimit(Exception): pass
class PdfToolError(Exception): pass
class OcrToolError(Exception): pass
class TextEncodingUnsupported(Exception): pass

budget=[TEXT_BUDGET]

def clipped(value,maximum=4000):
    if value is None: value=''
    if not isinstance(value,str): value=str(value)
    raw=value.encode('utf-8','replace')
    allowed=max(0,min(maximum,budget[0]))
    piece=raw[:allowed]
    while piece:
        try:
            text=piece.decode('utf-8');break
        except UnicodeDecodeError: piece=piece[:-1]
    else: text=''
    budget[0]-=len(piece)
    return text,len(piece)<len(raw)

def safe_cell(value):
    if value is None or isinstance(value,(str,bool,int)): return value
    if isinstance(value,float): return value if math.isfinite(value) else str(value)
    if isinstance(value,(datetime.date,datetime.datetime,datetime.time)): return value.isoformat()
    return str(value)

def bounded_rows(rows,total_rows,total_columns):
    result=[];cell_truncated=False
    for row in rows[:ROW_LIMIT]:
        values=[]
        for value in row[:COLUMN_LIMIT]:
            text,cut=clipped(safe_cell(value),2000) if isinstance(safe_cell(value),str) else (safe_cell(value),False)
            values.append(text);cell_truncated=cell_truncated or cut
        result.append(values)
    return {
        'rows':result,'rowCount':total_rows,'columnCount':total_columns,
        'returnedRows':len(result),'returnedColumns':min(total_columns,COLUMN_LIMIT),
        'truncatedRows':total_rows>ROW_LIMIT,'truncatedColumns':total_columns>COLUMN_LIMIT,
        'omittedRowRange':{'start':ROW_LIMIT+1,'end':total_rows} if total_rows>ROW_LIMIT else None,
        'omittedColumnRange':{'start':COLUMN_LIMIT+1,'end':total_columns} if total_columns>COLUMN_LIMIT else None,
        'cellTextTruncated':cell_truncated,
    }

def zip_guard(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos=archive.infolist()
        if len(infos)>10000: raise OfficePartLimit()
        if sum(item.file_size for item in infos)>MAX_EXPANDED: raise OfficeExpansionLimit()

def result(fmt,total,start,limit,locations,extra=None):
    end=min(total,start+limit)
    value={
        'format':fmt,'sourceSha256':hashlib.sha256(source).hexdigest(),
        'start':start,'limit':limit,'totalLocations':total,'locations':locations,
        'truncated':end<total,'nextStart':end if end<total else None,
    }
    if extra: value.update(extra)
    return value

def docx_read(raw,start,limit):
    zip_guard(raw)
    from docx import Document
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    document=Document(io.BytesIO(raw));blocks=[];paragraph_number=0;table_number=0
    for child in document.element.body.iterchildren():
        if isinstance(child,CT_P):
            paragraph_number+=1;paragraph=Paragraph(child,document)
            if paragraph.text.strip(): blocks.append(('paragraph',paragraph_number,paragraph))
        elif isinstance(child,CT_Tbl):
            table_number+=1;blocks.append(('table',table_number,Table(child,document)))
    locations=[]
    for kind,number,item in blocks[start:start+limit]:
        if kind=='paragraph':
            text,cut=clipped(item.text)
            links=[]
            from docx.oxml.ns import qn
            for hyperlink in item._p.iter(qn('w:hyperlink')):
                relationship=document.part.rels.get(hyperlink.get(qn('r:id')))
                if relationship is not None and relationship.is_external:
                    links.append({'text':''.join(t.text or '' for t in hyperlink.iter(qn('w:t'))),'url':relationship.target_ref})
            locations.append({'location':{'kind':'paragraph','paragraph':number},'text':text,'textTruncated':cut,'links':links[:32]})
        else:
            rows=[]
            for row in item.rows[:ROW_LIMIT]: rows.append([cell.text for cell in row.cells[:COLUMN_LIMIT]])
            columns=max((len(row.cells) for row in item.rows),default=0)
            table=bounded_rows(rows,len(item.rows),columns)
            table['location']={'kind':'table','table':number};locations.append(table)
    return result('docx',len(blocks),start,limit,locations,{
        'locationModel':'Non-empty paragraphs and tables in document order; paragraph/table numbers are physical OOXML order.',
        'tableLimits':{'rows':ROW_LIMIT,'columns':COLUMN_LIMIT},
    })

def xlsx_read(raw,start,limit):
    zip_guard(raw)
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter
    workbook=load_workbook(io.BytesIO(raw),read_only=True,data_only=False,keep_links=False)
    names=workbook.sheetnames;applied=min(limit,3);locations=[]
    try:
        for sheet_index in range(start,min(len(names),start+applied)):
            worksheet=workbook[names[sheet_index]]
            total_rows=max(0,int(worksheet.max_row or 0));total_columns=max(0,int(worksheet.max_column or 0))
            returned_rows=min(total_rows,ROW_LIMIT);returned_columns=min(total_columns,COLUMN_LIMIT)
            rows=[];formula_count=0;cell_truncated=False
            if returned_rows and returned_columns and worksheet.sheet_state == 'visible':
                for row in worksheet.iter_rows(min_row=1,max_row=returned_rows,min_col=1,max_col=returned_columns):
                    values=[]
                    for cell in row:
                        value=safe_cell(cell.value)
                        if cell.data_type=='f' or (isinstance(value,str) and value.startswith('=')): formula_count+=1
                        if isinstance(value,str): value,cut=clipped(value,2000);cell_truncated=cell_truncated or cut
                        values.append(value)
                    rows.append(values)
            locations.append({
                'location':{'kind':'worksheet','worksheet':sheet_index+1,'name':names[sheet_index]},
                'rows':rows,'rowCount':total_rows,'columnCount':total_columns,
                'state':worksheet.sheet_state,'hiddenDataOmitted':worksheet.sheet_state != 'visible',
                'returnedRows':len(rows),'returnedColumns':returned_columns,
                'truncatedRows':total_rows>ROW_LIMIT,'truncatedColumns':total_columns>COLUMN_LIMIT,
                'omittedRowRange':{'start':ROW_LIMIT+1,'end':total_rows} if total_rows>ROW_LIMIT else None,
                'omittedColumnRange':{'start':get_column_letter(COLUMN_LIMIT+1),'end':get_column_letter(total_columns)} if total_columns>COLUMN_LIMIT else None,
                'formulaCellCountInReturnedRange':formula_count,'cellTextTruncated':cell_truncated,
            })
    finally: workbook.close()
    end=min(len(names),start+applied)
    return {
        'format':'xlsx','sourceSha256':hashlib.sha256(raw).hexdigest(),'start':start,'limit':limit,
        'appliedSheetLimit':applied,'totalLocations':len(names),'locations':locations,
        'truncated':end<len(names),'nextStart':end if end<len(names) else None,
        'locationModel':'Worksheets in workbook order; worksheet numbers and row/column ranges are physical.',
        'formulaPolicy':'Formula strings are original workbook formulas (data_only=False); formulas are not evaluated and cached values are not claimed.',
        'sheetLimit':3,'rowLimitPerSheet':ROW_LIMIT,'columnLimitPerSheet':COLUMN_LIMIT,
    }

def table_from_pptx(table,shape_path):
    from itertools import islice
    rows=[[cell.text for cell in islice(row.cells,COLUMN_LIMIT)] for row in islice(table.rows,ROW_LIMIT)]
    value=bounded_rows(rows,len(table.rows),len(table.columns));value['shape']=shape_path;return value

def pptx_read(raw,start,limit):
    zip_guard(raw)
    from pptx import Presentation
    presentation=Presentation(io.BytesIO(raw));total=len(presentation.slides);locations=[]
    def walk(shapes,prefix=''):
        for index,shape in enumerate(shapes,1):
            shape_path=(prefix+'.' if prefix else '')+str(index);yield shape_path,shape
            nested=getattr(shape,'shapes',None)
            if nested is not None: yield from walk(nested,shape_path)
    for slide_index in range(start,min(total,start+limit)):
        slide=presentation.slides[slide_index];texts=[];tables=[]
        for shape_path,shape in walk(slide.shapes):
            if getattr(shape,'has_text_frame',False):
                for paragraph_index,paragraph in enumerate(shape.text_frame.paragraphs,1):
                    if not paragraph.text.strip(): continue
                    text,cut=clipped(paragraph.text)
                    texts.append({'shape':shape_path,'paragraph':paragraph_index,'text':text,'textTruncated':cut})
            if getattr(shape,'has_table',False): tables.append(table_from_pptx(shape.table,shape_path))
        locations.append({'location':{'kind':'slide','slide':slide_index+1},'texts':texts,'tables':tables})
    return result('pptx',total,start,limit,locations,{
        'locationModel':'Slides use one-based physical presentation order; shape paths are one-based within each slide/group.',
        'tableLimits':{'rows':ROW_LIMIT,'columns':COLUMN_LIMIT},
    })

def command(arguments,input_bytes=None,timeout=20):
    try: completed=subprocess.run(arguments,input=input_bytes,capture_output=True,timeout=timeout)
    except FileNotFoundError: raise ModuleNotFoundError()
    except subprocess.TimeoutExpired: raise TimeoutError()
    if completed.returncode!=0: raise PdfToolError()
    return completed.stdout

def ocr_file(filename):
    try: completed=subprocess.run(['tesseract',filename,'stdout','-l','chi_sim+eng'],capture_output=True,timeout=20)
    except FileNotFoundError: raise ModuleNotFoundError()
    except subprocess.TimeoutExpired: raise TimeoutError()
    if completed.returncode!=0: raise OcrToolError()
    return completed.stdout.decode('utf-8','replace').strip()

def pdf_read(raw,start,limit):
    info=command(['pdfinfo','-'],raw);match=re.search(rb'^Pages:\s*(\d+)\s*$',info,re.M)
    if not match: raise PdfToolError()
    total=int(match.group(1));locations=[];temporary=None;pdf_path=None
    try:
        for page_index in range(start,min(total,start+limit)):
            physical=page_index+1
            extracted=command(['pdftotext','-f',str(physical),'-l',str(physical),'-','-'],raw).decode('utf-8','replace').strip()
            sparse=len(re.sub(r'\s+','',extracted))<80;ocr_text='';ocr_used=False
            if sparse:
                if temporary is None:
                    temporary=tempfile.TemporaryDirectory(prefix='zhenwork-office-read-');os.chmod(temporary.name,0o700)
                    pdf_path=os.path.join(temporary.name,'source.pdf')
                    with open(pdf_path,'wb') as handle: handle.write(raw)
                    os.chmod(pdf_path,0o600)
                output_root=os.path.join(temporary.name,'page-'+str(physical))
                command(['pdftoppm','-f',str(physical),'-l',str(physical),'-singlefile','-scale-to','1800','-png',pdf_path,output_root],timeout=25)
                image_path=output_root+'.png';ocr_text=ocr_file(image_path)
                ocr_used=len(ocr_text)>len(extracted)
            chosen=ocr_text if ocr_used else extracted;text,cut=clipped(chosen,40000)
            locations.append({
                'location':{'kind':'page','physicalPage':physical},'text':text,
                'method':'ocr' if ocr_used else 'pdftotext','textTruncated':cut,
                'ocrAttempted':sparse,'ocrReviewRequired':ocr_used,
                'pdftotextLength':len(extracted),'ocrLength':len(ocr_text) if sparse else None,
            })
    finally:
        if temporary is not None: temporary.cleanup()
    return result('pdf',total,start,limit,locations,{
        'locationModel':'Pages use one-based physical PDF page numbers.',
        'ocrPolicy':'Pages with fewer than 80 non-whitespace extracted characters are rendered with pdftoppm scale-to 1800 and OCRed with chi_sim+eng; OCR output requires review.',
    })

def image_read(raw,start,limit):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS=40000000
    image=Image.open(io.BytesIO(raw));image.load();width,height=image.size;locations=[]
    if start==0 and limit>0:
        with tempfile.TemporaryDirectory(prefix='zhenwork-image-read-') as directory:
            os.chmod(directory,0o700);copy=image.copy();copy.thumbnail((1800,1800))
            image_path=os.path.join(directory,'image.png');copy.save(image_path,'PNG');os.chmod(image_path,0o600)
            recognized=ocr_file(image_path);text,cut=clipped(recognized,45000)
        locations=[{'location':{'kind':'image','image':1},'text':text,'method':'ocr','ocrReviewRequired':True,'textTruncated':cut,'width':width,'height':height}]
    return result('image',1,start,limit,locations,{
        'mediaType':sys.argv[4],'locationModel':'A single image is physical image 1; OCR output requires review.',
    })

def text_read(raw,fmt,start,limit):
    try: text=raw.decode('utf-8-sig')
    except UnicodeDecodeError: raise TextEncodingUnsupported()
    total=max(1,(len(text)+TEXT_CHUNK-1)//TEXT_CHUNK);locations=[]
    for chunk_index in range(start,min(total,start+limit)):
        begin=chunk_index*TEXT_CHUNK;end=min(len(text),begin+TEXT_CHUNK);value,cut=clipped(text[begin:end],TEXT_CHUNK*4)
        locations.append({
            'location':{'kind':'text_chunk','chunk':chunk_index+1,'characterStart':begin,'characterEnd':end,
                'lineStart':text.count('\n',0,begin)+1,'lineEnd':text.count('\n',0,end)+1},
            'text':value,'textTruncated':cut,
        })
    return result(fmt,total,start,limit,locations,{
        'locationModel':'Text is split into 16,000-character chunks; character offsets are zero-based and line numbers are one-based.',
        'chunkCharacters':TEXT_CHUNK,
    })

try:
    if len(sys.argv)>5 and sys.argv[5]=='preview' and sys.platform=='linux':
        import resource
        resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,384*1024*1024))
        resource.setrlimit(resource.RLIMIT_CPU,(15,15))
    fmt=sys.argv[1];start=int(sys.argv[2]);limit=int(sys.argv[3])
    source=sys.stdin.buffer.read(MAX_INPUT+1)
    if len(source)>MAX_INPUT: raise OverflowError()
    if fmt in ('docx','xlsx','pptx'): value={'docx':docx_read,'xlsx':xlsx_read,'pptx':pptx_read}[fmt](source,start,limit)
    elif fmt=='pdf': value=pdf_read(source,start,limit)
    elif fmt=='image': value=image_read(source,start,limit)
    else: value=text_read(source,fmt,start,limit)
    encoded=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf-8')
    if len(encoded)>MAX_OUTPUT: raise OfficeOutputLimit()
    sys.stdout.buffer.write(encoded)
except Exception as error:
    sys.stderr.write('OFFICE_READ_FAILED:'+type(error).__name__)
    sys.exit(2)
`;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOptions(options: ReadOfficeDocumentOptions | undefined): { start: number; limit: number } {
  if (
    options !== undefined &&
    (!isRecord(options) || Object.keys(options).some((key) => !['start', 'limit'].includes(key)))
  )
    fail('OFFICE_READ_OPTIONS_INVALID');
  const start = options?.start ?? 0;
  const limit = options?.limit ?? 5;
  if (!Number.isSafeInteger(start) || start < 0 || start > 1_000_000) fail('OFFICE_READ_START_INVALID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) fail('OFFICE_READ_LIMIT_1_TO_5');
  return { start, limit };
}

/** Read bounded, location-aware text and tables from a supported document held in memory. */
export async function readOfficeDocument(
  name: string,
  bytes: Buffer,
  options?: ReadOfficeDocumentOptions,
  previewLimits = false
): Promise<Record<string, unknown>> {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) fail('OFFICE_READ_NAME_REQUIRED');
  if (!Buffer.isBuffer(bytes)) fail('OFFICE_READ_BYTES_REQUIRED');
  if (bytes.length > MAX_INPUT_BYTES) fail('OFFICE_READ_INPUT_LIMIT_50MB');
  const extension = path.extname(name).toLowerCase();
  if (LEGACY.has(extension)) fail('OFFICE_LEGACY_FORMAT_UNSUPPORTED');
  const format = SUPPORTED.get(extension);
  if (!format) fail('OFFICE_READ_FORMAT_UNSUPPORTED');
  const { start, limit } = readOptions(options);
  const configured = process.env.ZHENWORK_OFFICE_PYTHON?.trim();
  const python = configured || DEFAULT_PYTHON;
  if (!python.startsWith('/') || python.includes('\0')) fail('OFFICE_PYTHON_PATH_INVALID');
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      [
        '-c',
        PYTHON_SCRIPT,
        format,
        String(start),
        String(limit),
        extension.slice(1),
        ...(previewLimits ? ['preview'] : []),
      ],
      {
        encoding: 'buffer',
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES + 1,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') reject(new Error('OFFICE_PYTHON_UNAVAILABLE'));
          else if ((error as Error & { killed?: boolean }).killed) reject(new Error('OFFICE_READ_TIMEOUT'));
          else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error('OFFICE_READ_OUTPUT_LIMIT_256KB'));
          else {
            const safe = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
            const category = /^OFFICE_READ_FAILED:([A-Za-z_][A-Za-z0-9_]{0,79})(?:\r?\n|$)/.exec(safe)?.[1];
            reject(new Error(category ? `OFFICE_READ_FAILED:${category}` : 'OFFICE_READ_FAILED'));
          }
          return;
        }
        const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (!output.length) {
          reject(new Error('OFFICE_READ_EMPTY_RESULT'));
          return;
        }
        if (output.length > MAX_OUTPUT_BYTES) {
          reject(new Error('OFFICE_READ_OUTPUT_LIMIT_256KB'));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(output.toString('utf8'));
          if (
            !isRecord(parsed) ||
            parsed.sourceSha256 !== sourceSha256 ||
            parsed.format !== format ||
            !Array.isArray(parsed.locations)
          )
            throw new Error('invalid');
          resolve({ ...parsed, sourceName: path.basename(name) });
        } catch {
          reject(new Error('OFFICE_READ_RESULT_INVALID'));
        }
      }
    );
    if (!child.stdin) {
      reject(new Error('OFFICE_READ_FAILED'));
      return;
    }
    child.stdin.once('error', () => reject(new Error('OFFICE_READ_FAILED')));
    child.stdin.end(bytes);
  });
}
