import { describe, expect, it } from 'vitest';
import { previewOfficeFile } from './index.js';
describe('bounded Office preview admission', () => {
  it('keeps an unsupported or empty original independent of conversion', async () => {
    await expect(previewOfficeFile('a.xlsx', Buffer.alloc(0), {})).rejects.toThrow('PREVIEW_EMPTY_FILE');
    await expect(previewOfficeFile('a.doc', Buffer.from('original'), {})).rejects.toThrow('PREVIEW_FORMAT_UNSUPPORTED');
  });
  it('rejects large inputs and invalid page requests before launching a converter', async () => {
    await expect(previewOfficeFile('a.xlsx', Buffer.alloc(25 * 1024 * 1024 + 1), {})).rejects.toThrow('PREVIEW_LIMIT_25MB');
    await expect(previewOfficeFile('a.docx', Buffer.from('x'), { start: -1 })).rejects.toThrow('PREVIEW_PAGE_INVALID');
  });
});
