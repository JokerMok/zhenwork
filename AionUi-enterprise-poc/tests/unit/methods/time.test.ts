import { describe, it, expect } from 'vitest';
import { methodTime } from '../../../packages/web-host/src/office/methods/index';
import { pinMethodTime } from '../../../packages/web-host/src/office/methods/continuation';
import { compare, data, preferences, config, company, rows } from './fixture';
type Cost = { totals: Array<{ after: string | null }>; cashOut: unknown; missingPeriods: string[] };
type Intensity = {
  total: { wasteBeforeKg: string; wasteAfterKg: string | null; productionAfter: string | null; comparable: boolean };
};
describe('task-level month and calendar boundaries', () => {
  it('changes only this request and keeps two separate months', async () => {
    const before = JSON.stringify(preferences);
    const a = await compare();
    const b = await compare(structuredClone(data), methodTime(preferences, ['2026-09', '2026-10'], '2026-10-31'));
    expect((a.summary.intensity as Intensity).total.wasteBeforeKg).toBe('3700');
    expect((b.summary.intensity as Intensity).total).toMatchObject({
      wasteBeforeKg: '4500',
      wasteAfterKg: '4700',
      productionAfter: '1320',
    });
    expect(JSON.stringify(preferences)).toBe(before);
  });
  it('rejects impossible cutoff dates and pins time across retries within a round', async () => {
    expect(() => methodTime(preferences, ['2026-08', '2026-09'], '2026-09-31')).toThrow('METHOD_CUTOFF_DATE_INVALID');
    const values = new Map<string, unknown>();
    const store = {
      businessResult: async (k: string) => values.get(k),
      saveBusinessResult: async (k: string, v: unknown) => {
        values.set(k, v);
      },
    };
    const a = methodTime(preferences, ['2026-08', '2026-09'], '2026-09-30');
    await pinMethodTime(store, 'same-round', a);
    await expect(
      pinMethodTime(store, 'same-round', methodTime(preferences, ['2026-09', '2026-10'], '2026-10-31'))
    ).rejects.toThrow('METHOD_TASK_TIME_CHANGED_RETRY');
  });
  it('retains an invalid settlement date with source/raw value and excludes its amount', async () => {
    const d = structuredClone(data);
    d.tables.costs[1].settlementDate = '2026-09-31';
    const r = await compare(d);
    expect(
      r.issues.some(
        (i) => i.code === 'COST_DATE_INVALID' && i.source.includes('costs') && i.detail.includes('2026-09-31')
      )
    ).toBe(true);
    expect((r.summary.costChange as Cost).totals[0].after).toBeNull();
  });
  it('does not let a bad payment date erase valid settlement; separately validates business basis', async () => {
    const d = structuredClone(data);
    d.tables.costs[1].paymentDate = '2026-09-31';
    d.tables.costs[1].paidAmount = 13200;
    const r = await compare(d);
    expect((r.summary.costChange as Cost).totals[0].after).toBe('14200');
    expect((r.summary.costChange as Cost).cashOut).toBeNull();
    expect(r.issues.some((i) => i.code === 'PAYMENT_DATE_INVALID')).toBe(true);
  });
  it('validates the business calendar date when business date is selected', async () => {
    const d = structuredClone(data);
    d.tables.costs[1].businessDate = '2026-09-31';
    const cfg = structuredClone(config);
    const pref = structuredClone(preferences);
    pref.analysis.costDateField = 'businessDate';
    cfg.files.find((f) => f.path === 'references/preferences.json')!.content = JSON.stringify(pref);
    const r = await compare(d, undefined, cfg);
    expect(r.issues.some((i) => i.code === 'COST_DATE_INVALID' && i.detail.includes('businessDate'))).toBe(true);
    expect((r.summary.costChange as Cost).totals[0].after).toBeNull();
  });
  it('does not count a receipt on October 2 as received at September 30', async () => {
    const a = await compare();
    const b = await compare(structuredClone(data), methodTime(preferences, ['2026-09', '2026-10'], '2026-10-31'));
    expect(rows(a, '清运时点').find((r) => r[0] === 'G09')?.[2]).toBe('待核');
    expect(rows(b, '清运时点').find((r) => r[0] === 'G09')?.[2]).toBe(2690);
  });
  it('reports missing October coverage instead of creating zero production or exited fees', async () => {
    const d = structuredClone(data);
    d.tables.production = d.tables.production.filter((r: { period: string }) => r.period !== '2026-10');
    d.tables.costs = d.tables.costs.filter((r: { settlementDate: string }) => !r.settlementDate.startsWith('2026-10'));
    const r = await compare(d, methodTime(preferences, ['2026-09', '2026-10'], '2026-10-31'));
    expect((r.summary.intensity as Intensity).total.productionAfter).toBeNull();
    expect((r.summary.costChange as Cost).missingPeriods).toEqual(['2026-10']);
    expect((r.summary.costChange as Cost).totals.every((t) => t.after === null)).toBe(true);
  });
  it('does not inject the demonstration scope into ordinary enterprise source rows', async () => {
    const cfg = structuredClone(config);
    const c = structuredClone(company);
    c.fictional = false;
    cfg.files.find((f) => f.path === 'references/company.json')!.content = JSON.stringify(c);
    const r = await compare(structuredClone(data), undefined, cfg);
    expect((r.summary.intensity as Intensity).total.comparable).toBe(false);
  });
});
