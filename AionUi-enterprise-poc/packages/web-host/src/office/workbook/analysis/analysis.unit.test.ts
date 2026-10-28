import { previewWorkbook } from '../index.js';
import { decimalDifference } from './service.js';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { dataPython, type Structure, type Result, type Definition } from './engine.js';
const available = !!process.env.ZHENWORK_OFFICE_PYTHON;
export const testRule: Definition = {
  kind: 'WASTE_MONTHLY',
  meaning: '合成数据按业务日期汇总产生重量',
  scope: '合成验收资料，不代表生产数据',
  grain: 'business_record_id',
  timeField: 'business_date',
  period: 'calendar_month_Asia_Shanghai',
  duplicateRule: 'identical_first',
  precision: 3,
  unitFactors: { kg: '1', 吨: '1000' },
  includeNodes: ['产生'],
  nodeAliases: { 产生: '产生', 入库: '入库' },
  sourceAliases: { A: 'A', B: 'B' },
  categoryAliases: { HW08: 'HW08', HW49: 'HW49' },
  organizationAliases: {},
  allowedOrganizations: [],
  statusAliases: { 有效: 'active', 撤销: 'cancelled', 冲销: 'reversal' },
  summaryRows: 'exclude_with_warning',
  negative: 'block',
  reversal: 'block',
};
const header = '业务单号,业务日期,业务节点,所属车间,废物类别,重量,单位\n';
const rows = [
  'A01,2026-09-02,产生,A,HW08,1200,kg',
  'A02,2026-09-03,产生,B,HW49,0.8,吨',
  'A03,2026-09-05,入库,A,HW08,300,kg',
  'A04,2026-09-06,产生,A,HW08,150,kg',
  'A04,2026-09-06,产生,A,HW08,150,kg',
  'A05,2026-10-01,产生,A,HW08,200,kg',
];
const csv = Buffer.from('\ufeff' + header + rows.join('\n'));
const mapping = {
  sheet: 'CSV',
  headerRow: 1,
  fields: { id: 0, date: 1, node: 2, source: 3, category: 4, weight: 5, unit: 6 },
  version: 1,
  confirmed: true,
};
const compute = (bytes = csv, rule = testRule) =>
  dataPython<Result>('compute', {
    file: bytes.toString('base64'),
    name: '合成验收.csv',
    options: {},
    mapping,
    rule,
    period: '2026-09',
  });
