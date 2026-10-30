import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PARSER_PYTHON } from '../workbook/analysis/parserScript.js';
import type { OfficeSheet } from '../generate.js';
import { APPROVED_METHOD_PROCESSORS } from './registry.js';

type File = { path: string; content: string; encoding?: string; sha256?: string };
type Detail = {
  version: number;
  config: { source: string; files: File[]; manifest?: { requiredTools?: string[] } };
};
type Client = { authorizedResource(id: string, type: string): Promise<unknown> };
export type MethodResult = {
  summary: Record<string, unknown>;
  sheets: OfficeSheet[];
  analysisSheet: OfficeSheet;
  issues: Array<{ kind: string; code: string; source: string; detail: string }>;
  coverage: { inputRows: number; allRowsProcessed: boolean; truncated: boolean };
  attachmentPaths: string[];
  contractSources: Array<{ path: string; quote: string; source: string }>;
};
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('METHOD_CONFIG_INVALID');
  return v as Record<string, unknown>;
};
export const methodTool = {
  name: 'run_enterprise_method',
  description:
    'Execute the currently authorized complete enterprise/personal Skill method on ALL rows of an authorized JSON/XLSX input. Only a reviewed SHA-pinned portable processor is executable; configuration and output preferences come from that Skill version, not model arguments. Explicit linked IDs only; exact Decimal calculations. Rechecks attachments and contract quotes using employee file authorization. Returns verified summary and real XLSX receipts; no external writes, legal verdict or arbitrary code. For formal waste monthly analysis use the resulting analysisInput with existing inspect_structured_data/analyze_waste_data.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      resourceId: { type: 'string', format: 'uuid' },
      path: { type: 'string', maxLength: 500 },
      methods: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        items: {
          type: 'string',
          enum: ['ledger', 'inventory', 'transfer', 'settlement', 'checklist'],
        },
      },
      outputBase: { type: 'string', maxLength: 140 },
    },
    required: ['resourceId', 'path'],
  },
};
let busy = false;
export async function methodPackage(client: Client, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error('METHOD_RESOURCE_ID_INVALID');
  const detail = (await client.authorizedResource(id, 'SKILL')) as Detail;
  if (!detail?.config || !Array.isArray(detail.config.files)) throw Error('METHOD_PACKAGE_INVALID');
  const text = (name: string) => {
    const files = detail.config.files.filter((f) => f.path === name);
    if (files.length !== 1 || files[0].encoding === 'base64' || Buffer.byteLength(files[0].content) > 128 * 1024)
      throw Error('METHOD_FILE_INVALID:' + name);
    const f = files[0];
    if (f.sha256 && f.sha256 !== sha(f.content)) throw Error('METHOD_FILE_HASH_MISMATCH');
    return f.content;
  };
  const script = text('scripts/process_records.py'),
    processorSha256 = sha(script);
  if (!APPROVED_METHOD_PROCESSORS.has(processorSha256)) throw Error('METHOD_PROCESSOR_NOT_APPROVED');
  const company = obj(JSON.parse(text('references/company.json'))),
    preferences = obj(JSON.parse(text('references/preferences.json')));
  if (company.schemaVersion !== 1 || preferences.schemaVersion !== 1) throw Error('METHOD_CONFIG_VERSION_UNSUPPORTED');
  const threshold = Number(preferences.capacityPercent);
  if (
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 100 ||
    !Number.isInteger(preferences.internalAgeDays) ||
    Number(preferences.internalAgeDays) < 0
  )
    throw Error('METHOD_REMINDER_INVALID');
  // Same dependency authorization as installed Skill use. No hidden administrator credentials.
  const tools =
    detail.config.manifest?.requiredTools ||
    (JSON.parse(detail.config.source.match(/^requiredTools:\s*(\[[^\n]*\])/m)?.[1] || '[]') as string[]);
  await Promise.all(tools.map((dependency) => client.authorizedResource(dependency, 'TOOL')));
  const configSha256 = sha(JSON.stringify(detail.config));
  return { detail, script, company, preferences, processorSha256, configSha256 };
}
export async function runMethodProcessor(
  script: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<MethodResult> {
  if (!APPROVED_METHOD_PROCESSORS.has(sha(script))) throw Error('METHOD_PROCESSOR_NOT_APPROVED');
  const python = process.env.ZHENWORK_OFFICE_PYTHON?.trim() || '/opt/zhenwork-office/bin/python';
  if (!path.isAbsolute(python) || python.includes('\0')) throw Error('OFFICE_PYTHON_PATH_INVALID');
  const limit = `\nimport resource,sys\nif sys.platform!='darwin':resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,384*1024*1024))\nresource.setrlimit(resource.RLIMIT_CPU,(18,18))\n`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-c', limit + PARSER_PYTHON + '\n' + script],
      {
        signal,
        timeout: 22000,
        maxBuffer: 3 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONNOUSERSITE: '1',
          LANG: 'C.UTF-8',
        },
      },
      (error, stdout) => {
        let body: MethodResult & { error?: string };
        try {
          body = JSON.parse(stdout);
        } catch {
          reject(Error('METHOD_EXECUTION_FAILED'));
          return;
        }
        if (error || body.error) {
          reject(Error(body.error || 'METHOD_EXECUTION_FAILED'));
          return;
        }
        if (
          !body.coverage?.allRowsProcessed ||
          body.coverage.truncated ||
          !Array.isArray(body.sheets) ||
          !Array.isArray(body.attachmentPaths) ||
          body.attachmentPaths.length > 200
        ) {
          reject(Error('METHOD_RESULT_INCOMPLETE'));
          return;
        }
        resolve(body);
      }
    );
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify(payload));
  });
}
export async function executeMethod(options: {
  client: Client;
  resourceId: string;
  input: Buffer;
  name: string;
  methods?: string[];
  read: (file: string) => Promise<{ bytes: Buffer; relative: string }>;
  signal?: AbortSignal;
}) {
  if (busy) throw Error('METHOD_BUSY_RETRY_AFTER_CURRENT');
  busy = true;
  try {
    if (options.input.length > 20 * 1024 * 1024 || !/\.(json|xlsx)$/i.test(options.name))
      throw Error('METHOD_INPUT_JSON_XLSX_20MB');
    const p = await methodPackage(options.client, options.resourceId);
    const payload = {
      company: p.company,
      preferences: p.preferences,
      methods: options.methods,
      name: options.name,
      input: options.input.toString('base64'),
      attachments: {} as Record<string, unknown>,
      unverifiedContracts: [] as string[],
    };
    const first = await runMethodProcessor(p.script, payload, options.signal);
    const sourceFiles: Array<{ path: string; sha256: string }> = [];
    const reads = new Map<string, { bytes: Buffer; relative: string } | null>();
    const read = async (file: string) => {
      // Package paths must be employee workspace-relative; no absolute host paths or traversal.
      if (
        typeof file !== 'string' ||
        !file ||
        file.length > 500 ||
        path.isAbsolute(file) ||
        file.includes('\\') ||
        file.includes('\0') ||
        file.split('/').some((s) => !s || s === '.' || s === '..')
      )
        throw Error('METHOD_SOURCE_PATH_INVALID');
      if (reads.has(file)) return reads.get(file)!;
      try {
        const value = await options.read(file);
        reads.set(file, value);
        sourceFiles.push({ path: file, sha256: sha(value.bytes) });
        return value;
      } catch (e) {
        if (e instanceof Error && /ENOENT|FILE_NOT_FOUND/.test(e.message)) {
          reads.set(file, null);
          return null;
        }
        throw e;
      }
    };
    for (const file of first.attachmentPaths) {
      // eslint-disable-next-line no-await-in-loop -- Bounded source reads stop on the first authorization denial and limit resident file bytes.
      const value = await read(file);
      payload.attachments[file] = value ? { available: true, sha256: sha(value.bytes) } : { available: false };
    }
    if (first.contractSources.length > 100) throw Error('METHOD_SOURCE_COUNT_LIMIT');
    const contractIssues: MethodResult['issues'] = [];
    for (const source of first.contractSources) {
      if (!source.path || !source.quote) throw Error('METHOD_CONTRACT_SOURCE_REQUIRED');
      // eslint-disable-next-line no-await-in-loop -- Preserve bounded sequential evidence reads.
      const value = await read(source.path);
      if (
        !value ||
        !/\.(txt|md)$/i.test(source.path) ||
        value.bytes.length > 128 * 1024 ||
        !value.bytes.toString('utf8').includes(source.quote)
      ) {
        payload.unverifiedContracts.push(source.path);
        contractIssues.push({
          kind: 'incomplete',
          code: 'CONTRACT_QUOTE_UNVERIFIED',
          source: source.source,
          detail: '合同摘录未在实际授权原文中核实，不生成最终结算金额',
        });
      }
    }
    const result = await runMethodProcessor(p.script, payload, options.signal);
    result.issues.push(...contractIssues);
    // Recheck the same immutable method config before any output writes.
    const current = await methodPackage(options.client, options.resourceId);
    if (current.configSha256 !== p.configSha256 || current.detail.version !== p.detail.version)
      throw Error('METHOD_VERSION_CHANGED_RETRY');
    return {
      ...result,
      provenance: {
        resourceId: options.resourceId,
        version: p.detail.version,
        configSha256: p.configSha256,
        processorSha256: p.processorSha256,
        inputSha256: sha(options.input),
        sourceFiles,
      },
      preferences: p.preferences,
    };
  } finally {
    busy = false;
  }
}
