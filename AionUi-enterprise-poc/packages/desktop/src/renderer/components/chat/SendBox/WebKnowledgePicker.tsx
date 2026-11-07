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
  const trigger = useRef<HTMLButtonElement>(null);
  const [scopeKnown, setScopeKnown] = useState(!conversationId);
  const [inherited, setInherited] = useState(false);
  const [editing, setEditing] = useState<Scope>({ baseIds: [], documents: [] });
  const [bases, setBases] = useState<WorkspaceResource[]>([]);
  const [baseId, setBaseId] = useState<string>();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string>();
  const saveBusy = useRef(false);
  const generation = useRef(0);
  const documentGeneration = useRef(0);
  useEffect(() => {
    const g = ++generation.current;
    setScopeKnown(!conversationId);
    setScope(null);
    setVisible(false);
    setSaving(false);
    if (!conversationId) {
      setScope(draft);
      return;
    }
    void enterpriseRequest<{ scope: Scope | null }>(`/enterprise/knowledge-scope/${conversationId}`)
      .then((value) => {
        if (g === generation.current) {
          setScope(value.scope);
          setScopeKnown(true);
        }
      })
      .catch((e) => {
        if (g === generation.current) setError(workspaceErrorCode(e));
      });
    return () => {
      generation.current += 1;
    };
  }, [conversationId]);
  const close = () => {
    if (saving) return;
    ++generation.current;
    ++documentGeneration.current;
    setVisible(false);
    setLoading(false);
  };
  const open = async () => {
    const g = ++generation.current;
    setVisible(true);
    setInherited(scope === null);
    setBases([]);
    setBaseId(undefined);
    setDocuments([]);
    setEditing(scope || { baseIds: [], documents: [] });
    setLoading(true);
    setLoadError(false);
    setError(undefined);
    try {
      if (conversationId) {
        const saved = await enterpriseRequest<{ scope: Scope | null }>(`/enterprise/knowledge-scope/${conversationId}`);
        if (g !== generation.current) return;
        setScope(saved.scope);
        setScopeKnown(true);
        setInherited(saved.scope === null);
        setEditing(saved.scope || { baseIds: [], documents: [] });
      }
      const all: WorkspaceResource[] = [];
      for (let page = 1; page <= 100; page++) {
        const rows = await enterpriseControl<WorkspaceResource[]>(
          `/ai/resources?type=KNOWLEDGE&scope=available&page=${page}`
        );
        if (g !== generation.current) return;
        all.push(...rows.filter((r) => r.actions.includes('USE')));
        if (rows.length < 30) break;
      }
      if (g !== generation.current) return;
      setBases(all);
      setBaseId(all[0]?.id);
    } catch (e) {
      if (g === generation.current) {
        setError(workspaceErrorCode(e));
        setLoadError(true);
      }
    } finally {
      if (g === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const g = ++documentGeneration.current;
    setDocuments([]);
    if (!visible || !baseId) return;
    setError(undefined);
    void (async () => {
      const all: KnowledgeDocument[] = [];
      for (let page = 1; page <= 100; page++) {
        const rows = await enterpriseControl<KnowledgeDocument[]>(`/ai/knowledge/${baseId}/documents?page=${page}`);
        if (g !== documentGeneration.current) return;
        all.push(...rows);
        if (rows.length < 30) break;
        if (page === 100) throw new Error('KNOWLEDGE_DOCUMENT_LIMIT');
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
    if (saveBusy.current || loading || loadError) return;
    if (inherited && scope === null) {
      close();
      return;
    }
    const g = generation.current;
    saveBusy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      if (conversationId)
        await enterpriseRequest(`/enterprise/knowledge-scope/${conversationId}`, {
          method: inherited ? 'DELETE' : 'PUT',
          ...(inherited ? {} : { body: JSON.stringify(editing) }),
        });
      else draft = inherited ? null : editing;
      if (g !== generation.current) return;
      setScope(inherited ? null : editing);
      setVisible(false);
    } catch (e) {
      if (g !== generation.current) return;
      setError(workspaceErrorCode(e));
      Message.error(t('workspace.errors.action', { code: workspaceErrorCode(e) }));
    } finally {
      saveBusy.current = false;
      if (g === generation.current) setSaving(false);
    }
  };
  const scopeLabel = !scopeKnown
    ? t('workspace.knowledge.scopeUnknown')
    : scope === null
      ? t('workspace.knowledge.inheritedLabel')
      : scope.baseIds.length + scope.documents.length === 0
        ? t('workspace.knowledge.scopeNone')
        : t('workspace.knowledge.selectionLabel', { count: scope.baseIds.length + scope.documents.length });
  return (
    <>
      <Button
        ref={trigger}
        disabled={saving}
        size='mini'
        type='text'
        className='shrink-0 whitespace-nowrap max-w-180px truncate'
        aria-label={`${t('workspace.knowledge.taskScope')}: ${scopeLabel}`}
        onClick={() => void open()}
      >
        {scopeLabel}
      </Button>
      <Modal
        visible={visible}
        title={t('workspace.knowledge.taskScope')}
        onCancel={close}
        afterClose={() => trigger.current?.focus()}
        escToExit
        focusLock
        okButtonProps={{ disabled: loading || loadError }}
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
            <div role='status'>
              {inherited
                ? t('workspace.knowledge.inheritedLabel')
                : editing.baseIds.length + editing.documents.length === 0
                  ? t('workspace.knowledge.scopeNone')
                  : t('workspace.knowledge.scopeCount', {
                      bases: editing.baseIds.length,
                      documents: editing.documents.length,
                    })}
            </div>
            <div>{t(inherited ? 'workspace.knowledge.scopeDefault' : 'workspace.knowledge.scopeHint')}</div>
            <Button
              disabled={loading || saving}
              type={inherited ? 'primary' : 'secondary'}
              onClick={() => {
                setError(undefined);
                setInherited(true);
                setEditing({ baseIds: [], documents: [] });
              }}
            >
              {t('workspace.knowledge.inheritedLabel')}
            </Button>
            <Button
              disabled={loading || saving}
              onClick={() => {
                setError(undefined);
                setInherited(false);
                setEditing({ baseIds: [], documents: [] });
              }}
            >
              {t('workspace.knowledge.scopeNone')}
            </Button>
            <label>{t('workspace.knowledge.selectedBases')}</label>
            <Select
              mode='multiple'
              showSearch
              aria-label={t('workspace.knowledge.selectedBases')}
              disabled={loading || saving}
              value={editing.baseIds}
              maxTagCount={3}
              onChange={(ids: string[]) => {
                setError(undefined);
                setInherited(false);
                setEditing((current) => ({
                  baseIds: ids.slice(0, 8),
                  documents: current.documents.filter((d) => !ids.includes(d.baseId)),
                }));
              }}
            >
              {bases.map((b) => (
                <Select.Option key={b.id} value={b.id}>
                  {b.name} ·{' '}
                  {t(`workspace.abilities.origin.${b.source === 'ORGANIZATION' ? 'organization' : 'personal'}`)}
                </Select.Option>
              ))}
            </Select>
            <label>{t('workspace.knowledge.selectedFiles')}</label>
            <Select
              aria-label={t('workspace.knowledge.documentBase')}
              disabled={loading || saving}
              value={baseId}
              onChange={setBaseId}
              showSearch
            >
              {bases.map((b) => (
                <Select.Option key={b.id} value={b.id}>
                  {b.name}
                </Select.Option>
              ))}
            </Select>
            {documents.length ? (
              <Select
                mode='multiple'
                aria-label={t('workspace.knowledge.selectedFiles')}
                disabled={loading || saving}
                showSearch
                value={editing.documents.filter((d) => d.baseId === baseId).map((d) => `${d.documentId}:${d.version}`)}
                onChange={(ids: string[]) => {
                  setError(undefined);
                  setInherited(false);
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
                  onClose={() => {
                    setError(undefined);
                    setInherited(false);
                    setEditing((current) => ({
                      ...current,
                      documents: current.documents.filter((x) => x.documentId !== d.documentId),
                    }));
                  }}
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
