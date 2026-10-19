/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Message } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type { FileMetadata } from '@renderer/services/FileService';
import { isSupportedFile, FileService } from '@renderer/services/FileService';

export interface UseDragUploadOptions {
  supportedExts?: string[];
  onFilesAdded?: (files: FileMetadata[]) => void;
  onFoldersAdded?: (folders: string[]) => void;
  /** Conversation ID for WebUI file uploads */
  conversation_id?: string;
}

/** Finder may provide file items before the drag types include `Files`. */
export const hasFileTransfer = (transfer: DataTransfer): boolean =>
  Array.from(transfer.types).includes('Files') ||
  Array.from(transfer.items).some((item) => item.kind === 'file') ||
  transfer.files.length > 0;

export const useDragUpload = ({
  supportedExts = [],
  onFilesAdded,
  onFoldersAdded,
  conversation_id,
}: UseDragUploadOptions) => {
  const { t } = useTranslation();
  const [isFileDragging, setIsFileDragging] = useState(false);

  // 拖拽计数器，防止状态闪烁
  const dragCounter = useRef(0);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!hasFileTransfer(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();

      if (!isFileDragging) {
        setIsFileDragging(true);
        dragCounter.current += 1;
      }
    },
    [isFileDragging]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFileTransfer(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();

    dragCounter.current += 1;
    setIsFileDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFileTransfer(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();

    dragCounter.current -= 1;

    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsFileDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!hasFileTransfer(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();

      // 重置状态
      dragCounter.current = 0;
      setIsFileDragging(false);

      if (!onFilesAdded && !onFoldersAdded) return;

      try {
        const transfer = e.dataTransfer;
        const droppedFiles: File[] = [];
        const folderPaths = new Set<string>();
        const items = Array.from(transfer.items).filter((item) => item.kind === 'file');

        const candidates =
          items.length > 0
            ? items.map((item, index) => ({
                file: item.getAsFile() ?? transfer.files.item(index),
                isDirectory: item.webkitGetAsEntry?.()?.isDirectory,
              }))
            : Array.from(transfer.files).map((file) => ({ file, isDirectory: undefined as boolean | undefined }));
        const resolved = await Promise.all(
          candidates.map(async ({ file, isDirectory }) => {
            // Electron 32+ removes File.path; the preload exposes webUtils.
            const path =
              file && (window.electronAPI?.getPathForFile?.(file) || (file as File & { path?: string }).path);
            const directory =
              isDirectory ?? (path ? (await ipcBridge.fs.getFileMetadata.invoke({ path })).isDirectory : false);
            return { file, path, isDirectory: directory };
          })
        );
        for (const { file, path, isDirectory } of resolved) {
          if (isDirectory) {
            // Finder folders are local references, not multipart file uploads.
            if (!path) throw new Error('Dropped folder path unavailable');
            folderPaths.add(path);
          } else if (file) {
            droppedFiles.push(file);
          }
        }

        if (folderPaths.size > 0) onFoldersAdded?.([...folderPaths]);

        // 第一步：先校验文件类型，筛选出支持的文件
        const validFiles: File[] = [];

        for (const file of droppedFiles) {
          if (supportedExts.length === 0 || isSupportedFile(file.name, supportedExts)) {
            validFiles.push(file);
          }
          // 注意：不支持的文件会被静默过滤，与原逻辑保持一致
        }

        // 第二步：只处理校验通过的文件
        if (validFiles.length > 0 && onFilesAdded) {
          // 创建 FileList 对象给 processDroppedFiles
          const validFileList = Object.assign(validFiles, {
            length: validFiles.length,
            item: (index: number) => validFiles[index] || null,
          }) as unknown as FileList;
          const processedFiles = await FileService.processDroppedFiles(validFileList, conversation_id);

          if (processedFiles.length > 0) {
            onFilesAdded(processedFiles);
          }
        }
      } catch (err) {
        console.error('Failed to process dropped files:', err);
        Message.error(t('conversation.workspace.dragFailed', 'Failed to process dropped files'));
      }
    },
    [conversation_id, onFilesAdded, onFoldersAdded, supportedExts, t]
  );

  const dragHandlers = {
    onDragOver: handleDragOver,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  return {
    isFileDragging,
    dragHandlers,
  };
};
