/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { buildFileStreamUrl } from './fileUrls';
import { base64ToBlob, BINARY_MIME_MAP } from './base64';

function triggerBlobDownload(blob: Blob, file_name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file_name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Download a file by reading its raw bytes from disk (works in both Electron and WebUI).
 * Uses getImageBase64 + in-memory atob decode to bypass CSP connect-src restrictions.
 */
export async function downloadFileFromPath(file_path: string, file_name: string, workspace?: string): Promise<void> {
  const dataUrl = await ipcBridge.fs.getImageBase64.invoke({ path: file_path, workspace });
  if (!dataUrl) {
    throw new Error('File data not found');
  }
  const ext = file_name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = BINARY_MIME_MAP[ext] ?? 'application/octet-stream';
  const blob = base64ToBlob(dataUrl, mimeType);
  triggerBlobDownload(blob, file_name);
}

/**
 * Download a file addressed by its renderer-safe file reference.
 *
 * Fetch the backend's raw byte stream rather than carrying the complete file as
 * base64 inside JSON. This is the same endpoint used by PDF previews and works
 * through both Electron's local backend and WebUI's same-origin reverse proxy.
 */
export async function downloadFileFromRef(file: ChatFileRef, file_name: string): Promise<void> {
  const blob = await readFileBlobFromRef(file);
  triggerBlobDownload(blob, file_name);
}

/** Read original file bytes through Core's authenticated file reference. */
export async function readFileBlobFromRef(file: ChatFileRef, maxBytes?: number): Promise<Blob> {
  const response = await fetch(buildFileStreamUrl(file));
  if (!response.ok) throw new Error(`File download failed (${response.status})`);
  const contentLength = Number(response.headers.get('content-length'));
  if (maxBytes && contentLength > maxBytes) throw new Error('File too large to save');
  if (!maxBytes || !response.body) {
    const blob = await response.blob();
    if (blob.size === 0) throw new Error('File data is empty');
    if (maxBytes && blob.size > maxBytes) throw new Error('File too large to save');
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  while (true) {
    // Stream reads must be sequential so the limit can stop a large response.
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw new Error('File too large to save');
    }
    chunks.push(Uint8Array.from(value).buffer);
  }
  if (size === 0) throw new Error('File data is empty');
  return new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
}

/** Encode a bounded Blob for the native save dialog IPC channel. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/**
 * Download in-memory text content as a file.
 */
export function downloadTextContent(content: string, file_name: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  triggerBlobDownload(blob, file_name);
}
