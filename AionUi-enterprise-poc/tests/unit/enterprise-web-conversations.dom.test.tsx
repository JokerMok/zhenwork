import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnterpriseWebConversations } from '@/renderer/pages/conversation/GroupedHistory/EnterpriseWebConversations';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  delete (window as Window & { enterpriseContext?: unknown }).enterpriseContext;
  delete (window as Window & { enterpriseResources?: unknown }).enterpriseResources;
});

it('shows an owned server conversation and opens its short Core ID through the desktop RPC', async () => {
  const id = 'a1b2c3d4';
  const request = vi.fn(async (action: string, args?: unknown) => {
    if (action === 'web-conversations') return { items: [{
      key: `enterprise_web:rc2:91:${id}`, id, source: 'enterprise_web',
      name: '服务端短会话', modified_at: 1234, status: 'pending', pinned: false,
    }], next_cursor: null };
    if (action === 'web-open' && (args as { id?: string })?.id === id) return { opened: true };
    throw new Error(`Unexpected enterprise request: ${action}`);
  });
  Object.assign(window, { enterpriseContext: { webOrigin: 'https://workspace.example' },
    enterpriseResources: { request } });
  render(<EnterpriseWebConversations collapsed={false} />);
  const entry = await screen.findByRole('button', { name: /服务端短会话/ });
  expect(entry.getAttribute('title')).toContain('服务端短会话');
  fireEvent.click(entry);
  await waitFor(() => expect(request).toHaveBeenCalledWith('web-open', { id }));
});

it('routes a server conversation rename and pin through the desktop RPC', async () => {
  const id = 'a1b2c3d4';
  let name = 'Server chat';
  let pinned = false;
  const request = vi.fn(async (action: string, args?: unknown) => {
    if (action === 'web-conversations') return { items: [{ key: `enterprise_web:rc2:91:${id}`, id,
      source: 'enterprise_web', name, modified_at: 1234, status: 'finished', pinned }], next_cursor: null };
    if (action === 'web-rename') { name = (args as { name: string }).name; return { updated: true }; }
    if (action === 'web-pin') { pinned = (args as { pinned: boolean }).pinned; return { updated: true }; }
    throw new Error(`Unexpected enterprise request: ${action}`);
  });
  Object.assign(window, { enterpriseContext: { webOrigin: 'https://workspace.example' },
    enterpriseResources: { request } });
  render(<EnterpriseWebConversations collapsed={false} />);
  await screen.findByRole('button', { name: /Server chat/ });
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'conversation.history.renameTitle' }),
    { target: { value: 'Renamed chat' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('web-rename', { id, name: 'Renamed chat' }));
  await screen.findByRole('button', { name: /Renamed chat/ });
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.pin' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('web-pin', { id, pinned: true }));
});

it('requires an explicit confirmation before deleting a server conversation', async () => {
  const id = 'a1b2c3d4';
  const request = vi.fn(async (action: string) => {
    if (action === 'web-conversations') return { items: [{ key: `enterprise_web:rc2:91:${id}`, id,
      source: 'enterprise_web', name: 'Delete candidate', modified_at: 1234, status: 'finished', pinned: false }],
      next_cursor: null };
    if (action === 'web-delete') return { updated: true };
    throw new Error(`Unexpected enterprise request: ${action}`);
  });
  Object.assign(window, { enterpriseContext: { webOrigin: 'https://workspace.example' },
    enterpriseResources: { request } });
  render(<EnterpriseWebConversations collapsed={false} />);
  await screen.findByRole('button', { name: /Delete candidate/ });
  fireEvent.click(screen.getByText('⋯'));
  fireEvent.click(screen.getByRole('button', { name: 'conversation.history.deleteTitle' }));
  expect(request).not.toHaveBeenCalledWith('web-delete', { id });
  fireEvent.click(screen.getAllByRole('button', { name: 'conversation.history.deleteTitle' }).at(-1)!);
  await waitFor(() => expect(request).toHaveBeenCalledWith('web-delete', { id }));
});
