import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EnterpriseActor } from '../../../enterprise-gateway.js';
import type { Rc2GatewayClient } from '../../../enterprise-rc2-login.mjs';
import { enterpriseManagedResourcePath } from '../../../enterprise-resource-runtime.js';
import { enterpriseProfilePath } from '../../../enterprise-core.js';
import { OfficeStore } from '../../office-store.js';
import {
  dataPython,
  type Mapping,
  type Policy,
  type Structure,
  type Result,
  type Options,
  type Definition,
} from './engine.js';

export type DataClient = Pick<Rc2GatewayClient, 'me' | 'resources' | 'authorizedResource'> & {
  request?: (relative: string) => Promise<{ response: { ok: boolean }; body: unknown }>;
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => [key, canonical(v)])
        )
      : value;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
    .digest('hex');

/** Exact comparison of verified fixed-point totals; never binary float arithmetic. */
export function decimalDifference(previous: string, current: string): string {
  if (![previous, current].every((v) => /^[0-9]{1,40}(?:\.[0-9]{1,6})?$/.test(v)))
    throw new Error('DATA_DELTA_VALUE_INVALID');
  const scale = Math.max(previous.split('.')[1]?.length || 0, current.split('.')[1]?.length || 0);
  const integer = (v: string) => {
    const [a, b = ''] = v.split('.');
    return BigInt(a) * 10n ** BigInt(scale) + BigInt(b.padEnd(scale, '0') || '0');
  };
  const delta = integer(current) - integer(previous);
  const sign = delta < 0n ? '-' : '';
  const digits = (delta < 0n ? -delta : delta).toString().padStart(scale + 1, '0');
  return sign + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
export interface Dataset {
  id: string;
  name: string;
  sourcePath: string;
  source: { path: string; versionId: string; sha256: string; name: string };
  structure: Structure;
  mapping: Mapping;
  options: Options;
  conversations: string[];
  createdAt: string;
  period?: string;
  ruleId?: string;
}
interface Receipt {
  path: string;
  versionId: string;
  version: number;
  sha256: string;
  downloadUrl: string;
  previewUrl: string;
  validation: { valid: true };
}
export interface Analysis {
  id: string;
  datasetId: string;
  resultHash: string;
  result: Result;
  policy: Policy;
  mapping: Mapping;
  source: Dataset['source'];
  sourceUrl: string;
  createdAt: string;
  artifacts: Receipt[];
  changedFrom?: {
    analysisId: string;
    previousWeightKg: string | null;
    currentWeightKg: string | null;
    deltaWeightKg?: string | null;
  };
  outputBase?: string;
  deliveries?: Record<string, Receipt[]>;
  pending?: Record<string, string>;
}
interface Index {
  datasets: string[];
  analyses: string[];
  templates: Array<{ fingerprint: string; mapping: Mapping }>;
  outputs: Record<string, string>;
}
const initial = (): Index => ({ datasets: [], analyses: [], templates: [], outputs: {} });
const locks = new Map<string, Promise<unknown>>();
const queued = new Map<string, number>();
const safeId = (id: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('DATA_NOT_FOUND');
  return id;
};
export class DataAnalysis {
  private constructor(
    private directory: string,
    private root: string,
    private actor: EnterpriseActor,
    private workspace: string,
    private store: OfficeStore,
    private client: DataClient,
    private origin: string
  ) {}
  static async create(root: string, actor: EnterpriseActor, workspace: string, client: DataClient, origin: string) {
    const directory = path.join(path.dirname(await enterpriseManagedResourcePath(root, actor)), 'data-analysis');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new DataAnalysis(directory, root, actor, workspace, await OfficeStore.create(root, actor), client, origin);
  }
  private async read<T>(name: string): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(this.directory, name + '.json'), 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('DATA_NOT_FOUND');
      throw e;
    }
  }
  private async write(name: string, data: unknown) {
    const value = JSON.stringify(data);
    if (Buffer.byteLength(value) > 48 * 1024 * 1024) throw new Error('DATA_RESULT_STORAGE_LIMIT');
    const entries = await readdir(this.directory);
    const sizes = await Promise.all(entries.map((f) => stat(path.join(this.directory, f))));
    if (entries.length > 220 || sizes.reduce((n, s) => n + s.size, 0) + Buffer.byteLength(value) > 128 * 1024 * 1024)
      throw new Error('DATA_STORAGE_BUDGET_128MB');
    const temp = path.join(this.directory, randomUUID() + '.tmp');
    await writeFile(temp, value, { mode: 0o600 });
    await rename(temp, path.join(this.directory, name + '.json'));
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const count = queued.get(this.directory) || 0;
    if (count >= 2) throw new Error('DATA_PROCESSOR_BUSY_RETRY');
    queued.set(this.directory, count + 1);
    const before = locks.get(this.directory) || Promise.resolve();
    const next = before.catch(() => {}).then(work);
    locks.set(this.directory, next);
    try {
      return await next;
    } finally {
      if (locks.get(this.directory) === next) locks.delete(this.directory);
      const remaining = (queued.get(this.directory) || 1) - 1;
      if (remaining) queued.set(this.directory, remaining);
      else queued.delete(this.directory);
    }
  }
  private async index() {
    try {
      return await this.read<Index>('index');
    } catch (e) {
      if ((e as Error).message === 'DATA_NOT_FOUND') return initial();
      throw e;
    }
  }
  private async input(file: string) {
    const uploads = path.join(enterpriseProfilePath(this.root, this.actor), 'runtime-temp', 'aionui');
    const root = path.isAbsolute(file) && file.startsWith(uploads + path.sep) ? uploads : this.workspace;
    const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
    return { root, relative, bytes: await this.store.downloadOriginal(root, relative) };
  }
  async policies(): Promise<Policy[]> {
    const resources = (await this.client.resources('TOOL')) as Array<{
      id: string;
      name: string;
      version: number;
    }>;
    const found: PromiseSettledResult<Policy | null>[] = [];
    for (let start = 0; start < resources.length; start += 8)
      found.push(
        ...(await Promise.allSettled(
          resources.slice(start, start + 8).map(async (r) => {
            const item = (await this.client.authorizedResource(r.id, 'TOOL')) as {
              name?: string;
              version: number;
              config?: { businessRule?: Definition };
            };
            return item.config?.businessRule?.kind === 'WASTE_MONTHLY'
              ? {
                  id: r.id,
                  name: item.name || r.name,
                  version: item.version,
                  definition: item.config.businessRule,
                }
              : null;
          })
        ))
      );
    return found.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
  }
  private async authorize(dataset: Dataset, ruleId?: string) {
    await this.client.me();
    await this.input(dataset.sourcePath);
    if (ruleId) await this.client.authorizedResource(ruleId, 'TOOL');
  }
  private publicDataset(data: Dataset, preview: boolean) {
    return {
      ...data,
      structure: {
        ...data.structure,
        meta: { ...data.structure.meta, formulaErrors: data.structure.meta.formulaErrors.slice(0, 80) },
        sheets: data.structure.sheets.map((s) => ({ ...s, ...(!preview ? { sample: [] } : {}) })),
      },
    };
  }
  async requireFormalGenerator(conversation: string, description: string) {
    const ix = await this.index();
    for (const id of ix.datasets) {
      const d = await this.read<Dataset>('dataset-' + id);
      if (d.conversations.includes(conversation) || (d.ruleId && description.includes(d.sourcePath)))
        throw new Error('DATA_USE_FORMAL_REPORT_GENERATOR');
    }
  }
  async context(conversation: string, description: string) {
    return this.serial(async () => {
      const ix = await this.index();
      const selected = [];
      for (const id of ix.datasets) {
        const d = await this.read<Dataset>('dataset-' + id);
        if (!d.conversations.includes(conversation) && !(d.ruleId && description.includes(d.sourcePath))) continue;
        await this.authorize(d);
        if (!d.conversations.includes(conversation)) {
          d.conversations.push(conversation);
          await this.write('dataset-' + id, d);
        }
        selected.push({
          datasetId: d.id,
          name: d.name,
          sourcePath: d.sourcePath,
          sourceSha256: d.source.sha256,
          mappingVersion: d.mapping.version,
          mappingConfirmed: d.mapping.confirmed,
          period: d.period,
          ruleId: d.ruleId,
        });
      }
      return {
        imports: selected,
        tools: ['inspect_structured_data', 'analyze_waste_data', 'generate_waste_report', 'inspect_waste_analysis'],
        nextStep: selected.length
          ? 'The employee already imported these selected files and saved mappings. Use ToolSearch with ONE EXACT name analyze_waste_data, then call it with the matching datasetId, saved period and ruleId. Do not list directories or run Exec/Read/Python to rediscover files. If mappingConfirmed=false, request the employee Data mapping UI once. Use the validated summary for the employee answer. Only call generate_waste_report when the employee requests a Word/report file; never force both files for an answer/Excel-only task.'
          : 'For XLSX/CSV monthly waste tasks, use ToolSearch with ONE EXACT name inspect_structured_data and the employee attachment/path to import. Never use shell directory scans or preview samples as monthly statistics.',
      };
    });
  }
  async list(conversation?: string) {
    const ix = await this.index();
    const rows = await Promise.all(ix.datasets.map((id) => this.read<Dataset>('dataset-' + id)));
    const visible: Dataset[] = [];
    for (const row of rows) {
      if (conversation && !row.conversations.includes(conversation)) continue;
      try {
        await this.authorize(row);
        visible.push(row);
      } catch {
        /* Revoked/deleted inputs are not catalogued. */
      }
    }
    return {
      items: visible.map((row) => this.publicDataset(row, false)),
      policies: await this.policies(),
    };
  }
  async inspect(file: string, options: Options = {}, conversation?: string, signal?: AbortSignal) {
    return this.serial(async () => {
      if (!/\.(xlsx|csv)$/i.test(file)) throw new Error('DATA_FORMAT_XLSX_CSV_ONLY');
      const input = await this.input(file);
      if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024) throw new Error('DATA_FILE_LIMIT_20MB');
      const sha = createHash('sha256').update(input.bytes).digest('hex');
      const id = hash({ sha, file, options });
      const ix = await this.index();
      if (ix.datasets.includes(id)) {
        const existing = await this.read<Dataset>('dataset-' + id);
        await this.authorize(existing);
        if (conversation && !existing.conversations.includes(conversation)) {
          existing.conversations.push(conversation);
          await this.write('dataset-' + id, existing);
        }
        return {
          dataset: this.publicDataset(existing, false),
          policies: await this.policies(),
          reused: true,
        };
      }
      if (ix.datasets.length >= 100) throw new Error('DATA_IMPORT_LIMIT_100');
      const structure = await dataPython<Structure>(
        'inspect',
        { file: input.bytes.toString('base64'), name: file, options },
        signal
      );
      const pinned = await this.store.pinSource(path.basename(file), input.bytes);
      const first = structure.sheets[0];
      const fingerprint = hash(first.columns);
      const template = ix.templates.find((t) => t.fingerprint === fingerprint);
      const mapping: Mapping = template
        ? { ...template.mapping, sheet: first.name }
        : {
            sheet: first.name,
            headerRow: first.headerRow,
            fields: first.mapping,
            defaultUnit: first.unitHint || undefined,
            version: 1,
            confirmed:
              structure.sheets.length === 1 &&
              first.ambiguities.length === 0 &&
              ['date', 'weight', 'id', 'node', 'source', 'category'].every((k) => first.mapping[k] !== undefined) &&
              (first.mapping.unit !== undefined || !!first.unitHint),
          };
      const dataset: Dataset = {
        id,
        name: path.basename(file),
        sourcePath: file,
        source: { ...pinned, sha256: sha, name: path.basename(file) },
        structure,
        mapping,
        options,
        conversations: conversation ? [conversation] : [],
        createdAt: new Date().toISOString(),
      };
      await this.authorize(dataset);
      signal?.throwIfAborted();
      await this.write('dataset-' + id, dataset);
      ix.datasets.push(id);
      await this.write('index', ix);
      return {
        dataset: this.publicDataset(dataset, false),
        policies: await this.policies(),
        mappingInstruction:
          'Open the conversation Data mapping control to review/edit mappings. Preview is limited to 12 rows; computations scan ALL bounded records. Never infer totals from preview.',
      };
    });
  }
  private async dataset(id: string) {
    const row = await this.read<Dataset>('dataset-' + safeId(id));
    await this.authorize(row);
    return row;
  }
  async get(id: string) {
    const row = await this.dataset(id);
    const ix = await this.index();
    const analyses = [];
    for (const id of ix.analyses) {
      const a = await this.read<Analysis>('analysis-' + id);
      if (a.datasetId !== row.id) continue;
      try {
        await this.client.authorizedResource(a.policy.id, 'TOOL');
        analyses.push(this.summary(a));
      } catch {
        /* Current ACL applies to historical results. */
      }
    }
    return { dataset: row, policies: await this.policies(), analyses };
  }

  async saveMapping(id: string, input: Record<string, unknown>) {
    return this.serial(async () => {
      const row = await this.dataset(id);
      const m = input.mapping as Mapping;
      if (
        !m ||
        typeof m.sheet !== 'string' ||
        !Number.isInteger(m.headerRow) ||
        m.headerRow < 1 ||
        m.headerRow > 25 ||
        !m.fields ||
        typeof m.fields !== 'object'
      )
        throw new Error('DATA_MAPPING_INVALID');
      const sheet = row.structure.sheets.find((s) => s.name === m.sheet);
      if (!sheet) throw new Error('DATA_SHEET_UNKNOWN');
      const allowed = new Set([
        'date',
        'weight',
        'unit',
        'id',
        'node',
        'source',
        'category',
        'status',
        'organization',
        'wasteName',
      ]);
      const fields: Record<string, number> = {};
      for (const [key, value] of Object.entries(m.fields)) {
        if (!allowed.has(key) || !Number.isInteger(value) || value < 0 || value >= sheet.columns.length)
          throw new Error('DATA_MAPPING_INVALID');
        fields[key] = value;
      }
      if (new Set(Object.values(fields)).size !== Object.values(fields).length)
        throw new Error('DATA_MAPPING_REPEATED_COLUMN');
      if (['date', 'weight', 'id', 'node', 'source', 'category'].some((k) => fields[k] === undefined))
        throw new Error('DATA_MAPPING_REQUIRED');
      if (typeof m.defaultUnit === 'string' && m.defaultUnit.length > 20) throw new Error('DATA_UNIT_INVALID');
      const value = {
        sheet: m.sheet,
        headerRow: m.headerRow,
        fields,
        defaultUnit: m.defaultUnit || undefined,
      };
      const old = {
        sheet: row.mapping.sheet,
        headerRow: row.mapping.headerRow,
        fields: row.mapping.fields,
        defaultUnit: row.mapping.defaultUnit,
      };
      row.mapping = {
        ...value,
        confirmed: true,
        version: row.mapping.version + (hash(value) !== hash(old) ? 1 : 0),
      };
      if (typeof input.period === 'string') {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new Error('PERIOD_INVALID');
        row.period = input.period;
      }
      if (typeof input.ruleId === 'string') {
        if (!(await this.policies()).some((p) => p.id === input.ruleId))
          throw new Error('BUSINESS_RULE_NOT_AUTHORIZED');
        row.ruleId = input.ruleId;
      }
      const ix = await this.index();
      if (input.saveTemplate === true) {
        const fingerprint = hash(sheet.columns);
        ix.templates = ix.templates.filter((x) => x.fingerprint !== fingerprint);
        ix.templates.push({ fingerprint, mapping: row.mapping });
        ix.templates = ix.templates.slice(-40);
        await this.write('index', ix);
      }
      await this.write('dataset-' + id, row);
      return { dataset: row };
    });
  }
  async compute(id: string, period?: string, ruleId?: string, signal?: AbortSignal, conversation?: string) {
    return this.serial(async () => {
      const dataset = await this.dataset(id);
      if (conversation && !dataset.conversations.includes(conversation)) {
        dataset.conversations.push(conversation);
        await this.write('dataset-' + id, dataset);
      }
      const policies = await this.policies();
      const selected = ruleId || dataset.ruleId || (policies.length === 1 ? policies[0].id : undefined);
      const policy = policies.find((p) => p.id === selected);
      if (!policy)
        return {
          status: 'needs_input',
          datasetId: id,
          reason: 'BUSINESS_RULE_SELECT_REQUIRED',
          policies,
        };
      if (!dataset.mapping.confirmed || !(period || dataset.period))
        return {
          status: 'needs_input',
          datasetId: id,
          reason: !dataset.mapping.confirmed ? 'DATA_MAPPING_CONFIRM_REQUIRED' : 'PERIOD_REQUIRED',
        };
      const input = await this.store.download(this.workspace, dataset.source.path, dataset.source.versionId);
      if (createHash('sha256').update(input).digest('hex') !== dataset.source.sha256)
        throw new Error('DATA_SOURCE_HASH_MISMATCH');
      const analysisId = hash({
        datasetId: id,
        source: dataset.source.sha256,
        mapping: dataset.mapping,
        policy,
        period: period || dataset.period,
      });
      const ix = await this.index();
      if (ix.analyses.includes(analysisId)) {
        const a = await this.read<Analysis>('analysis-' + analysisId);
        await this.authorize(dataset, policy.id);
        return this.summary(a, true);
      }
      if (ix.analyses.length >= 100) throw new Error('DATA_ANALYSIS_LIMIT_100');
      const result = await dataPython<Result>(
        'compute',
        {
          file: input.toString('base64'),
          name: dataset.name,
          options: { ...dataset.options, sheet: dataset.mapping.sheet },
          mapping: dataset.mapping,
          rule: policy.definition,
          period: period || dataset.period,
        },
        signal
      );
      const sourceUrl = new URL(
        '/enterprise/files/download?' +
          new URLSearchParams({ path: dataset.source.path, version: dataset.source.versionId }),
        this.origin
      ).href;
      let last: Analysis | undefined;
      for (const previous of ix.analyses) {
        const item = await this.read<Analysis>('analysis-' + previous);
        if (item.datasetId === id) last = item;
      }
      const analysis: Analysis = {
        id: analysisId,
        datasetId: id,
        resultHash: hash(result),
        result,
        policy,
        mapping: dataset.mapping,
        source: dataset.source,
        sourceUrl,
        createdAt: new Date().toISOString(),
        artifacts: [],
        ...(last
          ? {
              changedFrom: {
                analysisId: last.id,
                previousWeightKg: last.result.summary?.weightKg || null,
                currentWeightKg: result.summary?.weightKg || null,
                deltaWeightKg:
                  last.result.summary && result.summary
                    ? decimalDifference(last.result.summary.weightKg, result.summary.weightKg)
                    : null,
              },
            }
          : {}),
      };
      await this.authorize(dataset, policy.id);
      signal?.throwIfAborted();
      await this.write('analysis-' + analysisId, analysis);
      ix.analyses.push(analysisId);
      await this.write('index', ix);
      return this.summary(analysis);
    });
  }
  private summary(a: Analysis, reused = false, offset = 0) {
    return {
      ...a,
      changedFrom: a.changedFrom
        ? {
            ...a.changedFrom,
            deltaWeightKg:
              a.changedFrom.previousWeightKg !== null && a.changedFrom.currentWeightKg !== null
                ? decimalDifference(a.changedFrom.previousWeightKg, a.changedFrom.currentWeightKg)
                : null,
          }
        : undefined,
      result: { ...a.result, rows: undefined as undefined, issues: a.result.issues.slice(offset, offset + 80) },
      reused,
      issueCount: a.result.issues.length,
      issuesTruncated: a.result.issues.length > 80,
      instruction:
        a.result.status === 'validated'
          ? a.artifacts.length
            ? 'Existing verified file receipts are included. Answer from this verified summary. Only if the employee requests those report files, call generate_waste_report with ONLY this analysisId and omit baseName to attach the same existing files. Respect answer/Excel-only requests. Do not use Exec/ls or recalculate in prose.'
            : 'Use this validated summary for the answer. Report generation is optional: call generate_waste_report only when the employee requests a Word/monthly report file. For answer/Excel-only tasks keep the existing needed Excel and do not create Word/PPT. Do not recalculate in model prose.'
          : 'Blocked: correct mapping or source, then recompute. No monthly report is valid yet.',
    };
  }
  async analysis(id: string, offset = 0) {
    const a = await this.read<Analysis>('analysis-' + safeId(id));
    await this.authorize(await this.dataset(a.datasetId), a.policy.id);
    return this.summary(a, false, Math.max(0, Math.min(a.result.issues.length, Math.floor(offset) || 0)));
  }
  async presentationSource(id: string): Promise<Analysis> {
    const a = await this.read<Analysis>('analysis-' + safeId(id));
    await this.authorize(await this.dataset(a.datasetId), a.policy.id);
    if (a.result.status !== 'validated') throw new Error('DATA_VALIDATION_BLOCKED');
    return structuredClone(a);
  }
  async guardFile(name: string) {
    const ix = await this.index();
    const id = ix.outputs[name];
    if (id) {
      const a = await this.read<Analysis>('analysis-' + id);
      await this.authorize(await this.dataset(a.datasetId), a.policy.id);
    }
    let sourceMatch = false;
    let allowed = false;
    for (const id of ix.datasets) {
      const d = await this.read<Dataset>('dataset-' + id);
      if (d.source.path !== name) continue;
      sourceMatch = true;
      try {
        await this.authorize(d);
        allowed = true;
        break;
      } catch {
        /* Another independently authorized reference to identical bytes may remain. */
      }
    }
    if (sourceMatch && !allowed) throw new Error('DATA_SOURCE_ACCESS_REVOKED');
  }
  async generate(id: string, baseName?: string, signal?: AbortSignal) {
    return this.serial(async () => {
      const a = await this.read<Analysis>('analysis-' + safeId(id));
      const dataset = await this.dataset(a.datasetId);
      await this.authorize(dataset, a.policy.id);
      if (a.result.status !== 'validated') throw new Error('DATA_VALIDATION_BLOCKED');
      const base = (baseName || a.outputBase || '产废分析/' + a.result.period + '-' + id.slice(0, 8)).replace(
        /\.(xlsx|docx)$/i,
        ''
      );
      if (
        !base ||
        base.length > 180 ||
        base.startsWith('/') ||
        base.split('/').some((p) => !p || p === '.' || p === '..') ||
        /[\\\x00-\x1f]/.test(base)
      )
        throw new Error('DATA_OUTPUT_PATH_INVALID');
      if (a.outputBase && a.outputBase !== base) {
        if (a.artifacts.length === 1 || (!a.artifacts.length && Object.keys(a.pending || {}).length))
          throw new Error('DATA_RETRY_USE_ORIGINAL_OUTPUT');
        if (Object.keys(a.deliveries || {}).length >= 10 && !Object.hasOwn(a.deliveries || {}, base))
          throw new Error('DATA_DELIVERY_COPY_LIMIT_10');
        a.deliveries = { ...a.deliveries, [a.outputBase]: a.artifacts };
        a.artifacts = Object.hasOwn(a.deliveries, base) ? a.deliveries[base] : [];
        a.pending = {};
      }
      a.outputBase = base;
      const built = await dataPython<{
        docx: string;
        xlsx: string;
        validation: Record<string, unknown>;
      }>('report', { data: a }, signal);
      const ix = await this.index();
      await this.write('analysis-' + id, a);
      let outputError: string | undefined;
      try {
        for (const ext of ['docx', 'xlsx'] as const) {
          signal?.throwIfAborted();
          await this.authorize(dataset, a.policy.id);
          const name = base + '.' + ext;
          const existing = a.artifacts.find((x) => x.path === name);
          if (existing) {
            const actual = await this.store.download(this.workspace, name);
            if (
              hash(actual.toString('base64')) !== hash(Buffer.from(built[ext], 'base64').toString('base64')) &&
              createHash('sha256').update(actual).digest('hex') !== existing.sha256
            )
              throw new Error('DATA_OUTPUT_CHANGED_RETRY_REQUIRES_REVIEW');
            continue;
          }
          const bytes = Buffer.from(built[ext], 'base64');
          if (bytes.length > 20 * 1024 * 1024) throw new Error('DATA_OUTPUT_LIMIT_20MB');
          const old = await this.store.fileReceipt(name);
          if (old && a.pending?.[name] !== old.sha256) throw new Error('OUTPUT_EXISTS_USE_NEW_NAME');
          if (!old) {
            a.pending = { ...a.pending, [name]: createHash('sha256').update(bytes).digest('hex') };
            await this.write('analysis-' + id, a);
          }
          // Persist dependency before publishing bytes; a crash cannot expose an unguarded derivative.
          ix.outputs[name] = id;
          await this.write('index', ix);
          if (!old) await this.store.upload(this.workspace, name, bytes);
          const receipt = await this.store.fileReceipt(name);
          if (!receipt) throw new Error('DATA_RECEIPT_MISSING');
          const query = new URLSearchParams({ path: name, version: receipt.versionId });
          a.artifacts.push({
            path: name,
            ...receipt,
            downloadUrl: new URL('/enterprise/files/download?' + query, this.origin).href,
            previewUrl: new URL('/enterprise/files/preview?' + query, this.origin).href,
            validation: { valid: true },
          });
          await this.write('analysis-' + id, a);
        }
      } catch (error) {
        if (signal?.aborted || !a.artifacts.length) throw error;
        outputError = /^[A-Z0-9_:]+$/.test((error as Error).message) ? (error as Error).message : 'DATA_OUTPUT_FAILED';
      }
      return {
        error: outputError,
        nextStep: !outputError
          ? 'Both files were reopened and their exact mass totals/counts verified. Do not audit mass with the financial two-decimal audit_workbook. Use inspect_waste_analysis for exact kg/ton totals; only binary-format validate_artifact is additionally useful. Use returned versioned receipts verbatim.'
          : undefined,
        instruction: outputError
          ? 'Partial output retained. Do not use shell commands or overwrite successful files. Explain the failed deliverable and stop; after the user resolves it, retry this same analysisId/baseName only.'
          : undefined,
        analysisId: id,
        resultHash: a.resultHash,
        validation: built.validation,
        files: a.artifacts,
        artifacts: a.artifacts,
        status: !outputError && a.artifacts.length === 2 ? 'complete' : 'partial',
        source: { name: a.source.name, sha256: a.source.sha256, versionId: a.source.versionId },
        policy: { id: a.policy.id, name: a.policy.name, version: a.policy.version },
      };
    });
  }
}
