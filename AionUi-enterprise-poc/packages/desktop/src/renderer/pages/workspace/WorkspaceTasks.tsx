import TaskWork from './TaskWork';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import styles from './WorkspaceExperience.module.css';
import { TaskStateTag } from './TaskWork/overview';
import type { WorkAttempt, WorkTask } from './TaskWork/api';
import { Alert, Button, Empty, List, Select, Space, Spin, Tag } from '@arco-design/web-react';
import { AlarmClock, Refresh, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { enterpriseRequest, workspaceErrorCode } from './workspaceApi';
import type { WebConversationTask } from './workspaceTypes';

const isToolIdentifier = (value: string, attempt: WorkAttempt) =>
  attempt.steps?.some((step) => step.tool === value) ||
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value) ||
  /^(?:mcp__|mcp[.:/]|[\w-]+::)[\w./:-]+$/i.test(value);

function waitingQuestion(question: string | undefined): string {
  const text = question?.trim() ?? '';
  if (!text.startsWith('[')) return text;
  try {
    const items: unknown = JSON.parse(text);
    if (Array.isArray(items)) {
      const questions = items.flatMap((item) => {
        const label = item?.question || item?.header;
        return typeof label === 'string' && label.trim() ? [label.trim()] : [];
      });
      if (questions.length) return questions.join(' ');
    }
  } catch {
    // A bracketed label is valid employee-facing text.
  }
  return text;
}

