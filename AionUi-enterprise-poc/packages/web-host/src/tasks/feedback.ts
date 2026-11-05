import type { EnterpriseActor } from '../enterprise-gateway.js';
import type { TaskControlRequest } from './integration.js';
import { TaskStore } from './store.js';
import { currentAttempt, TaskError } from './types.js';

export const taskFeedbackCategories = ['correct', 'data_calculation', 'citation', 'tool', 'artifact', 'other'] as const;

export type TaskFeedbackCategory = (typeof taskFeedbackCategories)[number];

type FeedbackEnvelope<T> = { code?: unknown; msg?: unknown; data?: T };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_FEEDBACK_STATES = new Set(['completed', 'partial']);
const MAX_CONTROL_RESPONSE = 256 * 1024;

function safeControlError(value: unknown): string {
  if (!value || typeof value !== 'object') return 'FEEDBACK_CONTROL_UNAVAILABLE';
  const record = value as Record<string, unknown>;
  const candidate = record.error ?? record.msg ?? record.message;
  return typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(candidate)
    ? candidate
    : 'FEEDBACK_CONTROL_UNAVAILABLE';
}

async function control<T>(
  actor: EnterpriseActor,
  route: string,
  init: RequestInit,
  request: TaskControlRequest
): Promise<T> {
  const response = await request(actor, route, init);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_CONTROL_RESPONSE) throw new TaskError(502, 'FEEDBACK_CONTROL_RESPONSE_LIMIT');
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    throw new TaskError(502, 'FEEDBACK_CONTROL_RESPONSE_INVALID');
  }
  if (!response.ok) {
    throw new TaskError(
      [400, 401, 403, 404, 409].includes(response.status) ? response.status : 503,
      safeControlError(value)
    );
  }
  const envelope = value as FeedbackEnvelope<T> | null;
  if (envelope && typeof envelope.code === 'number') {
    if (envelope.code !== 200) throw new TaskError(502, safeControlError(envelope));
    return envelope.data as T;
  }
  return value as T;
}

async function ownedAttempt(
  root: string,
  actor: EnterpriseActor,
  taskId: string,
  attemptId: string,
  states: Set<string>
) {
  if (!UUID.test(attemptId)) throw new TaskError(400, 'TASK_FEEDBACK_INPUT_INVALID');
  const task = await (await TaskStore.create(root, actor)).get(taskId);
  const attempt = currentAttempt(task);
  if (attempt.id !== attemptId) throw new TaskError(409, 'TASK_ATTEMPT_CHANGED');
  if (!states.has(attempt.state)) throw new TaskError(409, 'TASK_FEEDBACK_NOT_AVAILABLE');
  return attempt;
}

export async function readTaskFeedback(
  root: string,
  actor: EnterpriseActor,
  taskId: string,
  attemptId: string,
  request: TaskControlRequest
): Promise<unknown> {
  await ownedAttempt(root, actor, taskId, attemptId, TERMINAL_FEEDBACK_STATES);
  const query = new URLSearchParams({ taskId, attemptId });
  return control(actor, `/ai/me/feedback?${query}`, { method: 'GET' }, request);
}

export async function submitTaskFeedback(
  root: string,
  actor: EnterpriseActor,
  taskId: string,
  input: Record<string, unknown>,
  request: TaskControlRequest
): Promise<unknown> {
  const attemptId = typeof input.attemptId === 'string' ? input.attemptId : '';
  await ownedAttempt(root, actor, taskId, attemptId, TERMINAL_FEEDBACK_STATES);
  const category = typeof input.category === 'string' ? input.category : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!taskFeedbackCategories.includes(category as TaskFeedbackCategory) || !note || note.length > 500) {
    throw new TaskError(400, 'TASK_FEEDBACK_INPUT_INVALID');
  }
  return control(
    actor,
    '/ai/me/feedback',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, attemptId, category, note }),
    },
    request
  );
}

/** Capture only control-authoritative resource versions before the task's first model relay. */
export async function captureTaskFeedbackProvenance(
  root: string,
  actor: EnterpriseActor,
  taskId: string,
  assistantId: string,
  request: TaskControlRequest
): Promise<void> {
  const normalizedAssistant = assistantId.replace(/^rc2-/, '');
  if (!UUID.test(normalizedAssistant)) throw new TaskError(400, 'TASK_PROVENANCE_INPUT_INVALID');
  const task = await (await TaskStore.create(root, actor)).get(taskId);
  const attempt = currentAttempt(task);
  if (attempt.state !== 'running') throw new TaskError(409, 'TASK_NOT_EXECUTING');
  await control(
    actor,
    '/ai/me/feedback/provenance',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, attemptId: attempt.id, assistantId: normalizedAssistant }),
    },
    request
  );
}
