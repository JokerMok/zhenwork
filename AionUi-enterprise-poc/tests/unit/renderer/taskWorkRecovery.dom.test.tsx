import React, { type PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeTaskSnapshot, useTaskWork, type WorkTask } from '@/renderer/pages/workspace/TaskWork/api';
import { enterpriseRequest } from '@/renderer/pages/workspace/workspaceApi';
import {
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';
import type { TMessage } from '@/common/chat/chatLib';
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: () => true }));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseRequest: vi.fn(),
  workspaceErrorCode: (e: Error) => e.message,
}));
vi.mock('@/common', () => ({ ipcBridge: {} }));
const task = (id: string, updatedAt = 1): WorkTask => ({ id, title: id, updatedAt, attempts: [] });
afterEach(() => {
  cleanup();
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