const WorkspaceTasks: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<WebConversationTask[]>([]);
  const [work, setWork] = useState<WorkTask[]>([]);
  const [params, setParams] = useSearchParams();
  const selected = params.get('task');
  const active = params.get('section') === 'tasks';
  const previousTask = useRef<string | null>(null);
  const listTrigger = useRef<HTMLElement | undefined>(undefined);
  const [detailTask, setDetailTask] = useState<WorkTask>();
  const selectTask = (id?: string, trigger?: HTMLElement) => {
    if (id && !selected) listTrigger.current = trigger;
    const next = new URLSearchParams(params);
    if (id) next.set('task', id);
    else next.delete('task');
    setParams(next);
  };
  useLayoutEffect(() => {
    if (!active) return;
    if (!selected && previousTask.current && listTrigger.current?.isConnected) {
      listTrigger.current.focus({ preventScroll: true });
    }
    previousTask.current = selected;
  }, [active, selected]);

  const generation = useRef(0);
  const reading = useRef(false);
  const status = params.get('status') || 'all';
  const setStatus = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('status');
    else next.set('status', value);
    setParams(next, { replace: true });
  };
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const loadTasks = useCallback(async (quiet = false) => {
    if (reading.current) return;
    reading.current = true;
    const sequence = ++generation.current;
    if (!quiet) setLoading(true);
    try {
      const [result, workResult] = await Promise.all([
        enterpriseRequest<{ items: WebConversationTask[] }>('/enterprise/conversations', {
          signal: AbortSignal.timeout(10000),
        }),
        enterpriseRequest<{ items: WorkTask[] }>('/enterprise/tasks', {
          signal: AbortSignal.timeout(10000),
        }),
      ]);
      if (sequence !== generation.current) return;
      setWork(workResult.items);
      const items = Array.isArray(result.items) ? result.items : [];
      setTasks([
        ...items,
        ...workResult.items
          .filter((w) => !items.some((t) => t.id === w.id))
          .map((w) => ({
            key: w.id,
            id: w.id,
            source: 'enterprise_web' as const,
            name: w.title,
            modified_at: w.updatedAt,
            status: null as string | null,
            pinned: false,
          })),
      ]);
      setErrorCode(null);
    } catch (error) {
      if (sequence !== generation.current) return;
      setErrorCode(workspaceErrorCode(error));
    } finally {
      reading.current = false;
      if (sequence === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadTasks(true);
    }, 5000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [loadTasks]);

  const workById = useMemo(() => new Map(work.map((task) => [task.id, task])), [work]);
  const visibleTasks = tasks.filter(
    (task) => status === 'all' || workById.get(task.id)?.attempts.at(-1)?.state === status
  );
  const statusValues = new Set(
    work.flatMap((task) => {
      const state = task.attempts.at(-1)?.state;
      return state ? [state] : [];
    })
  );
  if (status !== 'all') statusValues.add(status);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  );

  return (
    <div className='flex flex-col gap-12px'>
      <div className='flex flex-wrap items-center justify-between gap-8px'>
        <h1 className='m-0 text-24px font-medium text-t-primary'>{t('workspace.tasks.title')}</h1>
        <Space>
          <Select aria-label={t('common.status')} value={status} onChange={setStatus} style={{ width: 150 }}>
            <Select.Option value='all'>{t('workspace.status.all')}</Select.Option>
            {Array.from(statusValues, (value) => (
              <Select.Option key={value} value={value}>
                {t(`workspace.work.states.${value}`, { defaultValue: t('workspace.work.unknown') })}
              </Select.Option>
            ))}
          </Select>
          {isEnterpriseWeb() && (
            <Link className={styles.quietLink} to='/scheduled'>
              <AlarmClock size={16} aria-hidden='true' />
              {t('cron.scheduledTasks')}
            </Link>
          )}
          <Button icon={<Refresh />} onClick={() => void loadTasks()} loading={loading}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      {selected && (
        <section aria-labelledby='workspace-task-detail-title'>
          <div className='mb-8px flex items-start justify-between gap-8px'>
            <h3
              id='workspace-task-detail-title'
              tabIndex={-1}
              className='m-0 min-w-0 break-words text-16px font-semibold'
            >
              {(detailTask?.id === selected ? detailTask.title : undefined) ||
                workById.get(selected)?.title ||
                tasks.find((task) => task.id === selected)?.name ||
                t('workspace.work.details')}
            </h3>
            <Button type='text' onClick={() => selectTask()}>
              {t('common.close')}
            </Button>
          </div>
          <TaskWork key={selected} conversationId={selected} composer onTaskChange={setDetailTask} />
        </section>
      )}
      {errorCode && (
        <Alert
          type='error'
          showIcon
          content={t('workspace.errors.load', { code: errorCode })}
          action={
            <Button size='small' onClick={() => void loadTasks()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      <Spin loading={loading} className='w-full'>
        {visibleTasks.length === 0 && !loading && !errorCode ? (
          <Empty
            description={
              status === 'all' ? (
                t('workspace.tasks.empty')
              ) : (
                <Button type='text' onClick={() => setStatus('all')}>
                  {t('workspace.status.all')}
                </Button>
              )
            }
          />
        ) : visibleTasks.length > 0 ? (
          <List
            pagination={{ pageSize: 20 }}
            dataSource={visibleTasks}
            render={(task) => {
              const execution = workById.get(task.id);
              const attempt = execution?.attempts.at(-1);
              const updated = execution?.updatedAt ?? task.modified_at;
              const date = new Date(updated ?? '');
              const time = Number.isNaN(date.getTime()) ? t('workspace.tasks.timeUnknown') : dateFormatter.format(date);
              const progress = attempt?.progress?.trim();
              const summary =
                progress && attempt
                  ? t(`workspace.work.progress.${progress}`, { defaultValue: '' }) ||
                    (isToolIdentifier(progress, attempt) ? '' : progress)
                  : '';
              const question = ['waiting_input', 'waiting_confirmation'].includes(attempt?.state || '')
                ? waitingQuestion(attempt?.question)
                : '';
              const result = question || summary;
              const title = execution?.title || task.name;
              return (
                <List.Item
                  key={task.id}
                  actions={[
                    <Button
                      key='open'
                      type='text'
                      onClick={(event) => {
                        if (execution) {
                          selectTask(
                            task.id,
                            event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
                          );
                        } else {
                          navigate(`/conversation/${task.id}`);
                        }
                      }}
                    >
                      {t(execution ? 'workspace.work.details' : 'workspace.tasks.open')} <Right />
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <div className='flex flex-wrap items-center gap-8px'>
                        <span className='min-w-0 max-w-full truncate' title={title}>
                          {title}
                        </span>
                        {attempt ? (
                          <TaskStateTag state={attempt.state} />
                        ) : execution ? null : (
                          <Tag>{t('conversation.history.conversationsSection')}</Tag>
                        )}
                      </div>
                    }
                    description={
                      <div className='flex min-w-0 flex-wrap items-center gap-x-8px'>
                        {result && (
                          <span className='max-w-full truncate' title={result}>
                            {result}
                          </span>
                        )}
                        <span>{time}</span>
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        ) : null}
      </Spin>
    </div>
  );
};

export default WorkspaceTasks;
