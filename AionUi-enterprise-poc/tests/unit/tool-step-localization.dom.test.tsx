import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'conversation.toolSteps.view': '查看步骤',
        'conversation.toolSteps.read': '读取文件',
        'conversation.toolSteps.write': '写入文件',
        'conversation.toolSteps.skill': '使用技能',
        'conversation.toolSteps.search': '搜索',
        'conversation.toolSteps.input': '输入',
        'conversation.toolSteps.output': '输出',
      })[key] ?? key,
  }),
}));

afterEach(cleanup);

it('shows the completed task steps in Chinese while retaining their original diagnostic output', () => {
  const messages = [
    {
      type: 'tool_group',
      content: [
        { name: 'Read', call_id: 'read-1', status: 'Success', description: 'source.md', result_display: '读取成功' },
        { name: 'search', call_id: 'search-1', status: 'Success', description: '企业资料检索' },
        { name: 'Skill', call_id: 'skill-1', status: 'Success', description: 'enterprise-succinct' },
        { name: 'Write', call_id: 'write-1', status: 'Success', description: 'result.md' },
      ],
    },
  ] as unknown as ToolMessage[];

  render(<MessageToolGroupSummary messages={messages} />);
  fireEvent.click(screen.getByText(/查看步骤/));

  expect(screen.getByText('读取文件')).toBeTruthy();
  expect(screen.getByText('搜索')).toBeTruthy();
  expect(screen.getByText('使用技能')).toBeTruthy();
  expect(screen.getByText('写入文件')).toBeTruthy();
  fireEvent.click(screen.getByText('读取文件'));
  expect(screen.getByText('输入')).toBeTruthy();
  expect(screen.getByText('输出')).toBeTruthy();
  expect(screen.getByText('读取成功')).toBeTruthy();
});
