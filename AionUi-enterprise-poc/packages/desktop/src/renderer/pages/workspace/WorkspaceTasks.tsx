import { Alert, Button, Empty, List, Select, Space, Spin, Tag } from '@arco-design/web-react';
import { Refresh, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { workspaceTaskDisplayStatus } from '@/renderer/utils/ui/runtimeDisplayStatus';
import { enterpriseRequest, workspaceErrorCode } from './workspaceApi';
import type { WebConversationTask } from './workspaceTypes';

const WorkspaceTasks: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<WebConversationTask[]>([]);
  const [status, setStatus] = useState('all');
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await enterpriseRequest<{ items: WebConversationTask[] }>('/enterprise/conversations');
      setTasks(Array.isArray(result.items) ? result.items : []);
      setErrorCode(null);
    } catch (error) {
      setTasks([]);
      setErrorCode(workspaceErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const visibleTasks = useMemo(
    () => tasks.filter((task) => status === 'all' || workspaceTaskDisplayStatus(task.status, task.runtime) === status),
    [status, tasks]
  );
  const statusValues = useMemo(
    () => Array.from(new Set(tasks.map((task) => workspaceTaskDisplayStatus(task.status, task.runtime)))),
    [tasks]
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
                {t(`workspace.status.${value}`, { defaultValue: value })}
              </Select.Option>
            ))}
          </Select>
          <Button icon={<Refresh />} onClick={() => void loadTasks()} loading={loading}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      <Alert type='info' showIcon content={t('workspace.tasks.manageHint')} />
      {errorCode ? <Alert type='error' showIcon content={t('workspace.errors.load', { code: errorCode })} /> : null}
      <Spin loading={loading} className='w-full'>
        {visibleTasks.length === 0 && !loading ? (
          <Empty description={t('workspace.tasks.empty')} />
        ) : (
          <List
            dataSource={visibleTasks}
            render={(task) => (
              <List.Item
                key={task.id}
                actions={[
                  <Button key='open' type='text' onClick={() => navigate(`/conversation/${task.id}`)}>
                    {t('workspace.tasks.open')} <Right />
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <div className='flex items-center gap-8px'>
                      <span>{task.name}</span>
                      <Tag>
                        {t(`workspace.status.${workspaceTaskDisplayStatus(task.status, task.runtime)}`, {
                          defaultValue: workspaceTaskDisplayStatus(task.status, task.runtime),
                        })}
                      </Tag>
                    </div>
                  }
                  description={
                    task.modified_at
                      ? dateFormatter.format(new Date(task.modified_at))
                      : t('workspace.tasks.timeUnknown')
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
