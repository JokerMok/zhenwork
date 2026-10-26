import { toolDeliveryReceipts } from '../../../packages/desktop/src/common/chat/normalizeToolCall';
import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import { normalizeAcpToolCall } from '@/common/chat/normalizeToolCall';

describe('normalizeToolCall', () => {
  it('normalizes compact snake_case acp tool calls from history responses', () => {
    const result = normalizeAcpToolCall({
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
    } as unknown as IMessageAcpToolCall);

    expect(result).toMatchObject({
      key: 'tool-1',
      name: 'rg',
      status: 'completed',
      description: '"needle" in .',
      output: 'preview',
      truncated: true,
      messageId: 'message-1',
      conversationId: 'conversation-1',
    });
  });

  it('ignores malformed ACP content items in compact history output', () => {
    const result = normalizeAcpToolCall({
      id: 'message-2',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-2',
          status: 'completed',
          title: 'Edit file',
          kind: 'edit',
          content: [null, 'invalid', { type: 'diff', path: '/workspace/file.ts', old_text: 'old', new_text: 'new' }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.output).toBe('[diff] /workspace/file.ts');
  });
});

describe('verified tool delivery receipts', () => {
  it('keeps partial output failures and replaces a later successful retry by path', () => {
    const output = (outputs: unknown[]) => ({
      key: 'call',
      name: 'create_evidence_deliverables',
      status: 'completed' as const,
      output: JSON.stringify({ outputs }),
    });
    const digest = 'a'.repeat(64);
    expect(
      toolDeliveryReceipts([
        output([
          { path: 'report.docx', status: 'complete', sha256: digest },
          { path: 'table.xlsx', status: 'failed', error: 'DENIED' },
        ]),
      ]).map((file) => file.status)
    ).toEqual(['complete', 'failed']);
    expect(
      toolDeliveryReceipts([
        output([{ path: 'table.xlsx', status: 'failed' }]),
        output([{ path: 'table.xlsx', status: 'complete', sha256: digest }]),
      ])
    ).toEqual([{ path: 'table.xlsx', status: 'complete' }]);
  });
  it('does not turn prose or unchecked/foreign paths into downloadable successes', () => {
    const tool = {
      key: 'a',
      name: 'tool',
      status: 'completed' as const,
      output: JSON.stringify({
        outputs: [
          { path: '../other/file.xlsx', status: 'complete', sha256: 'a'.repeat(64) },
          { path: 'missing.xlsx', status: 'complete' },
        ],
      }),
    };
    expect(toolDeliveryReceipts([tool])).toEqual([]);
  });
});


it('uses the saved artifact version and actual appended heading in delivery receipts', () => {
  const receipts = toolDeliveryReceipts([{ key: 'revision', name: 'revise_office_document', status: 'completed', output: JSON.stringify({ path: 'actual.docx', sha256: 'a'.repeat(64), downloadUrl: 'https://workspace.example/enterprise/files/download?path=actual.docx', version: 3, versionId: '11111111-1111-4111-8111-111111111111', inspection: { headingCount: 6, tables: [{ rows: 3, columns: 2 }] }, changes: [{ kind: 'append_section', actualHeading: '6 核实资料' }] }) }]);
  expect(receipts[0]).toMatchObject({ path: 'actual.docx', version: 3, versionId: '11111111-1111-4111-8111-111111111111', headingCount: 6, tableCount: 1, addedHeadings: ['6 核实资料'] });
});
