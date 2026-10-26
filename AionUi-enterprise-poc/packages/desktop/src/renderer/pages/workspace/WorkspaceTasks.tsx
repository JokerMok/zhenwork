import TaskWork from './TaskWork';
import type { WorkTask } from './TaskWork/api';
import { Alert, Button, Empty, List, Select, Space, Spin, Tag } from '@arco-design/web-react';
import { Refresh, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { enterpriseRequest, workspaceErrorCode } from './workspaceApi';
import type { WebConversationTask } from './workspaceTypes';

const WorkspaceTasks: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<WebConversationTask[]>([]);
  const [work, setWork] = useState<WorkTask[]>([]);
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | undefined>(params.get('task') || undefined);
  const generation = useRef(0);
  const reading = useRef(false);
  const [status, setStatus] = useState('all');
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
        enterpriseRequest<{ items: WorkTask[] }>('/enterprise/tasks', { signal: AbortSignal.timeout(10000) }),
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

  const visibleTasks = useMemo(
    () => tasks.filter((task) => status === 'all' || (work.find((w) => w.id === task.id)?.attempts.at(-1)?.state || 'unknown') === status),
    [status, tasks, work]
  );
  const statusValues = useMemo(
    () => Array.from(new Set(tasks.map((task) => work.find((w) => w.id === task.id)?.attempts.at(-1)?.state || 'unknown'))),
    [tasks, work]
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  );

  return (
    <div className='flex flex-col gap-12px'>
      <div className='flex flex-wrap items-center justify-between gap-8px'>
        <div>
          <div className='text-20px font-semibold text-t-primary'>{t('workspace.tasks.title')}</div>
          <div className='mt-3px text-13px text-t-secondary'>{t('workspace.tasks.subtitle')}</div>
        </div>
        <Space>
          <Select value={status} onChange={setStatus} style={{ width: 150 }}>
            <Select.Option value='all'>{t('workspace.status.all')}</Select.Option>
            {statusValues.map((value) => (
              <Select.Option key={value} value={value}>
                {t(`workspace.work.states.${value}`, { defaultValue: t('workspace.work.unknown') })}
              </Select.Option>
            ))}
          </Select>
          <Button icon={<Refresh />} onClick={() => void loadTasks()} loading={loading}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      {selected ? <TaskWork conversationId={selected} composer /> : null}
      {errorCode ? <Alert type='error' showIcon content={t('workspace.errors.load', { code: errorCode })} /> : null}
      <Spin loading={loading} className='w-full'>
        {visibleTasks.length === 0 && !loading ? (
          <Empty description={t('workspace.tasks.empty')} />
        ) : (
          <List
            pagination={{ pageSize: 20 }}
            dataSource={visibleTasks}
            render={(task) => (
              <List.Item
                key={task.id}
                actions={[
                  <Button key='open' type='text' onClick={() =>
                      work.some((w) => w.id === task.id) ? setSelected(task.id) : navigate(`/conversation/${task.id}`)}>
                    {t(work.some((w) => w.id === task.id) ? 'workspace.work.details' : 'workspace.tasks.open')}{' '} <Right />
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <div className='flex items-center gap-8px'>
                      <span>{task.name}</span>
                      <Tag>
                        {t(
                          `workspace.work.states.${work.find((w) => w.id === task.id)?.attempts.at(-1)?.state || 'unknown'}`,
                          { defaultValue: t('workspace.work.unknown') })}
                      </Tag>
                    </div>
                  }
                  description={
                    work.find((w) => w.id === task.id)?.attempts.at(-1)?.question ||
                    (work.find((w) => w.id === task.id)?.attempts.at(-1)?.progress
                      ? t(`workspace.work.progress.${work.find((w) => w.id === task.id)?.attempts.at(-1)?.progress}`, {
                          defaultValue: work.find((w) => w.id === task.id)?.attempts.at(-1)?.progress,
                        })
                      : '') ||
                    (task.modified_at
                      ? dateFormatter.format(new Date(task.modified_at))
                      : t('workspace.tasks.timeUnknown'))
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Spin>
    </div>
  );
};

export default WorkspaceTasks;