describe.skipIf(!available)('bounded complete waste analysis', () => {
  it('separates 12-row preview from full deterministic scan and enforces published dedup/node/period', async () => {
    const structure = await dataPython<Structure>('inspect', {
      file: csv.toString('base64'),
      name: '合成验收.csv',
      options: {},
    });
    expect(structure.sheets[0].mapping).toMatchObject(mapping.fields);
    const result = await compute();
    expect(result).toMatchObject({
      status: 'validated',
      completeScan: true,
      rowCount: 6,
      includedCount: 3,
      excludedCount: 3,
      summary: {
        weightKg: '2150.000',
        weightTon: '2.150000',
        bySource: [
          { name: 'A', weightKg: '1350.000' },
          { name: 'B', weightKg: '800.000' },
        ],
      },
    });
    const many = Buffer.from(
      header + Array.from({ length: 151 }, (_, i) => `R${i},2026-09-02,产生,A,HW08,0.1,kg`).join('\n')
    );
    const preview = await dataPython<Structure>('inspect', {
      file: many.toString('base64'),
      name: '151.csv',
      options: {},
    });
    expect(preview.sheets[0].sample).toHaveLength(12);
    expect((await compute(many)).summary?.weightKg).toBe('15.100');
  });
  it('blocks missing/unknown units, invalid dates, node, identifiers, conflicts and unsafe scope rather than reporting a partial sum', async () => {
    for (const row of [
      'X1,invalid,产生,A,HW08,5,kg',
      'X1,2026-09-02,产生,A,HW08,5,',
      'X1,2026-09-02,未知,A,HW08,5,kg',
      ',2026-09-02,产生,A,HW08,5,kg',
      'X1,2026-09-02,产生,A,HW08,5,lb',
      'X1,2026-09-02,产生,未知,HW08,5,kg',
    ]) {
      const r = await compute(Buffer.from(header + row));
      expect(r.status).toBe('blocked');
      expect(r.summary).toBeNull();
      expect(r.invalidCount).toBe(1);
    }
    expect((await compute(csv, { ...testRule, duplicateRule: 'block' })).status).toBe('blocked');
    const conflict = await compute(Buffer.from(header + rows[0] + '\n' + rows[0].replace('1200', '1201')));
    expect(conflict.issues.some((x) => x.code === 'DUPLICATE_CONFLICT')).toBe(true);
  });
  it('reads embedded units, accounts for summary rows and uses actual date timezone', async () => {
    const r = await compute(Buffer.from(header + 'X1,2026-08-31T16:00:00Z,产生,A,HW08,0.1235 kg,\n合计,,,,,0.1235,kg'));
    expect(r.summary?.weightKg).toBe('0.124');
    expect(r.counts.SUMMARY_ROW).toBe(1);
  });
  it('uses real XLSX cells, fresh supported formulas and strict legacy Chinese CSV decoding', async () => {
    const files = JSON.parse(
      execFileSync(
        process.env.ZHENWORK_OFFICE_PYTHON!,
        [
          '-c',
          String.raw`import io,base64,json,openpyxl
headers=['业务单号','业务日期','业务节点','所属车间','废物类别','重量','单位']
rows=[['A01','2026-09-02','产生','A','HW08',1200,'kg'],['A02','2026-09-03','产生','B','HW49',0.8,'吨'],['A03','2026-09-05','入库','A','HW08',300,'kg'],['A04','2026-09-06','产生','A','HW08',150,'kg'],['A04','2026-09-06','产生','A','HW08',150,'kg'],['A05','2026-10-01','产生','A','HW08',200,'kg']]
out={}
for key,formula in [('same',None),('verified','=600+600'),('unsupported','=INDIRECT("A1")')]:
 w=openpyxl.Workbook();s=w.active;s.title='明细';s.append(headers)
 for row in rows:s.append(row)
 if formula:s['F2']=formula
 b=io.BytesIO();w.save(b);out[key]=base64.b64encode(b.getvalue()).decode()
raw='业务单号,业务日期,业务节点,所属车间,废物类别,重量,单位\nX1,2026-09-02,产生,A,HW08,1.25,kg'
out['legacy']=base64.b64encode(raw.encode('gb18030')).decode()
print(json.dumps(out))`,
        ],
        { encoding: 'utf8' }
      )
    ) as Record<string, string>;
    for (const key of ['same', 'verified', 'unsupported']) {
      const r = await dataPython<Result>('compute', {
        file: files[key],
        name: '不同布局.xlsx',
        options: {},
        mapping: { ...mapping, sheet: '明细' },
        rule: testRule,
        period: '2026-09',
      });
      expect(r.status).toBe(key === 'unsupported' ? 'blocked' : 'validated');
      if (key !== 'unsupported') expect(r.summary?.weightKg).toBe('2150.000');
      else expect(r.issues.some((x) => x.code === 'FORMULA_VALUE_UNVERIFIED')).toBe(true);
    }
    const structure = await dataPython<Structure>('inspect', {
      file: files.legacy,
      name: '中文.csv',
      options: {},
    });
    expect(structure.meta.encoding).toBe('gb18030');
    expect(structure.sheets[0].columns[0]).toBe('业务单号');
    expect((await compute(Buffer.from(files.legacy, 'base64'))).summary?.weightKg).toBe('1.250');
  });
  it('reopens both native report formats and preserves identical verified facts and source versions', async () => {
    const result = await compute();
    const out = await dataPython<{
      docx: string;
      xlsx: string;
      validation: { weightKg: string; includedCount: number };
    }>('report', {
      data: {
        id: 'a'.repeat(64),
        resultHash: 'b'.repeat(64),
        result,
        mapping,
        source: { name: '合成验收.csv', versionId: 'fixed-version', sha256: 'c'.repeat(64) },
        sourceUrl: 'https://zhenwork.shizibandu.icu/enterprise/files/download?path=source&version=fixed-version',
        policy: { id: 'x', name: '合成测试口径', version: 2, definition: testRule },
      },
    });
    expect(Buffer.from(out.docx, 'base64').subarray(0, 2).toString()).toBe('PK');
    expect(Buffer.from(out.xlsx, 'base64').length).toBeGreaterThan(5000);
    expect(out.validation).toMatchObject({ weightKg: '2150.000', includedCount: 3 });
  });
});

it('compares changed verified totals with exact decimal subtraction', () => {
  expect(decimalDifference('2150.000', '2151.250')).toBe('1.250');
  expect(decimalDifference('0.300', '0.100')).toBe('-0.200');
  expect(decimalDifference('9999999999999999.999', '10000000000000000.001')).toBe('0.002');
});

it.skipIf(!available)(
  'preserves numeric and formula preview precision instead of forcing monetary decimals',
  async () => {
    const file = execFileSync(
      process.env.ZHENWORK_OFFICE_PYTHON!,
      [
        '-c',
        String.raw`import openpyxl,io,base64
w=openpyxl.Workbook();s=w.active
s['A1']=0.001;s['A1'].number_format='0.000'
s['A2']='=A1+A1';s['A2'].number_format='0.000'
s['B1']=12.35;s['B1'].number_format='0.00'
s['C1']=0.0151;s['C1'].number_format='0.000000'
b=io.BytesIO();w.save(b);print(base64.b64encode(b.getvalue()).decode())`,
      ],
      { encoding: 'utf8' }
    );
    const view = (await previewWorkbook(Buffer.from(file.trim(), 'base64'))) as {
      rows: Array<{ cells: Array<{ text: string }> }>;
    };
    expect(view.rows[0].cells[0].text).toBe('0.001');
    expect(view.rows[1].cells[0].text).toBe('0.002');
    expect(view.rows[0].cells[1].text).toBe('12.35');
    expect(view.rows[0].cells[2].text).toBe('0.015100');
  }
);
