/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { ipcBridge } from '@/common';

export function initDialogBridge(): void {
  ipcBridge.dialog.showOpen.provider((options) => {
    // Get the focused window or the first available window as parent
    // This ensures the dialog appears in front on Windows and has proper modal behavior
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const dialogOptions = {
      defaultPath: options?.defaultPath,
      properties: options?.properties,
    };

    const showDialogPromise = parentWindow
      ? dialog.showOpenDialog(parentWindow, dialogOptions)
      : dialog.showOpenDialog(dialogOptions);

    return showDialogPromise.then((res) => {
      return res.filePaths;
    });
  });

  ipcBridge.dialog.saveFileAs.provider(async ({ fileName, dataBase64 }) => {
    // The destination is always selected in a native dialog. Never accept a
    // renderer-supplied destination path, and bound the IPC payload size.
    const maxBytes = 24 * 1024 * 1024;
    if (
      typeof fileName !== 'string' ||
      typeof dataBase64 !== 'string' ||
      !dataBase64 ||
      dataBase64.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
    ) {
      throw new Error('Invalid save payload');
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== dataBase64) {
      throw new Error('Invalid save payload');
    }
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const options = { defaultPath: basename(fileName) };
    const chosen = parentWindow
      ? await dialog.showSaveDialog(parentWindow, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { saved: false };

    // Write a temporary sibling, then replace the chosen file only after the
    // complete copy is ready. A failed write leaves any existing file intact.
    const tempPath = join(dirname(chosen.filePath), `.${basename(chosen.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });
      await rename(tempPath, chosen.filePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
    return { saved: true, filePath: chosen.filePath };
  });
}
