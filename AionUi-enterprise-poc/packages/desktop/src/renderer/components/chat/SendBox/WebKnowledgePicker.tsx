import { Alert, Button, Empty, Message, Modal, Select, Space, Spin, Tag } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { enterpriseControl, enterpriseRequest, workspaceErrorCode } from '@/renderer/pages/workspace/workspaceApi';
import type { KnowledgeDocument, WorkspaceResource } from '@/renderer/pages/workspace/workspaceTypes';

type Scope = {
  baseIds: string[];
  documents: Array<{ baseId: string; documentId: string; version: number }>;
};
let draft: Scope | null = null;
/** Transfer the current tab's explicit draft selection only after a real conversation exists. */
export async function persistDraftKnowledge(conversation: string): Promise<void> {
  if (!isEnterpriseWeb() || !draft) return;
  await enterpriseRequest(`/enterprise/knowledge-scope/${conversation}`, {
    method: 'PUT',
    body: JSON.stringify(draft),
  });
  draft = null;
}

export default function WebKnowledgePicker({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [scope, setScope] = useState<Scope | null>(conversationId ? null : draft);
  const [editing, setEditing] = useState<Scope>({ baseIds: [], documents: [] });
  const [bases, setBases] = useState<WorkspaceResource[]>([]);
  const [baseId, setBaseId] = useState<string>();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const documentGeneration = useRef(0);
  useEffect(() => {
    const g = ++generation.current;
    if (!conversationId) {
      setScope(draft);
      return;
    }
    void enterpriseRequest<{ scope: Scope | null }>(`/enterprise/knowledge-scope/${conversationId}`)
      .then((value) => {
        if (g === generation.current) setScope(value.scope);
      })
      .catch((e) => {
        if (g === generation.current) setError(workspaceErrorCode(e));
      });
    return () => {
      generation.current += 1;
    };
  }, [conversationId]);
  const open = async () => {
    setVisible(true);
    setEditing(scope || { baseIds: [], documents: [] });
    setLoading(true);
    setError(undefined);
    try {
      if (conversationId) {
        const saved = await enterpriseRequest<{ scope: Scope | null }>(`/enterprise/knowledge-scope/${conversationId}`);
        setScope(saved.scope);setEditing(saved.scope || { baseIds: [], documents: [] });
      }
      const all: WorkspaceResource[] = [];
      for (let page = 1; page <= 100; page++) {
        const rows = await enterpriseControl<WorkspaceResource[]>(
          `/ai/resources?type=KNOWLEDGE&scope=available&page=${page}`
        );
        all.push(...rows.filter((r) => r.actions.includes('USE')));
        if (rows.length < 30) break;
      }
      setBases(all);
      setBaseId(all[0]?.id);
    } catch (e) {
      setError(workspaceErrorCode(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const g = ++documentGeneration.current;
    setDocuments([]);
    if (!visible || !baseId) return;
    void (async () => {
      const all: KnowledgeDocument[] = [];
      for (let page = 1; page <= 2; page++) {
        const rows = await enterpriseControl<KnowledgeDocument[]>(`/ai/knowledge/${baseId}/documents?page=${page}`);
        all.push(...rows);
        if (rows.length < 30) break;
      }
      if (g === documentGeneration.current) setDocuments(all);
    })().catch((e) => {
      if (g === documentGeneration.current) setError(workspaceErrorCode(e));
    });
    return () => {
      documentGeneration.current += 1;
    };
  }, [baseId, visible]);
  const apply = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      if (conversationId)
        await enterpriseRequest(`/enterprise/knowledge-scope/${conversationId}`, {
          method: 'PUT',
          body: JSON.stringify(editing),
        });
      else draft = editing;
      setScope(editing);
      setVisible(false);
    } catch (e) {
      setError(workspaceErrorCode(e));
      Message.error(t('workspace.errors.action', { code: workspaceErrorCode(e) }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Button size='mini' type='text' onClick={() => void open()}>
        {t('workspace.knowledge.taskScope')}
      </Button>
      <span className='text-12px text-t-secondary'>
        {scope
          ? t('workspace.knowledge.scopeCount', {
              bases: scope.baseIds.length,
              documents: scope.documents.length,
            })
          : t('workspace.knowledge.scopeDefault')}
      </span>
      <Modal
        visible={visible}
        title={t('workspace.knowledge.taskScope')}
        onCancel={() => setVisible(false)}
        onOk={apply}
        confirmLoading={saving}
        style={{ width: 'min(720px, 92vw)' }}
      >
        <Spin loading={loading} className='w-full'>
          <Space direction='vertical' className='w-full' size='large'>
            {error ? (
              <Alert
                type='error'
                content={t('workspace.errors.action', { code: error })}
                action={<Button onClick={() => void open()}>{t('common.retry')}</Button>}
              />
            ) : null}
            <div>{t('workspace.knowledge.scopeHint')}</div>
            <label>{t('workspace.knowledge.selectedBases')}</label>
            <Select
              mode='multiple'
              showSearch
              value={editing.baseIds}
              maxTagCount={3}
              onChange={(ids: string[]) =>
                setEditing((current) => ({
                  baseIds: ids.slice(0, 8),
                  documents: current.documents.filter((d) => !ids.includes(d.baseId)),
                }))
              }
            >
              {bases.map((b) => (
                <Select.Option key={b.id} value={b.id}>
                  {b.name} ·{' '}
                  {t(`workspace.abilities.origin.${b.source === 'ORGANIZATION' ? 'organization' : 'personal'}`)}
                </Select.Option>
              ))}
            </Select>
            <label>{t('workspace.knowledge.selectedFiles')}</label>
            <Select value={baseId} onChange={setBaseId} showSearch>
              {bases.map((b) => (
                <Select.Option key={b.id} value={b.id}>
                  {b.name}
                </Select.Option>
              ))}
            </Select>
            {documents.length ? (
              <Select
                mode='multiple'
                showSearch
                value={editing.documents.filter((d) => d.baseId === baseId).map((d) => `${d.documentId}:${d.version}`)}
                onChange={(ids: string[]) => {
                  const refs = ids.map((id) => {
                    const [documentId, version] = id.split(':');
                    return { baseId: baseId!, documentId, version: Number(version) };
                  });
                  setEditing((current) => ({
                    baseIds: current.baseIds.filter((id) => id !== baseId),
                    documents: [...current.documents.filter((d) => d.baseId !== baseId), ...refs].slice(0, 8),
                  }));
                }}
              >
                {documents.map((d) => (
                  <Select.Option key={d.id} value={`${d.id}:${d.version}`} disabled={d.status !== 'READY'}>
                    {d.title} · v{d.version} · {t(`workspace.knowledge.status.${d.status}`, { defaultValue: d.status })}
                  </Select.Option>
                ))}
              </Select>
            ) : (
              <Empty description={t('workspace.knowledge.empty')} />
            )}
            <Space wrap>
              {editing.documents.map((d) => (
                <Tag
                  key={d.documentId}
                  closable
                  onClose={() =>
                    setEditing((current) => ({
                      ...current,
                      documents: current.documents.filter((x) => x.documentId !== d.documentId),
                    }))
                  }
                >
                  {documents.find((x) => x.id === d.documentId)?.title || d.documentId.slice(0, 8)} · v{d.version}
                </Tag>
              ))}
            </Space>
          </Space>
        </Spin>
      </Modal>
    </>
  );
}
