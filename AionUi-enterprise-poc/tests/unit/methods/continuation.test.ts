import { describe, it, expect } from 'vitest';
import {
  prepareRevision,
  saveMethodSnapshot,
  type MethodSnapshot,
  type FileRef,
} from '../../../packages/web-host/src/office/methods/continuation';
import { compare, client, folder, id, versionId, read, rows, sha } from './fixture';
import fs from 'node:fs/promises';
async function fixture() {
  const r = await compare();
  const resultBytes = Buffer.from('fixed original result');
  const base = { path: '八九月差异.xlsx', versionId, sha256: sha(resultBytes) };
  const evidenceBytes = await fs.readFile(folder + '/更正账单与补证-模拟-v1.xlsx');
  const evidence: FileRef = { path: '资料/补证.xlsx', versionId, sha256: sha(evidenceBytes) };
  const saved = new Map<string, unknown>();
  const deliveries = new Map<string, string>();
  let latest = { ...base, version: 1, byteSize: resultBytes.length, createdAt: '2026-11-01' };
  const store = {
    businessResult: async (k: string) => saved.get(k),
    saveBusinessResult: async (k: string, v: unknown) => {
      saved.set(k, v);
    },
    deliveryReceipt: async (k: string) => deliveries.get(k),
    fileReceipt: async () => latest,
  };
  const snapshot: MethodSnapshot = {
    kind: 'ENTERPRISE_METHOD_CONTINUATION_V1',
    resourceId: id,
    configSha256: r.provenance.configSha256,
    processorSha256: r.provenance.processorSha256,
    parameters: { periods: ['2026-08', '2026-09'], cutoff: '2026-09-30' },
    input: { path: '追加.json', versionId, sha256: sha('input') },
    sources: r.provenance.sourceFiles as FileRef[],
    continuation: r.continuation!,
    sheets: r.sheets,
    summary: r.summary,
  };
  await saveMethodSnapshot(store, base.sha256, snapshot);
  const reader = async (file: string, version?: string) =>
    file === base.path
      ? { bytes: resultBytes, relative: file, versionId: version }
      : file === '追加.json'
        ? { bytes: Buffer.from('input'), relative: file, versionId }
        : read(file);
  return {
    r,
    base,
    evidence,
    snapshot,
    store,
    saved,
    deliveries,
    reader,
    revision: { baseVersionId: versionId, baseSha256: base.sha256, businessIds: ['O08', 'O09'], evidence: [evidence] },
    setLatest: (value: typeof latest) => {
      latest = value;
    },
  };
}
describe('pinned business evidence continuation', () => {
  it('clears the independently reconciled bill and leaves the other final amount pending', async () => {
    const f = await fixture();
    const r = await prepareRevision({
      store: f.store,
      client,
      resourceId: id,
      path: f.base.path,
      revision: f.revision,
      read: f.reader,
    });
    if (r.reused) throw Error('unexpected reuse');
    const a = rows(r.result, '结算对账').find((x) => x[1] === 'O08')!,
      b = rows(r.result, '结算对账').find((x) => x[1] === 'O09')!;
    expect([a[9], a[11]]).toEqual([1838, 0]);
    expect([b[8], b[9], b[13]]).toEqual([2124, '未提供/待核', '实际车次未提供']);
    expect(rows(r.result, '清运时点').find((x) => x[0] === 'O09')?.[2]).toBe(1210);
  });
  it('preserves all unaffected settlement rows and only identifies requested businesses as recomputed', async () => {
    const f = await fixture();
    const r = await prepareRevision({
      store: f.store,
      client,
      resourceId: id,
      path: f.base.path,
      revision: f.revision,
      read: f.reader,
    });
    if (r.reused) throw Error('unexpected reuse');
    expect(rows(r.result, '结算对账').filter((x) => !['O08', 'O09'].includes(String(x[1])))).toEqual(
      rows(f.r, '结算对账').filter((x) => !['O08', 'O09'].includes(String(x[1])))
    );
    expect(r.result.coverage).toMatchObject({ recomputedBusinessIds: ['O08', 'O09'] });
  });
  it('rejects an evidence record belonging to another business instead of clearing a difference', async () => {
    const f = await fixture();
    const e = JSON.parse(await fs.readFile(folder + '/更正账单与补证-模拟-v1.json', 'utf8'));
    e.records[0].businessId = 'O09';
    const bytes = Buffer.from(JSON.stringify(e));
    f.revision.evidence = [{ path: '资料/错单.json', versionId, sha256: sha(bytes) }];
    const r = await prepareRevision({
      store: f.store,
      client,
      resourceId: id,
      path: f.base.path,
      revision: f.revision,
      read: async (p, v) => (p === '资料/错单.json' ? { bytes, relative: p, versionId: v } : f.reader(p, v)),
    });
    if (r.reused) throw Error('unexpected reuse');
    expect(rows(r.result, '结算对账').find((x) => x[1] === 'O08')?.[11]).toBe(40);
    expect(r.result.issues.some((i) => i.code === 'EVIDENCE_LINK_OR_CONDITION_CONFLICT')).toBe(true);
  });
  it('does not clear a bill merely because an uploaded amount is close', async () => {
    const f = await fixture();
    const e = JSON.parse(await fs.readFile(folder + '/更正账单与补证-模拟-v1.json', 'utf8'));
    e.records[0].amount = 1839;
    const bytes = Buffer.from(JSON.stringify(e));
    f.revision.evidence = [{ path: '资料/金额.json', versionId, sha256: sha(bytes) }];
    const r = await prepareRevision({
      store: f.store,
      client,
      resourceId: id,
      path: f.base.path,
      revision: f.revision,
      read: async (p, v) => (p === '资料/金额.json' ? { bytes, relative: p, versionId: v } : f.reader(p, v)),
    });
    if (r.reused) throw Error('unexpected reuse');
    expect(rows(r.result, '结算对账').find((x) => x[1] === 'O08')?.[11]).toBe(1);
  });
  it('holds conflicting records for the same bill instead of accepting the first', async () => {
    const f = await fixture();
    const e = JSON.parse(await fs.readFile(folder + '/更正账单与补证-模拟-v1.json', 'utf8'));
    e.records.push({ ...e.records[0], amount: 1839 });
    const bytes = Buffer.from(JSON.stringify(e));
    f.revision.evidence = [{ path: '资料/冲突.json', versionId, sha256: sha(bytes) }];
    const r = await prepareRevision({
      store: f.store,
      client,
      resourceId: id,
      path: f.base.path,
      revision: f.revision,
      read: async (p, v) => (p === '资料/冲突.json' ? { bytes, relative: p, versionId: v } : f.reader(p, v)),
    });
    if (r.reused) throw Error('unexpected reuse');
    expect(rows(r.result, '结算对账').find((x) => x[1] === 'O08')?.[11]).toBe(40);
  });
  it('rejects an altered credential even if its path and version are known', async () => {
    const f = await fixture();
    f.revision.evidence[0].sha256 = '0'.repeat(64);
    await expect(
      prepareRevision({
        store: f.store,
        client,
        resourceId: id,
        path: f.base.path,
        revision: f.revision,
        read: f.reader,
      })
    ).rejects.toThrow('METHOD_EVIDENCE_VERSION_MISMATCH');
  });
  it('refuses to overwrite a concurrently changed result', async () => {
    const f = await fixture();
    f.setLatest({ ...f.base, sha256: sha('someone else'), version: 2, byteSize: 12, createdAt: '2026-11-01' });
    await expect(
      prepareRevision({
        store: f.store,
        client,
        resourceId: id,
        path: f.base.path,
        revision: f.revision,
        read: f.reader,
      })
    ).rejects.toThrow('FILE_CHANGED_RETRY');
  });
  it('reuses a matching prior receipt without recomputation or a second revision', async () => {
    const f = await fixture();
    const key = sha(
      JSON.stringify({
        base: f.base.sha256,
        ids: ['O08', 'O09'],
        evidence: [f.evidence.sha256],
        config: f.snapshot.configSha256,
      })
    );
    f.deliveries.set(key, f.base.sha256);
    const r = await prepareRevision({
      store: f.store,
      client,
      resourceId: id,
      path: f.base.path,
      revision: f.revision,
      read: f.reader,
    });
    expect(r.reused).toBe(true);
  });
  it('keeps current source access checks even for a repeated credential', async () => {
    const f = await fixture();
    const denied = f.snapshot.sources[0].path;
    await expect(
      prepareRevision({
        store: f.store,
        client,
        resourceId: id,
        path: f.base.path,
        revision: f.revision,
        read: async (p, v) => {
          if (p === denied) throw Error('ACCESS_DENIED');
          return f.reader(p, v);
        },
      })
    ).rejects.toThrow('ACCESS_DENIED');
  });
  it('rejects cross-workspace evidence paths', async () => {
    const f = await fixture();
    f.revision.evidence[0].path = '../other/credentials.xlsx';
    await expect(
      prepareRevision({
        store: f.store,
        client,
        resourceId: id,
        path: f.base.path,
        revision: f.revision,
        read: f.reader,
      })
    ).rejects.toThrow('METHOD_SOURCE_PATH_INVALID');
  });
});
