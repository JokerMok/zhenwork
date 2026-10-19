/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { vi, expect, it } from 'vitest';
import { useDragUpload } from '@/renderer/hooks/file/useDragUpload';
import { useGuidInput } from '@/renderer/pages/guid/hooks/useGuidInput';

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: { getFileMetadata: { invoke: vi.fn(async () => ({ isDirectory: true })) } },
    application: { writeRendererLog: { invoke: vi.fn(async () => undefined) } },
  },
}));

vi.mock('@renderer/services/FileService', () => ({
  FileService: { processDroppedFiles: vi.fn() },
  isSupportedFile: vi.fn(() => true),
  allSupportedExts: [],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({ onPaste: vi.fn(), onFocus: vi.fn() }),
}));

const FolderDrop = ({ onFolder, onChildDrop }: { onFolder: (folders: string[]) => void; onChildDrop: () => void }) => {
  const { dragHandlers } = useDragUpload({ onFoldersAdded: onFolder });
  return (
    <div onDragOverCapture={dragHandlers.onDragOver} onDropCapture={dragHandlers.onDrop}>
      <div data-testid='editor' onDrop={onChildDrop} />
    </div>
  );
};

it('accepts a Finder folder item before Files appears in types and adds it once', async () => {
  const folder = new File([], 'sample-folder');
  const onFolder = vi.fn();
  const onChildDrop = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { getPathForFile: () => '/tmp/sample-folder' },
  });
  const dataTransfer = {
    types: [],
    items: [{ kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) }],
    files: { length: 1, item: () => folder },
  };

  render(<FolderDrop onFolder={onFolder} onChildDrop={onChildDrop} />);
  fireEvent.dragOver(screen.getByTestId('editor'), { dataTransfer });
  fireEvent.drop(screen.getByTestId('editor'), { dataTransfer });

  await waitFor(() => expect(onFolder).toHaveBeenCalledWith(['/tmp/sample-folder']));
  expect(onFolder).toHaveBeenCalledTimes(1);
  expect(onChildDrop).not.toHaveBeenCalled();
});

it('keeps a folder dropped on the new conversation page as one local first-turn attachment', async () => {
  const folder = new File([], 'sample-folder');
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { getPathForFile: () => '/tmp/sample-folder' },
  });
  const dataTransfer = {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) }],
    files: { length: 1, item: () => folder },
  };
  const NewConversation = () => {
    const { dragHandlers, files } = useGuidInput({ locationState: null });
    return (
      <div onDragOverCapture={dragHandlers.onDragOver} onDropCapture={dragHandlers.onDrop}>
        <div data-testid='new-conversation' {...dragHandlers} />
        <output data-testid='first-turn-files'>{JSON.stringify(files)}</output>
      </div>
    );
  };

  render(<NewConversation />);
  fireEvent.dragOver(screen.getByTestId('new-conversation'), { dataTransfer });
  fireEvent.drop(screen.getByTestId('new-conversation'), { dataTransfer });

  await waitFor(() =>
    expect(screen.getByTestId('first-turn-files').textContent).toBe(
      JSON.stringify([{ kind: 'local', path: '/tmp/sample-folder' }])
    )
  );
});
