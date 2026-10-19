import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import WorkspaceGroupedHistory from '@/renderer/pages/conversation/GroupedHistory';

const historyState = vi.hoisted(() => ({ empty: false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/components/base/AionModal', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/renderer/pages/cron', () => ({ useCronJobsMap: () => ({
  getJobStatus: () => undefined, markAsRead: () => {}, setActiveConversation: () => {},
}) }));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: historyState.empty ? [] : [{ id: 'local-1', name: 'Local chat' }],
    isConversationGenerating: () => false,
    isConversationWaitingConfirmation: () => false,
    hasCompletionUnread: () => false,
    isManualUnread: () => false,
    markManualUnread: () => {}, clearManualUnread: () => {},
    expandedWorkspaces: [], pinnedConversations: [],
    timelineSections: historyState.empty ? [] : [{ timeline: 'today', items: [{ type: 'conversation',
      conversation: { id: 'local-1', name: 'Local chat' } }] }],
    handleToggleWorkspace: () => {}, collapsedSections: new Set<string>(), toggleSection: () => {},
  }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationActions', () => ({
  useConversationActions: () => ({
    renameModalVisible: false, renameModalName: '', setRenameModalName: () => {}, renameLoading: false,
    dropdownVisibleId: null, archiveProjectTarget: null, archiveProjectLoading: false,
  }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useDragAndDrop', () => ({
  useDragAndDrop: () => ({ sensors: [], handleDragEnd: () => {}, isDragEnabled: false }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationRow', async () => {
  const React = await import('react');
  return { default: ({ conversation }: { conversation: { name: string } }) =>
    React.createElement('div', null, conversation.name) };
});

afterEach(() => {
  cleanup();
  historyState.empty = false;
  delete (window as Window & { enterpriseContext?: unknown }).enterpriseContext;
  delete (window as Window & { enterpriseResources?: unknown }).enterpriseResources;
});

it('keeps the web list available when there are no desktop conversations', async () => {
  historyState.empty = true;
  const request = vi.fn(async (action: string) => {
    if (action === 'web-conversations') return { items: [{ key: 'enterprise_web:rc2:91:a1b2c3d4',
      id: 'a1b2c3d4', source: 'enterprise_web', name: 'Web only chat',
      modified_at: 1234, status: 'finished', pinned: false }], next_cursor: null };
    throw new Error(`Unexpected enterprise request: ${action}`);
  });
  Object.assign(window, { enterpriseContext: { webOrigin: 'https://workspace.example' },
    enterpriseResources: { request } });
  render(<MemoryRouter><WorkspaceGroupedHistory collapsed={false} /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: /Web only chat/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.webConversationSource' }));
  expect(screen.queryByText('conversation.history.noDesktopHistory')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.desktopConversationSource' }));
  expect(screen.queryByRole('button', { name: /Web only chat/ })).toBeNull();
  expect(screen.getByText('conversation.history.noDesktopHistory')).toBeTruthy();
});

it('shows local and owned web conversations together when local history exists', async () => {
  const request = vi.fn(async (action: string) => {
    if (action === 'web-conversations') return { items: [{
      key: 'enterprise_web:rc2:91:a1b2c3d4', id: 'a1b2c3d4', source: 'enterprise_web',
      name: 'Server chat', modified_at: 1234, status: 'finished', pinned: false,
    }], next_cursor: null };
    throw new Error(`Unexpected enterprise request: ${action}`);
  });
  Object.assign(window, { enterpriseContext: { webOrigin: 'https://workspace.example' },
    enterpriseResources: { request } });
  render(<MemoryRouter><WorkspaceGroupedHistory collapsed={false} /></MemoryRouter>);
  expect(screen.getByText('Local chat')).toBeTruthy();
  expect(await screen.findByRole('button', { name: /Server chat/ })).toBeTruthy();
  await waitFor(() => expect(request).toHaveBeenCalledWith('web-conversations'));
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.webConversationSource' }));
  expect(screen.queryByText('Local chat')).toBeNull();
  expect(screen.getByRole('button', { name: /Server chat/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.desktopConversationSource' }));
  expect(screen.getByText('Local chat')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Server chat/ })).toBeNull();
});
