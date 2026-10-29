import { createHash } from 'node:crypto';
import path from 'node:path';
import { readOfficeDocument } from '../read-document.js';
import { previewWorkbook } from '../workbook/index.js';
import { previewPresentation } from '../presentation/preview.js';

// One conversion across all employees. Fail fast instead of retaining large
// files in an unbounded queue; callers can explicitly retry. No shared cache.
let converting = false;
export async function previewOfficeFile(
  name: string,
  bytes: Buffer,
  args: { sheet?: string; start?: number }
): Promise<Record<string, unknown>> {
  if (converting) throw new Error('PREVIEW_BUSY_RETRY');
  if (!bytes.length) throw new Error('PREVIEW_EMPTY_FILE');
  if (bytes.length > 25 * 1024 * 1024) throw new Error('PREVIEW_LIMIT_25MB');
  const extension = path.extname(name).toLowerCase();
  if (!['.xlsx', '.docx', '.pptx'].includes(extension)) throw new Error('PREVIEW_FORMAT_UNSUPPORTED');
  if (!Number.isInteger(args.start ?? 0) || (args.start ?? 0) < 0) throw new Error('PREVIEW_PAGE_INVALID');
  converting = true;
  try {
    const result =
      extension === '.xlsx'
        ? await previewWorkbook(bytes, args)
        : extension === '.pptx'
          ? await previewPresentation(bytes, args.start ?? 0)
          : await readOfficeDocument(name, bytes, { start: args.start ?? 0, limit: 5 }, true);
    return {
      ...result,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceName: path.basename(name),
    };
  } finally {
    converting = false;
  }
}
