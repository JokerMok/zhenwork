import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import LoginPage from '@/renderer/pages/login';
const auth = vi.hoisted(() => ({ status: 'unauthenticated', login: vi.fn() }));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/renderer/services/i18n', () => ({ changeLanguage: vi.fn() }));
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: () => true }));
const Destination = () => <output data-testid='route'>{useLocation().pathname}</output>;
beforeEach(() => {
  localStorage.clear();
  auth.status = 'unauthenticated';
  auth.login.mockResolvedValue({ success: true });
});
afterEach(cleanup);
test('legacy reversible passwords are removed and never restored into the login field', () => {
  localStorage.setItem('rememberMe', 'true');
  localStorage.setItem('rememberedPassword', btoa('synthetic-credential').split('').reverse().join(''));
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
  expect((screen.getByLabelText('login.password') as HTMLInputElement).value).toBe('');
  expect(localStorage.getItem('rememberedPassword')).toBeNull();
});
test('remember account stores only the account and goes directly to the enterprise workbench', async () => {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <LoginPage />
      <Destination />
    </MemoryRouter>
  );
  fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'employee' } });
  fireEvent.change(screen.getByLabelText('login.password'), {
    target: { value: 'synthetic-credential' },
  });
  fireEvent.submit(document.querySelector('form')!);
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/workspace'));
  expect(localStorage.getItem('rememberedAccount')).toBe('employee');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-credential');
});
test('authentication returns to the requested conversation rather than the homepage', async () => {
  auth.status = 'authenticated';
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/conversation/abcd1234' } }]}>
      <Routes>
        <Route path='/login' element={<LoginPage />} />
        <Route path='*' element={<Destination />} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/conversation/abcd1234'));
});

test('last successful enterprise account is restored without a remembered password or opt-in', () => {
  localStorage.setItem('rememberedAccount', 'previous-employee');
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
  expect((screen.getByLabelText('login.username') as HTMLInputElement).value).toBe('previous-employee');
  expect((screen.getByLabelText('login.password') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByText('login.clearAccount'));
  expect(localStorage.getItem('rememberedAccount')).toBeNull();
});
