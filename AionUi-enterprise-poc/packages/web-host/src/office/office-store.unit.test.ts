import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { enterpriseManagedResourcePath } from '../enterprise-resource-runtime.js';
import { OfficeStore, validateKnowledgeScope } from './office-store.js';

const roots: string[] = [];
const actor = (userId: string) => ({ serverId: 'rc2', userId });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function fixture(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'office-store-'));
  const workspace = path.join(root, 'workspace');
  roots.push(root);
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('concurrent cold start creates one actor store without directory races', async () => {
  const { root } = await fixture();
  const stores = await Promise.all(Array.from({ length: 20 }, () => OfficeStore.create(root, actor('17'))));
  expect(new Set(stores).size).toBe(1);
});

test('one actor gets one sequenced store when its control path already exists', async () => {
  const { root } = await fixture();
  await enterpriseManagedResourcePath(root, actor('21'));
  const stores = await Promise.all(Array.from({ length: 20 }, () => OfficeStore.create(root, actor('21'))));
  expect(new Set(stores).size).toBe(1);
});

test('memories remain actor-isolated and concurrent updates are not lost', async () => {
  const { root } = await fixture();
  const first = await OfficeStore.create(root, actor('17'));
  const second = await OfficeStore.create(root, actor('18'));
  await Promise.all(Array.from({ length: 20 }, (_, index) => first.remember({
    scope: 'personal', content: `first-${index}`,
  })));
  await second.remember({ scope: 'personal', content: 'second-only' });
  expect((await first.memories()).map((item) => item.content).sort()).toEqual(
    Array.from({ length: 20 }, (_, index) => `first-${index}`).sort(),
  );
  expect((await second.memories()).map((item) => item.content)).toEqual(['second-only']);
});

test.runIf(process.platform === 'linux')('file versions restore exact bytes and preserve the replaced version', async () => {
  const { root, workspace } = await fixture();
  const store = await OfficeStore.create(root, actor('19'));
  await store.upload(workspace, '资料/report.txt', Buffer.from('version one'));
  await store.upload(workspace, '资料/report.txt', Buffer.from('version two'), true);

  const listed = await store.files(workspace);
  const report = listed.files.find((item) => item.path === '资料/report.txt');
  const versions = report?.versions as Array<{ id: string; sha256: string }>;
  const original = versions.find((item) => item.sha256 === sha256('version one'));
  expect(original).toBeDefined();

  await store.restore(workspace, '资料/report.txt', original!.id);
  expect((await store.download(workspace, '资料/report.txt')).toString()).toBe('version one');
  const after = await store.files(workspace);
  const restored = after.files.find((item) => item.path === '资料/report.txt');
  expect((restored?.versions as Array<{ sha256: string }>).some((item) => item.sha256 === sha256('version two'))).toBe(true);
});

