import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
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
test('an enterprise Guid remount retains successful refresh freshness during SWR deduplication', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  list.mockResolvedValue([{ id: 'zhenwork-general-office' }]);
  const wrapper = setup();
  const first = renderHook(() => useCustomAgentsLoader(), { wrapper });
  await waitFor(() => expect(first.result.current.catalogRevision).toBeGreaterThan(0));
  const revision = first.result.current.catalogRevision;
  first.unmount();
  const returned = renderHook(() => useCustomAgentsLoader(), { wrapper });
  await waitFor(() => expect(returned.result.current.catalogLoading).toBe(false));
  expect(returned.result.current.catalogRevision).toBeGreaterThanOrEqual(revision);
  expect(returned.result.current.assistants[0].id).toBe('zhenwork-general-office');
  returned.unmount();
});
test('a rejected configuration refresh exposes its error without marking stale data ready', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'RESOURCE_REFRESH_FAILED' }) })
  );
  const hook = renderHook(() => useCustomAgentsLoader(), { wrapper: setup() });
  await waitFor(() => expect(hook.result.current.catalogError).toBe('RESOURCE_REFRESH_FAILED'));
  expect(hook.result.current.catalogRevision).toBe(0);
  hook.unmount();
});

test('a generic assistant catalog reader cannot consume the enterprise refresh completion', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  list.mockResolvedValue([{ id: 'zhenwork-general-office' }]);
  const hook = renderHook(() => {
    // Sidebar/assistant metadata is already mounted before Guid in the app.
    useSWR('assistants.list', () => Promise.resolve([{ id: 'zhenwork-general-office' }]));
    return useCustomAgentsLoader();
  }, { wrapper: setup() });
  await waitFor(() => expect(hook.result.current.catalogRevision).toBeGreaterThan(0));
  expect(hook.result.current.assistants[0].id).toBe('zhenwork-general-office');
  hook.unmount();
});
