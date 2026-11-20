import styles from '../WorkspaceExperience.module.css';
import { FileText } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type ArtifactCardProps = {
  path: string;
  name?: string;
  status?: React.ReactNode;
  metadata?: React.ReactNode;
  version?: number;
  versionId?: string;
  sha256?: string;
  details?: React.ReactNode;
  children: React.ReactNode;
};

/** A file's presentation only. Callers own its receipt, permissions and version-bound actions. */
export default function ArtifactCard({
  path,
  name,
  status,
  metadata,
  version,
  versionId,
  sha256,
  details,
  children,
}: ArtifactCardProps) {
  const { t } = useTranslation();
  const title = name || path.split('/').pop() || path;
  const extension = title.match(/\.([a-z0-9]{1,12})$/i)?.[1].toUpperCase();
  return (
    <article className={styles.surface + ' min-w-0 p-14px'}>
      <div className='flex items-start gap-12px'>
        <span
          aria-hidden='true'
          className='size-38px shrink-0 inline-flex items-center justify-center rd-8px bg-fill-2 text-t-secondary'
        >
          <FileText size={21} />
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center justify-between gap-8px'>
            <strong className='min-w-0 break-words text-15px text-t-primary'>{title}</strong>
            {status}
          </div>
          <div className='mt-3px flex flex-wrap items-center gap-x-8px gap-y-2px text-13px text-t-secondary'>
            <span>{extension || t('common.file')}</span>
            {metadata}
          </div>
        </div>
      </div>
      <div className='mt-10px flex flex-wrap items-center gap-8px'>{children}</div>
      <details className='mt-8px text-13px text-t-secondary'>
        <summary className='w-fit cursor-pointer'>{t('common.technical_details')}</summary>
        <div className='mt-6px grid gap-4px break-all'>
          {path !== title && <span>{path}</span>}
          {version !== undefined && (
            <span>
              {t('common.version')} · <span>v{version}</span>
            </span>
          )}
          {versionId && <code>{versionId}</code>}
          {sha256 && <code>SHA-256 · {sha256}</code>}
          {details}
        </div>
      </details>
    </article>
  );
}
