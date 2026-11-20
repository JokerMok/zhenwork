import { useCallback, useEffect, useRef, useState } from 'react';
import { employeeDraftScope, readDraft, writeDraft } from '@/renderer/hooks/chat/employeeDraftStorage';
import { enterpriseRequest, workspaceErrorCode } from '../workspaceApi';
import { taskAccepted, taskRequestId, type WorkAttempt, type WorkTask } from './api';

type Kind = 'approve' | 'decline';
type Decision = {
  kind: Kind;
  request_id: string;
  attemptId: string;
  confirmationId: string;
  language: string;
  reviewed: boolean;
  externalOutcome?: string;
  accepted?: true;
  rejection?: string;
};

const definitiveRejections = new Set([
  'TASK_ATTEMPT_CHANGED',
  'TASK_CONFIRMATION_CHANGED',
  'TASK_REQUEST_CONFLICT',
  'TASK_APPROVAL_DETAILS_UNAVAILABLE',
  'TASK_AUTHORIZATION_REVOKED',
  'TASK_EXECUTION_TIME_LIMIT',
  'TASK_RUNTIME_INTERRUPTED',
  'TASK_RUNTIME_TURN_CHANGED',
  'TASK_PENDING_CONFIRMATION_LOST',
  'TASK_APPROVAL_INPUT_CHANGED',
  'TASK_HISTORY_CAPACITY',
]);

function matchesDecision(attempt: WorkAttempt | undefined, decision: Decision) {
  return (
    attempt?.id === decision.attemptId &&
    attempt.state === 'waiting_confirmation' &&
    attempt.canApprove &&
    attempt.confirmation?.id === decision.confirmationId &&
    !!attempt.confirmation.proposal
  );
}

function storageKey(taskId: string) {
  const owner = localStorage.getItem('enterprise:storage-owner');
  return owner && 'enterprise:decision:' + employeeDraftScope(owner) + ':' + taskId;
}

/** Only a fresh authorized snapshot can reopen the original decision after a lost response. */
export function useConfirmationDecision(
  taskId: string,
  attempt: WorkAttempt | undefined,
  reload: (fresh?: boolean) => Promise<WorkTask | undefined>
) {
  const key = storageKey(taskId);
  const [stored, setStored] = useState<Decision>();
  const [safeId, setSafeId] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const current = useRef(attempt);
  current.current = attempt;
  const pending = stored && matchesDecision(attempt, stored) ? stored : undefined;
  useEffect(() => {
    setStored(key ? readDraft<Decision>(key) : undefined);
    setSafeId('');
    setBusy(false);
    setChecking(false);
    lock.current = false;
    return () => {
      generation.current++;
    };
  }, [key, taskId]);

  const remember = useCallback(
    (value?: Decision) => {
      if (key) {
        if (value) writeDraft(key, value);
        else sessionStorage.removeItem(key);
      }
      setStored(value);
      setSafeId('');
    },
    [key]
  );

  const check = useCallback(
    async (decision: Decision) => {
      const owner = generation.current;
      setChecking(true);
      const task = await reload(true);
      if (generation.current !== owner || storageKey(taskId) !== key) return;
      setChecking(false);
      const latest = task?.attempts.at(-1);
      if (!latest) return;
      if (!matchesDecision(latest, decision)) remember();
      else if (!decision.accepted && !decision.rejection) setSafeId(decision.request_id);
    },
    [reload, key, taskId, remember]
  );

  useEffect(() => {
    if (stored && attempt && !matchesDecision(attempt, stored)) remember();
  }, [attempt, stored, remember]);

  const submit = async (kind: Kind, options: Pick<Decision, 'language' | 'reviewed' | 'externalOutcome'>) => {
    const confirmationId = attempt?.confirmation?.id;
    if (
      lock.current ||
      !attempt?.canApprove ||
      !confirmationId ||
      !attempt.confirmation?.proposal ||
      (pending && (pending.kind !== kind || safeId !== pending.request_id))
    )
      return;
    const owner = generation.current;
    const active = () => owner === generation.current && key === storageKey(taskId);
    lock.current = true;
    setBusy(true);
    let decision = pending;
    try {
      const payload = { attemptId: attempt.id, ...options, confirmationId };
      if (!decision) decision = { kind, ...payload, request_id: await taskRequestId(taskId, { kind, ...payload }) };
      if (!active() || !matchesDecision(current.current, decision)) return;
      remember(decision);
      const { kind: action, accepted: _accepted, rejection: _rejection, ...body } = decision;
      await enterpriseRequest(`/enterprise/tasks/${taskId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!active()) return;
      decision = { ...decision, accepted: true };
      remember(decision);
      taskAccepted(taskId, decision.request_id);
      await check(decision);
    } catch (error) {
      if (active() && decision) {
        const code = workspaceErrorCode(error);
        if (definitiveRejections.has(code)) {
          decision = { ...decision, rejection: code };
          remember(decision);
        }
        await check(decision);
      }
    } finally {
      if (active()) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  return { pending, safeId: pending?.request_id === safeId ? safeId : '', checking, busy, submit, check };
}
