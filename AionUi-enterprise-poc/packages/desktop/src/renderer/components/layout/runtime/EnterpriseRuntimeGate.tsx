import { Alert, Button, Spin, Collapse } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

type Preparation = { ready?: boolean; phase?: string; error?: string; traceId?: string; timings?: { totalMs?: number } };

/** Only execution-dependent routes prepare a worker; browsing uses Host/control services. */
export default function EnterpriseRuntimeGate({ children }: React.PropsWithChildren) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
          window.location.replace('/enterprise/login');
          return;
        }
        setState(result);
        if (result.ready) {
          performance.mark('enterprise:execution_environment_ready');
          (window as Window & { __websocketReconnect?: () => void }).__websocketReconnect?.();
          window.dispatchEvent(new Event('enterprise:core-ready'));
          return;
        }
        if (response.status !== 202) return;
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
  const reason = state.error === 'DEFAULT_MODEL_UNAVAILABLE' ? t('workspace.errors.noModel')
    : state.error === 'CAPABILITY_FORBIDDEN' ? t('workspace.errors.forbidden')
    : state.error === 'PREPARATION_TIMEOUT' ? t('workspace.status.preparationTimedOut')
    : t('workspace.status.environmentUnavailable');
  return (
    <div className='h-full flex flex-col items-center justify-center gap-16px bg-bg-1 px-24px'>
      <Button type='text' onClick={() => navigate('/workspace')}>
        {t('workspace.tabs.home')}
      </Button>
      {state.error ? (
        <>
          <Alert type='error' content={reason} />
          <Collapse className='w-full max-w-480px'><Collapse.Item name='trace' header={t('workspace.status.preparationTechnicalDetails')}><code>{state.error}{state.traceId ? ` · ${state.traceId}` : ''}</code></Collapse.Item></Collapse>
          <Button type='primary' onClick={() => setAttempt((value) => value + 1)}>
            {t('common.retry')}
          </Button>
        </>
      ) : (
        <>
          <Spin />
          <span>
            {t(
              state.phase === 'starting' ? 'workspace.status.preparationStarting' : 'workspace.status.preparationQueued'
            )}
          </span>
        </>
      )}
      {!state.error && (state.timings?.totalMs ?? 0) >= 1000 ? <span className='text-12px text-t-secondary'>{t('workspace.status.preparationElapsed', { seconds: Math.round((state.timings?.totalMs ?? 0) / 1000) })}</span> : null}
    </div>
  );
}
