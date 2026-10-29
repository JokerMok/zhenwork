import { execFile } from 'node:child_process';
import { WORKBOOK_SUPPORT_PYTHON } from '../workbook/script.js';
import { OFFICE_PRESENTATION_PYTHON } from '../delivery/presentationScript.js';
import { NATIVE_PRESENTATION_PYTHON } from './nativeScript.js';

const helpers = String.raw`
def extract_evidence(content,word):
    import openpyxl
    from docx import Document
    def meta(raw):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:return json.loads(PX.fromstring(z.read(PROVENANCE_PART)).text)
    provenance=meta(content)
    if provenance!=meta(word) or not provenance.get('dataSha256'):raise ValueError('PPT_SOURCE_PAIR_PROVENANCE_MISMATCH')
    wb=openpyxl.load_workbook(io.BytesIO(content),data_only=True)
    if '核查清单' not in wb or '参数对比' not in wb:raise ValueError('PPT_VERIFIED_COMPLIANCE_PAIR_REQUIRED')
    main=wb['参数对比'];title=str(main.cell(1,1).value or '');scope=str(main.cell(2,1).value or '')
    params={}
    for row in main.iter_rows(values_only=True):
        if isinstance(row[0],int):
            val=row[3]
            if val is None:raise ValueError('PPT_SOURCE_PARAMETER_EMPTY')
            if hasattr(val,'isoformat'):val=val.date().isoformat() if hasattr(val,'date') else val.isoformat()
            params[row[0]]={'object':str(row[1] or ''),'parameter':str(row[2] or ''),'value':None if val=='未提供' else val,'unit':str(row[4] or '')}
    findings=[];used=set()
    for row in wb['核查清单'].iter_rows(values_only=True):
        if not isinstance(row[0],int):continue
        index=row[0];used.add(index);item={'rowType':'requirement','topic':str(row[1]),'assessment':str(row[2]),'requirement':str(row[3]),'source':str(row[4]),'analysis':str(row[5] or ''),'missing':str(row[6] or '')}
        if not re.fullmatch(r'S\d+',item['requirement']):item.pop('requirement')
        if index in params:item['metric']=params[index]
        findings.append(item)
    for index,m in params.items():
        if index not in used:
            source=next(str(row[5]) for row in main.iter_rows(values_only=True) if row[0]==index)
            findings.append({'rowType':'context','topic':m['object']+' · '+m['parameter'],'assessment':'背景说明','source':source,'analysis':'固定成果参数快照；不计正式符合率。','missing':'原成果未提供' if m['value'] is None else '', 'metric':m})
    conclusion=str(wb['分析与缺项'].cell(2,1).value or '') if '分析与缺项' in wb else ''
    doc=Document(io.BytesIO(word));paragraphs='\n'.join(p.text for p in doc.paragraphs)
    for item in findings:
        if item['rowType']=='requirement' and (item['topic'] not in paragraphs or '核查结论：'+item['assessment'] not in paragraphs):raise ValueError('PPT_SOURCE_PAIR_STATUS_MISMATCH')
    if params:
        if not doc.tables:raise ValueError('PPT_WORD_PARAMETERS_MISSING')
        expected=[((m['object']+' · '+m['parameter']), '未提供' if m['value'] is None else str(m['value'])+' '+m['unit']) for m in params.values()]
        rows=[tuple(c.text.strip() for c in row.cells[:2]) for row in doc.tables[0].rows][1:]
        if len(rows)!=len(expected):raise ValueError('PPT_SOURCE_PAIR_PARAMETER_COUNT')
        for actual,wanted in zip(rows,expected):
            if actual[0]!=wanted[0] or actual[1].strip()!=wanted[1].strip():raise ValueError('PPT_SOURCE_PAIR_PARAMETER_MISMATCH')
    if not 1<=len(findings)<=64:raise ValueError('PPT_RESULT_ROW_LIMIT')
    return {'title':title,'report':{'purpose':'compliance','scope':scope,'conclusion':conclusion,'findings':findings},'provenance':provenance}
try:
    import resource
    if sys.platform!='darwin':resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,384*1024*1024))
    resource.setrlimit(resource.RLIMIT_CPU,(25,25))
except ImportError:pass
try:
    raw=sys.stdin.buffer.read(32000001)
    if len(raw)>32000000:raise ValueError('PPT_REQUEST_LIMIT')
    request=json.loads(raw);mode=request['mode'];content=base64.b64decode(request.get('content',''),validate=True)
    if mode=='inspect':result=ppt_inspect(content)
    elif mode=='template':
        ppt_package(content,True);prs=Presentation(io.BytesIO(content))
        if len(prs.slides)>30 or abs(prs.slide_width/prs.slide_height-16/9)>.02:raise ValueError('PPT_TEMPLATE_16_9_REQUIRED')
        result={'valid':True,'slideCount':len(prs.slides),'layouts':[x.name for x in prs.slide_layouts]}
    elif mode=='extract':result=extract_evidence(content,base64.b64decode(request['word'],validate=True))
    else:raise ValueError('PPT_OPERATION_INVALID')
    print(json.dumps({'result':result},ensure_ascii=False,default=str))
except Exception as e:
    print(json.dumps({'error':str(e)[:180] if isinstance(e,ValueError) else type(e).__name__}));sys.exit(2)
`;

