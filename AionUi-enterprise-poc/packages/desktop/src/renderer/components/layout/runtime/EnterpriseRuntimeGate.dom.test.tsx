import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import EnterpriseRuntimeGate from './EnterpriseRuntimeGate';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@arco-design/web-react', () => ({
  Alert: ({ content }: { content: string }) => <span>{content}</span>,
  Spin: () => <span>spinner</span>,
  Collapse: Object.assign(({children}:React.PropsWithChildren)=><div>{children}</div>, {Item:({children}:React.PropsWithChildren)=><div>{children}</div>}),
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
