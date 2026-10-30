import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executeMethod, methodPackage, runMethodProcessor } from '../../packages/web-host/src/office/methods/index';
const root = path.resolve('../capabilities/waste-specialist');
const source = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
const script = await fs.readFile(path.join(root, 'scripts/process_records.py'), 'utf8');
const company = JSON.parse(await fs.readFile(path.join(root, 'references/company.json'), 'utf8'));
const preferences = JSON.parse(await fs.readFile(path.join(root, 'references/preferences.json'), 'utf8'));
const config = {
  source,
  files: [
    ['scripts/process_records.py', script],
    ['references/company.json', JSON.stringify(company)],
    ['references/preferences.json', JSON.stringify(preferences)],
  ].map(([filePath, content]) => ({ path: filePath, content, encoding: 'utf8' })),
};
const id = '11111111-1111-4111-a111-111111111111';
describe('authorized portable enterprise methods', () => {
  it('refuses arbitrary scripts even when an employee owns the Skill', async () => {
    const client = {
      authorizedResource: async () => ({
        version: 1,
        config: {
          ...config,
          files: config.files.map((f) => (f.path.startsWith('scripts/') ? { ...f, content: 'print("unsafe")' } : f)),
        },
      }),
    };
    await expect(methodPackage(client, id)).rejects.toThrow('METHOD_PROCESSOR_NOT_APPROVED');
  });
  it('requires current actor Skill authorization before execution', async () => {
    const client = {
      authorizedResource: async () => {
        throw Error('RESOURCE_NOT_FOUND');
      },
    };
    await expect(methodPackage(client, id)).rejects.toThrow('RESOURCE_NOT_FOUND');
  });
  it('processes every JSON and XLSX row consistently through the existing bounded parser', async () => {
    const process = async (file: string) =>
      runMethodProcessor(script, {
        company,
        preferences,
        name: file,
        input: (await fs.readFile(path.join(root, 'examples', file))).toString('base64'),
        attachments: {},
      });
    const a = await process('模拟制造企业-202608-09.json'),
      b = await process('模拟制造企业-202608-09.xlsx');
    expect(a.summary).toEqual(b.summary);
    expect(a.coverage).toEqual(b.coverage);
    expect((a.summary.inventory as { bookKg: string }).bookKg).toBe('1320');
    expect(a.analysisSheet.rows).toHaveLength(18);
  });
  it('denies path traversal instead of treating it as a missing attachment', async () => {
    const input = JSON.parse(await fs.readFile(path.join(root, 'examples/模拟制造企业-202608-09.json'), 'utf8'));
    input.tables.attachments[0].path = '../another-employee/secret.txt';
    let reads = 0;
    await expect(
      executeMethod({
        client: { authorizedResource: async () => ({ version: 1, config }) },
        resourceId: id,
        input: Buffer.from(JSON.stringify(input)),
        name: 'test.json',
        read: async () => {
          reads++;
          throw Error('unexpected');
        },
      })
    ).rejects.toThrow('METHOD_SOURCE_PATH_INVALID');
    expect(reads).toBe(0);
  });
  it('propagates source access denial and never labels it an absent file', async () => {
    await expect(
      executeMethod({
        client: { authorizedResource: async () => ({ version: 1, config }) },
        resourceId: id,
        input: await fs.readFile(path.join(root, 'examples/模拟制造企业-202608-09.json')),
        name: 'input.json',
        read: async () => {
          throw Error('ACCESS_DENIED');
        },
      })
    ).rejects.toThrow('ACCESS_DENIED');
  });
});

it('reads a complete large upstream catalog on explicit request while bounding automatic context', async () => {
  const { checkEnterpriseSkill } = await import('../../packages/web-host/src/office/skill-status');
  const content = 'x'.repeat(69000);
  const client = {
    resources: async () => [{ id, name: 'Standard', version: 1 }],
    authorizedResource: async () => ({
      version: 1,
      config: { source, files: [{ path: 'references/workflows.json', content, encoding: 'utf8' }] },
    }),
  };
  const loaded = [{ id, name: 'standard-runtime', version: 1 }];
  const explicit = await checkEnterpriseSkill(client, id, loaded, ['standard-runtime'], {
    file: 'references/workflows.json',
  });
  expect((explicit.instructions as Array<{ content: string }>)[0].content).toBe(content);
  const automatic = await checkEnterpriseSkill(client, id, loaded, ['standard-runtime'], {
    includeInstructions: true,
  });
  expect(automatic.omittedFiles).toContain('references/workflows.json');
});

