import { spawn } from 'node:child_process';
import { WORKBOOK_SUPPORT_PYTHON } from '../script.js';
import { OFFICE_PRESENTATION_PYTHON } from '../../delivery/presentationScript.js';
import { PARSER_PYTHON } from './parserScript.js';
import { COMPUTE_PYTHON } from './computeScript.js';
import { REPORT_PYTHON } from './reportScript.js';

export type Fields = Record<string, number>;
export interface Mapping {
  sheet: string;
  headerRow: number;
  fields: Fields;
  defaultUnit?: string;
  version: number;
  confirmed: boolean;
}
export interface Definition {
  kind: 'WASTE_MONTHLY';
  meaning: string;
  scope: string;
  grain: 'business_record_id';
  timeField: 'business_date';
  period: 'calendar_month_Asia_Shanghai';
  duplicateRule: 'identical_first' | 'block';
  precision: number;
  unitFactors: Record<string, string>;
  includeNodes: string[];
  nodeAliases: Record<string, string>;
  sourceAliases: Record<string, string>;
  categoryAliases: Record<string, string>;
  organizationAliases: Record<string, string>;
  allowedOrganizations: string[];
  statusAliases: Record<string, 'active' | 'cancelled' | 'reversal'>;
  summaryRows: 'exclude_with_warning';
  reversal: 'block';
  negative: 'block';
}
export interface Policy {
  id: string;
  name: string;
  version: number;
  definition: Definition;
}
export interface Sheet {
  name: string;
  headerRow: number;
  columns: string[];
  rowCount: number;
  mapping: Fields;
  unitHint?: string;
  ambiguities: string[];
  sample: Array<{ row: number; values: string[] }>;
  sampleIsPreviewOnly: true;
}
export interface Structure {
  sheets: Sheet[];
  meta: { encoding?: string; delimiter?: string; formulaErrors: Issue[] };
  budget: Record<string, number>;
  sha256: string;
}
export interface Issue {
  sheet: string;
  row: number;
  field?: string;
  code: string;
  severity: 'blocker' | 'warning';
  handling: string;
}
export interface Result {
  status: 'validated' | 'blocked';
  completeScan: true;
  rowCount: number;
  includedCount: number;
  excludedCount: number;
  invalidCount: number;
  blockerCount: number;
  warningCount: number;
  counts: Record<string, number>;
  period: string;
  rounding: string;
  timeBasis: string;
  limitations: string[];
  summary: null | {
    weightKg: string;
    weightTon: string;
    byCategory: Array<{ name: string; weightKg: string; percent: string | null }>;
    bySource: Array<{ name: string; weightKg: string; percent: string | null }>;
    trend: Array<{ month: string; weightKg: string }>;
  };
  issues: Issue[];
  rows: Array<{
    sheet: string;
    row: number;
    outcome: string;
    reason: string;
    original: string[];
    weightKg?: string;
  }>;
}
export type Options = { sheet?: string; headerRow?: number; encoding?: string; delimiter?: string };
let active = false;
const entry = String.raw`
import sys,base64,resource,os
def text(value):return '' if value is None else str(value)
if sys.platform=='linux':
 resource.setrlimit(resource.RLIMIT_AS,(640*1024*1024,640*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(55,55))
try:
 request=json.loads(sys.stdin.read(32*1024*1024))
 raw=base64.b64decode(request.get('file',''),validate=True)
 action=request['action']
 if action=='inspect':out=ds_structure(raw,request['name'],request.get('options',{}))
 elif action=='compute':out=ds_compute(raw,request['name'],request.get('options',{}),request['mapping'],request['rule'],request['period'])
 elif action=='report':out=ds_report(request['data'])
 else:raise ValueError('DATA_ACTION_INVALID')
 print(json.dumps({'data':out},ensure_ascii=False,separators=(',',':')))
except Exception as e:
 code=str(e) if isinstance(e,ValueError) and re.fullmatch(r'[A-Z0-9_:]+',str(e)) else 'DATA_PROCESSING_FAILED'
 print(json.dumps({'error':code}));sys.exit(2)
`;
export async function dataPython<T>(
  action: string,
  request: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  if (active) throw new Error('DATA_PROCESSOR_BUSY_RETRY');
  const payload = JSON.stringify({ action, ...request });
  if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error('DATA_PROCESSING_INPUT_LIMIT_32MB');
  active = true;
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(
        process.env.ZHENWORK_OFFICE_PYTHON || '/opt/zhenwork-office/bin/python',
        [
          '-I',
          '-c',
          WORKBOOK_SUPPORT_PYTHON +
            '\n' +
            OFFICE_PRESENTATION_PYTHON +
            '\n' +
            PARSER_PYTHON +
            '\n' +
            COMPUTE_PYTHON +
            '\n' +
            REPORT_PYTHON +
            '\n' +
            entry,
        ],
        {
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure = error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new Error('DATA_PROCESSING_CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(new Error('DATA_PROCESSING_TIMEOUT_60S')), 60000);
      child.stdout.on('data', (bytes: Buffer) => {
        size += bytes.length;
        if (size > 80 * 1024 * 1024) stop(new Error('DATA_RESULT_LIMIT_80MB'));
        else chunks.push(bytes);
      });
      child.stderr.resume(); // Never log uploaded cell contents or upstream secrets.
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) return reject(failure);
        try {
          const out = JSON.parse(Buffer.concat(chunks).toString()) as { data: T; error?: string };
          if (out.error) reject(new Error(out.error));
          else resolve(out.data);
        } catch {
          reject(new Error('DATA_PROCESSING_FAILED'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(payload);
    });
  } finally {
    active = false;
  }
}
