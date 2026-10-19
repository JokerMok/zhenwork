/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaveFileAsOptions, SaveFileAsResult } from '@/common/adapter/ipcBridge';

const mocks = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  saveProvider: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: mocks.saveDialog },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: { showOpen: { provider: vi.fn() }, saveFileAs: { provider: mocks.saveProvider } },
  },
}));

vi.mock('@/renderer/utils/file/fileUrls', () => ({
  buildFileStreamUrl: () => 'http://localhost/api/fs/stream',
}));

import { initDialogBridge } from '@/process/bridge/dialogBridge';
import { readFileBlobFromRef } from '@/renderer/utils/file/download';

let directory: string;
let save: (request: SaveFileAsOptions) => Promise<SaveFileAsResult>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aion-save-as-'));
  mocks.saveDialog.mockReset();
  mocks.saveProvider.mockReset();
  initDialogBridge();
  save = mocks.saveProvider.mock.calls[0][0];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('reads the original Core file bytes and enforces the Save As size limit', async () => {
  const content = '# 试点办公摘要\n';
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(content));
  const file = { kind: 'project' as const, pe_id: 'sample', relative_path: 'pilot-brief.md' };

  expect(await (await readFileBlobFromRef(file, 100)).text()).toBe(content);
  expect(fetchMock).toHaveBeenCalledWith('http://localhost/api/fs/stream');
  await expect(readFileBlobFromRef(file, 3)).rejects.toThrow('File too large to save');
});

it('writes the exact selected file bytes to the user-chosen destination', async () => {
  const destination = join(directory, 'pilot-brief.md');
  await writeFile(destination, 'previous copy');
  mocks.saveDialog.mockResolvedValue({ canceled: false, filePath: destination });
  const content = Buffer.from('# 试点办公摘要\n下一步。\n');

  const result = await save({ fileName: '../pilot-brief.md', dataBase64: content.toString('base64') });

  expect(mocks.saveDialog).toHaveBeenCalledWith({ defaultPath: 'pilot-brief.md' });
  expect(result).toEqual({ saved: true, filePath: destination });
  expect(await readFile(destination)).toEqual(content);
});

it('does not write when the user cancels or when the payload is malformed', async () => {
  mocks.saveDialog.mockResolvedValue({ canceled: true });
  expect(await save({ fileName: 'pilot-brief.md', dataBase64: Buffer.from('text').toString('base64') })).toEqual({
    saved: false,
  });
  await expect(save({ fileName: 'pilot-brief.md', dataBase64: 'bad=' })).rejects.toThrow('Invalid save payload');
  expect(mocks.saveDialog).toHaveBeenCalledTimes(1);
});
