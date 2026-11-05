import type { OfficeSheet } from '../generate.js';

const SCALE = 1_000_000n;
function quantity(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '未提供/待核') return null;
  const text = String(value);
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(text)) throw Error('METHOD_GROUP_QUANTITY_INVALID');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -result : result;
}
const formatted = (value: bigint | null): string | number => {
  if (value === null) return '未提供/待核';
  const absolute = value < 0 ? -value : value;
  const decimal = `${value < 0 ? '-' : ''}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(6, '0')}`;
  const result = Number(decimal);
  // Preserve native numeric XLSX cells; refuse sums beyond the reviewed precision contract.
  if (!Number.isFinite(result) || Math.abs(result) > 99_999_999_999.999 || quantity(result.toFixed(6)) !== value)
    throw Error('METHOD_GROUP_NUMERIC_PRECISION_LIMIT');
  return result;
};

/** Group reviewed processor output without changing business calculations or hiding offsetting batch errors. */
export function groupInventory(
  sheet: OfficeSheet,
  differencesOnly: boolean,
  inventory: Record<string, unknown>
): OfficeSheet {
  const expected = ['库区', '批次', '废物', '账面kg', '盘点kg', '差异kg', '批次天数', '来源', '状态'];
  if (JSON.stringify(sheet.headers) !== JSON.stringify(expected)) throw Error('METHOD_GROUP_SCHEMA_CHANGED');
  const groups = new Map<
    string,
    {
      book: bigint | null;
      physical: bigint | null;
      difference: bigint | null;
      batches: number;
      exceptions: number;
      missing: number;
      sources: Set<string>;
      states: Set<string>;
    }
  >();
  for (const row of sheet.rows) {
    const warehouse = String(row[0]);
    const group = groups.get(warehouse) ?? {
      book: 0n,
      physical: 0n,
      difference: 0n,
      batches: 0,
      exceptions: 0,
      missing: 0,
      sources: new Set<string>(),
      states: new Set<string>(),
    };
    const book = quantity(row[3]),
      physical = quantity(row[4]),
      difference = quantity(row[5]);
    group.book = group.book === null || book === null ? null : group.book + book;
    group.physical = group.physical === null || physical === null ? null : group.physical + physical;
    group.difference = group.difference === null || difference === null ? null : group.difference + difference;
    group.batches++;
    if (difference === null) group.missing++;
    else if (difference !== 0n) group.exceptions++;
    if (row[7]) group.sources.add(String(row[7]));
    if (row[8]) group.states.add(String(row[8]));
    groups.set(warehouse, group);
  }
  const attention = new Map<string, string[]>();
  for (const kind of ['capacityAttention', 'batchAttention']) {
    const values = inventory[kind];
    if (!Array.isArray(values)) continue;
    for (const item of values as Array<Record<string, unknown>>) {
      const key = String(item.warehouse),
        notes = attention.get(key) ?? [];
      notes.push(
        kind === 'capacityAttention'
          ? `容量${item.capacityPercent}%，个人阈值${item.thresholdPercent}%`
          : `批次${item.batch}：${item.days}天（内部关注）`
      );
      attention.set(key, notes);
    }
  }
  return {
    name: sheet.name,
    headers: ['库区', '账面kg', '盘点kg', '差异kg', '批次数', '差异批次', '待补盘点批次', '内部提醒', '来源', '状态'],
    rows: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([key, group]) => !differencesOnly || group.exceptions > 0 || group.missing > 0 || attention.has(key))
      .map(([key, group]) => [
        key,
        formatted(group.book),
        formatted(group.physical),
        formatted(group.difference),
        group.batches,
        group.exceptions,
        group.missing,
        (attention.get(key) ?? []).join('；'),
        [...group.sources].join('；'),
        [...group.states].join('；'),
      ]),
  };
}
