/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import MarkdownView from '@/renderer/components/Markdown';
import FilePreview from '@/renderer/components/media/FilePreview';
import { mcpDisplayName, skillDisplayName, slashCommandDisplay } from '@/renderer/utils/chat/capabilityLabels';
import type { TFunction } from 'i18next';
import zhGuid from '@/renderer/services/i18n/locales/zh-CN/guid.json';
import {
  resolveWorkspaceInlineFileReference,
  splitWorkspaceFilePaths,
} from '@/renderer/components/Markdown/markdownUtils';
import { copyText } from '@/renderer/utils/ui/clipboard';

vi.mock('@/renderer/components/Markdown/ShadowView', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/common', () => ({
  ipcBridge: { fs: { getFileMetadata: { invoke: vi.fn().mockResolvedValue({ size: 139, isDirectory: false }) } } },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const workspace = '/Users/test/.aionui-enterprise/profiles/server/user/aionui/conversations/aionrs-temp-ebcef1c2';
const resultFile = `${workspace}/pilot-brief.md`;

it('opens a generated file path and reports successful copying of its absolute path', async () => {
  const onOpen = vi.fn();
  const showCopySuccess = vi.spyOn(Message, 'success').mockReturnValue(() => undefined);
  render(
    <MarkdownView autoLinkWorkspaceFiles={workspace} onLocalFileLink={onOpen}>
      {`已在当前任务目录生成 pilot-brief.md，文件路径为${resultFile}, 内容包含本次资料。`}
    </MarkdownView>
  );

  fireEvent.click(screen.getByRole('button', { name: 'pilot-brief.md' }));
  expect(onOpen).toHaveBeenCalledWith(resultFile, { filePath: resultFile, rawReference: resultFile });

  fireEvent.click(screen.getByRole('button', { name: 'preview.copyPath' }));
  expect(copyText).toHaveBeenCalledWith(resultFile);
  await waitFor(() => expect(showCopySuccess).toHaveBeenCalledWith('common.copySuccess'));
});

it('opens a generated file named in inline code without changing fenced code', () => {
  const onOpen = vi.fn();
  render(
    <MarkdownView autoLinkWorkspaceFiles={workspace} onLocalFileLink={onOpen}>
      {'已保存至 `national_day_travel_guide.md` 文件。\n\n```\nnational_day_travel_guide.md\n```'}
    </MarkdownView>
  );

  fireEvent.click(screen.getByRole('button', { name: 'national_day_travel_guide.md' }));
  const filePath = `${workspace}/national_day_travel_guide.md`;
  expect(onOpen).toHaveBeenCalledWith(filePath, { filePath, rawReference: filePath });
  expect(screen.getAllByText('national_day_travel_guide.md')).toHaveLength(2);
});

it('does not turn traversal or outside paths in inline code into local actions', () => {
  expect(resolveWorkspaceInlineFileReference('../outside.md', workspace)).toBeNull();
  expect(resolveWorkspaceInlineFileReference('/Users/test/outside.md', workspace)).toBeNull();
  expect(resolveWorkspaceInlineFileReference('https://example.com/file.md', workspace)).toBeNull();
  expect(resolveWorkspaceInlineFileReference('notes.md', undefined)).toBeNull();
});

it('keeps code, unrelated paths and workspace traversal as ordinary text', () => {
  const outside = '/Users/test/other/pilot-brief.md';
  const traversal = `${workspace}/../other/pilot-brief.md`;
  expect(splitWorkspaceFilePaths(outside, workspace)).toEqual([{ kind: 'text', value: outside }]);
  expect(splitWorkspaceFilePaths(traversal, workspace)).toEqual([{ kind: 'text', value: traversal }]);

  const markdown = [`\`${resultFile}\``, outside].join('\n\n');
  render(
    <MarkdownView autoLinkWorkspaceFiles={workspace} onLocalFileLink={vi.fn()}>
      {markdown}
    </MarkdownView>
  );
  expect(screen.queryByRole('button', { name: 'pilot-brief.md' })).toBeNull();
});

it('opens a historical attached file card through its accessible button', () => {
  const onOpen = vi.fn();
  render(<FilePreview path='/tmp/local-office-notes(2).txt' onRemove={vi.fn()} onOpen={onOpen} readonly />);

  const card = screen.getByRole('button', { name: /local-office-notes\(2\)\.txt/ });
  fireEvent.click(card);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('shows known historical skills, MCPs, and commands in Chinese while retaining their execution identifiers', () => {
  const t = ((key: string) => {
    const parts = key.split('.').slice(1);
    let value: unknown = zhGuid;
    for (const part of parts) value = (value as Record<string, unknown>)?.[part];
    return typeof value === 'string' ? value : key;
  }) as TFunction;

  expect(skillDisplayName('aionui-config', t)).toBe('工作台设置');
  expect(mcpDisplayName('rc2-enterprise-catalog', t)).toBe('企业资料检索');
  const command = slashCommandDisplay(
    { name: 'compact', description: 'Compress conversation context', kind: 'template', source: 'acp' },
    t,
    true
  );
  expect(command).toMatchObject({ label: '压缩对话', description: '压缩当前会话的上下文' });
});
