import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeMethod, type TaskTime } from '../../../packages/web-host/src/office/methods/index';
export const root = path.resolve('../capabilities/waste-specialist');
export const folder = root + '/examples/continuation';
export const id = '11111111-1111-4111-a111-111111111111';
export const versionId = '22222222-2222-4222-a222-222222222222';
export const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const company = JSON.parse(await fs.readFile(root + '/references/company.json', 'utf8'));
export const preferences = JSON.parse(await fs.readFile(root + '/references/preferences.json', 'utf8'));
export const data = JSON.parse(await fs.readFile(folder + '/换月补证追加模拟-v1.json', 'utf8'));
const source = await fs.readFile(root + '/SKILL.md', 'utf8');
export const config = {
  source,
  files: await Promise.all(
    ['scripts/process_records.py', 'references/company.json', 'references/preferences.json'].map(async (p) => ({
      path: p,
      content: await fs.readFile(root + '/' + p, 'utf8'),
      encoding: 'utf8',
    }))
  ),
};
export const client = { authorizedResource: async () => ({ version: 8, config }) };
export async function read(file: string) {
  let local = file.startsWith('资料/换月补证模拟/')
    ? folder + '/' + path.basename(file)
    : root + '/examples/' + file.replace(/^资料\//, '');
  if (file === '资料/补证.xlsx') local = folder + '/更正账单与补证-模拟-v1.xlsx';
  return { bytes: await fs.readFile(local), relative: file, versionId };
}
export async function compare(
  input = structuredClone(data),
  parameters: TaskTime = { periods: ['2026-08', '2026-09'], cutoff: '2026-09-30' },
  cfg = structuredClone(config)
) {
  return executeMethod({
    client: { authorizedResource: async () => ({ version: 8, config: cfg }) },
    resourceId: id,
    input: Buffer.from(JSON.stringify(input)),
    name: '追加.json',
    methods: ['intensity', 'cost_change'],
    parameters,
    read,
  });
}
export const rows = (r: Awaited<ReturnType<typeof compare>>, name: string) =>
  r.sheets.find((s) => s.name === name)!.rows;
