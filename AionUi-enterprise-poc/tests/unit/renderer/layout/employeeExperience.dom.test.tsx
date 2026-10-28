import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import TaskWork from '@/renderer/pages/workspace/TaskWork';
import MessageTips from '@/renderer/pages/conversation/Messages/components/MessageTips';
import type { WorkAttempt } from '@/renderer/pages/workspace/TaskWork/api';
const fixture = vi.hoisted(() => ({
  attempt: undefined as WorkAttempt | undefined,
  request: vi.fn(),
  reload: vi.fn(),
}));
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }));
vi.mock('@/renderer/pages/workspace/TaskWork/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/pages/workspace/TaskWork/api')>()),
  useTaskWork: () => ({
    task: fixture.attempt ? { attempts: [fixture.attempt] } : undefined,
    attempt: fixture.attempt,
    reload: fixture.reload,
  }),
  taskRequestId: async () => 'stable-test-request',
  taskAccepted: vi.fn(),
}));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseRequest: (...args: unknown[]) => fixture.request(...args),
  workspaceErrorCode: () => 'UNAVAILABLE',
}));
vi.mock('@/renderer/components/base/ButlerDiagnoseButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/base/FeedbackButton', () => ({ default: () => null }));
vi.mock('@renderer/components/Markdown', () => ({ default: () => null }));
beforeEach(() => {
  fixture.request.mockReset();
  fixture.request.mockResolvedValue({});
  fixture.attempt = {
    id: 'attempt-1',
    round: 1,
    attempt: 1,
    state: 'completed',
    phase: 'settled',
    updatedAt: 1,
    steps: [],
    artifacts: [],
  };
});
afterEach(cleanup);
test('ordinary prose has no task card and no additional composer', () => {
  render(
    <MemoryRouter>
      <TaskWork conversationId='abcd1234' embedded />
    </MemoryRouter>
  );
  expect(screen.queryByTestId('task-work')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});
test('a waiting question uses the original composer and cannot approve an unspecified action', () => {
  Object.assign(fixture.attempt!, {
    state: 'waiting_confirmation',
    question: 'Which reporting period?',
    canApprove: false,
  });
  render(
    <MemoryRouter>
      <TaskWork conversationId='abcd1234' embedded />
    </MemoryRouter>
  );
  expect(screen.getByText('Which reporting period?')).toBeTruthy();
  expect(screen.queryByText('workspace.work.approve')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});
test('a concrete persisted operation has exactly one approval guarded against double submission', async () => {
  Object.assign(fixture.attempt!, {
    state: 'waiting_confirmation',
    question: 'Create the specified test file?',
    canApprove: true,
    confirmation: { proposal: '{"path":"synthetic.txt"}' },
  });
  fixture.request.mockImplementation(() => new Promise(() => {}));
  render(
    <MemoryRouter>
      <TaskWork conversationId='abcd1234' embedded />
    </MemoryRouter>
  );
  const approval = screen.getByText('workspace.work.approve');
  fireEvent.click(approval);
  fireEvent.click(approval);
  await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1));
});
test('employee model errors retain an actionable message without raw provider diagnostics', () => {
  render(
    <MessageTips
      message={{
        id: 'error1',
        conversation_id: 'abcd1234',
        type: 'tips',
        position: 'left',
        content: {
          type: 'error',
          content: 'API 401 secret endpoint',
          error: {
            code: 'USER_LLM_PROVIDER_AUTH_FAILED',
            message: 'API 401',
            detail: 'internal transport information',
          },
        },
      }}
    />
  );
  expect(screen.getByTestId('employee-chat-error').textContent).toBe('workspace.experience.aiUnavailable');
  expect(document.body.textContent).not.toMatch(/401|AUTH_FAILED|internal transport|secret endpoint/);
});
