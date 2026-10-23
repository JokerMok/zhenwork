import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import useSWR, { SWRConfig } from 'swr';
import { afterEach, expect, test, vi } from 'vitest';
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { assistants: { list: { invoke: list } } } }));
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: () => true }));
import { useCustomAgentsLoader } from '@/renderer/pages/guid/hooks/useCustomAgentsLoader';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function setup() {
  const cache = new Map();
  const value = { provider: () => cache, dedupingInterval: 60_000, errorRetryCount: 0 };
  return ({ children }: { children: React.ReactNode }) => React.createElement(SWRConfig, { value }, children);
}
function ready(state = 'ready') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state }) });
}
test('Guid remount reads authorized resources without requesting another environment update', async () => {
  const fetch = ready();
  vi.stubGlobal('fetch', fetch);
  list.mockResolvedValue([{ id: 'zhenwork-general-office' }]);
  const wrapper = setup(),
    first = renderHook(() => useCustomAgentsLoader(), { wrapper });
  await waitFor(() => expect(first.result.current.catalogRevision).toBeGreaterThan(0));
  first.unmount();
  const returned = renderHook(() => useCustomAgentsLoader(), { wrapper });
  await waitFor(() => expect(returned.result.current.catalogLoading).toBe(false));
  expect(returned.result.current.assistants[0].id).toBe('zhenwork-general-office');
  expect(fetch.mock.calls.every(([url]) => url === '/enterprise/resources/status')).toBe(true);
  returned.unmount();
});
test('an accepted pending update retains the existing assistant and never becomes a catalog error', async () => {
  vi.stubGlobal('fetch', ready('pending'));
  list.mockResolvedValue([{ id: 'zhenwork-general-office' }]);
  const hook = renderHook(() => useCustomAgentsLoader(), { wrapper: setup() });
  await waitFor(() => expect(hook.result.current.catalogRevision).toBeGreaterThan(0));
  expect(hook.result.current.catalogError).toBeUndefined();
  expect(hook.result.current.resourceState?.state).toBe('pending');
  hook.unmount();
});
test('retry coalesces rapid clicks and performs only another read after a real preparation failure', async () => {
  const fetch = ready().mockResolvedValueOnce({
    ok: false,
    status: 503,
    json: async () => ({ error: 'CORE_UNAVAILABLE' }),
  });
  vi.stubGlobal('fetch', fetch);
  list.mockResolvedValue([{ id: 'zhenwork-general-office' }]);
  const hook = renderHook(() => useCustomAgentsLoader(), { wrapper: setup() });
  await waitFor(() => expect(hook.result.current.catalogError).toBe('CORE_UNAVAILABLE'));
  act(() => {
    hook.result.current.retryCatalog();
    hook.result.current.retryCatalog();
    hook.result.current.retryCatalog();
  });
  await waitFor(() => expect(hook.result.current.catalogError).toBeUndefined());
  expect(fetch).toHaveBeenCalledTimes(2);
  hook.unmount();
});
test('a generic assistant reader and simultaneous Guid readers do not share the wrong completion state', async () => {
  const fetch = ready();
  vi.stubGlobal('fetch', fetch);
  list.mockResolvedValue([{ id: 'zhenwork-general-office' }]);
  const hook = renderHook(
    () => {
      useSWR('assistants.list', () => Promise.resolve([]));
      return [useCustomAgentsLoader(), useCustomAgentsLoader()];
    },
    { wrapper: setup() }
  );
  await waitFor(() => expect(hook.result.current.every((x) => x.catalogRevision > 0)).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
});
test('an empty authorized catalog reports missing capability without suggesting personal API configuration', async () => {
  vi.stubGlobal('fetch', ready());
  list.mockResolvedValue([]);
  const hook = renderHook(() => useCustomAgentsLoader(), { wrapper: setup() });
  await waitFor(() => expect(hook.result.current.catalogError).toBe('NO_AVAILABLE_CAPABILITY'));
  hook.unmount();
});