/** Runs bounded parser/quality checks in the existing Office virtual environment. */
export async function presentationPython<T = Record<string, unknown>>(
  mode: 'inspect' | 'template' | 'extract',
  bytes: Buffer,
  options: { word?: Buffer; signal?: AbortSignal } = {}
): Promise<T> {
  if (bytes.length > 10 * 1024 * 1024 || (options.word?.length || 0) > 10 * 1024 * 1024)
    throw new Error('PPT_INPUT_LIMIT_10MB');
  const python = process.env.ZHENWORK_OFFICE_PYTHON?.trim() || '/opt/zhenwork-office/bin/python';
  if (!python.startsWith('/') || python.includes('\0')) throw new Error('OFFICE_PYTHON_PATH_INVALID');
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      [
        '-c',
        WORKBOOK_SUPPORT_PYTHON +
          '\n' +
          OFFICE_PRESENTATION_PYTHON +
          '\n' +
          NATIVE_PRESENTATION_PYTHON +
          '\n' +
          helpers,
      ],
      {
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        signal: options.signal,
        killSignal: 'SIGKILL',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      },
      (error, stdout) => {
        if (options.signal?.aborted) return reject(new Error('PPT_CANCELLED'));
        try {
          const data = JSON.parse(stdout);
          if (error || data.error) reject(new Error('PPT_OPERATION_FAILED:' + String(data.error || 'execution')));
          else resolve(data.result as T);
        } catch {
          reject(new Error('PPT_PROCESSOR_UNAVAILABLE'));
        }
      }
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(
      JSON.stringify({ mode, content: bytes.toString('base64'), word: options.word?.toString('base64') })
    );
  });
}

export const presentationTool = {
  name: 'create_business_presentation',
  description:
    'Generate an editable PPT from an EXISTING verified business result. Monthly analysis: pass analysisId from inspect_waste_analysis, never re-analyze or retype numbers. Compliance/selection: pass evidencePath to the already verified current XLSX; the server verifies its linked Word, immutable delivery hashes, formal statuses, parameters and current source permissions. Optional templateId selects an authorized published enterprise presentation-template Skill; otherwise the one default or stable built-in theme. No slides/numbers/assessment arguments: data, charts, conditions and sources come from the saved result. Returns actual PPT receipt plus related Word/Excel fixed versions. Partial Agent history is not rewritten. Use inspect_office_document then revise_office_document with current SHA for later PPT edits.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      analysisId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      evidencePath: { type: 'string', maxLength: 200 },
      path: { type: 'string', maxLength: 200 },
      templateId: { type: 'string', format: 'uuid' },
      overwrite: { type: 'boolean' },
    },
    oneOf: [
      { required: ['analysisId'], not: { required: ['evidencePath'] } },
      { required: ['evidencePath'], not: { required: ['analysisId'] } },
    ],
  },
};
