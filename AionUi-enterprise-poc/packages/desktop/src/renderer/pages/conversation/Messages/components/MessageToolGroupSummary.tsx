import ArtifactCard from '@/renderer/pages/workspace/TaskWork/ArtifactCard';
import { attachWorkspaceVersion, pinnedArtifactDownload, pinnedArtifactPreview } from '@/renderer/services/FileService';
import { useNavigate } from 'react-router-dom';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { emitter } from '@/renderer/utils/emitter';
import EnterpriseFilePreview from '@/renderer/components/media/OfficePreview/EnterpriseFilePreview';
import type { BadgeProps } from '@arco-design/web-react';
import { Badge, Button, Drawer, Message, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { IconDown, IconRight } from '@arco-design/web-react/icon';
import { Checklist, Download, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getAcpImageFileName } from '@/common/chat/acpToolCallOutput';
import type { NormalizedToolCall, NormalizedToolStatus, ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages, hasRunningToolMessages, toolDeliveryReceipts } from '@/common/chat/normalizeToolCall';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import { useToolStepLabels } from './toolStepLabels';
import './MessageToolGroupSummary.css';
import type { WorkAttempt } from '@/renderer/pages/workspace/TaskWork/api';

const statusToBadge = (status: NormalizedToolStatus): BadgeProps['status'] => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'running':
      return 'processing';
    case 'canceled':
      return 'default';
    case 'pending':
    default:
      return 'default';
  }
};

