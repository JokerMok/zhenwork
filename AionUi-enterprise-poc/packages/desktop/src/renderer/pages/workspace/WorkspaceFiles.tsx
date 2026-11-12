import DataAnalysisControl from './TaskWork/DataAnalysis';
import OfficePreview from '@/renderer/components/media/OfficePreview';
import { formatFileSize } from '@/renderer/services/FileService';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  List,
  Message,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Upload,
} from '@arco-design/web-react';
import type { UploadRequest } from '@arco-design/web-react/es/Upload/interface';
import { Download, PreviewOpen, Refresh, Undo, UploadOne } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { enterpriseRequest, uploadWorkspaceFiles, workspaceErrorCode } from './workspaceApi';
import type { EnterpriseFile, EnterpriseFileVersion } from './workspaceTypes';

type EnterpriseFileDiff =
  | { kind: 'text'; previous: string; current: string; truncated: boolean }
  | {
      kind: 'binary';
      currentSha256: string;
      previousSha256: string;
      currentBytes: number;
      previousBytes: number;
    };

type FilePreviewKind = 'pdf' | 'image' | 'text' | 'office' | 'unsupported';

type FilePreview = {
  file: EnterpriseFile;
  kind: FilePreviewKind;
  loading: boolean;
  objectUrl?: string;
  text?: string;
  errorCode?: string;
  version?: EnterpriseFileVersion;
  retry?: number;
};

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'log',
  'xml',
  'ini',
  'conf',
  'sql',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'rs',
  'sh',
]);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 50 * 1024 * 1024;

export const workspaceFilePreviewKind = (fileName: string): FilePreviewKind => {
  const extension = fileName.toLowerCase().split('.').pop() || '';
  if (extension === 'pdf') return 'pdf';
  if (extension in IMAGE_MIME) return 'image';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  return 'unsupported';
};

const downloadWorkspaceFile = (file: EnterpriseFile, version?: EnterpriseFileVersion) => {
  const query = new URLSearchParams({ path: file.path });
  if (version) query.set('version', version.id);
  window.open(`/enterprise/files/download?${query.toString()}`, '_blank', 'noopener,noreferrer');
};

