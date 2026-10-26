import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import MessageToolGroupSummary, { TaskDeliverySummary } from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

vi.mock('@/renderer/utils/platform', async () => ({ ...await vi.importActual('@/renderer/utils/platform'), isEnterpriseWeb: () => true }));

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessage: {
        invoke: vi.fn(),
      },
    },
  },
}));

describe('MessageToolGroupSummary', () => {
  it('loads full tool content when expanding a compact history item', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockResolvedValue({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'full output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: {
                truncated: true,
                original_size: 90000,
                preview_chars: 4096,
              },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
                raw_input: { pattern: 'needle', path: '.' },
                content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    fireEvent.click(screen.getByText('conversation.toolSteps.view · 1'));
    fireEvent.click(screen.getByText('rg'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        conversation_id: 'conversation-1',
        message_id: 'message-1',
      });
    });
    expect(await screen.findByText('full output')).toBeInTheDocument();
  });
});


it('shows actual server revision structure and downloads the saved version rather than latest', () => {
  const open = vi.spyOn(window,'open').mockImplementation(() => null);
  const message = { id: 'receipt', conversation_id: 'conversation-1', type: 'tool_call', content: { call_id: 'revision-call', name: 'revise_office_document', status: 'completed', output: JSON.stringify({ path: 'actual.docx', sha256: 'a'.repeat(64), downloadUrl: 'https://workspace.example/enterprise/files/download?path=actual.docx', version: 3, versionId: '11111111-1111-4111-8111-111111111111', inspection: { headingCount: 6, tables: [{rows:2,columns:2}] }, changes: [{kind:'append_section',actualHeading:'6 核实资料'}] }) } } as ToolMessage;
  render(<MemoryRouter><TaskDeliverySummary messages={[message]} processing={false} /></MemoryRouter>);
  expect(screen.getByText('actual.docx')).toBeInTheDocument();
  expect(screen.getByText('v3')).toBeInTheDocument();
  expect(screen.getByText('6 核实资料')).toBeInTheDocument();
  fireEvent.click(screen.getByText('workspace.files.download'));
  expect(open).toHaveBeenCalledWith('/enterprise/files/download?path=actual.docx&version=11111111-1111-4111-8111-111111111111','_blank','noopener,noreferrer');
  open.mockRestore();
});