test.runIf(process.platform === 'linux')('ordinary symlink traversal is rejected for reads and writes', async () => {
  const { root, workspace } = await fixture();
  const outside = path.join(root, 'outside');
  await mkdir(path.join(workspace, '资料'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(path.join(outside, 'secret.txt'), path.join(workspace, '资料', 'secret-link.txt'));
  await symlink(outside, path.join(workspace, '资料', 'outside-link'));
  const store = await OfficeStore.create(root, actor('20'));

  await expect(store.download(workspace, '资料/secret-link.txt')).rejects.toThrow('WORKSPACE_DENIED');
  await expect(store.upload(workspace, '资料/outside-link/escaped.txt', Buffer.from('escaped'))).rejects.toThrow('WORKSPACE_DENIED');
});

test.runIf(process.platform === 'linux')('a rejected version-budget upload does not leave an unreported file behind', async () => {
  const { root, workspace } = await fixture();
  const currentActor = actor('22');
  const managed = await enterpriseManagedResourcePath(root, currentActor);
  const directory = path.join(path.dirname(managed), 'office');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'index.json'), JSON.stringify({
    files: { old: [{ id: 'existing', createdAt: new Date().toISOString(), byteSize: 256 * 1024 * 1024, sha256: '0'.repeat(64) }] },
    memories: [],
  }));
  const store = await OfficeStore.create(root, currentActor);
  await expect(store.upload(workspace, '资料/unreported.txt', Buffer.from('must be atomic'))).rejects.toThrow('VERSION_STORAGE_LIMIT_256MB');
  await expect(readFile(path.join(workspace, '资料', 'unreported.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.runIf(process.platform === 'linux')('overwrite refuses to erase a Core edit made after the version snapshot', async () => {
  const { root, workspace } = await fixture();
  const store = await OfficeStore.create(root, actor('24'));
  const directory = path.join(workspace, '资料');
  const target = path.join(directory, 'race.txt');
  await store.upload(workspace, '资料/race.txt', Buffer.from('original'));

  let changed = false;
  const concurrentEdit = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upload temporary file was not observed')), 5_000);
    const watcher = watch(directory, (_event, filename) => {
      if (changed || !String(filename).startsWith('.zhenwork-upload-')) return;
      changed = true;
      void writeFile(target, 'concurrent Core edit').then(() => {
        clearTimeout(timer);watcher.close();resolve();
      }, reject);
    });
  });
  const upload = store.upload(workspace, '资料/race.txt', Buffer.alloc(48 * 1024 * 1024, 0x78), true);
  await concurrentEdit;
  await expect(upload).rejects.toThrow('FILE_CHANGED_RETRY');
  expect(await readFile(target, 'utf8')).toBe('concurrent Core edit');
});

test.runIf(process.platform !== 'linux')('file access fails closed on platforms without descriptor paths', async () => {
  const { root, workspace } = await fixture();
  const store = await OfficeStore.create(root, actor('23'));
  await expect(store.upload(workspace, '资料/report.txt', Buffer.from('data'))).rejects.toThrow('OFFICE_FILE_STORAGE_REQUIRES_LINUX');
  await expect(store.download(workspace, '资料/report.txt')).rejects.toThrow('OFFICE_FILE_STORAGE_REQUIRES_LINUX');
});

test('delivery receipts persist by actor and dataset without exposing another employee receipt', async () => {
  const { root } = await fixture();
  const first = await OfficeStore.create(root, actor('17'));
  const second = await OfficeStore.create(root, actor('18'));
  await first.rememberDelivery('a'.repeat(64), 'report.docx', 'b'.repeat(64));
  expect(await first.deliveryReceipt('a'.repeat(64), 'report.docx')).toBe('b'.repeat(64));
  expect(await second.deliveryReceipt('a'.repeat(64), 'report.docx')).toBeUndefined();
  await expect(first.rememberDelivery('not-a-hash', 'report.docx', 'b'.repeat(64))).rejects.toThrow('INVALID_DELIVERY_RECEIPT');
});

test.runIf(process.platform === 'linux')('invalid Office originals remain listed and downloadable without weakening tool validation or path isolation', async () => {
  const { root, workspace } = await fixture();
  const store = await OfficeStore.create(root, actor('29'));
  await writeFile(path.join(workspace, 'broken.xlsx'), 'PK broken original');
  await expect(store.download(workspace, 'broken.xlsx')).rejects.toThrow('OFFICE_FILE_INCOMPLETE_RETRY');
  expect((await store.downloadOriginal(workspace, 'broken.xlsx')).toString()).toBe('PK broken original');
  expect((await store.files(workspace)).files.some(file => file.path === 'broken.xlsx')).toBe(true);
  await writeFile(path.join(root, 'outside.xlsx'), 'private');
  await symlink(path.join(root, 'outside.xlsx'), path.join(workspace, 'escape.xlsx'));
  await expect(store.downloadOriginal(workspace, 'escape.xlsx')).rejects.toThrow('WORKSPACE_DENIED');
});

test('task knowledge selection is persistent metadata isolated by actor and conversation', async () => {
  const { root } = await fixture();
  const first = await OfficeStore.create(root, actor('70'));
  const second = await OfficeStore.create(root, actor('71'));
  const scope = { baseIds: ['11111111-1111-4111-8111-111111111111'], documents: [] };
  await first.selectKnowledge('c1', scope);
  expect(await first.knowledgeScope('c1')).toEqual(scope);
  expect(await second.knowledgeScope('c1')).toBeUndefined();
  expect(await first.knowledgeScope('c2')).toBeUndefined();
  await first.selectKnowledge('c1', { baseIds: [], documents: [] });
  expect(await first.knowledgeScope('c1')).toEqual({ baseIds: [], documents: [] });
});

test('invalid knowledge selectors cannot become persisted runtime scope', () => {
  expect(() => validateKnowledgeScope({ baseIds: ['arbitrary-url'], documents: [] })).toThrow(
    'INVALID_KNOWLEDGE_SCOPE'
  );
  expect(() =>
    validateKnowledgeScope({
      baseIds: [],
      documents: [
        {
          baseId: '11111111-1111-4111-8111-111111111111',
          documentId: '22222222-2222-4222-8222-222222222222',
          version: 0,
        },
      ],
    })
  ).toThrow('INVALID_KNOWLEDGE_SCOPE');
});
