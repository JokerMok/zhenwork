import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import EnterpriseRuntimeGate from './EnterpriseRuntimeGate';
import { useVisibleConversationIds } from '@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds';
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  useConversationListSync: () => {
    throw new Error('Host-only browse must not initialize a worker history store');
  },
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: (): null => null }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@arco-design/web-react', () => ({
  Alert: ({ content }: { content: string }) => <span>{content}</span>,
  Spin: () => <span>spinner</span>,
  Input: { TextArea: () => <textarea disabled aria-label='common.send' /> },
  Collapse: Object.assign(({ children }: React.PropsWithChildren) => <div>{children}</div>, {
    Item: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  }),
  Button: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('keeps execution unavailable while queued and automatically mounts it only after readiness', async () => {
  const ready = vi.fn();
  window.addEventListener('enterprise:core-ready', ready, { once: true });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ status: 202, json: async () => ({ phase: 'queued' }) })
    .mockResolvedValueOnce({ status: 200, json: async () => ({ ready: true, phase: 'ready' }) });
  vi.stubGlobal('fetch', fetcher);
  render(
    <EnterpriseRuntimeGate>
      <span>execution</span>
    </EnterpriseRuntimeGate>
  );
  expect(screen.queryByText('execution')).toBeNull();
  expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true);
  expect(screen.getByTestId('inline-execution-preparation')).toBeTruthy();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1050));
  });
  expect(screen.getByText('execution')).toBeTruthy();
  expect(ready).toHaveBeenCalledTimes(1);
});

test('a final failure offers an explicit retry without starting an infinite preparation loop', async () => {
  const fetcher = vi.fn().mockResolvedValue({ status: 503, json: async () => ({ error: 'CORE_START_FAILED' }) });
  vi.stubGlobal('fetch', fetcher);
  render(
    <EnterpriseRuntimeGate>
      <span>execution</span>
    </EnterpriseRuntimeGate>
  );
  await screen.findByText('workspace.status.environmentUnavailable');
  expect(screen.queryByText('execution')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('Host-only layout shortcuts can mount before an execution history provider exists', () => {
  const hook = renderHook(() => useVisibleConversationIds());
  expect(hook.result.current).toEqual([]);
});

test('a failed HTTP response without a code becomes a recoverable inline error instead of waiting forever', async () => {
  const fetcher = vi.fn().mockResolvedValue({ status: 503, json: async () => ({}) });
  vi.stubGlobal('fetch', fetcher);
  render(
    <EnterpriseRuntimeGate>
      <span>execution</span>
    </EnterpriseRuntimeGate>
  );
  await screen.findByText('workspace.status.environmentUnavailable');
  expect(screen.queryByText('spinner')).toBeNull();
  await act(async () => screen.getByText('common.retry').click());
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
