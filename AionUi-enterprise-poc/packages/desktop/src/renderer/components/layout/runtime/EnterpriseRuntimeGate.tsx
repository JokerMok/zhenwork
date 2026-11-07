import { Button, Input, Spin } from '@arco-design/web-react';
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import MarkdownView, { TrustedArtifactContext } from '@/renderer/components/Markdown';
import type { WorkTask } from '@/renderer/pages/workspace/TaskWork/api';
import { emitter } from '@/renderer/utils/emitter';

type Preparation = { ready?: boolean; phase?: string; error?: string; traceId?: string };
const TaskWork = React.lazy(() => import('@/renderer/pages/workspace/TaskWork'));

type Snapshot = {
  name: string;
  messages: Array<{ id: string; position: string; text: string }>;
  nextOlder?: string | null;
};

/** Keep the conversation structure and its authorized saved prose while execution prepares. */
export default function EnterpriseRuntimeGate({ children }: React.PropsWithChildren) {
  const { t } = useTranslation();
  const { pathname, state: navigationState } = useLocation();
  const targetMessage = (navigationState as { targetMessageId?: string } | null)?.targetMessageId;
  const [state, setState] = useState<Preparation>({ phase: 'queued' });
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [task, setTask] = useState<WorkTask>();
  const onTaskChange = useCallback((value: WorkTask | undefined) => setTask(value), []);
  const [attempt, setAttempt] = useState(0);
  const [snapshotAttempt, setSnapshotAttempt] = useState(0);
  const [snapshotError, setSnapshotError] = useState<number>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const snapshotController = useRef<AbortController>(null);
  const id = /^\/conversation\/([A-Za-z0-9_-]{1,100})$/.exec(pathname)?.[1];
  const readOnly = Boolean(id) && attempt === 0;

  const readSnapshot = async (before?: string): Promise<void> => {
    if (!id || (before && loadingOlder)) return;
    snapshotController.current?.abort();
    const controller = new AbortController();
    snapshotController.current = controller;
    setSnapshotError(undefined);
    setLoadingOlder(Boolean(before));
    const query = new URLSearchParams({ page: '1' });
    if (before) query.set('before', before);
    else if (targetMessage) query.set('target', targetMessage);
    try {
      const response = await fetch(`/enterprise/conversations/${id}/view?${query}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setSnapshotError(response.status);
        return;
      }
      const view = (await response.json()) as Snapshot;
      if (controller.signal.aborted) return;
      if (typeof view?.name !== 'string' || !Array.isArray(view.messages)) {
        setSnapshotError(503);
        return;
      }
      setSnapshot((current) =>
        before && current ? { ...view, messages: [...view.messages, ...current.messages] } : view
      );
    } catch {
      if (!controller.signal.aborted) setSnapshotError(503);
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  };

  useEffect(() => {
    setSnapshot(undefined);
    setTask(undefined);
    void readSnapshot();
    return () => snapshotController.current?.abort();
  }, [id, targetMessage, snapshotAttempt]);

  useEffect(() => {
    if (snapshot && targetMessage)
      document.getElementById(`snapshot-${targetMessage}`)?.scrollIntoView?.({ block: 'center' });
  }, [snapshot, targetMessage]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    let explicitRetry = attempt > 0;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/enterprise/ready${readOnly ? '?inspect=1' : explicitRetry ? '?retry=1' : ''}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        explicitRetry = false;
        const result = (await response.json()) as Preparation;
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          window.location.replace('/enterprise/login' + window.location.hash);
          return;
        }
        setState(result);
        if (result.ready) {
          performance.mark('enterprise:execution_environment_ready');
          (window as Window & { __websocketReconnect?: () => void }).__websocketReconnect?.();
          window.dispatchEvent(new Event('enterprise:core-ready'));
          emitter.emit('chat.history.refresh');
          return;
        }
        if (readOnly) return;
        if (response.status !== 202 || result.phase === 'failed') {
          setState({ ...result, error: result.error || 'CORE_START_FAILED' });
          return;
        }
      } catch {
        if (controller.signal.aborted || readOnly) return;
        setState({ phase: 'queued' });
      }
      if (performance.now() - started >= 180000) {
        setState({ error: 'PREPARATION_TIMEOUT' });
        return;
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    setState({ phase: 'queued' });
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt, readOnly]);
  if (state.ready) return children;
  const visibleTask = task?.id === id ? task : undefined;
  const waiting = ['waiting_input', 'waiting_confirmation'].includes(visibleTask?.attempts.at(-1)?.state || '');
  const pendingQuestion = waiting ? visibleTask?.attempts.at(-1)?.question : undefined;
  const receipts = visibleTask?.attempts.flatMap((item) => item.artifacts) || [];
  const reason =
    state.error === 'CORE_CAPACITY'
      ? t('workspace.status.capacityBusy')
      : state.error === 'DEFAULT_MODEL_UNAVAILABLE'
        ? t('workspace.errors.noModel')
        : state.error === 'CAPABILITY_FORBIDDEN'
          ? t('workspace.errors.forbidden')
          : state.error === 'PREPARATION_TIMEOUT'
            ? t('workspace.status.preparationTimedOut')
            : t('workspace.status.environmentUnavailable');
  return (
    <section className='h-full min-h-0 min-w-0 flex flex-col bg-bg-1' data-testid='inline-execution-preparation'>
      <header className='min-h-44px px-20px py-12px border-b border-solid border-border-2 font-medium truncate'>
        {snapshot?.name || t('conversation.welcome.newConversation')}
      </header>
      <div className='flex-1 min-h-0 overflow-y-auto px-24px py-20px' data-testid='preparation-transcript'>
        <div className='mx-auto max-w-880px flex flex-col gap-20px'>
          {snapshotError ? (
            <div role='alert' className='flex items-center gap-8px text-13px text-t-secondary'>
              <span>{t('workspace.errors.load', { code: `HTTP_${snapshotError}` })}</span>
              <Button
                type='text'
                onClick={() =>
                  snapshot?.nextOlder ? void readSnapshot(snapshot.nextOlder) : setSnapshotAttempt((value) => value + 1)
                }
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
          {snapshot?.nextOlder && !snapshotError && (
            <Button
              type='text'
              loading={loadingOlder}
              onClick={() => void readSnapshot(snapshot.nextOlder ?? undefined)}
            >
              {t('conversation.historySearch.loadMore')}
            </Button>
          )}
          <TrustedArtifactContext.Provider value={receipts}>
            {snapshot?.messages.map((message) => (
              <div
                key={message.id}
                id={`snapshot-${message.id}`}
                className={`whitespace-pre-wrap break-words text-14px leading-7 ${message.position === 'right' ? 'self-end bg-bg-2 rd-12px px-16px py-10px max-w-80%' : 'self-start w-full'}`}
              >
                {message.position === 'left' ? (
                  message.text === pendingQuestion ? (
                    <details>
                      <summary className='cursor-pointer text-t-secondary'>
                        {t('workspace.work.states.waiting_input')}
                      </summary>
                      <MarkdownView>{message.text}</MarkdownView>
                    </details>
                  ) : (
                    <MarkdownView>{message.text}</MarkdownView>
                  )
                ) : (
                  message.text
                )}
              </div>
            ))}
          </TrustedArtifactContext.Provider>
          {id && snapshot && (
            <Suspense fallback={null}>
              <TaskWork
                conversationId={id}
                hideOpenAction
                onTaskChange={onTaskChange}
                onContinue={readOnly ? () => setAttempt(1) : undefined}
              />
            </Suspense>
          )}
        </div>
      </div>
      <div className='box-border mx-auto w-full max-w-920px px-20px pb-20px shrink-0'>
        {readOnly ? (
          snapshot && !waiting ? (
            <Button type='primary' onClick={() => setAttempt(1)}>
              {t('workspace.work.continue')}
            </Button>
          ) : !snapshot && !snapshotError ? (
            <div role='status' aria-label={t('common.loading')}>
              <Spin size={16} />
            </div>
          ) : null
        ) : (
          <>
            <Input.TextArea disabled aria-label={t('common.send')} autoSize={{ minRows: 2, maxRows: 2 }} />
            <div className='mt-8px flex items-center gap-8px text-12px text-t-secondary' role='status'>
              {!state.error && <Spin size={14} />}
              <span>
                {state.error
                  ? reason
                  : t(
                      state.phase === 'starting'
                        ? 'workspace.status.preparationStarting'
                        : 'workspace.status.preparationQueued'
                    )}
              </span>
              {state.error && (
                <Button size='mini' type='text' onClick={() => setAttempt((value) => value + 1)}>
                  {t('common.retry')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
