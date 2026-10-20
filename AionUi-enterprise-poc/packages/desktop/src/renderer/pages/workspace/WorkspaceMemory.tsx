import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  List,
  Message,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from '@arco-design/web-react';
import { AlarmClock, Delete, Edit, Plus, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { enterpriseRequest, workspaceErrorCode } from './workspaceApi';
import type { WorkspaceMemory as WorkspaceMemoryItem } from './workspaceTypes';

type MemoryFormValue = { scope: 'personal' | 'project'; projectId?: string; content: string };

const WorkspaceMemory: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [message, messageContext] = Message.useMessage();
  const [form] = Form.useForm<MemoryFormValue>();
  const [items, setItems] = useState<WorkspaceMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkspaceMemoryItem | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await enterpriseRequest<{ items: WorkspaceMemoryItem[] }>('/enterprise/memories');
      setItems(Array.isArray(value.items) ? value.items : []);
      setErrorCode(null);
    } catch (error) {
      setItems([]);
      setErrorCode(workspaceErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (item?: WorkspaceMemoryItem) => {
    const value = item || 'new';
    setEditing(value);
    form.setFieldsValue(
      item
        ? { scope: item.scope, projectId: item.projectId || '', content: item.content }
        : { scope: 'personal', projectId: '', content: '' }
    );
  };

  const save = async () => {
    const values = await form.validate();
    setSaving(true);
    try {
      await enterpriseRequest('/enterprise/memories', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: editing !== 'new' ? editing?.id : undefined,
          scope: values.scope,
          projectId: values.scope === 'project' ? values.projectId?.trim() || undefined : undefined,
          content: values.content.trim(),
        }),
      });
      message.success(t('workspace.memory.saved'));
      setEditing(null);
      await load();
    } catch (error) {
      message.error(t('workspace.errors.action', { code: workspaceErrorCode(error) }));
    } finally {
      setSaving(false);
    }
  };

  const remove = (item: WorkspaceMemoryItem) => {
    Modal.confirm({
      title: t('workspace.memory.deleteTitle'),
      content: t('workspace.memory.deleteConfirm'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        await enterpriseRequest(`/enterprise/memories?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        message.success(t('workspace.memory.deleted'));
        await load();
      },
    });
  };

  return (
    <div className='flex flex-col gap-12px'>
      {messageContext}
      <div className='flex flex-wrap items-start justify-between gap-8px'>
        <div>
          <div className='text-20px font-semibold text-t-primary'>{t('workspace.memory.title')}</div>
          <div className='mt-3px text-13px text-t-secondary'>{t('workspace.memory.subtitle')}</div>
        </div>
        <Space wrap>
          <Button icon={<AlarmClock />} onClick={() => navigate('/scheduled')}>{t('workspace.memory.scheduled')}</Button>
          <Button type='primary' icon={<Plus />} onClick={() => openEditor()}>{t('workspace.memory.create')}</Button>
          <Button icon={<Refresh />} onClick={() => void load()}>{t('common.refresh')}</Button>
        </Space>
      </div>
      <Alert type='info' showIcon content={t('workspace.memory.scopeHint')} />
      {errorCode ? <Alert type='error' showIcon content={t('workspace.errors.load', { code: errorCode })} /> : null}
      <Spin loading={loading} className='w-full'>
        {items.length === 0 && !loading ? <Empty description={t('workspace.memory.empty')} /> : (
          <List
            dataSource={items}
            render={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button key='edit' type='text' icon={<Edit />} onClick={() => openEditor(item)}>{t('common.edit')}</Button>,
                  <Button key='delete' type='text' status='danger' icon={<Delete />} onClick={() => remove(item)}>{t('common.delete')}</Button>,
                ]}
              >
                <List.Item.Meta
                  title={<div className='flex items-center gap-8px'><Tag>{t(`workspace.memory.scope.${item.scope}`)}</Tag><span className='line-clamp-1'>{item.content}</span></div>}
                  description={item.scope === 'project' && item.projectId ? t('workspace.memory.project', { id: item.projectId }) : t('workspace.memory.personal')}
                />
              </List.Item>
            )}
          />
        )}
      </Spin>
      <Modal visible={editing !== null} title={editing === 'new' ? t('workspace.memory.create') : t('workspace.memory.edit')} onCancel={() => setEditing(null)} onOk={() => void save()} okButtonProps={{ loading: saving }} autoFocus={false} focusLock>
        <Form form={form} layout='vertical'>
          <Form.Item field='scope' label={t('workspace.memory.scopeLabel')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value='personal'>{t('workspace.memory.scope.personal')}</Select.Option>
              <Select.Option value='project'>{t('workspace.memory.scope.project')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {(values) => values.scope === 'project' ? (
              <Form.Item field='projectId' label={t('workspace.memory.projectId')} rules={[{ required: true }]}><Input /></Form.Item>
            ) : null}
          </Form.Item>
          <Form.Item field='content' label={t('workspace.memory.content')} rules={[{ required: true }]}><Input.TextArea maxLength={4000} autoSize={{ minRows: 5, maxRows: 12 }} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default WorkspaceMemory;
