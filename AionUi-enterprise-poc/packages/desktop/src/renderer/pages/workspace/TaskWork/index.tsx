import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Link,
  Message,
  Select,
  Space,
  Tag,
  Typography,
} from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { enterpriseRequest, workspaceErrorCode } from '../workspaceApi';
import { taskAccepted, taskRequestId, taskStatusVisible, useTaskWork, type WorkTask } from './api';
import { useConfirmationDecision } from './useConfirmationDecision';
import { TaskStateTag } from './overview';
import ArtifactCard from './ArtifactCard';
import { pinnedArtifactDownload, pinnedArtifactPreview } from '@/renderer/services/FileService';
import TaskFeedback from './Feedback';

/** One business status, one approval; all additional employee input uses the main conversation composer. */
export default function TaskWork({
  conversationId,
  composer = false,
  embedded = false,
  hideOpenAction = false,
  onContinue,
  onTaskChange,
}: {
  conversationId: string;
  composer?: boolean;
  embedded?: boolean;
  hideOpenAction?: boolean;
  onContinue?: () => void;
  onTaskChange?: (task: WorkTask | undefined) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { task, attempt: a, error, reload } = useTaskWork(conversationId);
  useEffect(() => {
    onTaskChange?.(task);
  }, [task, onTaskChange]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [externalOutcome, setExternalOutcome] = useState<string>();
  const decision = useConfirmationDecision(conversationId, a, reload);
  const requestBusy = useRef(false);
  useEffect(() => {
    setReviewed(false);
    setExternalOutcome(undefined);
    setFailure(false);
  }, [conversationId, a?.id, a?.confirmation?.id]);
  if (!isEnterpriseWeb()) return null;
  if (!task || !a)
    return error && !embedded ? (
      <Alert
        type='error'
        content={t('workspace.experience.actionFailed')}
        action={<Button onClick={() => void reload()}>{t('common.retry')}</Button>}
      />
    ) : null;
  const feedbackVisible = ['completed', 'partial'].includes(a.state);
  const artifacts = Array.from(
    new Map(
      task.attempts
        .flatMap((attempt) => attempt.artifacts)
        .map((file) => [JSON.stringify([file.path, file.versionId || file.sha256]), file] as const)
    ).values()
  );
  const statusVisible = taskStatusVisible(a);
  if (embedded && !statusVisible && !feedbackVisible) return null;
  const action = async (kind: string): Promise<void> => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true);
    setFailure(false);
    try {
      const payload = {
        attemptId: a.id,
        reviewed,
        externalOutcome,
        language: i18n.language,
      };
      const request_id = await taskRequestId(conversationId, { kind, ...payload });
      await enterpriseRequest(`/enterprise/tasks/${conversationId}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, request_id }),
      });
      taskAccepted(conversationId, request_id);
      await reload();
    } catch (e) {
      if (workspaceErrorCode(e) !== 'AUTHENTICATION_REQUIRED') {
        setFailure(true);
        Message.error(t('workspace.experience.actionFailed'));
      }
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  };
  const waiting = ['waiting_input', 'waiting_confirmation'].includes(a.state);
  const canApprove =
    a.state === 'waiting_confirmation' && a.canApprove === true && !!a.confirmation?.id && !!a.confirmation?.proposal;
  const canRetry =
    ['partial', 'failed', 'interrupted'].includes(a.state) ||
    (a.state === 'cancelled' && a.requiresExternalReview === true);
  const stopped = busy || decision.busy || (!!decision.pending && !decision.pending.rejection);
  let question = a.question;
  if (question?.startsWith('[')) {
    try {
      const items = JSON.parse(question) as Array<{ question?: string; header?: string }>;
      question = items
        .map((item) => item.question || item.header)
        .filter(Boolean)
        .join('\n');
    } catch {
      /* Preserve plain employee text. */
    }
  }
  if (embedded && !statusVisible && feedbackVisible) {
    return <TaskFeedback taskId={conversationId} attemptId={a.id} />;
  }
  const body = (
    <>
      {waiting && question && (
        <Typography.Paragraph
          ellipsis={{ rows: 2, expandable: true }}
          className='m-0 text-13px leading-6 whitespace-pre-wrap break-words'
          data-testid='task-pending-question'
        >
          {question}
        </Typography.Paragraph>
      )}
      {waiting && a.reason && (
        <span className='text-13px text-t-secondary'>
          {t(`workspace.work.reasons.${a.reason}`, {
            defaultValue: t('workspace.work.reasons.TASK_EXECUTION_UNAVAILABLE'),
          })}
        </span>
      )}
      {waiting && !canApprove && onContinue && (
        <Button type='primary' onClick={onContinue}>
          {t('workspace.work.continue')}
        </Button>
      )}
      {canApprove && (
        <div
          className='flex flex-col gap-8px border-l-2 border-solid border-warning pl-12px'
          data-testid='task-confirmation'
        >
          <span className='text-13px text-t-secondary'>{t('workspace.experience.confirmScope')}</span>
          <pre className='m-0 whitespace-pre-wrap break-words max-h-180px overflow-auto text-14px'>
            {a.confirmation?.proposal}
          </pre>
          <Space>
            <Button
              type='primary'
              loading={decision.busy && decision.pending?.kind === 'approve'}
              disabled={
                busy ||
                decision.busy ||
                (!!decision.pending && (decision.pending.kind !== 'approve' || !decision.safeId))
              }
              onClick={() =>
                void decision.submit('approve', {
                  reviewed,
                  externalOutcome,
                  language: i18n.language,
                })
              }
            >
              {t('workspace.work.approve')}
            </Button>
            <Button
              loading={decision.busy && decision.pending?.kind === 'decline'}
              disabled={
                busy ||
                decision.busy ||
                (!!decision.pending && (decision.pending.kind !== 'decline' || !decision.safeId))
              }
              onClick={() =>
                void decision.submit('decline', {
                  reviewed,
                  externalOutcome,
                  language: i18n.language,
                })
              }
            >
              {t('workspace.work.decline')}
            </Button>
          </Space>
          {decision.pending && !decision.busy && (
            <div role='alert' className='flex items-center gap-8px text-14px'>
              {decision.pending.rejection
                ? t('workspace.errors.action', { code: decision.pending.rejection })
                : t(decision.safeId ? 'workspace.work.repeatDecision' : 'workspace.work.checkDecision')}
              {!decision.safeId && (
                <Button size='small' loading={decision.checking} onClick={() => void decision.check(decision.pending!)}>
                  {t('common.refresh')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {(a.state === 'interrupted' || (canRetry && a.requiresExternalReview)) && (
        <Space wrap>
          {a.state === 'interrupted' && (
            <Checkbox checked={reviewed} onChange={setReviewed}>
              {t('workspace.work.reviewRecovery')}
            </Checkbox>
          )}
          {a.requiresExternalReview && (
            <Select
              value={externalOutcome}
              aria-label={t('workspace.work.externalReview')}
              placeholder={t('workspace.work.externalReview')}
              onChange={setExternalOutcome}
            >
              <Select.Option value='applied'>{t('workspace.work.externalApplied')}</Select.Option>
              <Select.Option value='not_applied'>{t('workspace.work.externalNotApplied')}</Select.Option>
            </Select>
          )}
        </Space>
      )}
      {a.reason && ['failed', 'partial', 'interrupted'].includes(a.state) && (
        <span className='text-14px text-t-secondary'>
          {t(`workspace.work.reasons.${a.reason}`, {
            defaultValue: t('workspace.experience.actionFailed'),
          })}
        </span>
      )}
      {failure && (
        <span role='alert' className='text-danger text-12px'>
          {t('workspace.experience.actionFailed')}
        </span>
      )}
    </>
  );
  return (
    <section
      data-testid='task-work'
      className={`${embedded ? 'py-6px' : 'p-12px border border-solid border-border-2 rd-8px'} min-w-0 shrink-0 flex flex-col gap-6px`}
    >
      <div className='flex flex-wrap items-center justify-between gap-8px min-w-0'>
        <span role='status'>
          <TaskStateTag state={a.state} />
        </span>
        <Space size='mini' wrap>
          {canRetry && (
            <Button
              size='mini'
              type='text'
              loading={busy}
              disabled={(a.state === 'interrupted' && !reviewed) || (a.requiresExternalReview && !externalOutcome)}
              onClick={() => void action('retry')}
            >
              {t('workspace.work.retryRemaining')}
            </Button>
          )}
          {!embedded && !hideOpenAction && (
            <Button size='mini' type='text' onClick={() => navigate(`/conversation/${conversationId}`)}>
              {t(composer ? 'workspace.work.continue' : 'workspace.tasks.open')}
            </Button>
          )}
          {['queued', 'waiting_input', 'waiting_confirmation', 'interrupted'].includes(a.state) && (
            <Button
              size='mini'
              type='text'
              status='danger'
              disabled={stopped}
              loading={busy}
              onClick={() => void action('cancel')}
            >
              {t('common.cancel')}
            </Button>
          )}
        </Space>
      </div>
      {body}
      {!embedded && (
        <Collapse bordered={false}>
          <Collapse.Item
            name='steps'
            header={t('workspace.experience.executionDetails') + (a.steps.length ? ' · ' + a.steps.length : '')}
          >
            <div className='flex flex-col gap-6px'>
              {a.steps.map((step) => (
                <div key={step.id} className='flex items-start gap-8px text-12px break-words'>
                  <Tag size='small'>
                    {t(`workspace.work.step.${step.state}`, {
                      defaultValue: t('workspace.work.unknown'),
                    })}
                  </Tag>
                  <span>{step.tool}</span>
                </div>
              ))}
              {a.reason && !waiting && !['failed', 'partial', 'interrupted'].includes(a.state) && (
                <p>
                  {t(`workspace.work.reasons.${a.reason}`, {
                    defaultValue: t('workspace.work.reasons.TASK_EXECUTION_UNAVAILABLE'),
                  })}
                </p>
              )}
              {task.attempts.length > 1 && (
                <span className='text-t-secondary'>
                  {t('workspace.work.round', { round: a.round, attempt: a.attempt })}
                </span>
              )}
            </div>
          </Collapse.Item>
        </Collapse>
      )}
      {!embedded &&
        artifacts.map((file) => {
          const verified = file.valid && /^[a-f0-9]{64}$/i.test(file.sha256 || '');
          const previewVersion = verified
            ? pinnedArtifactPreview(file.previewUrl, file.path, file.versionId)
            : undefined;
          const download = verified ? pinnedArtifactDownload(file.downloadUrl, file.versionId) : undefined;
          const fileName = file.path.split('/').pop() || file.path;
          const title = file.version !== undefined ? fileName + ' · v' + file.version : fileName;
          return (
            <ArtifactCard
              key={JSON.stringify([file.path, file.versionId || file.sha256])}
              {...file}
              onPreview={
                previewVersion
                  ? () => {
                      const current = new URLSearchParams(location.search);
                      const inTask =
                        location.pathname === '/workspace' &&
                        current.get('section') === 'tasks' &&
                        current.get('task') === conversationId;
                      const next = inTask ? current : new URLSearchParams({ section: 'files' });
                      next.set('previewPath', file.path);
                      next.set('fileVersion', previewVersion);
                      navigate({ pathname: '/workspace', search: next.toString() });
                    }
                  : undefined
              }
              status={
                <Tag color={!file.valid ? 'red' : undefined}>
                  {t(
                    !file.valid
                      ? 'workspace.delivery.verificationFailed'
                      : download || previewVersion
                        ? 'workspace.delivery.complete'
                        : 'workspace.experience.artifactUnavailable'
                  )}
                </Tag>
              }
            >
              {download && (
                <Link href={download} download aria-label={t('common.download') + ' · ' + title}>
                  {t('common.download')}
                </Link>
              )}
              {!file.valid && (
                <span className='text-13px text-t-secondary'>{t('workspace.experience.artifactUnavailable')}</span>
              )}
            </ArtifactCard>
          );
        })}
      {feedbackVisible && <TaskFeedback taskId={conversationId} attemptId={a.id} />}
    </section>
  );
}
