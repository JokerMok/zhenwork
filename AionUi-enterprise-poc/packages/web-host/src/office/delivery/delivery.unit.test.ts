import { generateOfficeArtifact } from '../generate.js';
import { inspectOfficeStructure } from './revision.js';
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
test('one shared fact dataset uses distinct layouts and hidden provenance; absent requirements cannot pass', () => {
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
  expect(result.files[0].content.report).toEqual(result.files[1].content.report);
  expect(result.files[0].content.report!.findings[0].assessment).toBe('证据不足');
  expect(JSON.stringify(result.files)).toContain('dry conditions');
  expect(result.files.every((item) => item.content.provenance!.dataSha256 === result.dataSha256)).toBe(true);
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
  expect(result.files[0].content.report!.findings[0].assessment).toBe('原文声明');
  expect(result.files[0].content.report).toEqual(result.files[1].content.report);
  expect(() => parseEvidenceDelivery({ ...input, rows: Array.from({ length: 17 }, () => ({ ...input.rows[0], requirement: { ref: 'r', quoteIndex: 0 } })) })).toThrow('REFERENCE_LIMIT_32');
  expect(() => validateToolArguments(evidenceDeliveryTool.inputSchema, { ...input, evidenceRows: [] })).toThrow('allowed fields here:');
});


test('a re-read or another version of the supplier document is not independent requirement evidence', () => {
  const parsed = parseEvidenceDelivery({...input, rows:[{...input.rows[0], requirement:{ref:'requirements', quoteIndex:0}}]});
  const source = {ref:'source',kind:'workspace' as const,quote:'容量10kg',locator:{path:'product.txt',sha256:'v1'}};
  const same = {...source,ref:'requirements',locator:{path:'product.txt',sha256:'v2'}};
  expect(buildEvidenceDeliverables(parsed,[source,same]).files[0].content.report!.findings[0].assessment).toBe('证据不足');
  const different = {...same,locator:{path:'customer.txt',sha256:'independent'}};
  expect(buildEvidenceDeliverables(parsed,[source,different]).files[0].content.report!.findings[0].assessment).toBe('符合');
});


test.skipIf(!process.env.ZHENWORK_OFFICE_PYTHON)('actual generated workbook retains all compliance statuses alongside numeric parameter rows', async () => {
  const parsed = parseEvidenceDelivery({...input, rows:[{...input.rows[0], requirement:{ref:'requirements',quoteIndex:0},metric:{object:'candidate',parameter:'capacity',value:10,unit:'kg'}}]});
  const delivered = buildEvidenceDeliverables(parsed,[{ref:'source',kind:'workspace',quote:'Capacity10kg',locator:{path:'product.txt',sha256:'a'}},{ref:'requirements',kind:'workspace',quote:'Required8kg',locator:{path:'customer.txt',sha256:'b'}}]);
  const content=delivered.files.find(f=>f.path.endsWith('.xlsx'))!.content;
  const bytes=await generateOfficeArtifact(content);
  const inspected=await inspectOfficeStructure('review.xlsx',bytes);
  expect(JSON.stringify(inspected)).toContain('核查清单');
});

test("preserves typed text, enum and dates, rejecting silent coercion and unexplained missing values", () => {
  const metric = (value: unknown, valueType?: string) => ({
    object: "candidate",
    parameter: "rating",
    unit: "",
    value,
    ...(valueType ? { valueType } : {}),
  });
  for (const [value, type] of [
    ["IP54", "enum"],
    ["v2.0", "text"],
    ["2026-10-29", "date"],
    [0, "number"],
    ["0012", "text"],
  ]) {
    const parsed = parseEvidenceDelivery({
      ...input,
      rows: [{ ...input.rows[0], metric: metric(value, String(type)) }],
    });
    expect(parsed.rows[0].metric?.value).toBe(value);
    expect(() =>
      validateToolArguments(evidenceDeliveryTool.inputSchema, {
        ...input,
        rows: [{ ...input.rows[0], metric: metric(value, String(type)) }],
      }),
    ).not.toThrow();
  }
  for (const [value, type] of [
    ["IP54", "number"],
    ["2026-02-30", "date"],
    ["2026-2-1", "date"],
    ["", "text"],
    [12, "text"],
  ])
    expect(() =>
      parseEvidenceDelivery({
        ...input,
        rows: [{ ...input.rows[0], metric: metric(value, String(type)) }],
      }),
    ).toThrow();
  expect(() =>
    parseEvidenceDelivery({ ...input, rows: [{ ...input.rows[0], metric: metric(null) }] }),
  ).toThrow("MISSING_REASON_REQUIRED");
  expect(() =>
    parseEvidenceDelivery({
      ...input,
      rows: [{ ...input.rows[0], metric: metric(null), missing: "No certificate was supplied." }],
    }),
  ).not.toThrow();
});

test("background/version rows never become formal conformity findings", () => {
  const parsed = parseEvidenceDelivery({
    ...input,
    rows: [{ ...input.rows[0], rowType: "context", assessment: "符合" }],
  });
  const result = buildEvidenceDeliverables(parsed, [
    {
      ref: "source",
      kind: "workspace",
      quote: "Old version differs.",
      locator: { path: "v1.txt" },
    },
  ]);
  const report = result.files[0].content.report!;
  expect(report.findings[0]).toMatchObject({ rowType: "context", assessment: "背景说明" });
  expect(report.conclusion).toContain("正式核查 0 项");
});
