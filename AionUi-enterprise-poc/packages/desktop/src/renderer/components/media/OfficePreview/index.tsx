import { safeOfficeHyperlink } from './types';
import { Alert, Button, Empty, Select, Space, Spin, Table, Tag } from '@arco-design/web-react';
import { Download, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewErrorKey, type OfficePreviewData } from './types';
import styles from './OfficePreview.module.css';

export type OfficePreviewProps = { path: string; version?: string; revision?: string; onContinue?: () => void };
const table = (rows: unknown[][], key: string) => (
  <Table
    key={key}
    size='small'
    pagination={false}
    scroll={{ x: true }}
    columns={Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, i) => ({
      title: String(i + 1),
      dataIndex: String(i),
      render: (_value: unknown, row: Record<string, unknown>) => String(row[String(i)] ?? ''),
    }))}
    data={rows.map((row, index) => ({
      key: index,
      ...Object.fromEntries(row.map((value, i) => [String(i), value])),
    }))}
  />
);
const OfficePreview: React.FC<OfficePreviewProps> = ({ path, version, revision, onContinue }) => {
  const { t } = useTranslation();
  const [data, setData] = useState<OfficePreviewData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState('');
  const [start, setStart] = useState(0);
  const [retry, setRetry] = useState(0);
  const current = useRef<OfficePreviewData | undefined>(undefined);
  const identity = `${path}\0${version || ''}\0${revision || ''}`;
  useEffect(() => {
    setSheet('');
    setStart(0);
    current.current = undefined;
    setData(undefined);
  }, [identity]);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const controller = new AbortController();
    current.current = undefined;
    setData(undefined);
    const load = async (background = false) => {
      if (inFlight) return;
      inFlight = true;
      if (!background) {
        setLoading(true);
        setError(undefined);
      }
      const query = new URLSearchParams({ path, start: String(start) });
      if (version) query.set('version', version);
      if (sheet) query.set('sheet', sheet);
      if (background && current.current) query.set('knownSha', current.current.sourceSha256);
      const timeout = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await fetch(`/enterprise/files/preview?${query}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        const value = await response.json();
        if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP_${response.status}`);
        if (!stopped && !value.unchanged) {
          current.current = value;
          setData(value);
          setError(undefined);
        }
      } catch (issue) {
        if (!stopped) {
          setData(undefined);
          current.current = undefined;
          setError(
            issue instanceof Error && issue.name === 'AbortError'
              ? 'PREVIEW_TIMEOUT'
              : issue instanceof Error
                ? issue.message
                : 'PREVIEW_FAILED'
          );
        }
      } finally {
        inFlight = false;
        clearTimeout(timeout);
        if (!stopped) setLoading(false);
      }
    };
    void load();
    // Read current bytes, not a shared conversion cache. A changed file is
    // converted again; revoked identity clears the existing displayed content.
    const timer = setInterval(() => {
      if (!document.hidden) void load(true);
    }, 15000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [identity, path, version, sheet, start, retry]);
  const download = useCallback(() => {
    const query = new URLSearchParams({ path });
    if (version) query.set('version', version);
    window.open(`/enterprise/files/download?${query}`, '_blank', 'noopener,noreferrer');
  }, [path, version]);

  return (
    <div className='flex flex-col gap-12px' data-testid='office-preview'>
      <Space wrap>
        <Button icon={<Refresh />} onClick={() => setRetry((n) => n + 1)} loading={loading}>
          {t('common.refresh')}
        </Button>
        <Button icon={<Download />} onClick={download}>
          {t('workspace.files.download')}
        </Button>
        {onContinue ? <Button onClick={onContinue}>{t('workspace.files.continue')}</Button> : null}
        {data ? <Tag>{data.sourceSha256.slice(0, 12)}</Tag> : null}
      </Space>
      <Alert type='info' content={t('workspace.preview.basicHint')} />
      {loading ? (
        <Spin loading className='min-h-120px' />
      ) : error ? (
        <Alert
          type='error'
          content={
            <Space direction='vertical'>
              <span>{t(previewErrorKey(error), { code: error })}</span>
              <Button onClick={() => setRetry((n) => n + 1)}>{t('workspace.preview.retry')}</Button>
            </Space>
          }
        />
      ) : data?.format === 'xlsx' ? (
        <>
          <Select
            aria-label={t('workspace.preview.worksheet')}
            value={data.sheet}
            onChange={(name) => {
              setSheet(name);
              setStart(0);
            }}
            options={data.sheets || []}
          />
          <div className='overflow-auto max-h-[65vh]'>
            <table className={styles.grid}>
              <colgroup>
                <col style={{ width: 45 }} />
                {data.widths?.map((width, i) => (
                  <col key={i} style={{ width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th />
                  {data.widths?.map((_, i) => (
                    <th key={i}>
                      {String.fromCharCode(65 + Math.floor(i / 26) - 1).replace('@', '')}
                      {String.fromCharCode(65 + (i % 26))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows?.map((row) => (
                  <tr key={row.number}>
                    <th>{row.number}</th>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.reference}
                        colSpan={cell.colSpan}
                        rowSpan={cell.rowSpan}
                        style={cell.style}
                        title={[cell.reference, cell.formula, cell.error].filter(Boolean).join(' · ')}
                      >
                        {safeOfficeHyperlink(cell.href) ? <a href={safeOfficeHyperlink(cell.href)} target='_blank' rel='noopener noreferrer'>{cell.text}</a> : cell.text}
                        {cell.error ? <span className='text-warning ml-4px'>⚠</span> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.rows?.length ? <Empty description={t('workspace.preview.empty')} /> : null}
          {data.unsupportedFormulas || data.truncatedColumns || data.textTruncated ? (
            <Alert
              type='warning'
              content={t('workspace.preview.limitedHint', { count: data.unsupportedFormulas || 0 })}
            />
          ) : null}
        </>
      ) : data ? (
        <div className='overflow-auto max-h-[65vh] flex flex-col gap-12px'>
          {!data.locations?.length ? <Empty description={t('workspace.preview.empty')} /> : null}
          {data.locations?.map((location, i) => (
            <section key={i} className='p-16px bg-fill-1 rd-8px'>
              <Tag>
                {t(`workspace.preview.location.${location.location.kind}`, {
                  count: location.location.slide || location.location.table || location.location.paragraph || i + 1,
                  defaultValue: String(i + 1),
                })}
              </Tag>
              {location.text ? <p className='whitespace-pre-wrap break-words'>{location.text}</p> : null}
              {location.links?.map((link, index) => safeOfficeHyperlink(link.url) ? <a key={index} href={safeOfficeHyperlink(link.url)} target='_blank' rel='noopener noreferrer'>{link.text || link.url}</a> : null)}
              {location.texts?.map((text, j) => (
                <p key={j} className='whitespace-pre-wrap break-words'>
                  {text.text}
                </p>
              ))}
              {location.rows ? table(location.rows, 'table') : null}
              {location.tables?.map((item, j) => table(item.rows, String(j)))}
            </section>
          ))}
        </div>
      ) : null}
      {data ? (
        <Space>
          <Button disabled={!start} onClick={() => setStart(Math.max(0, start - (data.format === 'xlsx' ? 100 : 5)))}>
            {t('workspace.preview.previous')}
          </Button>
          <span>
            {t('workspace.preview.page', { start: start + 1, total: data.rowCount ?? data.totalLocations ?? 0 })}
          </span>
          <Button disabled={data.nextStart == null} onClick={() => setStart(data.nextStart!)}>
            {t('workspace.preview.next')}
          </Button>
        </Space>
      ) : null}
    </div>
  );
};
export default OfficePreview;
