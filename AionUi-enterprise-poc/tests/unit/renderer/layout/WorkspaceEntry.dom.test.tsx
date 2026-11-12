import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import WorkspaceHome from '@/renderer/pages/workspace/WorkspaceHome';
import WorkspaceTasks from '@/renderer/pages/workspace/WorkspaceTasks';
import { enterpriseRequest } from '@/renderer/pages/workspace/workspaceApi';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }));
vi.mock('@/renderer/components/layout/enterpriseBrand', () => ({
  requestEnterpriseBrand: async () => ({ productName: 'ZhenWork' }),
}));
vi.mock('@/renderer/pages/workspace/TaskWork', () => ({
  default: ({ conversationId }: { conversationId: string }) => <output>{conversationId}</output>,
}));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseRequest: vi.fn(),
  workspaceErrorCode: () => 'UNAVAILABLE',
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Location() {
  const location = useLocation();
  return <output data-testid='location'>{location.pathname + location.search}</output>;
}

function Draft() {
  const location = useLocation();
  return <output>{location.state?.prefillPrompt}</output>;
}

test('home examples are named buttons and open the new task with a draft', async () => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  render(
    <MemoryRouter>
      <Routes>
        <Route path='/' element={<WorkspaceHome />} />
        <Route path='/guid' element={<Draft />} />
      </Routes>
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: /workspace\.examples\.reimbursement\.title/ }));
  expect(await screen.findByText('workspace.examples.reimbursement.prompt')).toBeTruthy();
});

test('task details are linked by URL while ordinary conversations are not shown as unknown tasks', async () => {
  vi.mocked(enterpriseRequest)
    .mockResolvedValueOnce({ items: [{ id: 'chat-b', name: 'Ordinary chat' }] })
    .mockResolvedValueOnce({
      items: [{ id: 'task-a', title: 'Executed task', updatedAt: 1, attempts: [{ state: 'waiting_input' }] }],
    });
  render(
    <MemoryRouter initialEntries={['/workspace?section=tasks']}>
      <WorkspaceTasks />
      <Location />
    </MemoryRouter>
  );
  expect(await screen.findByText('conversation.history.conversationsSection')).toBeTruthy();
  expect(screen.getByText('workspace.work.states.waiting_input')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'workspace.work.details' }));
  expect(screen.getByTestId('location').textContent).toBe('/workspace?section=tasks&task=task-a');
  expect(screen.getByText('task-a')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workspace?section=tasks'));
});
