import React, { type PropsWithChildren } from 'react';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskWork from '@/renderer/pages/workspace/TaskWork';
import { mergeTaskSnapshot, useTaskWork, type WorkTask } from '@/renderer/pages/workspace/TaskWork/api';
import { enterpriseRequest } from '@/renderer/pages/workspace/workspaceApi';
import {
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';
import type { TMessage } from '@/common/chat/chatLib';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: () => true }));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseRequest: vi.fn(),
  workspaceErrorCode: (e: Error) => e.message,
}));
vi.mock('@/common', () => ({ ipcBridge: {} }));
const task = (id: string, updatedAt = 1): WorkTask => ({ id, title: id, updatedAt, attempts: [] });
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('persisted task recovery', () => {
  it('never returns the previous conversation while a new snapshot is loading', async () => {
    let finishB: (v: WorkTask) => void = () => {};
    vi.mocked(enterpriseRequest).mockImplementation((path) =>
      path.includes('switch-a')
        ? Promise.resolve(task('switch-a'))
        : new Promise((resolve) => {
            finishB = resolve as typeof finishB;
          })
    );
    const { result, rerender } = renderHook(({ id }) => useTaskWork(id), { initialProps: { id: 'switch-a' } });
    await waitFor(() => expect(result.current.task?.id).toBe('switch-a'));
    rerender({ id: 'switch-b' });
    expect(result.current.task).toBeUndefined();
    await act(async () => finishB(task('switch-b')));
    expect(result.current.task?.id).toBe('switch-b');
  });
  it('ignores a late response belonging to the conversation that was left', async () => {
    let finishA: (v: WorkTask) => void = () => {};
    vi.mocked(enterpriseRequest).mockImplementation((path) =>
      path.includes('late-a')
        ? new Promise((resolve) => {
            finishA = resolve as typeof finishA;
          })
        : Promise.resolve(task('late-b'))
    );
    const { result, rerender } = renderHook(({ id }) => useTaskWork(id), { initialProps: { id: 'late-a' } });
    rerender({ id: 'late-b' });
    await waitFor(() => expect(result.current.task?.id).toBe('late-b'));
    await act(async () => finishA(task('late-a', 99)));
    expect(result.current.task?.id).toBe('late-b');
  });
  it('retains the latest persisted state and rejects a cross-conversation payload', () => {
    const latest = task('versioned', 100);
    expect(mergeTaskSnapshot(latest, task('versioned', 90), 'versioned')).toBe(latest);
    expect(mergeTaskSnapshot(latest, task('versioned', 101), 'versioned').updatedAt).toBe(101);
    expect(() => mergeTaskSnapshot(latest, task('other', 200), 'versioned')).toThrow('TASK_SNAPSHOT_INVALID');
  });
});
describe('displayed approval identity', () => {
  const pendingTask = (id: string, confirmationId?: string, updatedAt = 1): WorkTask => ({
    ...task(id, updatedAt),
    attempts: [
      {
        id: 'same-attempt',
        round: 1,
        attempt: 1,
        updatedAt,
        state: 'waiting_confirmation',
        phase: 'awaiting_confirmation',
        canApprove: true,
        confirmation: { id: confirmationId, proposal: `Review operation ${updatedAt}` },
        steps: [],
        artifacts: [],
      },
    ],
  });

  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(Message, 'error').mockImplementation(() => () => {});
  });

  it.each(['approve', 'decline'])(
    'binds %s to the displayed confirmation after a stale decision fails',
    async (kind) => {
      const id = `approval-${kind}`;
      let snapshot = pendingTask(id, 'confirmation-one');
      const decisions: Array<{ attemptId: string; confirmationId: string; request_id: string }> = [];
      vi.mocked(enterpriseRequest).mockImplementation(async (path, init) => {
        if (init?.method === 'POST') {
          if (path !== `/enterprise/tasks/${id}/${kind}`) throw Error('UNEXPECTED_ACTION');
          decisions.push(JSON.parse(String(init.body)) as (typeof decisions)[number]);
          if (decisions.length === 1) throw Error('TASK_CONFIRMATION_CHANGED');
        }
        return snapshot;
      });
      render(
        <MemoryRouter>
          <TaskWork conversationId={id} embedded />
        </MemoryRouter>
      );
      await screen.findByText('Review operation 1');
      fireEvent.click(screen.getByRole('button', { name: `workspace.work.${kind}` }));
      const rejection = await screen.findByRole('alert');
      expect(rejection).toHaveTextContent('workspace.errors.action');
      fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'common.refresh' })).not.toBeDisabled());
      expect(screen.queryByText('workspace.work.repeatDecision')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: `workspace.work.${kind}` })).toBeDisabled();
      expect(decisions).toHaveLength(1);

      // A new confirmation in the same attempt must use its own request ID.
      snapshot = pendingTask(id, 'confirmation-two', 2);
      act(() => window.dispatchEvent(new Event('task-work:changed')));
      await screen.findByText('Review operation 2');
      fireEvent.click(screen.getByRole('button', { name: `workspace.work.${kind}` }));
      await waitFor(() => expect(decisions).toHaveLength(2));
      expect(decisions).toEqual([
        expect.objectContaining({
          attemptId: 'same-attempt',
          confirmationId: 'confirmation-one',
          request_id: expect.any(String),
        }),
        expect.objectContaining({
          attemptId: 'same-attempt',
          confirmationId: 'confirmation-two',
          request_id: expect.any(String),
        }),
      ]);
      expect(decisions[1].request_id).not.toBe(decisions[0].request_id);
    }
  );

  it('withholds decisions when the pending proposal has no confirmation identity', async () => {
    vi.mocked(enterpriseRequest).mockResolvedValue(pendingTask('unbound-approval'));
    render(
      <MemoryRouter>
        <TaskWork conversationId='unbound-approval' embedded />
      </MemoryRouter>
    );
    await screen.findByRole('status');
    expect({
      approve: screen.queryByRole('button', { name: 'workspace.work.approve' }),
      decline: screen.queryByRole('button', { name: 'workspace.work.decline' }),
    }).toEqual({ approve: null, decline: null });
    expect(vi.mocked(enterpriseRequest).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('checks a lost decision before retry, survives remount and retains its original body', async () => {
    const id = 'uncertain-decision';
    localStorage.setItem('enterprise:storage-owner', 'isolated-reviewer');
    const snapshot = pendingTask(id, 'one');
    let readable = true;
    const bodies: string[] = [];
    vi.mocked(enterpriseRequest).mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') {
        bodies.push(String(init.body));
        if (bodies.length === 1) {
          readable = false;
          throw Error('TIMEOUT');
        }
        snapshot.attempts[0].canApprove = false;
      }
      if (!readable) throw Error('NETWORK');
      return snapshot;
    });
    const card = (
      <MemoryRouter>
        <TaskWork conversationId={id} embedded />
      </MemoryRouter>
    );
    const first = render(card);
    fireEvent.click(await screen.findByRole('button', { name: 'workspace.work.approve' }));
    await screen.findByText('workspace.work.checkDecision');
    expect(screen.getByRole('button', { name: 'workspace.work.decline' })).toBeDisabled();
    first.unmount();
    readable = true;
    render(card);
    await screen.findByText('workspace.work.checkDecision');
    expect(bodies).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    await screen.findByText('workspace.work.repeatDecision');
    expect(screen.getByRole('button', { name: 'workspace.work.decline' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'workspace.work.approve' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toBe(bodies[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'workspace.work.approve' })).toBeNull());
    localStorage.removeItem('enterprise:storage-owner');
  });

  it.each(['failed', 'partial', 'cancelled'])(
    'requires reviewing the external outcome before retrying an approved write in state %s',
    async (state) => {
      const id = `${state}-approved-write`;
      const snapshot = pendingTask(id);
      snapshot.attempts[0] = {
        ...snapshot.attempts[0],
        state,
        phase: state,
        canApprove: false,
        confirmation: undefined,
        requiresExternalReview: true,
      };
      vi.mocked(enterpriseRequest).mockImplementation(async (path) => (path.includes('/feedback') ? null : snapshot));
      render(
        <MemoryRouter>
          <TaskWork conversationId={id} embedded />
        </MemoryRouter>
      );
      const retry = await screen.findByRole('button', { name: 'workspace.work.retryRemaining' });
      expect(retry).toBeDisabled();
      fireEvent.click(retry);
      expect(vi.mocked(enterpriseRequest).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      fireEvent.click(screen.getByRole('combobox', { name: 'workspace.work.externalReview' }));
      fireEvent.click(await screen.findByRole('option', { name: 'workspace.work.externalNotApplied' }));
      fireEvent.click(retry);
      await waitFor(() => {
        const sent = vi.mocked(enterpriseRequest).mock.calls.find(([, init]) => init?.method === 'POST');
        expect({ path: sent?.[0], body: JSON.parse(String(sent?.[1]?.body || '{}')) }).toMatchObject({
          path: `/enterprise/tasks/${id}/retry`,
          body: { attemptId: 'same-attempt', externalOutcome: 'not_applied' },
        });
      });
    }
  );

  it('keeps ordinary cancelled work closed when no external write needs review', async () => {
    const snapshot = pendingTask('ordinary-cancelled');
    snapshot.attempts[0] = { ...snapshot.attempts[0], state: 'cancelled', canApprove: false };
    vi.mocked(enterpriseRequest).mockResolvedValue(snapshot);
    render(
      <MemoryRouter>
        <TaskWork conversationId={snapshot.id} embedded />
      </MemoryRouter>
    );
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: 'workspace.work.retryRemaining' })).toBeNull();
  });
});
describe('existing execution event identity', () => {
  it('settles repeated tool events into one card by stable call identity', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <MessageListProvider value={[]}>{children}</MessageListProvider>
    );
    const { result } = renderHook(() => ({ add: useAddOrUpdateMessage(), messages: useMessageList() }), { wrapper });
    const event = {
      id: 'frame-one',
      conversation_id: 'event-conversation',
      msg_id: 'turn-one',
      type: 'tool_call',
      content: { call_id: 'tool-one', name: 'read_document', status: 'completed' },
    } as TMessage;
    act(() => {
      result.current.add(event);
      result.current.add({ ...event, id: 'replayed-frame' });
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].type).toBe('tool_call');
    act(() =>
      result.current.add({
        ...event,
        id: 'late-running-frame',
        content: { ...event.content, status: 'running' },
      } as TMessage)
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect((result.current.messages[0].content as { status: string }).status).toBe('completed');
  });
  it('does not reopen a settled tool group when an earlier executing event arrives', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <MessageListProvider value={[]}>{children}</MessageListProvider>
    );
    const { result } = renderHook(() => ({ add: useAddOrUpdateMessage(), messages: useMessageList() }), { wrapper });
    const event = {
      id: 'group-one',
      conversation_id: 'group-conversation',
      msg_id: 'group-turn',
      type: 'tool_group',
      content: [
        {
          call_id: 'settled-tool',
          name: 'read_document',
          description: 'read',
          render_output_as_markdown: false,
          status: 'Success',
        },
      ],
    } as TMessage;
    act(() => result.current.add(event));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    act(() =>
      result.current.add({
        ...event,
        id: 'older-group-frame',
        content: [{ ...(event.content as Array<Record<string, unknown>>)[0], status: 'Executing' }],
      } as TMessage)
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect((result.current.messages[0].content as Array<{ status: string }>)[0].status).toBe('Success');
    expect(result.current.messages).toHaveLength(1);
  });
});
