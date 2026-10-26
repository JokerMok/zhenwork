import { Alert, Button, Empty, Space, Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import OfficePreview from './index';
import { previewErrorKey } from './types';

const images: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};
const text = new Set([
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'log',
  'xml',
  'html',
  'htm',
  'py',
  'js',
  'ts',
  'css',
  'ini',
  'sql',
]);
const BinaryFilePreview: React.FC<{ path: string; extension: string; version?: string }> = ({ path, extension, version }) => {
  const { t } = useTranslation();
  const [data, setData] = useState<{ url?: string; text?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  const supported = extension === 'pdf' || extension in images || text.has(extension);
  const url = '/enterprise/files/download?' + new URLSearchParams({ path, ...(version ? { version } : {}) });
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    let disposed = false;
    let objectUrl: string | undefined;
    const timer = setTimeout(() => controller.abort(), 30000);
    setData(undefined);
    void fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const limit = text.has(extension) ? 5 * 1024 * 1024 : 50 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) throw new Error('PREVIEW_TOO_LARGE');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > limit) throw new Error('PREVIEW_TOO_LARGE');
        if (disposed) return;
        if (!bytes.byteLength) {
          setData({ text: '' });
          return;
        }
        if (text.has(extension)) {
          setData({ text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: extension === 'pdf' ? 'application/pdf' : images[extension] })
        );
        setData({ url: objectUrl });
      })
      .catch((issue) => {
        if (!disposed)
          setData({
            error:
              issue instanceof Error
                ? issue.name === 'AbortError'
                  ? 'PREVIEW_TIMEOUT'
                  : issue.message
                : 'PREVIEW_FAILED',
          });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, extension, supported, retry]);
  return (
    <div className='flex flex-col gap-12px'>
      <Space>
        <Button onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
          {t('workspace.files.download')}
        </Button>
        <Button onClick={() => setRetry((n) => n + 1)}>{t('workspace.preview.retry')}</Button>
      </Space>
      {!supported ? (
        <Alert type='warning' content={t('workspace.files.unsupportedPreviewHint')} />
      ) : !data ? (
        <Spin loading />
      ) : data.error ? (
        <Alert type='error' content={t(previewErrorKey(data.error), { code: data.error })} />
      ) : data.text !== undefined ? (
        data.text ? (
          <pre className='max-h-[65vh] overflow-auto whitespace-pre-wrap break-words'>{data.text}</pre>
        ) : (
          <Empty description={t('workspace.preview.empty')} />
        )
      ) : extension === 'pdf' ? (
        <iframe title={path.split('/').pop()} src={data.url} className='h-[65vh] w-full border-0' />
      ) : (
        <img src={data.url} alt={path.split('/').pop()} className='max-h-[65vh] max-w-full object-contain' />
      )}
    </div>
  );
};
/** Uses actor-private Host bytes for attachments too; never opens a server path or public viewer. */
const EnterpriseFilePreview: React.FC<{ path: string; version?: string }> = ({ path, version }) => {
  const extension = path.toLowerCase().split('.').pop() || '';
  return ['xlsx', 'docx', 'pptx'].includes(extension) ? (
    <OfficePreview path={path} version={version} />
  ) : (
    <BinaryFilePreview path={path} extension={extension} version={version} />
  );
};
export default EnterpriseFilePreview;
