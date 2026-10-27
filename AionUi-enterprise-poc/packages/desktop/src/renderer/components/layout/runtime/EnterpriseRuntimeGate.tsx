import { Button, Spin, Collapse, Input } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emitter } from '@/renderer/utils/emitter';

type Preparation = {
  ready?: boolean;
  phase?: string;
  error?: string;
  traceId?: string;
  timings?: { totalMs?: number };
};

/** Only execution-dependent routes prepare a worker; browsing uses Host/control services. */
export default function EnterpriseRuntimeGate({ children }: React.PropsWithChildren) {
  const { t } = useTranslation();
  const [state, setState] = useState<Preparation>({ phase: 'queued' });
  const [attempt, setAttempt] = useState(0);
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
    <div className='h-full min-h-0 flex flex-col justify-end p-24px bg-bg-1' data-testid='inline-execution-preparation'>
      <div className='mx-auto w-full max-w-800px border-1 border-solid border-border-2 rd-12px p-16px'>
        <Input.TextArea disabled aria-label={t('common.send')} autoSize={{ minRows: 3, maxRows: 3 }} />
        <div className='mt-12px flex items-center gap-8px' role='status'>
          {!state.error && <Spin size={16} />}
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
            <Button type='text' onClick={() => setAttempt((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          )}
        </div>
        {state.error && (
          <Collapse className='mt-8px'>
            <Collapse.Item name='trace' header={t('workspace.status.preparationTechnicalDetails')}>
              <code>
                {state.error}
                {state.traceId ? ` · ${state.traceId}` : ''}
              </code>
            </Collapse.Item>
          </Collapse>
        )}
      </div>
    </div>
  );
}
