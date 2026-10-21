import { execFile } from 'node:child_process';

export const summaryTool = {
  name: 'summarize_json_data',
  description:
    'Read and calculate structured JSON using a fixed Decimal program, not guessed Python. Each operation selects a dot-path array collection; optional flatten selects a nested array on EACH item (e.g. expenses -> daily_amounts), optional groupBy groups actual items, sum adds a numeric field. Without sum returns counts. Missing or wrongly typed fields fail; no invented zero totals. Values include currency-neutral exact decimals. Use audit_workbook on the current XLSX for final financial verification; this tool summarizes source data, not the delivered workbook.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            collection: { type: 'string' },
            flatten: { type: 'string' },
            groupBy: { type: 'string' },
            sum: { type: 'string' },
          },
          required: ['collection'],
        },
      },
    },
    required: ['path', 'operations'],
  },
};
const script = String.raw`import sys,json
from decimal import Decimal,localcontext
try:
 request=json.load(sys.stdin,parse_float=Decimal,parse_int=Decimal)
 data=json.loads(request['data'],parse_float=Decimal,parse_int=Decimal)
 def select(item,field):
  for key in field.split('.'):
   if not isinstance(item,dict) or key not in item: raise ValueError('missing field: '+field)
   item=item[key]
  return item
 out=[]
 with localcontext() as ctx:
  ctx.prec=40
  for operation in request['operations']:
   rows=select(data,operation['collection'])
   if not isinstance(rows,list) or len(rows)>10000: raise ValueError('collection must be array, at most 10000 items')
   if 'flatten' in operation:
    flat=[]
    for item in rows:
     values=select(item,operation['flatten'])
     if not isinstance(values,list): raise ValueError('flatten must select an array on every item')
     flat.extend(values)
     if len(flat)>10000: raise ValueError('flatten limit 10000')
    rows=flat
   groups={}
   for item in rows:
    key=select(item,operation['groupBy']) if 'groupBy' in operation else 'all'
    if isinstance(key,(dict,list,bool)) or key is None: raise ValueError('groupBy must select a non-null scalar')
    key=str(key)
    if key not in groups: groups[key]={'count':0,'sum':Decimal(0)}
    if len(groups)>500: raise ValueError('group limit 500')
    groups[key]['count']+=1
    if 'sum' in operation:
     value=select(item,operation['sum'])
     if isinstance(value,bool) or not isinstance(value,(str,Decimal)): raise ValueError('sum must select decimal number or decimal string')
     number=Decimal(value)
     if not number.is_finite(): raise ValueError('sum must be finite')
     groups[key]['sum']+=number
   out.append({'operation':operation,'itemCount':len(rows),'groups':{key:({'count':value['count'],'sum':str(value['sum'])} if 'sum' in operation else {'count':value['count']}) for key,value in groups.items()}})
 print(json.dumps({'calculations':out},ensure_ascii=False))
except Exception as error:
 print(json.dumps({'error':'JSON_DATA_INVALID','reason':str(error)[:200]},ensure_ascii=False));sys.exit(2)
`;
export async function summarizeJsonData(data: Buffer, operations: unknown): Promise<Record<string, unknown>> {
  if (data.length > 2 * 1024 * 1024) throw new Error('JSON_SUMMARY_INPUT_LIMIT_2MB');
  const python = process.env.ZHENWORK_OFFICE_PYTHON || '/opt/zhenwork-office/bin/python';
  if (!python.startsWith('/')) throw new Error('OFFICE_PYTHON_PATH_INVALID');
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-c', script],
      { encoding: 'buffer', timeout: 10_000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout.toString()) as Record<string, unknown>;
          if (error || result.error)
            reject(
              new Error(
                String(result.error || 'JSON_DATA_INVALID') + ': ' + String(result.reason || 'calculation failed')
              )
            );
          else resolve(result);
        } catch {
          reject(new Error('JSON_SUMMARY_PROCESS_FAILED'));
        }
      }
    );
    child.stdin?.on('error', () => reject(new Error('JSON_SUMMARY_PROCESS_FAILED')));
    child.stdin?.end(JSON.stringify({ data: data.toString('utf8'), operations }));
  });
}
