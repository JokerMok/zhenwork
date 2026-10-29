import { execFile } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { WORKBOOK_SUPPORT_PYTHON } from '../workbook/script.js';
import { OFFICE_PRESENTATION_PYTHON } from './presentationScript.js';
import { OFFICE_REVISION_PYTHON } from './revisionScript.js';
import { NATIVE_PRESENTATION_PYTHON } from '../presentation/nativeScript.js';
import { PPT_REVISION_PYTHON } from '../presentation/revisionScript.js';

const scalar = z.union([z.string().max(8000), z.number().finite(), z.null()]);
const operations = z
  .array(
    z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('set_slide_title'),
          slide: z.number().int().min(1).max(30),
          expectedText: z.string().max(2000),
          title: z.string().min(1).max(160),
        })
        .strict(),
      z
        .object({
          kind: z.literal('set_slide_text'),
          slide: z.number().int().min(1).max(30),
          shapeId: z.number().int().min(1),
          expectedText: z.string().max(8000),
          text: z.string().max(2000),
        })
        .strict(),
      z
        .object({
          kind: z.literal('set_chart_style'),
          slide: z.number().int().min(1).max(30),
          shapeId: z.number().int().min(1),
          expectedText: z.string().max(1000).optional(),
          title: z.string().max(160).optional(),
          style: z.number().int().min(1).max(48).optional(),
          showLegend: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('insert_slide'),
          position: z.number().int().min(1).max(30),
          content: z
            .object({
              title: z.string().max(160),
              paragraphs: z.array(z.string().max(500)).max(5).optional(),
              bullets: z.array(z.string().max(200)).max(6).optional(),
              layout: z.enum(['content', 'section', 'conclusion']).optional(),
            })
            .strict(),
        })
        .strict(),
      z.object({ kind: z.literal('delete_slide'), slide: z.number().int().min(1).max(30) }).strict(),
      z
        .object({
          kind: z.literal('move_slide'),
          slide: z.number().int().min(1).max(30),
          destination: z.number().int().min(1).max(30),
        })
        .strict(),
      z
        .object({
          kind: z.literal('update_chart'),
          slide: z.number().int().min(1).max(30),
          shapeId: z.number().int().min(1),
          resultId: z.string().regex(/^[a-f0-9]{64}$/),
          dataKey: z.enum(['byCategory', 'bySource', 'trend']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('replace_text'),
          find: z.string().min(1).max(8000),
          replace: z.string().max(8000),
          expectedOccurrences: z.literal(1).default(1),
          paragraph: z.number().int().min(1).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('append_section'),
          heading: z.string().min(1).max(200),
          paragraphs: z.array(z.string().max(8000)).min(1).max(30),
          numbered: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('set_table_cell'),
          table: z.number().int().min(1),
          row: z.number().int().min(1),
          column: z.number().int().min(1),
          expected: z.string().max(8000),
          value: z.string().max(8000),
        })
        .strict(),
      z
        .object({
          kind: z.literal('set_cell'),
          sheet: z.string().min(1).max(31),
          cell: z.string().regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/),
          expected: scalar,
          value: scalar,
        })
        .strict(),
    ])
  )
  .min(1)
  .max(32);

