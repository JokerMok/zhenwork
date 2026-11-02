import { expect, test } from 'vitest';
import { methodReportScope, methodTime } from './index.js';
const result = (periods: string[]) => ({
  summary: { analysisInput: { periods } },
  sheets: [],
  analysisSheet: { name: '产废分析输入', headers: [], rows: [] },
});
test('single month comes from actual data despite a saved comparison title and months', () => {
  expect(methodReportScope(result(['2026-11']), false, ['2026-10', '2026-11'], '10/11月比较')).toMatchObject({
    kind: 'monthly',
    periods: ['2026-11'],
    title: '2026年11月固危废月度分析',
  });
  expect(
    methodTime({ cutoff: '2026-11-02', analysis: { periods: ['2026-10', '2026-11'] } }, undefined, '2026-11-02', false)
  ).toEqual({ periods: [], cutoff: '2026-11-02' });
});
test('two actual months require comparison intent; missing months never claim a comparison', () => {
  expect(methodReportScope(result(['2026-10', '2026-11']), true, ['2026-10', '2026-11']).kind).toBe('comparison');
  expect(methodReportScope(result(['2026-10', '2026-11']), false).kind).toBe('range');
  expect(methodReportScope(result(['2026-11']), true, ['2026-10', '2026-11']).kind).toBe('monthly');
});
test('multiple months and unknown or invalid periods cannot use a comparison title', () => {
  expect(methodReportScope(result(['2026-09', '2026-10', '2026-11']), false).title).toBe(
    '2026年9月至2026年11月固危废分析'
  );
  expect(methodReportScope(result(['2026-13']), true, ['2026-10', '2026-11']).kind).toBe('unconfirmed');
  expect(() => methodTime({ cutoff: '2026-09-31' }, undefined, undefined, false)).toThrow('METHOD_CUTOFF_DATE_INVALID');
});

test('a single explicit month is allowed for a monthly task but never substitutes for a comparison pair', () => {
 expect(methodTime({cutoff:'2026-11-02'}, ['2026-11'], '2026-11-02', false)).toEqual({periods:['2026-11'],cutoff:'2026-11-02'});
 expect(() => methodTime({cutoff:'2026-11-02'}, ['2026-11'], '2026-11-02', true)).toThrow('METHOD_TWO_ORDERED_PERIODS_REQUIRED');
});
