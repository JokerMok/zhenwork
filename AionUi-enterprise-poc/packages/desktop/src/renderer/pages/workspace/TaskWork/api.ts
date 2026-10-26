import { useCallback, useEffect, useRef, useState } from 'react';
import { enterpriseRequest, workspaceErrorCode } from '../workspaceApi';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
export type WorkAttempt = {
  id: string;
  round: number;
  attempt: number;
  state: string;
  phase: string;
  updatedAt: number;
  progress?: string;
  assistant?: { id: string; name: string };
  requiresExternalReview?: boolean;
  inputs?: { content: string; files: Array<{ kind: string; path?: string; relative_path?: string }> };
  question?: string;
  reason?: string;
  scope?: { baseIds: string[]; documents: Array<{ documentId: string; version: number }> };
  steps: Array<{ id: string; tool: string; state: string; summary: string }>;
  artifacts: Array<{
    path: string;
    valid: boolean;
    sha256: string;
    versionId?: string;
    downloadUrl?: string;
    previewUrl?: string;
  }>;
};
export type WorkTask = { id: string; title: string; updatedAt: number; attempts: WorkAttempt[] };
const pending = new Map<string, Promise<WorkTask>>();
export async function fetchTask(id: string): Promise<WorkTask> {
  const prior = pending.get(id);
  if (prior) return prior;
  const request = enterpriseRequest<WorkTask>(`/enterprise/tasks/${id}`, {
    signal: AbortSignal.timeout(10000),
  }).finally(() => {
    if (pending.get(id) === request) pending.delete(id);
  });
  pending.set(id, request);
  return request;
}
export function useTaskWork(id?: string) {
  const [task, setTask] = useState<WorkTask>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!id || !isEnterpriseWeb()) return;
    const n = ++generation.current;
    try {
      const value = await fetchTask(id);
      if (n === generation.current) {
        setTask(value);
        setError(undefined);
      }
    } catch (e) {
      const code = workspaceErrorCode(e);
      if (n === generation.current) {
        if (code === 'TASK_NOT_FOUND') setTask(undefined);
        else setError(code);
      }
    }
  }, [id]);
  useEffect(() => {
    setTask(undefined);
    setError(undefined);
    if (!id || !isEnterpriseWeb()) return;
    void reload();
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = setInterval(tick, 3000);
    window.addEventListener('task-work:changed', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener('task-work:changed', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [id, reload]);
  return { task, attempt: task?.attempts.at(-1), error, reload };
}
export async function taskRequestId(id: string, payload: unknown): Promise<string> {
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  const key = 'zhenwork:pending-send:' + id;
  const saved = sessionStorage.getItem(key);
  if (saved) {
    try {
      const v = JSON.parse(saved) as { hash: string; id: string };
      if (v.hash === hash) return v.id;
    } catch {
      /* Invalid tab state is replaced. */
    }
  }
  const requestId = crypto.randomUUID();
  sessionStorage.setItem(key, JSON.stringify({ hash, id: requestId }));
  return requestId;
}
export function taskAccepted(id: string): void {
  sessionStorage.removeItem('zhenwork:pending-send:' + id);
  window.dispatchEvent(new Event('task-work:changed'));
}