it('delivers native numeric Excel cells whose differences can be independently summed', async () => {
  const { generateOfficeArtifact } = await import('../../packages/web-host/src/office/generate');
  const { auditWorkbook } = await import('../../packages/web-host/src/office/workbook/index');
  const result = await runMethodProcessor(script, {
    company,
    preferences: { ...preferences, methods: ['inventory'], differencesOnly: true, capacityPercent: '80' },
    name: 'input.json',
    input: (await fs.readFile(path.join(root, 'examples/模拟制造企业-202608-09.json'))).toString('base64'),
    attachments: {},
  });
  const bytes = await generateOfficeArtifact({ format: 'xlsx', title: 'Personal inventory', sheets: result.sheets });
  const audit = await auditWorkbook(bytes, { sheet: '库存差异', amountRange: 'F3:F5', expectedTotal: '-50' });
  expect(audit.exactTotal).toBe('-50');
});

it('exports only requested monthly formats, preserves old files, and can explicitly add Word later', async () => {
  const os = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { DataAnalysis } = await import('../../packages/web-host/src/office/workbook/analysis/service');
  const { dataPython } = await import('../../packages/web-host/src/office/workbook/analysis/engine');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'method-format-'));
  try {
    const policy = JSON.parse(
      await fs.readFile(path.join(root, 'templates/demo-monthly-rule.json'), 'utf8')
    ).businessRule;
    const raw = Buffer.from(
      '业务单号,业务日期,业务节点,所属车间,废物类别,重量,单位\nA01,2026-09-01,产生,A,D-GW,250,kg\nB01,2026-09-02,产生,B,D-OIL,0.5,吨'
    );
    const mapping = {
      sheet: 'CSV',
      headerRow: 1,
      fields: { id: 0, date: 1, node: 2, source: 3, category: 4, weight: 5, unit: 6 },
      version: 1,
      confirmed: true,
    };
    const result = await dataPython('compute', {
      file: raw.toString('base64'),
      name: 'source.csv',
      mapping,
      options: {},
      rule: policy,
      period: '2026-09',
    });
    const analysisId = 'a'.repeat(64),
      datasetId = 'b'.repeat(64);
    const sourceRef = {
      name: 'source.csv',
      path: 'snapshot.csv',
      versionId: 'source-v1',
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    await fs.writeFile(
      path.join(directory, 'dataset-' + datasetId + '.json'),
      JSON.stringify({ id: datasetId, sourcePath: 'source.csv', source: sourceRef })
    );
    await fs.writeFile(
      path.join(directory, 'analysis-' + analysisId + '.json'),
      JSON.stringify({
        id: analysisId,
        datasetId,
        resultHash: 'c'.repeat(64),
        result,
        mapping,
        source: sourceRef,
        sourceUrl: 'https://example.com/source.csv',
        policy: { id, name: 'Demo', version: 1, definition: policy },
        artifacts: [],
      })
    );
    const outputs = new Map<string, Buffer>();
    const receipts = new Map();
    const store = {
      downloadOriginal: async () => raw,
      download: async (_root: string, file: string) => outputs.get(file),
      fileReceipt: async (file: string) => receipts.get(file),
      upload: async (_root: string, file: string, bytes: Buffer) => {
        expect(outputs.has(file)).toBe(false);
        outputs.set(file, bytes);
        receipts.set(file, { versionId: file, version: 1, sha256: createHash('sha256').update(bytes).digest('hex') });
      },
    };
    const client = { me: async () => ({}), authorizedResource: async () => ({}) };
    const service = Reflect.construct(DataAnalysis, [
      directory,
      directory,
      { serverId: 'test', userId: '1' },
      directory,
      store,
      client,
      'https://example.com',
    ]) as InstanceType<typeof DataAnalysis>;
    const first = await service.generate(analysisId, 'monthly', undefined, ['xlsx']);
    expect(first.status).toBe('complete');
    expect(first.files.map((f) => f.path)).toEqual(['monthly.xlsx']);
    expect(outputs.has('monthly.docx')).toBe(false);
    const pinned = outputs.get('monthly.xlsx');
    const copy = await service.generate(analysisId, 'monthly-revision', undefined, ['xlsx']);
    expect(copy.status).toBe('complete');
    expect(outputs.has('monthly-revision.docx')).toBe(false);
    const both = await service.generate(analysisId, 'monthly');
    expect(both.status).toBe('complete');
    expect(both.files).toHaveLength(2);
    expect(outputs.get('monthly.xlsx')).toEqual(pinned);
    const selected = await service.generate(analysisId, undefined, undefined, ['xlsx']);
    expect(selected.files).toHaveLength(1);
    expect(selected.files[0].path).toBe('monthly.xlsx');
    expect(outputs.has('monthly.docx')).toBe(true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
