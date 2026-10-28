import { Tag } from '@arco-design/web-react';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { enterpriseRequest } from '../workspaceApi';
import type { WorkTask } from './api';
const TaskOverview = createContext<Map<string, string>>(new Map());
/** One visible-tab read for the whole conversation list, not one request per row. */
export function TaskOverviewProvider({ children }: React.PropsWithChildren) {
  const [states, setStates] = useState(new Map<string, string>());
  useEffect(() => {
    if (!isEnterpriseWeb()) return;
    let stopped = false,
      busy = false;
    const load = async () => {
      if (stopped || busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const value = await enterpriseRequest<{ items: WorkTask[] }>('/enterprise/tasks', {
          signal: AbortSignal.timeout(10000),
        });
        if (!stopped) setStates(new Map(value.items.map((t) => [t.id, t.attempts.at(-1)?.state || 'unknown'])));
      } catch {
        if (!stopped) setStates(new Map());
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    const refresh = (): void => {
      void load();
    };
    window.addEventListener('task-work:changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('task-work:changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return <TaskOverview.Provider value={states}>{children}</TaskOverview.Provider>;
}
export function TaskBadge({ id }: { id: string }) {
  const { t } = useTranslation();
  const state = useContext(TaskOverview).get(id);
  return state && !['completed', 'cancelled', 'unknown'].includes(state) ? (
    <Tag size='small'>{t(`workspace.work.states.${state}`, { defaultValue: t('workspace.work.unknown') })}</Tag>
  ) : null;
}
