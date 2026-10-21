import { afterEach, expect, test } from 'vitest';
import { summarizeJsonData } from './data-summary.js';
afterEach(() => {
  delete process.env.ZHENWORK_OFFICE_PYTHON;
});
test('flattens real daily arrays, exact-decimal sums and source counts; never silently converts a list to zero', async () => {
  process.env.ZHENWORK_OFFICE_PYTHON = '/usr/bin/python3';
  const data = Buffer.from(
    '{"expenses":[{"daily":[{"date":"d1","amount":0.1},{"date":"d1","amount":"0.2"}]},{"daily":[{"date":"d2","amount":"19.995"}]}],"invoices":[{"source":"a"},{"source":"a"},{"source":"b"}]}'
  );
  const output = await summarizeJsonData(data, [
    { collection: 'expenses', flatten: 'daily', groupBy: 'date', sum: 'amount' },
    { collection: 'invoices', groupBy: 'source' },
  ]);
  expect(output).toMatchObject({
    calculations: [
      { itemCount: 3, groups: { d1: { count: 2, sum: '0.3' }, d2: { sum: '19.995' } } },
      { itemCount: 3, groups: { a: { count: 2 }, b: { count: 1 } } },
    ],
  });
  await expect(summarizeJsonData(data, [{ collection: 'expenses', sum: 'daily' }])).rejects.toThrow(
    'sum must select decimal'
  );
  await expect(summarizeJsonData(data, [{ collection: 'expenses', flatten: 'unknown' }])).rejects.toThrow(
    'missing field'
  );
});
