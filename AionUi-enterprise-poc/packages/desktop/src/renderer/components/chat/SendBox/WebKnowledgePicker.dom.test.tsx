import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import WebKnowledgePicker from './WebKnowledgePicker';
const control = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseControl: control,
  enterpriseRequest: request,
  workspaceErrorCode: (): string => 'DENIED',
}));
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: (): boolean => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string): string => k }) }));
vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, onClick }: React.PropsWithChildren<{ onClick?: () => void }>) => (
    <button onClick={onClick}>{children}</button>
  ),
  Modal: ({ visible, children, onOk }: React.PropsWithChildren<{ visible: boolean; onOk: () => void }>) =>
    visible ? (
      <div role='dialog'>
        {children}
        <button onClick={onOk}>Apply</button>
      </div>
    ) : null,
  Spin: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Space: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Alert: ({ content }: { content: string }) => <div role='alert'>{content}</div>,
  Empty: () => <div>empty</div>,
  Tag: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  Select: Object.assign(
    ({
      children,
      value,
      mode,
      onChange,
    }: React.PropsWithChildren<{
      value: string | string[];
      mode?: string;
      onChange: (v: unknown) => void;
    }>) => (
      <select
        aria-label={mode || 'base'}
        multiple={mode === 'multiple'}
        value={value}
        onChange={(e) =>
          onChange(mode === 'multiple' ? [...e.target.selectedOptions].map((x) => x.value) : e.target.value)
        }
      >
        {children}
      </select>
    ),
    {
      Option: ({ children, value }: React.PropsWithChildren<{ value: string }>) => (
        <option value={value}>{children}</option>
      ),
    }
  ),
  Message: { error: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const id = '11111111-1111-4111-8111-111111111111';
function fixtures() {
  request.mockResolvedValue({ scope: { baseIds: [id], documents: [] } });
  control.mockImplementation(async (path: string) =>
    path.includes('/documents')
      ? []
      : [{ id, name: 'Organization products', source: 'ORGANIZATION', actions: ['VIEW', 'USE'] }]
  );
}
test('conversation scope is restored and saved through actor-authenticated Host metadata', async () => {
  fixtures();
  render(<WebKnowledgePicker conversationId='c1' />);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/enterprise/knowledge-scope/c1'));
  fireEvent.click(screen.getByText('workspace.knowledge.taskScope'));
  await screen.findByRole('dialog');
  await screen.findAllByText(/Organization products/);
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/enterprise/knowledge-scope/c1', {
      method: 'PUT',
      body: JSON.stringify({ baseIds: [id], documents: [] }),
    })
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
test('revoked scope save leaves the editor open for correction', async () => {
  fixtures();
  render(<WebKnowledgePicker conversationId='c2' />);
  await waitFor(() => expect(request).toHaveBeenCalled());
  fireEvent.click(screen.getByText('workspace.knowledge.taskScope'));
  await screen.findAllByText(/Organization products/);
  request.mockRejectedValueOnce(new Error('permission changed'));
  await act(async () => fireEvent.click(screen.getByText('Apply')));
  await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).toBeTruthy();
});
