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
import { Delete, Edit, Plus, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enterpriseRequest, workspaceErrorCode } from './workspaceApi';
import type { WorkspaceMemory as WorkspaceMemoryItem } from './workspaceTypes';

type MemoryFormValue = { scope: 'personal' | 'project'; projectId?: string; content: string };

const WorkspaceMemory: React.FC = () => {
  const { t } = useTranslation();
  const [message, messageContext] = Message.useMessage();
  const [form] = Form.useForm<MemoryFormValue>();
  const [items, setItems] = useState<WorkspaceMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkspaceMemoryItem | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const loadRequest = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    setLoading(true);
    setErrorCode(null);
    try {
      const value = await enterpriseRequest<{ items: WorkspaceMemoryItem[] }>('/enterprise/memories', {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setItems(Array.isArray(value.items) ? value.items : []);
    } catch (error) {
      if (!controller.signal.aborted) setErrorCode(workspaceErrorCode(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => loadRequest.current?.abort();
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
    if (!editing || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      const values = await form.validate().catch((): null => null);
      if (!values) return;
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
      submitting.current = false;
      setSaving(false);
    }
  };

  const remove = (item: WorkspaceMemoryItem) => {
    Modal.confirm({
      title: t('workspace.memory.deleteTitle'),
      content: t('workspace.memory.deleteConfirm'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        await enterpriseRequest(`/enterprise/memories?id=${encodeURIComponent(item.id)}`, {
          method: 'DELETE',
        });
        message.success(t('workspace.memory.deleted'));
        await load();
      },
    });
  };

  return (
    <div className='flex flex-col gap-12px'>
      {messageContext}
      <div className='flex flex-wrap items-start justify-between gap-8px'>
        <h2 className='m-0 text-20px font-semibold text-t-primary'>{t('workspace.tabs.memory')}</h2>
        <Space wrap>
          <Button type='primary' icon={<Plus />} onClick={() => openEditor()}>
            {t('workspace.memory.create')}
          </Button>
          <Button icon={<Refresh />} loading={loading} onClick={() => void load()}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      <Alert type='info' showIcon content={t('workspace.memory.scopeHint')} />
      {errorCode && (
        <Alert
          type='error'
          showIcon
          content={t('workspace.errors.load', { code: errorCode })}
          action={
            <Button size='small' onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      <Spin loading={loading} className='w-full'>
        {items.length === 0 ? (
          !loading && !errorCode && <Empty description={t('workspace.memory.empty')} />
        ) : (
          <List
            dataSource={items}
            render={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button key='edit' type='text' icon={<Edit />} onClick={() => openEditor(item)}>
                    {t('common.edit')}
                  </Button>,
                  <Button key='delete' type='text' status='danger' icon={<Delete />} onClick={() => remove(item)}>
                    {t('common.delete')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <div className='flex items-center gap-8px'>
                      <Tag>{t(`workspace.memory.scope.${item.scope}`)}</Tag>
                      <span className='line-clamp-1'>{item.content}</span>
                    </div>
                  }
                  description={
                    item.scope === 'project' && item.projectId
                      ? t('workspace.memory.project', { id: item.projectId })
                      : t('workspace.memory.personal')
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Spin>
      <Modal
        visible={editing !== null}
        title={editing === 'new' ? t('workspace.memory.create') : t('workspace.memory.edit')}
        onCancel={() => !submitting.current && setEditing(null)}
        onOk={() => void save()}
        okButtonProps={{ loading: saving }}
        cancelButtonProps={{ disabled: saving }}
        maskClosable={false}
        focusLock
      >
        <Form form={form} layout='vertical' disabled={saving}>
          <Form.Item field='scope' label={t('workspace.memory.scopeLabel')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value='personal'>{t('workspace.memory.scope.personal')}</Select.Option>
              <Select.Option value='project'>{t('workspace.memory.scope.project')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {(values) =>
              values.scope === 'project' ? (
                <Form.Item field='projectId' label={t('workspace.memory.projectId')} rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item field='content' label={t('workspace.memory.content')} rules={[{ required: true }]}>
            <Input.TextArea maxLength={4000} autoSize={{ minRows: 5, maxRows: 12 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default WorkspaceMemory;
