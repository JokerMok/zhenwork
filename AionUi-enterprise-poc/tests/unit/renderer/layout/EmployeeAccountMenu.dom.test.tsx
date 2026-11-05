import SiderFooter from '@/renderer/components/layout/Sider/SiderFooter';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { id: 'a', username: 'alpha' },
  profile: vi.fn(),
}));

vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', user: mocks.user }),
}));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseRequest: mocks.profile,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function RouteMarker() {
  return <output>{useLocation().pathname}</output>;
}

function Footer({ logout }: { logout: () => void }) {
  return (
    <MemoryRouter>
      <SiderFooter
        isMobile
        isSettings={false}
        enterpriseWeb
        theme='light'
        siderTooltipProps={{}}
        onSettingsClick={() => {}}
        onThemeToggle={() => {}}
        onLogoutClick={logout}
      />
      <RouteMarker />
    </MemoryRouter>
  );
}

test('uses current identity, restores focus on Escape and navigates from the account menu', async () => {
  mocks.user = { id: 'a', username: 'alpha' };
  mocks.profile.mockResolvedValue({ id: 'a', nickname: 'Employee Alpha' });
  render(<Footer logout={vi.fn()} />);
  const account = await screen.findByRole('button', { name: 'Employee Alpha' });

  fireEvent.keyDown(account, { key: 'ArrowDown' });
  const profile = await screen.findByRole('menuitem', { name: 'settings.enterpriseAccount.profile' });
  await waitFor(() => expect(document.activeElement).toBe(profile));
  fireEvent.keyDown(profile, { key: 'Escape' });
  expect(document.activeElement).toBe(account);
  expect(account.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(account);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.enterpriseAccount.personalization' }));
  expect(await screen.findByText('/settings/personalization')).toBeTruthy();
});

test('does not show another employee’s profile when the authenticated account changes', async () => {
  mocks.user = { id: 'a', username: 'alpha' };
  let finishOld: (value: unknown) => void = () => {};
  mocks.profile
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ id: 'a', nickname: 'Unexpected old employee' });
  const view = render(<Footer logout={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'alpha' })).toBeTruthy();
  mocks.user = { id: 'b', username: 'bravo' };
  view.rerender(<Footer logout={vi.fn()} />);
  await act(async () => finishOld({ id: 'a', nickname: 'Previous employee' }));
  expect(screen.getByRole('button', { name: 'bravo' })).toBeTruthy();
  expect(screen.queryByText(/employee/i)).toBeNull();
});
