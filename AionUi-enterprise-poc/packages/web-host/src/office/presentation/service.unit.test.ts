import { expect, test, vi } from 'vitest';
import { BusinessPresentation } from './service.js';
import { presentationTheme } from './template.js';
import { requiredFormats } from '../../tasks/types.js';
import type { DataClient } from '../workbook/analysis/service.js';

const id = '9'.repeat(64);
test('checks current resource permission before exposing an already generated PPT', async () => {
  const store = {
    businessFileResult: async () => id,
    businessResult: async () => ({
      id,
      kind: 'evidence',
      dependencies: [{ id: 'revoked-rule', type: 'TOOL' }],
      sourceFiles: [],
      provenance: { sources: [] },
    }),
    isBusinessFile: async () => true,
  };
  const client = {
    me: async () => ({}),
    authorizedResource: async () => {
      throw new Error('REVOKED');
    },
  };
  const service = Reflect.construct(BusinessPresentation, [
    store,
    {},
    '/unused',
    client,
    'https://example.com',
  ]) as BusinessPresentation;
  await expect(service.guardFile('report.pptx', Buffer.from('already-delivered'))).rejects.toThrow('REVOKED');
  await expect(
    service.relatedReceipts(
      (await store.businessResult()) as unknown as Parameters<BusinessPresentation['relatedReceipts']>[0]
    )
  ).rejects.toThrow('REVOKED');
});
test('does not bypass source permission by replacing bytes on a known derivative path', async () => {
  const get = vi.fn();
  const service = Reflect.construct(BusinessPresentation, [
    { businessFileResult: async () => undefined, isBusinessFile: async () => true, businessResult: get },
    {},
    '/unused',
    {},
    'https://example.com',
  ]) as BusinessPresentation;
  await expect(service.guardFile('report.pptx', Buffer.from('modified'))).rejects.toThrow('PPT_DERIVATIVE_CHANGED');
  expect(get).not.toHaveBeenCalled();
});
test('rejects an explicitly selected unavailable template instead of silently changing branding', async () => {
  await expect(
    presentationTheme({ resources: async () => [] } as unknown as DataClient, '11111111-1111-4111-8111-111111111111')
  ).rejects.toThrow('PPT_TEMPLATE_NOT_AUTHORIZED');
});
test('requires a real PPT deliverable for ordinary natural-language presentation requests', () => {
  expect(requiredFormats('把刚才的月报再做成一份汇报 PPT。')).toEqual(['pptx']);
  expect(requiredFormats('请生成 Word、Excel 和 PPTX。')).toEqual(['docx', 'xlsx', 'pptx']);
  expect(requiredFormats('不要生成PPT，但请修改Word。')).toEqual(['docx']);
});