const WorkspaceFiles: React.FC<{ active?: boolean; previewOnly?: boolean }> = ({
  active = true,
  previewOnly = false,
}) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [message, messageContext] = Message.useMessage();
  const [files, setFiles] = useState<EnterpriseFile[]>([]);
  const [kind, setKind] = useState('all');
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [versionFile, setVersionFile] = useState<EnterpriseFile | null>(null);
  const [diff, setDiff] = useState<EnterpriseFileDiff | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [dataPath, setDataPath] = useState<string>();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const params = new URLSearchParams(location.search);
  const requestedPath = active
    ? params.get('previewPath') || (location.state as { previewPath?: string } | null)?.previewPath
    : undefined;
  const requestedVersion = params.get('fileVersion');
  const requestedFile = files.find((item) => item.path === requestedPath);
  const fileVersion = requestedVersion ? requestedFile?.versions?.find((version) => version.id === requestedVersion) : undefined;
  const matchesPreview = preview?.file.path === requestedPath && (preview?.version?.id ?? null) === requestedVersion;
  const previewLookupError = !loading && (
    errorCode || (!requestedFile ? 'FILE_NOT_FOUND' : requestedVersion && !fileVersion ? 'VERSION_NOT_FOUND' : null)
  );

  const fileListRequest = useRef<AbortController | null>(null);
  const loadFiles = useCallback(async () => {
    fileListRequest.current?.abort();
    const controller = new AbortController();
    fileListRequest.current = controller;
    setLoading(true);
    setErrorCode(null);
    try {
      const result = await enterpriseRequest<{ files: EnterpriseFile[]; workspaceRoot?: string; warnings?: string[] }>(
        '/enterprise/files',
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      const currentFiles = Array.isArray(result.files) ? result.files : [];
      setFiles(currentFiles);
      setVersionFile((current) => (current ? currentFiles.find((file) => file.path === current.path) || null : null));
      setWarnings(Array.isArray(result.warnings) ? result.warnings : []);
      setWorkspaceRoot(typeof result.workspaceRoot === 'string' ? result.workspaceRoot : '');
      setErrorCode(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setFiles([]);
      setWarnings([]);
      setWorkspaceRoot('');
      setErrorCode(workspaceErrorCode(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
    return () => fileListRequest.current?.abort();
  }, [loadFiles]);

  const visibleFiles = useMemo(
    () =>
      files.filter((file) => {
        const normalizedKind = file.kind.toLowerCase() === 'result' ? 'generated' : file.kind.toLowerCase();
        return kind === 'all' || normalizedKind === kind;
      }),
    [files, kind]
  );
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  );
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatter.format(date);
  };

  const restore = (file: EnterpriseFile, version: EnterpriseFileVersion) => {
    Modal.confirm({
      title: t('workspace.files.restoreTitle'),
      content: t('workspace.files.restoreConfirm', { name: file.name, time: formatDate(version.createdAt) }),
      onOk: async () => {
        try {
          await enterpriseRequest('/enterprise/files/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: file.path, version: version.id }),
          });
          message.success(t('workspace.files.restored'));
          await loadFiles();
        } catch (error) {
          message.error(t('workspace.errors.action', { code: workspaceErrorCode(error) }));
          throw error;
        }
      },
    });
  };

  const compare = async (file: EnterpriseFile, version: EnterpriseFileVersion) => {
    try {
      const query = new URLSearchParams({ path: file.path, version: version.id });
      setDiff(await enterpriseRequest<EnterpriseFileDiff>(`/enterprise/files/diff?${query.toString()}`));
    } catch (error) {
      message.error(t('workspace.errors.action', { code: workspaceErrorCode(error) }));
    }
  };

  const continueWithFile = (file: EnterpriseFile) => {
    if (!workspaceRoot) {
      message.error(t('workspace.errors.action', { code: 'WORKSPACE_UNAVAILABLE' }));
      return;
    }
    navigate('/guid', {
      state: {
        workspace: workspaceRoot,
        prefillPrompt: t('workspace.files.continuePrompt', { path: file.path }),
        focusPrefill: true,
      },
    });
  };

  const openPreview = (file: EnterpriseFile, version?: EnterpriseFileVersion) => {
    const next = new URLSearchParams(location.search);
    next.set('previewPath', file.path);
    const versionId = version?.id || file.currentVersionId;
    if (versionId) next.set('fileVersion', versionId);
    else next.delete('fileVersion');
    navigate({ pathname: location.pathname, search: next.toString() });
  };
  const closePreview = () => {
    const next = new URLSearchParams(location.search);
    next.delete('previewPath');
    next.delete('fileVersion');
    navigate({ pathname: location.pathname, search: next.toString() }, { replace: true, state: null });
  };

  useEffect(() => {
    if (!requestedFile || (requestedVersion && !fileVersion)) {
      setPreview(null);
      return;
    }
    const previewKind = workspaceFilePreviewKind(requestedFile.name || requestedFile.path);
    setPreview({
      file: requestedFile,
      version: fileVersion,
      kind: previewKind,
      loading: ['pdf', 'image', 'text'].includes(previewKind),
    });
  }, [requestedFile, requestedVersion, fileVersion]);

  useEffect(() => {
    const file = preview?.file;
    const previewKind = preview?.kind;
    if (!file || (previewKind !== 'pdf' && previewKind !== 'image' && previewKind !== 'text')) return;
    const limit = previewKind === 'text' ? MAX_TEXT_PREVIEW_BYTES : MAX_BINARY_PREVIEW_BYTES;
    if ((preview.version?.byteSize ?? file.byteSize) > limit) {
      setPreview((current) =>
        current?.file.path === file.path ? { ...current, loading: false, errorCode: 'PREVIEW_TOO_LARGE' } : current
      );
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | undefined;
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 30000);
    const query = new URLSearchParams({ path: file.path });
    if (preview.version) query.set('version', preview.version.id);
    void fetch(`/enterprise/files/download?${query.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const bytes = await response.arrayBuffer();
        if (disposed) return;
        if (bytes.byteLength > limit) throw new Error('PREVIEW_TOO_LARGE');
        if (previewKind === 'text') {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          setPreview((current) => (current?.file.path === file.path ? { ...current, loading: false, text } : current));
          return;
        }
        const extension = file.name.toLowerCase().split('.').pop() || '';
        const mime = previewKind === 'pdf' ? 'application/pdf' : IMAGE_MIME[extension];
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setPreview((current) =>
          current?.file.path === file.path ? { ...current, loading: false, objectUrl } : current
        );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setPreview((current) =>
          current?.file.path === file.path
            ? {
                ...current,
                loading: false,
                errorCode: controller.signal.aborted ? 'PREVIEW_TIMEOUT' : workspaceErrorCode(error),
              }
            : current
        );
      });

    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview?.file, preview?.kind, preview?.version, preview?.retry]);

  const upload: UploadRequest = async ({ file, onSuccess, onError }) => {
    try {
      const result = await uploadWorkspaceFiles([file as File]);
      if (result.failed.length > 0 || result.uploaded.length !== 1) {
        const first = result.failed[0];
        throw new Error(first?.error || 'UPLOAD_FAILED');
      }
      onSuccess?.({});
      message.success(t('workspace.files.uploaded'));
      await loadFiles();
      if(/\.(xlsx|csv)$/i.test(result.uploaded[0]))setDataPath(result.uploaded[0]);
    } catch (error) {
      onError?.(error as Error);
      message.error(t('workspace.errors.action', { code: workspaceErrorCode(error) }));
    }
  };

  const visiblePreview = matchesPreview ? preview : null;
  const previewDrawer = (
      <Drawer
        width='min(900px, 100vw)'
        visible={Boolean(requestedPath)}
        focusLock
        autoFocus
        role='dialog'
        aria-modal='true'
        aria-label={visiblePreview?.file.name || t('workspace.files.preview')}
        title={visiblePreview
          ? visiblePreview.file.name + (visiblePreview.version ? ' · ' + formatDate(visiblePreview.version.createdAt) : '')
          : t('workspace.files.preview')}
        footer={
          <Space wrap>
            <Button onClick={closePreview}>{t('common.close')}</Button>
            {visiblePreview && (
              <Button icon={<Download />} onClick={() => downloadWorkspaceFile(visiblePreview.file, visiblePreview.version)}>
                {t('workspace.files.download')}
              </Button>
            )}
          </Space>
        }
        onCancel={closePreview}
      >
        {previewLookupError ? (
          <Alert type='error' showIcon content={t('workspace.errors.action', { code: previewLookupError })} />
        ) : !visiblePreview ? (
          <div className='flex min-h-240px items-center justify-center'>
            <Spin loading />
          </div>
        ) : visiblePreview.kind === 'office' && /\.(xlsx|docx|pptx)$/i.test(visiblePreview.file.name) ? (
          <OfficePreview
            path={visiblePreview.file.path}
            version={visiblePreview.version?.id}
            revision={visiblePreview.version?.sha256 || visiblePreview.file.modifiedAt}
            onContinue={previewOnly || (visiblePreview.version && visiblePreview.version.id !== visiblePreview.file.currentVersionId)
              ? undefined : () => continueWithFile(visiblePreview.file)}
          />
        ) : visiblePreview.loading ? (
          <div className='flex min-h-240px items-center justify-center'>
            <Spin loading />
          </div>
        ) : visiblePreview.errorCode ? (
          <Space direction='vertical'>
            <Alert type='error' showIcon content={t('workspace.errors.action', { code: visiblePreview.errorCode })} />
            <Button
              onClick={() =>
                setPreview((current) =>
                  current
                    ? { ...current, loading: true, errorCode: undefined, retry: (current.retry || 0) + 1 }
                    : current
                )
              }
            >
              {t('workspace.preview.retry')}
            </Button>
          </Space>
        ) : visiblePreview.kind === 'text' ? (
          <pre className='m-0 max-h-[72vh] overflow-auto whitespace-pre-wrap break-words bg-fill-1 p-12px text-12px'>
            {visiblePreview.text || t('workspace.preview.empty')}
          </pre>
        ) : visiblePreview.kind === 'image' && visiblePreview.objectUrl ? (
          <div className='flex max-h-[72vh] justify-center overflow-auto bg-fill-1 p-12px'>
            <img src={visiblePreview.objectUrl} alt={visiblePreview.file.name} className='max-w-full object-contain' />
          </div>
        ) : visiblePreview.kind === 'pdf' && visiblePreview.objectUrl ? (
          <iframe title={visiblePreview.file.name} src={visiblePreview.objectUrl} className='h-[72vh] w-full border-0' />
        ) : (
          <div className='min-w-0 flex flex-col gap-12px'>
            <Alert
              type={visiblePreview.kind === 'office' ? 'info' : 'warning'}
              showIcon
              content={
                visiblePreview.kind === 'office'
                  ? t('workspace.files.officePreviewHint')
                  : t('workspace.files.unsupportedPreviewHint')
              }
            />
            <Space wrap>
              {visiblePreview.kind === 'office' && !previewOnly ? (
                <Button type='primary' onClick={() => continueWithFile(visiblePreview.file)}>
                  {t('workspace.files.openInTask')}
                </Button>
              ) : null}
              <Button icon={<Download />} onClick={() => downloadWorkspaceFile(visiblePreview.file, visiblePreview.version)}>
                {t('workspace.files.download')}
              </Button>
            </Space>
          </div>
        )}
      </Drawer>
  );
  if (previewOnly) return previewDrawer;

  return (
    <div className='min-w-0 flex flex-col gap-12px'>
      {dataPath && <DataAnalysisControl key={dataPath} filePath={dataPath} autoOpen />}
      {messageContext}
      <div className='flex flex-wrap items-center justify-between gap-8px'>
        <div>
          <div className='text-20px font-semibold text-t-primary'>{t('workspace.files.title')}</div>
          <div className='mt-3px text-13px text-t-secondary'>{t('workspace.files.subtitle')}</div>
        </div>
        <Space wrap className='max-w-full'>
          <Select aria-label={t('workspace.files.title')} value={kind} onChange={setKind} style={{ width: 145 }}>
            {['all', 'task', 'personal', 'shared', 'generated'].map((value) => (
              <Select.Option key={value} value={value}>
                {t(`workspace.fileKind.${value}`)}
              </Select.Option>
            ))}
          </Select>
          <Upload multiple showUploadList={false} customRequest={upload}>
            <Button type='primary' icon={<UploadOne />}>
              {t('workspace.files.upload')}
            </Button>
          </Upload>
          <Button icon={<Refresh />} onClick={() => void loadFiles()} loading={loading}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      {errorCode && (
        <Alert
          type='error'
          showIcon
          content={t('workspace.errors.load', { code: errorCode })}
          action={<Button size='small' onClick={() => void loadFiles()}>{t('common.retry')}</Button>}
        />
      )}
      {warnings.length > 0 ? (
        <Alert type='warning' showIcon content={t('workspace.files.warnings', { count: warnings.length })} />
      ) : null}
      <Spin loading={loading} className='w-full'>
        {visibleFiles.length === 0 ? (
          !loading && !errorCode && (
            <Empty description={kind === 'all' ? t('workspace.files.empty') : (
              <Button type='text' onClick={() => setKind('all')}>{t('workspace.fileKind.all')}</Button>
            )} />
          )
        ) : (
          <List
            dataSource={visibleFiles}
            render={(file) => (
              <List.Item
                key={file.path}
                className='!flex-wrap gap-y-8px [&_.arco-list-item-main]:min-w-0 [&_.arco-list-item-main]:flex-1 [&_.arco-list-item-action]:flex-wrap [&_.arco-list-item-action]:!ml-0'
                actions={[
                  /\.(xlsx|csv)$/i.test(file.path) ? <DataAnalysisControl key='data-analysis' filePath={file.path} /> : null,
                  <Button key='preview' type='text' icon={<PreviewOpen />} onClick={() => openPreview(file)}>
                    {t('workspace.files.preview')}
                  </Button>,
                  <Button key='download' type='text' icon={<Download />} onClick={() => downloadWorkspaceFile(file)}>
                    {t('workspace.files.download')}
                  </Button>,
                  <Button key='continue' type='text' onClick={() => continueWithFile(file)}>
                    {t('workspace.files.continue')}
                  </Button>,
                  <Button
                    key='versions'
                    type='text'
                    disabled={!file.versions?.length}
                    onClick={() => setVersionFile(file)}
                  >
                    {t('workspace.files.versions', { count: file.versions?.length || 0 })}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <div className='min-w-0 flex flex-wrap items-center gap-8px'>
                      <span className='min-w-0 break-all' title={file.name}>{file.name}</span>
                      <Tag>
                        {t(
                          `workspace.fileKind.${file.kind.toLowerCase() === 'result' ? 'generated' : file.kind.toLowerCase()}`,
                          { defaultValue: file.kind }
                        )}
                      </Tag>
                    </div>
                  }
                  description={`${formatFileSize(file.byteSize)} · ${formatDate(file.modifiedAt)}`}
                />
              </List.Item>
            )}
          />
        )}
      </Spin>
      <Drawer
        width={520}
        visible={Boolean(versionFile)}
        title={t('workspace.files.versionTitle', { name: versionFile?.name || '' })}
        footer={null}
        onCancel={() => setVersionFile(null)}
      >
        {versionFile ? (
          <List
            dataSource={versionFile.versions || []}
            render={(version) => (
              <List.Item
                key={version.id}
                actions={[
                  <Button key='preview' type='text' onClick={() => openPreview(versionFile, version)}>
                    {t('workspace.files.preview')}
                  </Button>,
                  <Button
                    key='download'
                    type='text'
                    icon={<Download />}
                    onClick={() => downloadWorkspaceFile(versionFile, version)}
                  >
                    {t('workspace.files.download')}
                  </Button>,
                  <Button key='compare' type='text' onClick={() => void compare(versionFile, version)}>
                    {t('workspace.files.compare')}
                  </Button>,
                  <Button key='restore' type='text' icon={<Undo />} onClick={() => restore(versionFile, version)}>
                    {t('workspace.files.restore')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <span>{formatDate(version.createdAt)}</span>
                      {version.id === versionFile.currentVersionId && (
                        <Tag color='green'>{t('workspace.files.currentVersion')}</Tag>
                      )}
                    </Space>
                  }
                  description={`${formatFileSize(version.byteSize)} · ${version.sha256.slice(0, 12)}`}
                />
              </List.Item>
            )}
          />
        ) : null}
      </Drawer>
      {previewDrawer}
      <Drawer
        width={720}
        visible={Boolean(diff)}
        title={t('workspace.files.compareTitle')}
        footer={null}
        onCancel={() => setDiff(null)}
      >
        {diff?.kind === 'text' ? (
          <div className='grid grid-cols-1 gap-12px md:grid-cols-2'>
            <div>
              <div className='mb-6px font-medium text-t-primary'>{t('workspace.files.previous')}</div>
              <pre className='m-0 max-h-600px overflow-auto whitespace-pre-wrap break-words bg-fill-1 p-10px text-12px'>
                {diff.previous}
              </pre>
            </div>
            <div>
              <div className='mb-6px font-medium text-t-primary'>{t('workspace.files.current')}</div>
              <pre className='m-0 max-h-600px overflow-auto whitespace-pre-wrap break-words bg-fill-1 p-10px text-12px'>
                {diff.current}
              </pre>
            </div>
            {diff.truncated ? (
              <Alert className='md:col-span-2' type='warning' content={t('workspace.files.diffTruncated')} />
            ) : null}
          </div>
        ) : diff?.kind === 'binary' ? (
          <Descriptions
            column={1}
            border
            data={[
              {
                label: t('workspace.files.previous'),
                value: `${formatFileSize(diff.previousBytes)} · ${diff.previousSha256}`,
              },
              {
                label: t('workspace.files.current'),
                value: `${formatFileSize(diff.currentBytes)} · ${diff.currentSha256}`,
              },
            ]}
          />
        ) : null}
      </Drawer>
    </div>
  );
};

export default WorkspaceFiles;
