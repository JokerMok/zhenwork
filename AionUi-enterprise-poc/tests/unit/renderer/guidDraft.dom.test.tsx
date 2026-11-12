import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useGuidInput } from '@/renderer/pages/guid/hooks/useGuidInput';

vi.mock('@/renderer/hooks/file/useDragUpload', () => ({
  useDragUpload: () => ({ isFileDragging: false, dragHandlers: {} }),
}));
vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({ onPaste: vi.fn(), onFocus: vi.fn() }),
}));

function DraftRoute({ scope }: { scope: string }) {
  const location = useLocation();
  const input = useGuidInput({
    locationState: location.state,
    employeeDraft: { scope, location },
  });
  return (
    <>
      <input aria-label='Body' value={input.input} onChange={(event) => input.setInput(event.target.value)} />
      <input aria-label='Directory' value={input.dir} onChange={(event) => input.setDir(event.target.value)} />
      <output aria-label='Attachments'>{input.files.map((file) => 'path' in file && file.path).join(',')}</output>
      <button onClick={() => input.handleRemoveFile('/uploads/stock-v1.xlsx')}>Remove version</button>
      <button onClick={() => input.handleFilesUploaded(['/uploads/added.txt'])}>Attach</button>
      <button onClick={() => input.discardDraft?.()}>Discard</button>
    </>
  );
}

function DraftRoutes({ scope }: { scope: string }) {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/elsewhere')}>Leave</button>
      <button onClick={() => navigate(-1)}>Back</button>
      <Routes>
        <Route path='/guid' element={<DraftRoute scope={scope} />} />
        <Route path='/elsewhere' element={<div>Other page</div>} />
      </Routes>
    </>
  );
}

const versionEntry = {
  pathname: '/guid',
  key: 'version',
  state: { prefillPrompt: 'Use version 1', prefillFiles: ['/uploads/stock-v1.xlsx'], workspace: '/previous' },
};

function draftRouter(scope: string, entry: string | typeof versionEntry) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <DraftRoutes scope={scope} />
    </MemoryRouter>
  );
}

function leaveAndReturn() {
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.queryByLabelText('Body')).toBeNull();
  fireEvent.click(screen.getByText('Back'));
}

describe('employee Guid draft across route mounts', () => {
  it('restores ordinary text and workspace after leaving', () => {
    sessionStorage.clear();
    render(draftRouter('employee-1', '/guid'));
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Ordinary draft' } });
    fireEvent.change(screen.getByLabelText('Directory'), { target: { value: '/chosen' } });
    leaveAndReturn();
    expect(screen.getByLabelText('Body')).toHaveProperty('value', 'Ordinary draft');
    expect(screen.getByLabelText('Directory')).toHaveProperty('value', '/chosen');
  });

  it('preserves edits and attachment changes on return and reload of a version prefill', () => {
    sessionStorage.clear();
    const initial = render(draftRouter('employee-1', versionEntry));
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Compare the fixed version' } });
    fireEvent.click(screen.getByText('Remove version'));
    fireEvent.click(screen.getByText('Attach'));
    leaveAndReturn();
    expect(screen.getByLabelText('Body')).toHaveProperty('value', 'Compare the fixed version');
    expect(screen.getByLabelText('Attachments').textContent).toBe('/uploads/added.txt');

    initial.unmount();
    render(draftRouter('employee-1', versionEntry));
    expect(screen.getByLabelText('Body')).toHaveProperty('value', 'Compare the fixed version');
    expect(screen.getByLabelText('Attachments').textContent).toBe('/uploads/added.txt');
  });

  it('isolates employees and clears only the discarded draft without replaying prefill', () => {
    sessionStorage.clear();
    const view = render(draftRouter('employee-1', versionEntry));
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Employee 1 edits' } });
    view.rerender(draftRouter('employee-2', '/guid'));
    expect(screen.getByLabelText('Body')).not.toHaveProperty('value', 'Employee 1 edits');
    view.rerender(draftRouter('employee-1', versionEntry));
    fireEvent.click(screen.getByText('Discard'));
    leaveAndReturn();
    expect(screen.getByLabelText('Body')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Attachments').textContent).toBe('');
  });
});