const ToolItemDetail: React.FC<{ item: NormalizedToolCall }> = ({ item }) => {
  const { t, displayName } = useToolStepLabels();
  const [expanded, setExpanded] = useState(false);
  const [fullItem, setFullItem] = useState<NormalizedToolCall | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const displayItem = fullItem ?? item;
  const hasDetail = displayItem.input || displayItem.output || item.truncated || item.imagePath;
  const [messageApi, messageContext] = Message.useMessage();
  const handleDownloadImage = useCallback(
    async (path: string) => {
      try {
        await downloadFileFromPath(path, getAcpImageFileName(path));
        messageApi.success(t('acp.image.download_success'));
      } catch (error) {
        console.error('[MessageToolGroupSummary] Failed to download image:', error);
        messageApi.error(t('acp.image.download_error'));
      }
    },
    [messageApi, t]
  );

  const loadFullItem = async () => {
    if (!item.truncated || fullItem || loadingFull || !item.conversationId || !item.messageId) return;
    setLoadingFull(true);
    setLoadError(false);
    try {
      const message = await ipcBridge.database.getConversationMessage.invoke({
        conversation_id: item.conversationId,
        message_id: item.messageId,
      });
      const next = normalizeToolMessages([message as ToolMessage]).find((candidate) => candidate.key === item.key);
      if (next) setFullItem(next);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingFull(false);
    }
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded) void loadFullItem();
  };

  return (
    <div className='flex flex-col'>
      {messageContext}
      <div className='flex flex-row color-#86909C gap-12px items-center'>
        <Badge status={statusToBadge(item.status)} className={item.status === 'running' ? 'badge-breathing' : ''} />
        <span
          className={
            'flex-1 min-w-0' +
            (expanded ? ' break-all' : ' truncate') +
            (hasDetail ? ' cursor-pointer hover:color-#4E5969' : '')
          }
          onClick={hasDetail ? toggleExpanded : undefined}
        >
          <span className='font-medium text-13px'>{displayName(displayItem.name)}</span>
          {displayItem.description && displayItem.description !== displayItem.name && (
            <span className='m-l-4px opacity-80 text-13px'>{displayName(displayItem.description)}</span>
          )}
        </span>
        {hasDetail && (
          <span className='flex-shrink-0 cursor-pointer hover:color-#4E5969 transition-colors' onClick={toggleExpanded}>
            {expanded ? <IconDown style={{ fontSize: 12 }} /> : <IconRight style={{ fontSize: 12 }} />}
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <div className='tool-detail-panel m-l-20px m-t-4px'>
          {loadingFull && <div className='tool-detail-label'>{t('conversation.toolSteps.loading')}</div>}
          {loadError && <div className='tool-detail-label'>{t('conversation.toolSteps.loadError')}</div>}
          {displayItem.input && (
            <div className='tool-detail-section'>
              <div className='tool-detail-label'>{t('conversation.toolSteps.input')}</div>
              <pre className='tool-detail-content'>{displayItem.input}</pre>
            </div>
          )}
          {displayItem.output && (
            <div className='tool-detail-section'>
              <div className='tool-detail-label'>{t('conversation.toolSteps.output')}</div>
              <pre className='tool-detail-content'>{displayItem.output}</pre>
            </div>
          )}
        </div>
      )}
      {item.imagePath && (
        <div className='group relative m-l-20px m-t-8px overflow-hidden rounded border bg-1 p-2 max-w-280px'>
          <LocalImageView
            src={item.imagePath}
            alt={getAcpImageFileName(item.imagePath)}
            className='max-w-full max-h-320px object-contain rounded'
          />
          <Tooltip content={t('acp.image.download')}>
            <Button
              aria-label={t('acp.image.download_aria')}
              className='!absolute end-10px top-10px !h-28px !w-28px !p-0 opacity-0 shadow-sm transition-opacity group-hover:opacity-90 focus:opacity-100'
              type='secondary'
              size='mini'
              shape='circle'
              icon={<Download theme='outline' size='14' />}
              onClick={() => void handleDownloadImage(item.imagePath)}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
};

const MessageToolGroupSummary: React.FC<{ messages: ToolMessage[] }> = ({ messages }) => {
  const { t } = useTranslation();
  const hasRunning = hasRunningToolMessages(messages);
  const [showMore, setShowMore] = useState(!isEnterpriseWeb() && hasRunning);

  useEffect(() => {
    if (hasRunning && !isEnterpriseWeb()) setShowMore(true);
  }, [hasRunning]);

  const tools = useMemo(() => normalizeToolMessages(messages), [messages]);

  if (isEnterpriseWeb() && tools.every((tool) => ['office_context', 'task_checkpoint'].includes(tool.name)))
    return null;
  return (
    <div className='tool-group-summary'>
      <Button
        type='text'
        size='mini'
        className='tool-group-summary__header'
        aria-expanded={showMore}
        onClick={() => setShowMore(!showMore)}
      >
        <span className='tool-group-summary__icon'>
          {hasRunning ? <Spin size={12} /> : <Checklist theme='outline' size='14' />}
        </span>
        <span className='tool-group-summary__label'>
          {t(isEnterpriseWeb() ? 'workspace.experience.executionDetails' : 'conversation.toolSteps.view')}{' '}
          {tools.length > 0 ? `· ${tools.length}` : ''}
        </span>
        <span className={`tool-group-summary__arrow${showMore ? ' tool-group-summary__arrow--open' : ''}`}>
          <Right theme='outline' size='12' />
        </span>
      </Button>
      {showMore && (
        <div className='tool-group-summary__body'>
          {tools.map((item) => (
            <ToolItemDetail key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};

export default React.memo(MessageToolGroupSummary);

/** Persistent delivery receipts for the most recent user turn, never inferred from prose. */
export const TaskDeliverySummary: React.FC<{
  messages: ToolMessage[];
  processing: boolean;
  conversationId?: string;
  state?: string;
  trustedArtifacts?: WorkAttempt['artifacts'];
}> = ({ messages, processing, trustedArtifacts, conversationId, state }) => {
  const { t } = useTranslation();
  const receipts = toolDeliveryReceipts(normalizeToolMessages(messages));
  const files =
    trustedArtifacts === undefined
      ? receipts
      : trustedArtifacts.map((file) => ({
          ...receipts.find(
            (entry) => entry.path === file.path && entry.versionId === file.versionId && entry.sha256 === file.sha256
          ),
          ...file,
          status: file.valid ? ('complete' as const) : ('failed' as const),
        }));
  const [preview, setPreview] = useState<{ path: string; version: string }>();
  const [attaching, setAttaching] = useState<string>();
  const continuation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => continuation.current?.abort(), [conversationId]);
  const navigate = useNavigate();
  if (!isEnterpriseWeb() || !files.length) return null;
  const failures = files.filter((file) => file.status === 'failed').length;
  const heading =
    state === 'partial' || (failures > 0 && failures < files.length)
      ? 'workspace.delivery.partial'
      : failures === files.length
        ? 'workspace.delivery.verificationFailed'
        : processing
          ? 'workspace.delivery.processing'
          : 'workspace.delivery.receipts';
  const continueHere = async (path: string, version: string, versionNumber?: number) => {
    if (!conversationId || continuation.current) return;
    const controller = new AbortController();
    continuation.current = controller;
    setAttaching(version);
    try {
      const attachment = await attachWorkspaceVersion(
        path,
        path.split('/').pop() || path,
        version,
        controller.signal,
        conversationId
      );
      if (!controller.signal.aborted)
        emitter.emit(
          'aionrs.upload.file.append',
          [attachment],
          conversationId,
          t('workspace.files.continueSnapshotPrompt', {
            path,
            time: versionNumber === undefined ? version : 'v' + versionNumber,
          })
        );
    } catch {
      if (!controller.signal.aborted) Message.error(t('workspace.experience.actionFailed'));
    } finally {
      if (!controller.signal.aborted) setAttaching(undefined);
      if (continuation.current === controller) continuation.current = undefined;
    }
  };
  return (
    <section
      className='mx-auto my-12px grid w-full max-w-800px min-w-0 gap-8px px-8px box-border'
      data-testid='task-delivery-summary'
    >
      <div className='flex items-center justify-between gap-8px'>
        <h3 className='m-0 text-16px font-semibold'>{t(heading)}</h3>
        <Button type='text' size='small' onClick={() => navigate('/workspace?section=files')}>
          {t('workspace.tabs.files')}
        </Button>
      </div>
      {files.map((file) => {
        const available = file.status === 'complete' && !!file.versionId && /^[a-f0-9]{64}$/.test(file.sha256 || '');
        const downloadUrl =
          'downloadUrl' in file && typeof file.downloadUrl === 'string'
            ? pinnedArtifactDownload(file.downloadUrl, file.versionId)
            : undefined;
        const canDownload = available && (trustedArtifacts === undefined || !!downloadUrl);
        const canPreview =
          available &&
          (trustedArtifacts === undefined ||
            ('previewUrl' in file &&
              typeof file.previewUrl === 'string' &&
              !!pinnedArtifactPreview(file.previewUrl, file.path, file.versionId)));
        return (
          <div
            key={JSON.stringify([file.path, file.versionId || file.sha256 || file.status])}
            data-testid='trusted-artifact-card'
            data-version-id={file.versionId}
            data-sha256={file.sha256}
          >
            <ArtifactCard
              {...file}
              status={
                <Tag color={file.status === 'failed' ? 'red' : canDownload || canPreview ? 'green' : undefined}>
                  {t(
                    file.status === 'failed'
                      ? 'workspace.delivery.verificationFailed'
                      : canDownload || canPreview
                        ? 'workspace.delivery.complete'
                        : 'workspace.experience.artifactUnavailable'
                  )}
                </Tag>
              }
              metadata={file.checks?.map((check) => (
                <span
                  key={JSON.stringify([check.sheet, check.scope])}
                  className={check.matched ? 'text-t-secondary' : 'text-danger'}
                >
                  {check.sheet} · {check.scope} ·{' '}
                  {t(check.matched ? 'workspace.delivery.checkedAmount' : 'workspace.delivery.mismatchedAmount', {
                    amount: check.currency + ' ' + check.total,
                  })}
                </span>
              ))}
              details={
                <>
                  {file.headingCount !== undefined && (
                    <span>
                      {t('workspace.delivery.savedStructure', {
                        headings: file.headingCount,
                        tables: file.tableCount ?? 0,
                      })}
                    </span>
                  )}
                  {file.sheetCount !== undefined && (
                    <span>{t('workspace.delivery.savedWorkbookStructure', { sheets: file.sheetCount })}</span>
                  )}
                  {file.addedHeadings?.map((heading) => (
                    <span key={heading}>{heading}</span>
                  ))}
                  {file.error && <span>{file.error}</span>}
                </>
              }
            >
              {canPreview && (
                <Button size='small' onClick={() => setPreview({ path: file.path, version: file.versionId! })}>
                  {t('workspace.files.preview')}
                </Button>
              )}
              {canDownload && (
                <Button
                  type='text'
                  size='small'
                  onClick={() =>
                    window.open(
                      downloadUrl ||
                        `/enterprise/files/download?${new URLSearchParams({ path: file.path, version: file.versionId! })}`,
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                >
                  {t('workspace.files.download')}
                </Button>
              )}
              {canDownload && conversationId && (
                <Button
                  type='text'
                  size='small'
                  disabled={!!attaching}
                  loading={attaching === file.versionId}
                  onClick={() => void continueHere(file.path, file.versionId!, file.version)}
                >
                  {t('workspace.files.continue')}
                </Button>
              )}
            </ArtifactCard>
          </div>
        );
      })}
      <Drawer
        width='min(920px, 100vw)'
        visible={Boolean(preview)}
        focusLock
        autoFocus
        unmountOnExit
        title={preview?.path.split('/').pop() || ''}
        footer={null}
        onCancel={() => setPreview(undefined)}
      >
        {preview && (
          <EnterpriseFilePreview key={JSON.stringify(preview)} path={preview.path} version={preview.version} />
        )}
      </Drawer>
    </section>
  );
};