export const revisionTool = {
  name: 'revise_office_document',
  description:
    'NARROW in-place DOCX/XLSX/PPTX changes with current SHA guard and atomic versioned commit. First inspect_office_document to identify current paragraphs/cells OR PPT slide number, shape id, exact text and chart dataKey. PPT uses set_slide_title{slide,expectedText,title}, set_slide_text{slide,shapeId,expectedText,text}, set_chart_style{slide,shapeId,title?,expectedText?,style?:1..48,showLegend?}, insert_slide{position,content:{title,paragraphs?,bullets?}}, delete_slide{slide}, move_slide{slide,destination}, update_chart{slide,shapeId,resultId,dataKey}. Business fact text/tables/source pages are protected; chart data can only refresh from the SAME saved verified result. To change business data, first recompute a new result and regenerate PPT from that id, preserving prior versions; never change a chart number and claim Word/Excel synchronized. Deleting unique facts/source pages is rejected. DOCX uses replace_text, append_section, set_table_cell; XLSX uses set_cell with actual sheet/address/expected value. Source quotes/catalogs remain protected. No outputPath. Returned actual receipt/version is authoritative; other file formats are not silently rewritten.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'replace_text',
                'append_section',
                'set_table_cell',
                'set_cell',
                'set_slide_title',
                'set_slide_text',
                'set_chart_style',
                'insert_slide',
                'delete_slide',
                'move_slide',
                'update_chart',
              ],
            },
            find: { type: 'string' },
            replace: { type: 'string' },
            expectedOccurrences: { type: 'integer', minimum: 1, maximum: 100 },
            heading: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } },
            numbered: { type: 'boolean' },
            table: { type: 'integer', minimum: 1 },
            row: { type: 'integer', minimum: 1 },
            column: { type: 'integer', minimum: 1 },
            sheet: { type: 'string' },
            cell: { type: 'string' },
            expected: { type: ['string', 'number', 'null'] },
            value: { type: ['string', 'number', 'null'] },
            slide: { type: 'integer', minimum: 1, maximum: 30 },
            shapeId: { type: 'integer', minimum: 1 },
            expectedText: { type: 'string' },
            text: { type: 'string' },
            title: { type: 'string' },
            style: { type: 'integer', minimum: 1, maximum: 48 },
            showLegend: { type: 'boolean' },
            position: { type: 'integer', minimum: 1, maximum: 30 },
            destination: { type: 'integer', minimum: 1, maximum: 30 },
            content: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
                bullets: { type: 'array', items: { type: 'string' } },
                layout: { type: 'string', enum: ['content', 'section', 'conclusion'] },
              },
              required: ['title'],
            },
            resultId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            dataKey: { type: 'string', enum: ['byCategory', 'bySource', 'trend'] },
          },
          required: ['kind'],
        },
      },
    },
    required: ['path', 'expectedSha256', 'operations'],
  },
};
export const inspectionTool = {
  name: 'inspect_office_document',
  description:
    "Read CURRENT DOCX paragraphs/tables, XLSX sheets/formulas or PPTX slide titles, native text/table/chart object IDs, exact chart data and editable structure with actual SHA. PPT structural inspection is distinct from the file page's LibreOffice visual preview. Use actual slide/shape IDs and exact text before edits.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const main = String.raw`
try:
    request=json.load(sys.stdin);content=base64.b64decode(request['content'],validate=True)
    if len(content)>25*1024*1024:raise ValueError('OFFICE_REVISION_LIMIT_25MB')
    if request['mode']=='inspect':result,_,_=inspect_office(content,request['format']);output=None
    elif request['format']=='pptx':output,result=ppt_revise(content,request['operations'],request.get('trusted'))
    else:output,result=revise_office(content,request['format'],request['operations'])
    print(json.dumps({'result':result,'output':base64.b64encode(output).decode() if output else None},ensure_ascii=False))
except Exception as error:
    code=error.code if isinstance(error,WorkbookError) else str(error) if isinstance(error,ValueError) else type(error).__name__
    print(json.dumps({'error':'OFFICE_REVISION_FAILED','reason':code[:200]}));sys.exit(2)
`;
async function run(
  mode: 'inspect' | 'revise',
  filename: string,
  bytes: Buffer,
  changes?: unknown,
  signal?: AbortSignal,
  trusted?: unknown
): Promise<{ result: Record<string, unknown>; bytes?: Buffer }> {
  const format = path.extname(filename).slice(1).toLowerCase();
  if (!['docx', 'xlsx', 'pptx'].includes(format)) throw new Error('OFFICE_REVISION_DOCX_XLSX_PPTX_REQUIRED');
  if (bytes.length > 25 * 1024 * 1024) throw new Error('OFFICE_REVISION_LIMIT_25MB');
  const parsed = mode === 'revise' ? operations.safeParse(changes) : undefined;
  if (parsed && !parsed.success)
    throw new Error(
      'OFFICE_REVISION_ARGUMENT_INVALID ' +
        parsed.error.issues
          .map((issue) => issue.path.join('.') + ': ' + issue.message)
          .join('; ')
          .slice(0, 800)
    );
  const interpreter = process.env.ZHENWORK_OFFICE_PYTHON?.trim() || '/opt/zhenwork-office/bin/python';
  if (!path.isAbsolute(interpreter) || interpreter.includes('\0')) throw new Error('OFFICE_PYTHON_PATH_INVALID');
  return new Promise((resolve, reject) => {
    const child = execFile(
      interpreter,
      [
        '-c',
        WORKBOOK_SUPPORT_PYTHON +
          '\n' +
          OFFICE_PRESENTATION_PYTHON +
          '\n' +
          NATIVE_PRESENTATION_PYTHON +
          '\n' +
          PPT_REVISION_PYTHON +
          '\n' +
          OFFICE_REVISION_PYTHON +
          '\n' +
          main,
      ],
      {
        signal,
        killSignal: 'SIGKILL',
        timeout: 20000,
        maxBuffer: 38 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      },
      (error, stdout) => {
        if (signal?.aborted) {
          reject(new Error('OFFICE_REVISION_CANCELLED'));
          return;
        }
        try {
          const response = JSON.parse(stdout);
          if (error || response.error)
            return reject(new Error('OFFICE_REVISION_FAILED: ' + String(response.reason || 'execution failed')));
          resolve({
            result: response.result,
            bytes: response.output ? Buffer.from(response.output, 'base64') : undefined,
          });
        } catch {
          reject(new Error('OFFICE_REVISION_UNAVAILABLE'));
        }
      }
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(
      JSON.stringify({
        mode,
        format,
        content: bytes.toString('base64'),
        operations: parsed?.success ? parsed.data : undefined,
        trusted,
      })
    );
  });
}
export async function inspectOfficeStructure(filename: string, bytes: Buffer, signal?: AbortSignal) {
  return (await run('inspect', filename, bytes, undefined, signal)).result;
}
export async function reviseOfficeDocument(
  filename: string,
  bytes: Buffer,
  changes: unknown,
  signal?: AbortSignal,
  trusted?: unknown
) {
  return run('revise', filename, bytes, changes, signal, trusted);
}
