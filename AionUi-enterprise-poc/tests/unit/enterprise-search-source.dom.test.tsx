import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';

const searchInvoke = vi.hoisted(() => vi.fn());
vi.mock('@/common', () => ({ ipcBridge: { database: { searchConversationMessages: { invoke: searchInvoke } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key,
  i18n: { language: 'zh-CN' } }) }));
vi.mock('@/renderer/components/base/AionModal', () => ({ default: ({ visible, children }: {
  visible: boolean; children: React.ReactNode }) => visible ? <div>{children}</div> : null }));
vi.mock('@/renderer/components/base', () => ({ AionSearchInput: ({ value, onChange }: {
  value: string; onChange: (value: string) => void }) =>
  <input aria-label='search-input' value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({ usePresetAssistantInfo: () => ({ info: undefined }) }));
vi.mock('@/renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}), resolveAgentLogo: () => undefined }));

afterEach(() => {
  cleanup();
  searchInvoke.mockReset();
  delete (window as Window & { enterpriseContext?: unknown }).enterpriseContext;
  delete (window as Window & { enterpriseResources?: unknown }).enterpriseResources;
});

it('keeps a slower old desktop result out of a newer source filtered search', async () => {
  const pending = new Map<string, (value: unknown) => void>();
  searchInvoke.mockImplementation(({ keyword }: { keyword: string }) =>
    new Promise((resolve) => pending.set(keyword, resolve)));
  Object.assign(window, { enterpriseContext: { webOrigin: 'https://workspace.example' },
    enterpriseResources: { request: async (action: string) => {
      if (action === 'web-search') return { items: [], has_more: false };
      throw new Error(`Unexpected ${action}`);
    } } });
  render(<MemoryRouter><ConversationSearchPopover renderTrigger={({ onClick }) =>
    <button type='button' onClick={onClick}>Open</button>} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'search-input' }), { target: { value: 'old' } });
  await waitFor(() => expect(pending.has('old')).toBe(true));
  fireEvent.change(screen.getByRole('textbox', { name: 'search-input' }), { target: { value: 'new' } });
  await waitFor(() => expect(pending.has('new')).toBe(true));
  const result = (name: string, id: string) => ({ items: [{ message_id: id, message_created_at: 1234,
    preview_text: name, conversation: { id, name, type: 'agent' } }], has_more: false });
  pending.get('new')!(result('New chat', 'bbbbbbbb'));
  expect(await screen.findByText('New chat')).toBeTruthy();
  await act(async () => { pending.get('old')!(result('Old chat', 'aaaaaaaa')); });
  expect(screen.queryByText('Old chat')).toBeNull();
  expect(screen.getByText('New chat')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.webConversationSource' }));
  expect(screen.queryByText('New chat')).toBeNull();
});
