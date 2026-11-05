import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { captureTaskFeedbackProvenance, readTaskFeedback, submitTaskFeedback } from './feedback.js';
import { TaskStore } from './store.js';
import { currentAttempt } from './types.js';

const roots: string[] = [];
const actor = { serverId: 'rc2', userId: '17' };
const emptyControlResponse = async () => new Response(JSON.stringify({ code: 200, data: null }));

async function fixture(state: 'running' | 'completed' | 'partial' = 'completed') {
  const root = await mkdtemp(path.join(tmpdir(), 'task-feedback-'));
  roots.push(root);
  const store = await TaskStore.create(root, actor);
  const task = (await store.accept('conversation-1', randomUUID(), { content: 'Check result' })).task;
  const attempt = currentAttempt(task);
  await store.mutate(task.id, attempt.id, (value) => {
    value.state = state;
  });
  return { root, store, taskId: task.id, attemptId: attempt.id };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('employee feedback forwards only the selected category and short note', async () => {
  const { root, store, taskId, attemptId } = await fixture();
  const artifactVersion = randomUUID();
  await store.mutate(taskId, attemptId, (attempt) => {
    attempt.steps.push({
      id: randomUUID(),
      tool: 'create_office_document',
      digest: 'a'.repeat(64),
      state: 'completed',
      at: Date.now(),
      summary: 'created',
    });
    attempt.artifacts.push({
      path: 'result.xlsx',
      sha256: 'b'.repeat(64),
      versionId: artifactVersion,
      valid: true,
    });
  });
  const calls: Array<{ route: string; body: unknown }> = [];
  const result = await submitTaskFeedback(
    root,
    actor,
    taskId,
    {
      attemptId,
      category: 'data_calculation',
      note: '  total is wrong  ',
      ignored: 'private',
      actualTaskState: 'failed',
      actualTools: ['browser-forged'],
      artifactVersionIds: [randomUUID()],
    },
    async (_actor, route, init) => {
      calls.push({ route, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ code: 200, data: { id: 'feedback-1', status: 'NEW' } }));
    }
  );

  expect(result).toEqual({ id: 'feedback-1', status: 'NEW' });
  expect(calls).toEqual([
    {
      route: '/ai/me/feedback',
      body: {
        taskId,
        attemptId,
        category: 'data_calculation',
        note: 'total is wrong',
        actualTaskState: 'completed',
        actualTools: ['create_office_document'],
        artifactVersionIds: [artifactVersion],
      },
    },
  ]);
});

test('a category-only feedback keeps the optional note empty', async () => {
  const { root, taskId, attemptId } = await fixture();
  let sent: Record<string, unknown> | undefined;

  await submitTaskFeedback(root, actor, taskId, { attemptId, category: 'correct' }, async (_actor, _route, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ code: 200, data: { id: 'feedback-2', status: 'NEW' } }));
  });

  expect(sent).toMatchObject({ category: 'correct', note: '', actualTaskState: 'completed' });
});

test('feedback remains scoped to the current terminal attempt and actor', async () => {
  const { root, taskId, attemptId } = await fixture();

  await expect(
    readTaskFeedback(root, { ...actor, userId: '18' }, taskId, attemptId, emptyControlResponse)
  ).rejects.toThrow('TASK_NOT_FOUND');
  await expect(
    submitTaskFeedback(
      root,
      actor,
      taskId,
      { attemptId: randomUUID(), category: 'other', note: 'Mismatch' },
      emptyControlResponse
    )
  ).rejects.toThrow('TASK_ATTEMPT_CHANGED');
});

test('feedback rejects active work and invalid categories before contacting control', async () => {
  const active = await fixture('running');
  let requests = 0;
  const request = async () => {
    requests += 1;
    return new Response('{}');
  };

  await expect(
    submitTaskFeedback(
      active.root,
      actor,
      active.taskId,
      { attemptId: active.attemptId, category: 'tool', note: 'Too early' },
      request
    )
  ).rejects.toThrow('TASK_FEEDBACK_NOT_AVAILABLE');
  const terminal = await fixture();
  await expect(
    submitTaskFeedback(
      terminal.root,
      actor,
      terminal.taskId,
      { attemptId: terminal.attemptId, category: 'model_judgement', note: 'Unsupported' },
      request
    )
  ).rejects.toThrow('TASK_FEEDBACK_INPUT_INVALID');
  expect(requests).toBe(0);
});

test('provenance capture sends task identity plus the real assistant and model resource ids', async () => {
  const { root, taskId, attemptId } = await fixture('running');
  const assistantId = randomUUID();
  const modelId = randomUUID();
  let sent: unknown;

  await captureTaskFeedbackProvenance(
    root,
    actor,
    taskId,
    `rc2-${assistantId}`,
    async (_actor, route, init) => {
      sent = { route, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ code: 200, data: { captured: true } }));
    },
    modelId
  );

  expect(sent).toEqual({
    route: '/ai/me/feedback/provenance',
    body: { taskId, attemptId, assistantId, modelId },
  });
});

test('provenance capture rejects a non-UUID runtime model before contacting control', async () => {
  const { root, taskId } = await fixture('running');
  let requests = 0;

  await expect(
    captureTaskFeedbackProvenance(
      root,
      actor,
      taskId,
      randomUUID(),
      async () => {
        requests += 1;
        return new Response('{}');
      },
      'not-a-model-id'
    )
  ).rejects.toThrow('TASK_PROVENANCE_INPUT_INVALID');
  expect(requests).toBe(0);
});

test('invalid control responses fail without exposing upstream text', async () => {
  const { root, taskId, attemptId } = await fixture();
  await expect(
    readTaskFeedback(root, actor, taskId, attemptId, async () => new Response('<html>secret</html>'))
  ).rejects.toThrow('FEEDBACK_CONTROL_RESPONSE_INVALID');
});
