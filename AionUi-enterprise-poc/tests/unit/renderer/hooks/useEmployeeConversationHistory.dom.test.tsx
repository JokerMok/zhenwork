import { ipcBridge } from '@/common';
import {
  setConversationListEmployee,
  useConversationListSync,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: () => true }));
vi.mock('@/renderer/utils/emitter', () => ({ addEventListener: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getUserConversations: { invoke: vi.fn() } },
    application: { writeRendererLog: { invoke: vi.fn().mockResolvedValue(undefined) } },
    conversation: {
      listChanged: { on: vi.fn() },
      responseStream: { on: vi.fn() },
      turnCompleted: { on: vi.fn() },
      confirmation: { remove: { on: vi.fn() } },
    },
  },
}));

test('history retries a failed page and appends one bounded window without duplicate rows', async () => {
  const request = vi.mocked(ipcBridge.database.getUserConversations.invoke);
  const page = (ids: string[], hasMore: boolean) => ({
    items: ids.map((id) => ({ id, name: id })),
    total: 3,
    has_more: hasMore,
  }) as Awaited<ReturnType<typeof request>>;
  request
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(page(['aaaaaaaa', 'bbbbbbbb'], true))
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(page(['bbbbbbbb', 'cccccccc'], false));

  setConversationListEmployee('a');
  const { result } = renderHook(() => useConversationListSync());
  expect(result.current.historyLoading).toBe(true);
  await waitFor(() => expect(result.current.historyError).toBe('REQUEST_FAILED'));
  expect(result.current.conversations).toEqual([]);

  act(() => result.current.retryHistory());
  await waitFor(() => expect(result.current.historyHasMore).toBe(true));
  act(() => result.current.loadMoreHistory());
  await waitFor(() => expect(result.current.historyError).toBe('REQUEST_FAILED'));
  expect(result.current.conversations.map(({ id }) => id)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  act(() => result.current.retryHistory());
  await waitFor(() =>
    expect(result.current.conversations.map(({ id }) => id)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
  );
  expect(request).toHaveBeenLastCalledWith({ cursor: 'bbbbbbbb', limit: 100 });
  expect(result.current.historyHasMore).toBe(false);
  act(() => setConversationListEmployee(null));
});

test('switching employees clears rendered history before the new read and ignores a prior response', async () => {
  const request = vi.mocked(ipcBridge.database.getUserConversations.invoke);
  let resolveOld: (value: Awaited<ReturnType<typeof request>>) => void = () => {};
  request
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ items: [], total: 0, has_more: false });
  const { result } = renderHook(() => useConversationListSync());
  act(() => setConversationListEmployee('a'));
  act(() => setConversationListEmployee('b'));
  expect(result.current.conversations).toEqual([]);
  await waitFor(() => expect(result.current.historyLoading).toBe(false));
  await act(async () => resolveOld({
    items: [{ id: 'aaaaaaaa', name: 'Previous employee' }],
    total: 1,
    has_more: false,
  } as Awaited<ReturnType<typeof request>>));
  expect(result.current.conversations).toEqual([]);
  act(() => setConversationListEmployee(null));
});
