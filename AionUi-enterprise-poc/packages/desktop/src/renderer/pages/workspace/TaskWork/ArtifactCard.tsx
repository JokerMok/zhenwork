import { Button, Dropdown, Menu } from '@arco-design/web-react';
import { DataFile, FileEditing, FileText, MoreOne, Picture } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../WorkspaceExperience.module.css';

type ArtifactAction = {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

type ArtifactCardProps = {
  path: string;
  name?: string;
  status?: React.ReactNode;
  metadata?: React.ReactNode;
  version?: number;
  versionId?: string;
  sha256?: string;
  details?: React.ReactNode;
  layout?: 'card' | 'row';
  onPreview?: (event: Event) => void;
  menuActions?: ArtifactAction[];
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
  layout = 'card',
  onPreview,
  menuActions = [],
  children,
}: ArtifactCardProps) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const title = name || path.split('/').pop() || path;
  const extension = title.match(/\.([a-z0-9]{1,12})$/i)?.[1].toUpperCase();
  const FileIcon = /^(XLSX?|CSV|TSV)$/.test(extension || '')
    ? DataFile
    : /^(DOCX?|RTF|ODT)$/.test(extension || '')
      ? FileEditing
      : /^(PNG|JPE?G|GIF|WEBP|SVG)$/.test(extension || '')
        ? Picture
        : FileText;
  const technicalLabel = t('common.technical_details');
  const technicalDetails = (
    <div className={styles.artifactDetails}>
      {path !== title && <span>{path}</span>}
      {version !== undefined && (
        <span>
          {t('common.version')} · v{version}
        </span>
      )}
      {versionId && <code>{versionId}</code>}
      {sha256 && <code>SHA-256 · {sha256}</code>}
      {details}
    </div>
  );

  return (
    <article className={layout === 'row' ? styles.artifactRow : styles.artifactCard}>
      <div className={styles.artifactObject}>
        <span className={styles.artifactIcon} aria-hidden='true'>
          <FileIcon size={20} />
        </span>
        <div className={styles.artifactContent}>
          <div className={styles.artifactTitleLine}>
            {onPreview ? (
              <Button
                type='text'
                size='small'
                className={styles.artifactName}
                title={title}
                aria-label={t('workspace.files.preview') + ' · ' + title}
                onClick={onPreview}
              >
                <span className='min-w-0 truncate'>{title}</span>
              </Button>
            ) : (
              <strong className='min-w-0 break-words text-15px text-t-primary'>{title}</strong>
            )}
            {status}
          </div>
          <div className={styles.artifactMeta}>
            <span>{extension || t('common.file')}</span>
            {version !== undefined && <span>v{version}</span>}
            {metadata}
          </div>
        </div>
      </div>
      <div className={styles.artifactActions}>
        {children}
        {layout === 'row' && (
          <Dropdown
            trigger='click'
            position='br'
            droplist={
              <Menu
                onClickMenuItem={(key) => {
                  if (key === 'details') setDetailsOpen((open) => !open);
                  else menuActions.find((action) => action.key === key)?.onSelect();
                }}
              >
                {menuActions.map((action) => (
                  <Menu.Item key={action.key} disabled={action.disabled}>
                    {action.label}
                  </Menu.Item>
                ))}
                <Menu.Item key='details'>{technicalLabel}</Menu.Item>
              </Menu>
            }
          >
            <Button
              type='text'
              size='small'
              aria-label={t('common.more') + ' · ' + title}
              aria-haspopup='menu'
              icon={<MoreOne size={17} />}
            />
          </Dropdown>
        )}
      </div>
      {layout === 'row' ? (
        detailsOpen && technicalDetails
      ) : (
        <details className={styles.artifactDisclosure}>
          <summary>{technicalLabel}</summary>
          {technicalDetails}
        </details>
      )}
    </article>
  );
}
