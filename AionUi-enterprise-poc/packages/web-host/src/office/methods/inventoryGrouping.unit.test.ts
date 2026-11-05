import { expect, test } from 'vitest';
import { groupInventory } from './inventoryGrouping.js';
const headers = ['库区', '批次', '废物', '账面kg', '盘点kg', '差异kg', '批次天数', '来源', '状态'];
test('warehouse grouping keeps exact decimals and offsetting batch errors visible', () => {
  const sheet = groupInventory(
    {
      name: '库存差异',
      headers,
      rows: [
        ['A', 'B1', 'X', '0.100001', '0.200001', '0.100000', 1, 'row1', '核算'],
        ['A', 'B2', 'X', '0.200002', '0.100002', '-0.100000', 1, 'row2', '核算'],
      ],
    },
    true,
    {}
  );
  expect(sheet.rows).toHaveLength(1);
  expect(sheet.rows[0].slice(0, 7)).toEqual(['A', 0.300003, 0.300003, 0, 2, 2, 0]);
});
test('missing counts stay unknown and capacity reminders remain in exception output', () => {
  const sheet = groupInventory(
    {
      headers,
      rows: [
        ['A', 'B1', 'X', '10', null, null, 1, 'r1', '待核'],
        ['B', 'B2', 'X', '80', '80', '0', 1, 'r2', '核算'],
        ['C', 'B3', 'X', '1', '1', '0', 1, 'r3', '核算'],
      ],
    },
    true,
    { capacityAttention: [{ warehouse: 'B', capacityPercent: '80', thresholdPercent: '80' }] }
  );
  expect(sheet.rows.map((r) => r[0])).toEqual(['A', 'B']);
  expect(sheet.rows[0][2]).toBe('未提供/待核');
  expect(sheet.rows[1][7]).toContain('个人阈值80%');
});
test('changed processor schemas and nondecimal quantities fail explicitly', () => {
  expect(() => groupInventory({ headers: ['unexpected'], rows: [] }, false, {})).toThrow('METHOD_GROUP_SCHEMA_CHANGED');
  expect(() => groupInventory({ headers, rows: [['A', 'B', 'X', 'NaN', null, null, 1, 'r', '']] }, false, {})).toThrow(
    'METHOD_GROUP_QUANTITY_INVALID'
  );
});

test('renamed sheets retain their title and native numeric quantities; processor missing markers remain unknown', () => {
  const sheet = groupInventory(
    { name: '库存盘点', headers, rows: [['A', 'B', 'X', 10, '未提供/待核', '未提供/待核', 1, 'r', '待核']] },
    true,
    {}
  );
  expect(sheet.name).toBe('库存盘点');
  expect(sheet.rows[0][1]).toBe(10);
  expect(sheet.rows[0][2]).toBe('未提供/待核');
});
