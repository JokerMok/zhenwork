import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import EnterprisePersonalSettings from '@/renderer/pages/EnterprisePersonalSettings';
import { enterpriseRequest, WorkspaceApiError } from '@/renderer/pages/workspace/workspaceApi';

const auth = vi.hoisted(() => ({ user: { id: 'employee-1' } }));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, clearAuthCache: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en-US' } }),
}));
vi.mock('@/renderer/pages/workspace/workspaceApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/pages/workspace/workspaceApi')>()),
  enterpriseRequest: vi.fn(),
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  auth.user = { id: 'employee-1' };
  vi.mocked(enterpriseRequest).mockReset();
});

test('keeps unsaved changes on conflict and uses the newer version and untouched fields on explicit save', async () => {
  const original = { version: 1, enabled: true, style: '', detail: '', language: '', instructions: '' };
  const latest = { ...original, version: 2, style: 'direct' };
  const request = vi.mocked(enterpriseRequest);
  request
    .mockResolvedValueOnce(original)
    .mockRejectedValueOnce(new WorkspaceApiError('PREFS_VERSION_CONFLICT', 'Conflict'))
    .mockResolvedValueOnce(latest)
    .mockResolvedValueOnce({ ...latest, version: 3, instructions: 'Keep replies concise.' });

  render(<EnterprisePersonalSettings section='personalization' />);
  const input = await screen.findByRole('textbox', { name: 'settings.enterpriseAccount.instructions' });
  fireEvent.change(input, { target: { value: 'Keep replies concise.' } });
  const save = screen.getByRole('button', { name: 'common.save' }) as HTMLButtonElement;
  fireEvent.click(save);

  const reload = await screen.findByRole('button', { name: 'settings.enterpriseAccount.reloadPreferences' });
  expect(save.disabled).toBe(true);
  fireEvent.click(reload);
  await waitFor(() => expect(save.disabled).toBe(false));
  expect((input as HTMLTextAreaElement).value).toBe('Keep replies concise.');
  expect(request).toHaveBeenCalledTimes(3);

  fireEvent.click(save);
  await screen.findByText('settings.enterpriseAccount.saved');
  expect(request).toHaveBeenCalledTimes(4);
  expect(JSON.parse(String(request.mock.calls[3][1]?.body))).toMatchObject({
    expectedVersion: 2,
    style: 'direct',
    instructions: 'Keep replies concise.',
  });
});

test('restores an unsaved draft for the same account and never shows it to another account', async () => {
  const original = { version: 1, enabled: true, style: '', detail: '', language: '', instructions: '' };
  const request = vi.mocked(enterpriseRequest).mockResolvedValue(original);
  const input = async () =>
    (await screen.findByRole('textbox', { name: 'settings.enterpriseAccount.instructions' })) as HTMLTextAreaElement;
  const renderSettings = () => render(<EnterprisePersonalSettings section='personalization' />);
  const first = renderSettings();
  fireEvent.change(await input(), { target: { value: 'Employee one draft' } });
  first.unmount();

  auth.user = { id: 'employee-2' };
  const second = renderSettings();
  expect((await input()).value).toBe('');
  second.unmount();

  auth.user = { id: 'employee-1' };
  const third = renderSettings();
  expect((await input()).value).toBe('Employee one draft');
  fireEvent.click(screen.getByRole('button', { name: 'settings.enterpriseAccount.discard' }));
  third.unmount();
  renderSettings();
  expect((await input()).value).toBe('');
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
