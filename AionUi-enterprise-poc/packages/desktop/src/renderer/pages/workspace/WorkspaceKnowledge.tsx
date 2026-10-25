import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  List,
  Message,
  Modal,
  Pagination,
  Select,
  Space,
  Spin,
  Tag,
  Upload,
} from '@arco-design/web-react';
import type { UploadRequest } from '@arco-design/web-react/es/Upload/interface';
import { Delete, Refresh, Search, UploadOne } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { catalogOrigin } from './workspaceCatalog';
import { enterpriseControl, newIdempotencyKey, workspaceErrorCode, workspaceErrorTranslationKey } from './workspaceApi';
import type {
  KnowledgeCitation,
  KnowledgeDocument,
  KnowledgeJob,
  KnowledgeSearchResponse,
  ResourceScope,
  WorkspaceResource,
} from './workspaceTypes';

type Preview = {
  documentId: string;
  version: number;
  filename: string;
  content: string;
  fileId: string;
  sha256: string;
  baseId: string;
  latestVersion: number;
  indexedVersion: number | null;
  status: string;
  chunks: Array<{
    chunk_index: number;
    location_label: string;
    line_start: number;
    line_end: number;
    content: string;
  }>;
};

const knowledgeIssueKey = (code: string): string => {
  if (code === 'UnsupportedKnowledgeFileType') return 'fileType';
  if (['InvalidOfficeDocument', 'InvalidPdfDocument'].includes(code)) return 'invalidDocument';
  if (code === 'Utf8TextRequired') return 'utf8';
  if (['DocumentContainsNoExtractableText', 'ScannedPdfOcrUnavailable'].includes(code)) return 'noText';
  if (
    [
      'FileSizeLimitExceeded',
      'DocumentTextLimitExceeded',
      'DocumentStructureLimitExceeded',
      'PdfPageLimitExceeded',
      'ImagePixelLimitExceeded',
    ].includes(code)
  )
    return 'tooLarge';
  if (['OcrLanguageUnavailable', 'OcrUnavailable'].includes(code)) return 'ocrUnavailable';
  if (code === 'ReindexContentChanged') return 'contentChanged';
  if (
    [
      'PdfInfoUnavailable',
      'PdfRenderFailed',
      'PdfRenderIncomplete',
      'OcrFailed',
      'DocumentExtractionTimeout',
      'DocumentExtractionInterrupted',
    ].includes(code)
  )
    return 'temporary';
  return 'failed';
};

