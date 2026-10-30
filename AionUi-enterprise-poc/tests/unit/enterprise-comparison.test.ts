import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executeMethod } from '../../packages/web-host/src/office/methods/index';
import { generateOfficeArtifact } from '../../packages/web-host/src/office/generate';
import { inspectWorkbook } from '../../packages/web-host/src/office/workbook/index';
const root = path.resolve('../capabilities/waste-specialist');
const company = JSON.parse(await fs.readFile(root + '/references/company.json', 'utf8'));
const preferences = JSON.parse(await fs.readFile(root + '/references/preferences.json', 'utf8'));
const input = JSON.parse(await fs.readFile(root + '/examples/comparison/产废强度费用变化-追加模拟-v1.json', 'utf8'));
const source = await fs.readFile(root + '/examples/comparison/既有核对结果-脱敏模拟.json');
const script = await fs.readFile(root + '/scripts/process_records.py', 'utf8');
const instruction = await fs.readFile(root + '/SKILL.md', 'utf8');
const id = '11111111-1111-4111-a111-111111111111';
async function run(
  data = structuredClone(input),
  prefs = structuredClone(preferences),
  methods = ['intensity', 'cost_change']
) {
  const config = {
    source: instruction,
    files: [
      ['scripts/process_records.py', script],
      ['references/company.json', JSON.stringify(company)],
      ['references/preferences.json', JSON.stringify(prefs)],
    ].map(([file, content]) => ({ path: file, content, encoding: 'utf8' })),
  };
  return executeMethod({
    client: { authorizedResource: async () => ({ version: 6, config }) },
    resourceId: id,
    input: Buffer.from(JSON.stringify(data)),
    name: '追加模拟.json',
    methods,
    read: async (file) => ({ bytes: source, relative: file }),
  });
}
describe('reuse intensity and cost comparison', () => {
  it('matches independent references and exports real numeric cells in one workbook', async () => {
    const r = await run();
    const a = r.summary.intensity as { total: Record<string, unknown> };
    expect(a.total).toMatchObject({
      productionBefore: '1000',
      productionAfter: '1250',
      wasteBeforeKg: '3700',
      wasteAfterKg: '4500',
      intensityBefore: '3.7',
      intensityAfter: '3.6',
      productionChangePercent: '25',
      wasteChangePercent: '21.6216',
      intensityChangePercent: '-2.7027',
    });
    const c = r.summary.costChange as {
      items: Array<Record<string, unknown>>;
      totals: Array<Record<string, unknown>>;
      pending: Array<Record<string, unknown>>;
      cashOut: unknown;
      legacyChanges: Array<Record<string, unknown>>;
    };
    expect(c.items.find((x) => x.project === 'NEW-DISPOSAL')).toMatchObject({
      difference: '3200',
      quantityEffect: '2000',
      priceEffect: '1200',
      otherEffect: '0',
    });
    expect(c.items.find((x) => x.project === 'NEW-TRANSPORT')).toMatchObject({
      difference: '300',
      quantityEffect: null,
      priceEffect: null,
      otherEffect: '300',
    });
    expect(c.totals[0]).toMatchObject({ before: '10500', after: '14200', difference: '3700' });
    expect(c.pending.some((x) => x.shipment === 'O09' && x.finalAmount === null)).toBe(true);
    expect(c.cashOut).toBeNull();
    expect(c.legacyChanges.find((x) => x.direction === '回收收入')).toMatchObject({
      before: '1095',
      after: '1345',
      difference: '250',
    });
    expect(r.issues.some((x) => x.code === 'PRODUCTION_MISSING_OR_UNIT_UNKNOWN')).toBe(true);
    expect(r.coverage).toMatchObject({ allRowsProcessed: true, reusedNormalizedRows: 24 });
    const bytes = await generateOfficeArtifact({ format: 'xlsx', title: '比较', sheets: r.sheets });
    const inspection = await inspectWorkbook(bytes, { sheet: '强度变化', maxRows: 10, maxColumns: 13 });
    expect(inspection).toBeTruthy();
  });
  it('reads saved periods/date choice, thresholds and differences/detail preferences', async () => {
    const p = structuredClone(preferences);
    p.analysis.costDateField = 'businessDate';
    p.analysis.weightDisplayUnit = '吨';
    p.analysis.costAlertPercent = '1000';
    p.analysis.intensityAlertPercent = '1000';
    p.analysis.differencesOnly = true;
    p.analysis.outputs.detail = false;
    const r = await run(structuredClone(input), p);
    expect((r.summary.costChange as { totals: Array<{ difference: string }> }).totals[0].difference).toBe('3300');
    expect((r.summary.costChange as { attention: unknown[] }).attention).toEqual([]);
    expect((r.summary.intensity as { attention: unknown[] }).attention).toEqual([]);
    expect(r.sheets.some((s) => s.name === '产废强度')).toBe(false);
    expect((r.summary.intensity as { total: { intensityBefore: string } }).total.intensityBefore).toBe('0.0037');
    expect(r.summary.configApplied).toMatchObject({ costDateField: 'businessDate', differencesOnly: true });
  });
  it('does not combine incompatible production units or force a zero/missing denominator', async () => {
    const d = structuredClone(input);
    d.tables.production[0].quantity = 0;
    d.tables.production[1].unit = '吨';
    const r = await run(d);
    expect((r.summary.intensity as { total: { comparable: boolean; intensityBefore: null } }).total.comparable).toBe(
      false
    );
    expect(JSON.stringify(r)).not.toMatch(/Infinity|NaN/);
    expect(r.issues.some((x) => x.code === 'INTENSITY_NOT_SUPPORTED')).toBe(true);
  });
  it('separates product-mix changes, unknown fees and zero prior amounts', async () => {
    const d = structuredClone(input);
    d.tables.production[3].comparability = '产品结构变化';
    d.tables.costs[1].quantity = null;
    d.tables.costs[2].amount = 0;
    const r = await run(d);
    expect((r.summary.intensity as { total: { comparable: boolean } }).total.comparable).toBe(false);
    expect((r.summary.costChange as { completeProvidedNewProjects: boolean }).completeProvidedNewProjects).toBe(false);
    expect(r.issues.some((x) => x.code === 'COST_CONDITIONS_PENDING')).toBe(true);
    expect((r.summary.costChange as { totals: Array<{ after: null }> }).totals[0].after).toBeNull();
    expect(
      (r.summary.costChange as { items: Array<{ project: string; decompositionConvention: string }> }).items.find(
        (i) => i.project === 'NEW-DISPOSAL'
      )?.decompositionConvention
    ).toContain('待核');
    expect(JSON.stringify(r)).not.toContain('Infinity');
  });
  it('treats source version conflicts as missing support, never verified zero', async () => {
    const d = structuredClone(input);
    d.tables.sources[0].sha256 = '0'.repeat(64);
    const r = await run(d);
    expect(r.issues.some((x) => x.code === 'SOURCE_VERSION_CONFLICT')).toBe(true);
    expect(
      (r.summary.intensity as { total: { wasteBeforeKg: null; intensityBefore: null } }).total.wasteBeforeKg
    ).toBeNull();
  });
  it('keeps source ACL/traversal checks on the new content path', async () => {
    const d = structuredClone(input);
    d.tables.sources[0].path = '../other-person/secret.json';
    await expect(run(d)).rejects.toThrow('METHOD_SOURCE_PATH_INVALID');
  });
});
