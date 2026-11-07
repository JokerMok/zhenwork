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
  Button: ({ children, onClick, disabled, ref, 'aria-label': label }: React.ComponentProps<'button'>) => (
    <button ref={ref} disabled={disabled} aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
  Modal: ({
    visible,
    children,
    onOk,
    onCancel,
    afterClose,
    okButtonProps,
  }: React.PropsWithChildren<{
    visible: boolean;
    onOk: () => void;
    onCancel: () => void;
    afterClose: () => void;
    okButtonProps: { disabled: boolean };
  }>) =>
    visible ? (
      <div
        role='dialog'
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onCancel();
            afterClose();
          }
        }}
      >
        {children}
        <button disabled={okButtonProps.disabled} onClick={onOk}>
          Apply
        </button>
        <button
          onClick={() => {
            onCancel();
            afterClose();
          }}
        >
          Cancel
        </button>
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
      'aria-label': label,
    }: React.PropsWithChildren<{
      value: string | string[];
      mode?: string;
      'aria-label'?: string;
      onChange: (v: unknown) => void;
    }>) => (
      <select
        aria-label={label || mode || 'base'}
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
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
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
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await screen.findAllByText(/Organization products/);
  request.mockRejectedValueOnce(new Error('permission changed'));
  await act(async () => fireEvent.click(screen.getByText('Apply')));
  await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('inherited defaults remain unset instead of becoming explicit empty selections', async () => {
  fixtures();
  request.mockResolvedValue({ scope: null });
  render(<WebKnowledgePicker conversationId='default' />);
  await screen.findByText('workspace.knowledge.inheritedLabel');
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await screen.findAllByText(/Organization products/);
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(request.mock.calls.every((call) => !call[1])).toBe(true);
});

test('explicitly excluding knowledge sends empty arrays and can be reset to inherited defaults', async () => {
  fixtures();
  render(<WebKnowledgePicker conversationId='reset' />);
  await screen.findByText('workspace.knowledge.selectionLabel');
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await screen.findAllByText(/Organization products/);
  fireEvent.click(screen.getByRole('button', { name: 'workspace.knowledge.scopeNone' }));
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/enterprise/knowledge-scope/reset', {
      method: 'PUT',
      body: JSON.stringify({ baseIds: [], documents: [] }),
    })
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await screen.findAllByText(/Organization products/);
  fireEvent.click(screen.getByRole('button', { name: 'workspace.knowledge.inheritedLabel' }));
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/enterprise/knowledge-scope/reset', { method: 'DELETE' }));
});

test('Escape discards picker edits, retains saved selection and returns focus to its trigger', async () => {
  fixtures();
  render(<WebKnowledgePicker conversationId='cancel' />);
  await screen.findByText('workspace.knowledge.selectionLabel');
  const trigger = screen.getByRole('button', { name: /workspace.knowledge.taskScope/ });
  fireEvent.click(trigger);
  await screen.findAllByText(/Organization products/);
  fireEvent.click(screen.getByRole('button', { name: 'workspace.knowledge.scopeNone' }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger.textContent).toBe('workspace.knowledge.selectionLabel');
  expect(document.activeElement).toBe(trigger);
  expect(request.mock.calls.every((call) => !call[1])).toBe(true);
});

test('switching libraries rejects an older document response', async () => {
  fixtures();
  const second = '22222222-2222-4222-8222-222222222222';
  let finish: (value: unknown) => void = () => {};
  control.mockImplementation(async (path: string) =>
    path.includes('/documents')
      ? path.includes(id)
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : [{ id: 'new-doc', title: 'Current library document', version: 2, status: 'READY' }]
      : [
          { id, name: 'First', actions: ['USE'] },
          { id: second, name: 'Second', actions: ['USE'] },
        ]
  );
  render(<WebKnowledgePicker conversationId='libraries' />);
  await screen.findByText('workspace.knowledge.selectionLabel');
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await waitFor(() => expect(control).toHaveBeenCalledWith(`/ai/knowledge/${id}/documents?page=1`));
  fireEvent.change(screen.getByRole('combobox', { name: 'workspace.knowledge.documentBase' }), {
    target: { value: second },
  });
  await screen.findByRole('option', { name: /Current library document/ });
  await act(async () => finish([{ id: 'old-doc', title: 'Stale document', version: 1, status: 'READY' }]));
  expect(screen.queryByRole('option', { name: /Stale document/ })).toBeNull();
});

test('a fixed document replaces its whole-library selection and keeps the selected version', async () => {
  fixtures();
  const doc = '33333333-3333-4333-8333-333333333333';
  control.mockImplementation(async (path: string) =>
    path.includes('/documents')
      ? [{ id: doc, title: 'Versioned source', version: 4, status: 'READY' }]
      : [{ id, name: 'Library', actions: ['USE'] }]
  );
  render(<WebKnowledgePicker conversationId='fixed-version' />);
  await screen.findByText('workspace.knowledge.selectionLabel');
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await screen.findByRole('option', { name: /Versioned source/ });
  fireEvent.change(screen.getByRole('listbox', { name: 'workspace.knowledge.selectedFiles' }), {
    target: { value: `${doc}:4` },
  });
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/enterprise/knowledge-scope/fixed-version', {
      method: 'PUT',
      body: JSON.stringify({ baseIds: [], documents: [{ baseId: id, documentId: doc, version: 4 }] }),
    })
  );
});

test('a failed save retains its draft and allows a corrected selection to be saved', async () => {
  fixtures();
  render(<WebKnowledgePicker conversationId='retry-save' />);
  await screen.findByText('workspace.knowledge.selectionLabel');
  fireEvent.click(screen.getByRole('button', { name: /workspace.knowledge.taskScope/ }));
  await screen.findAllByText(/Organization products/);
  request.mockRejectedValueOnce(new Error('revoked'));
  fireEvent.click(screen.getByText('Apply'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'workspace.knowledge.scopeNone' }));
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/enterprise/knowledge-scope/retry-save', {
      method: 'PUT',
      body: JSON.stringify({ baseIds: [], documents: [] }),
    })
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
