import { enterpriseRequest } from '../../workspaceApi';

export type FeedbackCategory = 'correct' | 'data_calculation' | 'citation' | 'tool' | 'artifact' | 'other';

export type TaskFeedbackRecord = {
  id: string;
  task_id: string;
  attempt_id: string;
  category: FeedbackCategory;
  note: string;
  status: 'NEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  resolution?: string | null;
  created_at: string;
  updated_at: string;
};

export const feedbackCategories: FeedbackCategory[] = [
  'correct',
  'data_calculation',
  'citation',
  'tool',
  'artifact',
  'other',
];

export const readFeedback = (taskId: string, attemptId: string) =>
  enterpriseRequest<TaskFeedbackRecord | null>(
    `/enterprise/tasks/${taskId}/feedback?attemptId=${encodeURIComponent(attemptId)}`,
    { signal: AbortSignal.timeout(10000) }
  );

export const submitFeedback = (taskId: string, attemptId: string, category: FeedbackCategory, note: string) =>
  enterpriseRequest<TaskFeedbackRecord>(`/enterprise/tasks/${taskId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attemptId, category, note }),
  });
