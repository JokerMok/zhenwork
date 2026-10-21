import { expect, test } from 'vitest';
import { buildEvidenceDeliverables, parseEvidenceDelivery, deliveryReferences, evidenceDeliveryTool } from './index.js';
import { InvalidCallBudget, validateToolArguments } from './arguments.js';

const input = {
  basePath: 'review',
  title: 'Evidence review',
  scope: 'Labelled regression example, not real customer acceptance.',
  rows: [
    {
      topic: 'Capacity',
      source: { ref: 'source', quoteIndex: 0 },
      assessment: '符合',
      analysis: 'A supplier claim is not a customer requirement.',
    },
  ],
};
test('one shared table and hash appears in both real artifact inputs; absent requirements cannot pass', () => {
  const parsed = parseEvidenceDelivery(input);
  const result = buildEvidenceDeliverables(parsed, [
    {
      ref: 'source',
      kind: 'workspace',
      quote: 'Capacity 10 kg/h under dry conditions.',
      locator: { path: 'product.txt', sha256: 'version', location: 'section 2' },
    },
  ]);
  expect(result.files.map((item) => item.path)).toEqual(['review.docx', 'review.xlsx']);
  expect(result.files[0].content.table).toEqual(result.files[1].content.table);
  expect(result.files[0].content.table!.rows[0][3]).toBe('证据不足');
  expect(JSON.stringify(result.files)).toContain('dry conditions');
  expect(result.files.every((item) => item.content.paragraphs!.at(-1)!.includes(result.dataSha256))).toBe(true);
  expect(deliveryReferences(parsed)).toHaveLength(1);
});
test('schema rejects empty refs, missing args and wrong nested types before any write', () => {
  expect(() => validateToolArguments(evidenceDeliveryTool.inputSchema, {})).toThrow('missing basePath');
  expect(() =>
    parseEvidenceDelivery({
      ...input,
      rows: [{ ...input.rows[0], source: { ref: '', quote: '' } }],
    })
  ).toThrow('rows.0.source');
  expect(() =>
    validateToolArguments(evidenceDeliveryTool.inputSchema, {
      ...input,
      rows: [{ ...input.rows[0], source: { ref: 'x', quoteIndex: '0' } }],
    })
  ).toThrow('expected integer');
  expect(() =>
    validateToolArguments(evidenceDeliveryTool.inputSchema, {
      ...input,
      rows: [{ ...input.rows[0], source: { ref: 'x', quoteIndex: 0, quote: 'both' } }],
    })
  ).toThrow('exactly one');
  expect(() => validateToolArguments(evidenceDeliveryTool.inputSchema, input)).not.toThrow();
});
test('bounded correction rejects a fourth identical bad call but permits corrected input and expiry', () => {
  let now = 0;
  const budget = new InvalidCallBudget(() => now);
  for (let i = 0; i < 3; i++) {
    budget.check('c', 't', {});
    budget.failed('c', 't', {});
  }
  expect(() => budget.check('c', 't', {})).toThrow('OFFICE_CORRECTION_LIMIT');
  expect(() => budget.check('c', 't', { path: 'correct' })).not.toThrow();
  expect(() => budget.check('other-user', 't', {})).not.toThrow();
  now = 300_001;
  expect(() => budget.check('c', 't', {})).not.toThrow();
});

test('research preserves source-location status while compliance still needs requirements; reference work stays bounded', () => {
  const parsed = parseEvidenceDelivery({ ...input, purpose: 'research', rows: Array.from({ length: 32 }, () => input.rows[0]) });
  const source = { ref: 'source', kind: 'web' as const, quote: 'A vendor claim, not independent acceptance.', locator: { url: 'https://example.com', sha256: 'v1' } };
  const result = buildEvidenceDeliverables(parsed, Array.from({ length: 32 }, () => source));
  expect(result.files[0].content.table!.rows[0][3]).toContain('原文已定位');
  expect(result.files[0].content.table).toEqual(result.files[1].content.table);
  expect(() => parseEvidenceDelivery({ ...input, rows: Array.from({ length: 17 }, () => ({ ...input.rows[0], requirement: { ref: 'r', quoteIndex: 0 } })) })).toThrow('REFERENCE_LIMIT_32');
  expect(() => validateToolArguments(evidenceDeliveryTool.inputSchema, { ...input, evidenceRows: [] })).toThrow('allowed fields here:');
});
