import { Button, Input, Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { emitter } from '@/renderer/utils/emitter';

type Preparation = { ready?: boolean; phase?: string; error?: string; traceId?: string };
type Snapshot = { name: string; messages: Array<{ id: string; position: string; text: string }> };

/** Keep the conversation structure and its authorized saved prose while execution prepares. */
export default function EnterpriseRuntimeGate({ children }: React.PropsWithChildren) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [state, setState] = useState<Preparation>({ phase: 'queued' });
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const id = /^\/conversation\/([A-Za-z0-9_-]{1,100})$/.exec(pathname)?.[1];
    setSnapshot(undefined);
    if (id)
      void fetch(`/enterprise/conversations/${id}/view`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.ok) {
            const view = (await response.json()) as Snapshot;
            if (!controller.signal.aborted && typeof view?.name === 'string' && Array.isArray(view.messages))
              setSnapshot(view);
          }
        })
        .catch(() => {});
    return () => controller.abort();
  }, [pathname]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    let explicitRetry = attempt > 0;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/enterprise/ready${explicitRetry ? '?retry=1' : ''}`, {
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
        if (response.status !== 202 || result.phase === 'failed') {
          setState({ ...result, error: result.error || 'CORE_START_FAILED' });
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
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
  }, [attempt]);
  if (state.ready) return children;
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
    <section className='h-full min-h-0 flex flex-col bg-bg-1' data-testid='inline-execution-preparation'>
      <header className='min-h-44px px-20px py-12px border-b border-solid border-border-2 font-medium truncate'>
        {snapshot?.name || t('conversation.welcome.newConversation')}
      </header>
      <div className='flex-1 min-h-0 overflow-y-auto px-24px py-20px' data-testid='preparation-transcript'>
        <div className='mx-auto max-w-880px flex flex-col gap-20px'>
          {snapshot?.messages.map((message) => (
            <div
              key={message.id}
              className={`whitespace-pre-wrap break-words text-14px leading-7 ${message.position === 'right' ? 'self-end bg-bg-2 rd-12px px-16px py-10px max-w-80%' : 'self-start w-full'}`}
            >
              {message.text}
            </div>
          ))}
        </div>
      </div>
      <div className='mx-auto w-full max-w-920px px-20px pb-20px shrink-0'>
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
      </div>
    </section>
  );
}
