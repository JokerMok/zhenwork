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
