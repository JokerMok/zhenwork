import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GenerateOfficeArtifactInput } from '../generate.js';
import type { VerifiedSourceEvidence } from '../source-evidence.js';

const reference = z
  .object({
    ref: z.string().min(1),
    quote: z.string().min(2).max(2000).optional(),
    quoteIndex: z.number().int().min(0).max(15).optional(),
  })
  .strict()
  .refine(
    (value) => (value.quote !== undefined) !== (value.quoteIndex !== undefined),
    'Provide exactly one of quote or quoteIndex'
  );
const row = z
  .object({
    topic: z.string().min(1).max(300),
    source: reference,
    requirement: reference.optional(),
    assessment: z.enum(['符合', '不符合', '部分符合', '证据不足']).default('证据不足'),
    analysis: z.string().max(2000).default(''),
    missing: z.string().max(2000).default(''),
  })
  .strict();
const input = z
  .object({
    basePath: z.string().min(1).max(240),
    title: z.string().min(1).max(300),
    scope: z.string().min(1).max(2000),
    rows: z.array(row).min(1).max(16),
    overwrite: z.boolean().optional(),
  })
  .strict();
export type EvidenceDeliveryInput = z.infer<typeof input>;
export function parseEvidenceDelivery(value: unknown): EvidenceDeliveryInput {
  const result = input.safeParse(value);
  if (!result.success)
    throw new Error(
      'OFFICE_DELIVERY_INPUT_INVALID ' +
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
          .slice(0, 900)
    );
  if (/\.(xlsx|docx|pdf|pptx)$/i.test(result.data.basePath))
    throw new Error('OFFICE_DELIVERY_BASE_PATH_WITHOUT_EXTENSION_REQUIRED');
  return result.data;
}
export function deliveryReferences(value: EvidenceDeliveryInput) {
  return value.rows.flatMap((item) => (item.requirement ? [item.source, item.requirement] : [item.source]));
}
export function buildEvidenceDeliverables(
  value: EvidenceDeliveryInput,
  sources: VerifiedSourceEvidence[]
): { dataSha256: string; files: Array<{ path: string; content: GenerateOfficeArtifactInput }> } {
  if (sources.length !== deliveryReferences(value).length) throw new Error('OFFICE_DELIVERY_SOURCE_COUNT_MISMATCH');
  let cursor = 0;
  const table = {
    headers: [
      '编号',
      '主题',
      '原文事实（非独立验收）',
      '核查状态',
      '独立要求原文',
      '解释与判断（分析）',
      '缺失信息/下一步',
      '事实来源及版本定位',
      '要求来源及版本定位',
    ],
    rows: value.rows.map((item, index) => {
      const source = sources[cursor++],
        requirement = item.requirement ? sources[cursor++] : undefined;
      return [
        index + 1,
        item.topic,
        source.quote,
        requirement ? item.assessment : '证据不足',
        requirement?.quote ?? '未提供独立要求；不得据此判定符合',
        item.analysis,
        item.missing ||
          (requirement ? '仍需核对单位、范围、条件、日期、版本及实际验收。' : '待提供独立需求与验收依据。'),
        JSON.stringify(source.locator),
        requirement ? JSON.stringify(requirement.locator) : '未提供',
      ];
    }),
  };
  const dataSha256 = createHash('sha256')
    .update(JSON.stringify({ scope: value.scope, table }))
    .digest('hex');
  const paragraphs = [
    value.scope,
    '原文由服务器从当前有权访问的版本中插入。解释栏为分析；原文存在不等于推断正确或实际验收通过。未提供独立要求时，状态强制为证据不足。',
    '共同数据版本 SHA256: ' + dataSha256,
  ];
  return {
    dataSha256,
    files: [
      {
        path: value.basePath + '.docx',
        content: { format: 'docx', title: value.title, paragraphs, table },
      },
      {
        path: value.basePath + '.xlsx',
        content: { format: 'xlsx', title: value.title, paragraphs, table },
      },
    ],
  };
}

const referenceSchema = {
  type: 'object',
  properties: {
    ref: { type: 'string', minLength: 1 },
    quote: { type: 'string', minLength: 2, maxLength: 2000 },
    quoteIndex: { type: 'integer', minimum: 0, maximum: 15 },
  },
  required: ['ref'],
  oneOf: [
    { required: ['quote'], not: { required: ['quoteIndex'] } },
    { required: ['quoteIndex'], not: { required: ['quote'] } },
  ],
  additionalProperties: false,
};
export const evidenceDeliveryTool = {
  name: 'create_evidence_deliverables',
  description:
    'Create BOTH a real Word report and Excel comparison from ONE shared evidence dataset. Preferred for research/compliance multi-deliverable tasks. Each row needs a valid source reference. The server inserts the actual original quote and version/location in both files. analysis is explicitly labelled inference; never put unsourced facts in it. Requirement references are optional; without independent requirements the status is forced to insufficient evidence. Read sources first. Returns per-file validation and downloads; partial means an output failed, never claim completion. Use basePath WITHOUT extension. All rows require source; put data gaps in missing, not an empty ref. Max 16 rows. Check units/conditions/date/version before choosing assessment.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      basePath: { type: 'string' },
      title: { type: 'string' },
      scope: { type: 'string' },
      overwrite: { type: 'boolean' },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topic: { type: 'string' },
            source: referenceSchema,
            requirement: referenceSchema,
            assessment: { type: 'string', enum: ['符合', '不符合', '部分符合', '证据不足'] },
            analysis: { type: 'string' },
            missing: { type: 'string' },
          },
          required: ['topic', 'source'],
        },
      },
    },
    required: ['basePath', 'title', 'scope', 'rows'],
  },
};
