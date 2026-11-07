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
import { useNavigate } from 'react-router-dom';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { enterpriseRequest, workspaceErrorCode } from '../workspaceApi';
import { taskAccepted, taskRequestId, taskStatusVisible, useTaskWork, type WorkTask } from './api';
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
  const { task, attempt: a, error, reload } = useTaskWork(conversationId);
  useEffect(() => {
    onTaskChange?.(task);
  }, [task, onTaskChange]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [externalOutcome, setExternalOutcome] = useState<string>();
  const requestBusy = useRef(false);
  useEffect(() => {
    setReviewed(false);
    setExternalOutcome(undefined);
    setFailure(false);
  }, [conversationId, a?.id]);
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
      const payload = { attemptId: a.id, reviewed, externalOutcome, language: i18n.language };
      const request_id = await taskRequestId(conversationId, { kind, ...payload });
      await enterpriseRequest(`/enterprise/tasks/${conversationId}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, request_id }),
      });
      taskAccepted(conversationId);
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
  const canApprove = a.state === 'waiting_confirmation' && a.canApprove === true && !!a.confirmation?.proposal;
  const status = t(`workspace.work.states.${a.state}`, { defaultValue: t('workspace.work.unknown') });
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
        <span className='text-12px text-t-secondary'>
          {t(`workspace.work.reasons.${a.reason}`, {
            defaultValue: t('workspace.work.reasons.TASK_EXECUTION_UNAVAILABLE'),
          })}
        </span>
      )}
      {waiting && onContinue && (
        <Button type='primary' onClick={onContinue}>
          {t('workspace.work.continue')}
        </Button>
      )}
      {canApprove && (
        <div
          className='flex flex-col gap-8px border-l-2 border-solid border-warning pl-12px'
          data-testid='task-confirmation'
        >
          <span className='text-12px text-t-secondary'>{t('workspace.experience.confirmScope')}</span>
          <pre className='m-0 whitespace-pre-wrap break-words max-h-180px overflow-auto text-12px'>
            {a.confirmation?.proposal}
          </pre>
          <Space>
            <Button type='primary' loading={busy} onClick={() => void action('approve')}>
              {t('workspace.work.approve')}
            </Button>
            <Button loading={busy} onClick={() => void action('decline')}>
              {t('workspace.work.decline')}
            </Button>
          </Space>
        </div>
      )}
      {a.state === 'interrupted' && (
        <Space wrap>
          <Checkbox checked={reviewed} onChange={setReviewed}>
            {t('workspace.work.reviewRecovery')}
          </Checkbox>
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
      {embedded && a.reason && ['failed', 'partial', 'interrupted'].includes(a.state) && (
        <span className='text-12px text-t-secondary'>{t('workspace.experience.actionFailed')}</span>
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
        <span role='status' className='text-12px text-t-secondary'>
          {status}
        </span>
        <Space size='mini' wrap>
          {['partial', 'failed', 'interrupted'].includes(a.state) && (
            <Button
              size='mini'
              type='text'
              loading={busy}
              disabled={a.state === 'interrupted' && (!reviewed || (a.requiresExternalReview && !externalOutcome))}
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
            <Button size='mini' type='text' status='danger' loading={busy} onClick={() => void action('cancel')}>
              {t('common.cancel')}
            </Button>
          )}
        </Space>
      </div>
      {body}
      {!embedded && (
        <Collapse bordered={false}>
          <Collapse.Item name='steps' header={t('workspace.experience.executionDetails')}>
            <div className='flex flex-col gap-6px'>
              {a.steps.map((step) => (
                <div key={step.id} className='flex items-start gap-8px text-12px break-words'>
                  <Tag size='small'>
                    {t(`workspace.work.step.${step.state}`, { defaultValue: t('workspace.work.unknown') })}
                  </Tag>
                  <span>{step.tool}</span>
                </div>
              ))}
              {a.reason && !waiting && (
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
        artifacts.map((file) => (
          <Space key={JSON.stringify([file.path, file.versionId || file.sha256])} wrap className='min-w-0'>
            <span className='break-all text-13px' title={file.path}>
              {file.path.split('/').pop() || file.path}
              {file.version !== undefined ? ` · v${file.version}` : ''}
            </span>
            {file.valid && file.previewUrl && (
              <Button
                size='mini'
                type='text'
                onClick={() => {
                  try {
                    const target = new URL(file.previewUrl!, window.location.origin);
                    if (target.origin !== window.location.origin || !target.hash.startsWith('#/workspace?')) {
                      throw new Error('Invalid artifact preview route');
                    }
                    navigate(target.hash.slice(1));
                  } catch {
                    setFailure(true);
                  }
                }}
              >
                {t('workspace.files.preview')}
              </Button>
            )}
            {file.valid && file.downloadUrl && (
              <Link href={file.downloadUrl} download>
                {t('common.download')}
              </Link>
            )}
            {!file.valid && (
              <span className='text-12px text-t-secondary'>{t('workspace.experience.artifactUnavailable')}</span>
            )}
          </Space>
        ))}
      {feedbackVisible && <TaskFeedback taskId={conversationId} attemptId={a.id} />}
    </section>
  );
}
