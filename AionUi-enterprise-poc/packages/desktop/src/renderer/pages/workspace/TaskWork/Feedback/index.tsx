import { Button, Input, Message, Select, Space, Tag, Typography } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  feedbackCategories,
  readFeedback,
  submitFeedback,
  type FeedbackCategory,
  type TaskFeedbackRecord,
} from './api';

export default function TaskFeedback({ taskId, attemptId }: { taskId: string; attemptId: string }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<TaskFeedbackRecord | null>();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = async () => {
    const current = ++generation.current;
    try {
      const value = await readFeedback(taskId, attemptId);
      if (current === generation.current) setFeedback(value);
    } catch {
      if (current === generation.current) setFeedback(undefined);
    }
  };

  useEffect(() => {
    setFeedback(undefined);
    setOpen(false);
    setCategory(undefined);
    setNote('');
    void load();
    return () => {
      generation.current++;
    };
  }, [taskId, attemptId]);

  const submit = async () => {
    const normalized = note.trim();
    if (!category || busy) return;
    setBusy(true);
    try {
      const value = await submitFeedback(taskId, attemptId, category, normalized);
      setFeedback(value);
      setOpen(false);
      Message.success(t('workspace.feedback.submitted'));
    } catch {
      Message.error(t('workspace.feedback.error'));
    } finally {
      setBusy(false);
    }
  };

  if (feedback) {
    return (
      <div className='flex flex-col items-start gap-4px' data-testid='task-feedback-status'>
        <Space size='mini'>
          <Tag>{t(`workspace.feedback.status.${feedback.status}`)}</Tag>
          <Typography.Text type='secondary'>{t('workspace.feedback.submitted')}</Typography.Text>
        </Space>
        {feedback.resolution && (
          <Typography.Text className='text-12px whitespace-pre-wrap break-words'>{feedback.resolution}</Typography.Text>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <Button size='mini' type='text' onClick={() => setOpen(true)} data-testid='task-feedback-open'>
        {t('workspace.feedback.action')}
      </Button>
    );
  }

  return (
    <div className='flex flex-col gap-8px max-w-520px' data-testid='task-feedback-form'>
      <Select
        value={category}
        onChange={setCategory}
        placeholder={t('workspace.feedback.categoryPlaceholder')}
        options={feedbackCategories.map((value) => ({
          value,
          label: t(`workspace.feedback.categories.${value}`),
        }))}
      />
      <Input.TextArea
        value={note}
        onChange={setNote}
        maxLength={500}
        showWordLimit
        autoSize={{ minRows: 2, maxRows: 4 }}
        placeholder={t('workspace.feedback.notePlaceholder')}
      />
      <Space>
        <Button type='primary' size='mini' loading={busy} disabled={!category} onClick={submit}>
          {t('workspace.feedback.submit')}
        </Button>
        <Button size='mini' disabled={busy} onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </Space>
    </div>
  );
}
