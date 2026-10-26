import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from './store.js';
import { currentAttempt, publicTask } from './types.js';
import { checkpoint, recordTool, reusableOutput } from './protocol.js';
const roots: string[] = [];
const actor = { serverId: 'rc2', userId: '17' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'task-store-'));
  roots.push(root);
  return { root, store: await TaskStore.create(root, actor) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test('atomic durable admission merges concurrent retransmits and rejects reuse with different input', async () => {
  const { store } = await fixture(),
    id = randomUUID(),
    payload = { content: 'Generate Word and Excel', files: [] };
  const results = await Promise.all(Array.from({ length: 8 }, () => store.accept('aabbccdd', id, payload)));
  expect(results.filter((x) => !x.duplicate)).toHaveLength(1);
  expect((await store.list())[0].attempts).toHaveLength(1);
  await expect(store.accept('aabbccdd', id, { content: 'Different input' })).rejects.toThrow('TASK_REQUEST_CONFLICT');
});
test('a new round cannot be overwritten by an old attempt callback', async () => {
  const { store } = await fixture();
  const first = currentAttempt((await store.accept('aabbccdd', randomUUID(), { content: 'First' })).task);
  await store.mutate('aabbccdd', first.id, (a) => {
    a.state = 'completed';
  });
  const second = currentAttempt((await store.accept('aabbccdd', randomUUID(), { content: 'Follow up' })).task);
  await store.mutate('aabbccdd', first.id, (a) => {
    a.state = 'failed';
  });
  expect(currentAttempt(await store.get('aabbccdd'))).toMatchObject({ id: second.id, round: 2, state: 'queued' });
});
test('private actor storage prevents task lookup and never exposes raw payload or approval capability', async () => {
  const { root, store } = await fixture();
  await store.accept('aabbccdd', randomUUID(), { content: 'Private' });
  const other = await TaskStore.create(root, { ...actor, userId: '18' });
  await expect(other.get('aabbccdd')).rejects.toThrow('TASK_NOT_FOUND');
  const safe = publicTask(await store.get('aabbccdd')) as { attempts: Array<Record<string, unknown>> };
  expect(safe.attempts[0]).not.toHaveProperty('payload');
});
test('waiting for input needs an explicit saved question and is not completion', async () => {
  const { root, store } = await fixture();
  const a = currentAttempt((await store.accept('aabbccdd', randomUUID(), { content: 'Report' })).task);
  await store.mutate('aabbccdd', a.id, (x) => {
    x.state = 'running';
  });
  await expect(checkpoint(root, actor, 'aabbccdd', { state: 'waiting_input', summary: 'Need data' })).rejects.toThrow(
    'TASK_WAITING_QUESTION_REQUIRED'
  );
  await checkpoint(root, actor, 'aabbccdd', {
    state: 'waiting_input',
    summary: 'Need data',
    question: 'Which reporting period?',
  });
  expect(currentAttempt(await store.get('aabbccdd'))).toMatchObject({
    state: 'running',
    stopReason: 'waiting_input',
    question: 'Which reporting period?',
  });
});
test('a retry reuses verified successful file receipt and refuses changed bytes', async () => {
  const { root, store } = await fixture();
  const a = currentAttempt((await store.accept('aabbccdd', randomUUID(), { content: 'Generate Word and Excel' })).task);
  await store.mutate('aabbccdd', a.id, (x) => {
    x.state = 'running';
  });
  const result = { path: 'report.docx', sha256: 'a'.repeat(64), validation: { valid: true }, versionId: randomUUID() };
  await recordTool(root, actor, 'aabbccdd', 'create_office_document', { path: 'report.docx' }, result);
  await store.mutate('aabbccdd', a.id, (x) => {
    x.state = 'partial';
  });
  const retry = currentAttempt(
    (await store.accept('aabbccdd', randomUUID(), { content: 'Retry unfinished' }, true)).task
  );
  expect(retry).toMatchObject({ round: 1, attempt: 2, retryOf: a.id });
  await expect(
    reusableOutput(root, actor, 'aabbccdd', 'create_office_document', { path: 'report.docx' }, async () => true)
  ).resolves.toMatchObject({ ...result, reused: true, unchanged: true });
  await expect(
    reusableOutput(root, actor, 'aabbccdd', 'create_office_document', { path: 'report.docx' }, async () => false)
  ).rejects.toThrow('TASK_SUCCESSFUL_ARTIFACT_CHANGED');
});
test('source reads are steps rather than generated deliverables; partial tool results preserve completed outputs', async () => {
  const { root, store } = await fixture();
  const a = currentAttempt((await store.accept('aabbccdd', randomUUID(), { content: 'Compare' })).task);
  await store.mutate('aabbccdd', a.id, (x) => {
    x.state = 'running';
  });
  await recordTool(
    root,
    actor,
    'aabbccdd',
    'read_document',
    { path: 'source.pdf' },
    { path: 'source.pdf', sha256: 'a'.repeat(64) }
  );
  expect(currentAttempt(await store.get('aabbccdd')).artifacts).toHaveLength(0);
  await recordTool(
    root,
    actor,
    'aabbccdd',
    'create_evidence_deliverables',
    {},
    {
      status: 'partial',
      outputs: [
        { path: 'out.docx', sha256: 'b'.repeat(64), validation: { valid: true } },
        { path: 'out.xlsx', status: 'failed' },
      ],
    }
  );
  expect(currentAttempt(await store.get('aabbccdd'))).toMatchObject({
    artifacts: [{ path: 'out.docx', valid: true }],
    steps: [{ state: 'completed' }, { state: 'failed', summary: 'PARTIAL_OUTPUT' }],
  });
});

test('late tool and checkpoint callbacks cannot affect a newer round', async () => {
  const {root, store} = await fixture();
  const old = currentAttempt((await store.accept('aabbccdd',randomUUID(),{content:'First'})).task);
  await store.mutate('aabbccdd',old.id,a=>{a.state='completed';});
  const next = currentAttempt((await store.accept('aabbccdd',randomUUID(),{content:'Next'})).task);
  await store.mutate('aabbccdd',next.id,a=>{a.state='running';});
  await recordTool(root,actor,'aabbccdd','create_office_document',{path:'late.docx'}, {path:'late.docx',sha256:'a'.repeat(64)},undefined,old.id);
  await expect(checkpoint(root,actor,'aabbccdd',{state:'completed',summary:'Old'},old.id)).rejects.toThrow('TASK_NOT_EXECUTING');
  expect(currentAttempt(await store.get('aabbccdd'))).toMatchObject({id:next.id,steps:[],artifacts:[]});
});
