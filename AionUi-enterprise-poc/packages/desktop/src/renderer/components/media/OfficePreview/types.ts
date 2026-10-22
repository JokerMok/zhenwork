import type { CSSProperties } from 'react';
export type OfficeCell = {
  reference: string;
  column: number;
  text: string;
  formula?: string;
  error?: string;
  colSpan: number;
  rowSpan: number;
  style: CSSProperties;
};
export type OfficeLocation = {
  location: { kind: string; name?: string; paragraph?: number; table?: number; slide?: number };
  text?: string;
  rows?: unknown[][];
  texts?: Array<{ text: string }>;
  tables?: Array<{ rows: unknown[][] }>;
  textTruncated?: boolean;
};
export type OfficePreviewData = {
  format: 'xlsx' | 'docx' | 'pptx';
  sourceSha256: string;
  sourceName: string;
  unchanged?: boolean;
  sheets?: string[];
  sheet?: string;
  start?: number;
  nextStart?: number | null;
  rowCount?: number;
  columnCount?: number;
  rows?: Array<{ number: number; cells: OfficeCell[] }>;
  widths?: number[];
  unsupportedFormulas?: number;
  locations?: OfficeLocation[];
  totalLocations?: number;
  truncatedColumns?: boolean;
  textTruncated?: boolean;
};

export function previewErrorKey(code: string): string {
  if (code === 'PREVIEW_EMPTY_FILE') return 'workspace.preview.empty';
  if (code === 'PREVIEW_BUSY_RETRY') return 'workspace.preview.busy';
  if (code === 'PREVIEW_LIMIT_25MB' || code === 'PREVIEW_TOO_LARGE') return 'workspace.preview.tooLarge';
  if (code === 'PREVIEW_TIMEOUT') return 'workspace.preview.timeout';
  if (code === 'PREVIEW_FORMAT_UNSUPPORTED') return 'workspace.files.unsupportedPreviewHint';
  return 'workspace.preview.failed';
}