const WorkspaceKnowledge: React.FC = () => {
  const { t } = useTranslation();
  const [message, messageContext] = Message.useMessage();
  const [scope, setScope] = useState<ResourceScope>('available');
  const [bases, setBases] = useState<WorkspaceResource[]>([]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<KnowledgeCitation[]>([]);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [params, setParams] = useSearchParams();
  const [documentPage, setDocumentPage] = useState(1);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const sourceId = params.get('documentId');
  const sourceVersion = Number(params.get('version'));
  const sourceChunk = Number(params.get('chunk'));
  const previewGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const [searched, setSearched] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const basesLoadGeneration = useRef(0);
  const documentsLoadGeneration = useRef(0);
  const issueMessage = useCallback(
    (code: string) =>
      t(`workspace.knowledge.issues.${knowledgeIssueKey(code)}`, {
        code,
        defaultValue: t('workspace.knowledge.issues.failed', { code }),
      }),
    [t]
  );

  const selectedBase = useMemo(() => bases.find((base) => base.id === baseId) || null, [baseId, bases]);
  const canEdit = Boolean(selectedBase?.actions.includes('EDIT'));

  useEffect(
    () => () => {
      basesLoadGeneration.current += 1;
      documentsLoadGeneration.current += 1;
    },
    []
  );

  const loadBases = useCallback(async () => {
    const generation = ++basesLoadGeneration.current;
    documentsLoadGeneration.current += 1;
    setLoading(true);
    setBaseId(null);
    setDocuments([]);
    setJobs([]);
    setResults([]);
    try {
      const value: WorkspaceResource[] = [];
      for (let page = 1; page <= 100; page++) {
        const batch = await enterpriseControl<WorkspaceResource[]>(
          `/ai/resources?type=KNOWLEDGE&scope=${scope}&page=${page}`
        );
        value.push(...batch);
        if (batch.length < 30) break;
      }
      if (generation !== basesLoadGeneration.current) return;
      const items = Array.isArray(value) ? value : [];
      setBases(items);
      setBaseId((current) => (current && items.some((item) => item.id === current) ? current : items[0]?.id || null));
      setErrorCode(null);
    } catch (error) {
      if (generation !== basesLoadGeneration.current) return;
      setBases([]);
      setBaseId(null);
      setErrorCode(workspaceErrorCode(error));
    } finally {
      if (generation === basesLoadGeneration.current) setLoading(false);
    }
  }, [scope]);

  const loadDocuments = useCallback(async () => {
    const generation = ++documentsLoadGeneration.current;
    if (!baseId) {
      setDocuments([]);
      setJobs([]);
      return;
    }
    setDocumentsLoading(true);
    try {
      const [value, jobValue] = await Promise.allSettled([
        enterpriseControl<KnowledgeDocument[]>(`/ai/knowledge/${baseId}/documents?page=${documentPage}`),
        enterpriseControl<KnowledgeJob[]>(`/ai/knowledge/${baseId}/jobs`),
      ]);
      if (generation !== documentsLoadGeneration.current) return;
      if (value.status === 'rejected') throw value.reason;
      setDocuments(Array.isArray(value.value) ? value.value : []);
      setJobs(jobValue.status === 'fulfilled' && Array.isArray(jobValue.value) ? jobValue.value : []);
      setErrorCode(jobValue.status === 'rejected' ? workspaceErrorCode(jobValue.reason) : null);
    } catch (error) {
      if (generation !== documentsLoadGeneration.current) return;
      setErrorCode(workspaceErrorCode(error));
    } finally {
      if (generation === documentsLoadGeneration.current) setDocumentsLoading(false);
    }
  }, [baseId, documentPage]);

  useEffect(() => {
    void loadBases();
  }, [loadBases]);
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    setDocumentPage(1);
    setResults([]);
    setSearched(false);
    searchGeneration.current += 1;
  }, [baseId]);
  useEffect(() => {
    if (
      !jobs.some((j) => ['QUEUED', 'RUNNING'].includes(j.status)) &&
      !documents.some((d) => ['QUEUED', 'INDEXING'].includes(d.status))
    )
      return;
    let polls = 0;
    const timer = setInterval(() => {
      if (++polls > 40) {
        clearInterval(timer);
        return;
      }
      if (document.visibilityState === 'visible') void loadDocuments();
    }, 3000);
    return () => clearInterval(timer);
  }, [
    baseId,
    jobs.some((j) => ['QUEUED', 'RUNNING'].includes(j.status)),
    documents.some((d) => ['QUEUED', 'INDEXING'].includes(d.status)),
    loadDocuments,
  ]);
  useEffect(() => {
    const generation = ++previewGeneration.current;
    setPreview(null);
    setPreviewError(undefined);
    if (!sourceId) return;
    if (!/^[0-9a-f-]{36}$/i.test(sourceId) || !Number.isInteger(sourceVersion) || sourceVersion < 1) { setPreviewError('INVALID_DOCUMENT_VERSION');setPreviewLoading(false);return; }
    setPreviewLoading(true);
    void enterpriseControl<Preview>(`/ai/knowledge/documents/${sourceId}/versions/${sourceVersion}`)
      .then((value) => {
        if (generation === previewGeneration.current) setPreview(value);
      })
      .catch((e) => {
        if (generation === previewGeneration.current) setPreviewError(workspaceErrorCode(e));
      })
      .finally(() => {
        if (generation === previewGeneration.current) setPreviewLoading(false);
      });
    return () => {
      previewGeneration.current += 1;
    };
  }, [sourceId, sourceVersion, previewAttempt]);
  useEffect(() => {
    if (preview && params.has('chunk'))
      document.querySelector(`[data-knowledge-chunk="${sourceChunk}"]`)?.scrollIntoView({ block: 'center' });
  }, [preview, sourceChunk]);

  const createBase = () => {
    let name = '';
    Modal.confirm({
      title: t('workspace.knowledge.createBase'),
      content: (
        <Input
          autoFocus
          placeholder={t('workspace.knowledge.baseName')}
          onChange={(value) => {
            name = value.trim();
          }}
        />
      ),
      onOk: async () => {
        if (!name) throw new Error(t('workspace.knowledge.baseNameRequired'));
        const created = await enterpriseControl<WorkspaceResource>('/ai/resources', {
          method: 'POST',
          body: JSON.stringify({
            resourceType: 'KNOWLEDGE',
            name,
            description: '',
            enterprise: false,
            config: { format: 'TEXT_V1' },
            idempotencyKey: newIdempotencyKey(),
          }),
        });
        await enterpriseControl(`/ai/resources/${created.id}/activate`, {
          method: 'POST',
          body: JSON.stringify({ version: created.version }),
        });
        message.success(t('workspace.knowledge.baseCreated'));
        await loadBases();
      },
    });
  };

  const makeUpload =
    (document?: KnowledgeDocument): UploadRequest =>
    async ({ file, onSuccess, onError }) => {
      if (!baseId) return;
      try {
        if ((file as File).size > 10 * 1024 * 1024) throw new Error('FileSizeLimitExceeded');
        const params = new URLSearchParams({ idempotencyKey: newIdempotencyKey() });
        if (document) {
          params.set('documentId', document.id);
          params.set('expectedVersion', String(document.latest_version));
        }
        const form = new FormData();
        form.append('file', file as File);
        const result = await enterpriseControl<{ reused?: boolean }>(
          `/ai/knowledge/${baseId}/documents?${params.toString()}`,
          {
            method: 'POST',
            body: form,
          }
        );
        onSuccess?.({});
        message.success(
          result.reused
            ? t('workspace.knowledge.duplicateReused')
            : document
              ? t('workspace.knowledge.versionUploaded')
              : t('workspace.knowledge.uploaded')
        );
        await loadDocuments();
      } catch (error) {
        onError?.(error as Error);
        const code = workspaceErrorCode(error);
        message.error(issueMessage(code));
      }
    };

  const search = async () => {
    if (!baseId || !query.trim()) return;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setSearched(false);
    try {
      const value = await enterpriseControl<KnowledgeSearchResponse>(
        `/ai/knowledge/${baseId}/search?query=${encodeURIComponent(query.trim())}`
      );
      if (generation !== searchGeneration.current) return;
      setResults(Array.isArray(value.citations) ? value.citations : []);
      setSearched(true);
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  };

  const openPreview = (documentId: string, version: number, chunk?: number) => {
    setParams((current) => {
      current.set('documentId', documentId);
      current.set('version', String(version));
      if (chunk !== undefined) current.set('chunk', String(chunk));
      else current.delete('chunk');
      return current;
    });
  };

  const remove = (document: KnowledgeDocument) => {
    Modal.confirm({
      title: t('workspace.knowledge.deleteTitle'),
      content: t('workspace.knowledge.deleteConfirm', { name: document.title }),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          await enterpriseControl(`/ai/knowledge/documents/${document.id}`, { method: 'DELETE' });
          message.success(t('workspace.knowledge.deleted'));
          await loadDocuments();
        } catch (error) {
          const code = workspaceErrorCode(error);
          message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
          throw error;
        }
      },
    });
  };

  const reindex = async (document: KnowledgeDocument) => {
    try {
      await enterpriseControl(`/ai/knowledge/documents/${document.id}/reindex`, { method: 'POST' });
      message.success(t('workspace.knowledge.reindexQueued'));
      await loadDocuments();
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    }
  };

  return (
    <div className='flex flex-col gap-12px'>
      {messageContext}
      <div className='flex flex-wrap items-start justify-between gap-8px'>
        <div>
          <div className='text-20px font-semibold text-t-primary'>{t('workspace.knowledge.title')}</div>
          <div className='mt-3px text-13px text-t-secondary'>{t('workspace.knowledge.subtitle')}</div>
        </div>
        <Space wrap>
          <Select value={scope} onChange={setScope} style={{ width: 150 }}>
            <Select.Option value='available'>{t('workspace.scope.available')}</Select.Option>
            <Select.Option value='mine'>{t('workspace.scope.mine')}</Select.Option>
            <Select.Option value='shared'>{t('workspace.scope.shared')}</Select.Option>
          </Select>
          {selectedBase ? (
            <Tag color={catalogOrigin(selectedBase) === 'organization' ? 'arcoblue' : 'purple'}>
              {t(`workspace.abilities.origin.${catalogOrigin(selectedBase)}`)}
            </Tag>
          ) : null}
          <Select
            value={baseId || undefined}
            onChange={setBaseId}
            placeholder={t('workspace.knowledge.selectBase')}
            style={{ width: 220 }}
          >
            {bases.map((base) => (
              <Select.Option key={base.id} value={base.id}>
                {base.name}
              </Select.Option>
            ))}
          </Select>
          <Button onClick={createBase}>{t('workspace.knowledge.createBase')}</Button>
          {canEdit && baseId ? (
            <Upload
              accept='.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp'
              showUploadList={false}
              customRequest={makeUpload()}
            >
              <Button type='primary' icon={<UploadOne />}>
                {t('workspace.knowledge.upload')}
              </Button>
            </Upload>
          ) : null}
          <Button
            icon={<Refresh />}
            loading={documentsLoading}
            onClick={() => void (baseId ? loadDocuments() : loadBases())}
          >
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      {errorCode ? (
        <Alert
          type='error'
          showIcon
          content={t(workspaceErrorTranslationKey(errorCode, 'load'), { code: errorCode })}
        />
      ) : null}
      {selectedBase ? (
        <div className='text-13px text-t-secondary'>
          {t('workspace.knowledge.accessScope', {
            permissions: selectedBase.actions
              .filter((a) => ['VIEW', 'USE', 'EDIT'].includes(a))
              .map((a) => t(`workspace.knowledge.permissions.${a}`))
              .join(' · '),
          })}
        </div>
      ) : null}
      <Card>
        <Input.Search
          value={query}
          onChange={setQuery}
          onSearch={() => void search()}
          searchButton={<Search />}
          loading={searching}
          disabled={!baseId}
          placeholder={t('workspace.knowledge.searchPlaceholder')}
        />
        {results.length > 0 ? (
          <List
            className='mt-10px'
            dataSource={results}
            render={(row) => (
              <List.Item
                key={`${row.documentId}:${row.version}:${row.chunkIndex}`}
                actions={[
                  <Button
                    key='preview'
                    type='text'
                    onClick={() => void openPreview(row.documentId, row.version, row.chunkIndex)}
                  >
                    {t('workspace.knowledge.viewSource')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={`${row.reference} · ${row.title} · v${row.version} · ${row.locationLabel || t('workspace.knowledge.lines', { start: row.lineStart ?? '-', end: row.lineEnd ?? '-' })}`}
                  description={row.content}
                />
              </List.Item>
            )}
          />
        ) : null}
        {searched && !results.length ? <Empty description={t('workspace.knowledge.noMatches')} /> : null}
      </Card>
      <Spin loading={loading || documentsLoading} className='w-full'>
        {!baseId || (documents.length === 0 && !loading) ? (
          <Empty
            description={
              scope === 'available' ? t('workspace.knowledge.availableEmpty') : t('workspace.knowledge.empty')
            }
          />
        ) : (
          <List
            dataSource={documents}
            render={(document) => (
              <List.Item
                key={document.id}
                actions={[
                  <Button key='preview' type='text' onClick={() => void openPreview(document.id, document.version)}>
                    {t('workspace.knowledge.preview')}
                  </Button>,
                  ...(canEdit
                    ? [
                        <Upload key='version' showUploadList={false} customRequest={makeUpload(document)}>
                          <Button type='text'>{t('workspace.knowledge.newVersion')}</Button>
                        </Upload>,
                        <Button key='reindex' type='text' onClick={() => void reindex(document)}>
                          {t('workspace.knowledge.reindex')}
                        </Button>,
                        <Button
                          key='delete'
                          type='text'
                          status='danger'
                          icon={<Delete />}
                          onClick={() => remove(document)}
                        >
                          {t('common.delete')}
                        </Button>,
                      ]
                    : []),
                ]}
              >
                <List.Item.Meta
                  title={
                    <div className='flex items-center gap-8px'>
                      <span>{document.title}</span>
                      <Tag
                        color={document.status === 'READY' ? 'green' : document.status === 'ERROR' ? 'red' : 'orange'}
                      >
                        {t(`workspace.knowledge.status.${document.status}`, {
                          defaultValue: document.status,
                        })}
                      </Tag>
                    </div>
                  }
                  description={
                    <span>
                      {t('workspace.knowledge.versionStatus', {
                        latest: document.latest_version,
                        indexed: document.indexed_version ?? '-',
                      })}
                      {(() => {
                        const job = jobs.find(
                          (item) => item.document_id === document.id && item.version === document.version
                        );
                        const error = job?.errorCode || job?.error_code;
                        return error ? ` · ${issueMessage(error)}` : '';
                      })()}
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Spin>
      {baseId ? (
        <Pagination
          simple
          current={documentPage}
          pageSize={30}
          total={documentPage * 30 + (documents.length === 30 ? 1 : 0)}
          onChange={setDocumentPage}
        />
      ) : null}
      <Drawer
        width={640}
        visible={Boolean(sourceId)}
        title={preview?.filename || t('workspace.knowledge.preview')}
        footer={null}
        onCancel={() =>
          setParams((current) => {
            current.delete('documentId');
            current.delete('version');
            current.delete('chunk');
            return current;
          })
        }
      >
        {previewLoading ? <Spin /> : null}
        {previewError ? (
          <Alert
            type='error'
            content={t('workspace.knowledge.sourceUnavailable', {
              version: sourceVersion,
              code: previewError,
            })}
          />
        ) : null}
        {preview ? (
          <div className='flex flex-col gap-12px'>
            <Descriptions
              column={1}
              border
              data={[
                { label: t('workspace.knowledge.version'), value: `v${preview.version}` },
                { label: t('workspace.knowledge.title'), value: t(`workspace.knowledge.status.${preview.status}`, { defaultValue: preview.status }) },
                { label: 'SHA-256', value: preview.sha256 },
              ]}
            />
            {preview.version !== preview.indexedVersion ? (
              <Alert
                type='warning'
                content={t('workspace.knowledge.historicalSource', {
                  version: preview.version,
                  indexed: preview.indexedVersion ?? '-',
                })}
              />
            ) : null}
            <Button href={`/enterprise/control/ai/files/${preview.fileId}/download`}>{t('common.download')}</Button>
            {preview.chunks?.length ? (
              preview.chunks.map((chunk) => (
                <div
                  key={chunk.chunk_index}
                  data-knowledge-chunk={chunk.chunk_index}
                  className={sourceChunk === chunk.chunk_index && params.has('chunk') ? 'p-12px bg-fill-2' : 'p-12px'}
                >
                  <div className='font-semibold'>
                    {chunk.location_label} ·{' '}
                    {t('workspace.knowledge.lines', {
                      start: chunk.line_start,
                      end: chunk.line_end,
                    })}
                  </div>
                  <pre className='m-0 whitespace-pre-wrap break-words text-13px leading-22px text-t-primary'>
                    {chunk.content}
                  </pre>
                </div>
              ))
            ) : (
              <pre className='whitespace-pre-wrap break-words'>{preview.content}</pre>
            )}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
};

export default WorkspaceKnowledge;
