import { createHash } from "node:crypto";
import { z } from "zod";
import type { GenerateOfficeArtifactInput } from "../generate.js";
import type { VerifiedSourceEvidence } from "../source-evidence.js";
import { buildOfficeSources, type OfficeReport, type OfficeMetric } from "./presentation.js";

const reference = z
  .object({
    ref: z.string().min(1),
    quote: z.string().min(2).max(2000).optional(),
    quoteIndex: z.number().int().min(0).max(15).optional(),
  })
  .strict()
  .refine(
    (value) => (value.quote !== undefined) !== (value.quoteIndex !== undefined),
    "Provide exactly one of quote or quoteIndex",
  );
const row = z
  .object({
    topic: z.string().min(1).max(300),
    source: reference,
    requirement: reference.optional(),
    assessment: z.enum(["符合", "不符合", "部分符合", "证据不足"]).default("证据不足"),
    analysis: z.string().max(2000).default(""),
    missing: z.string().max(2000).default(""),
    metric: z
      .object({
        object: z.string().min(1).max(200),
        parameter: z.string().min(1).max(200),
        unit: z.string().max(100),
        value: z.number().finite().nullable().optional(),
        calculation: z
          .object({
            operation: z.enum(["sum", "difference", "ratio"]),
            rows: z.array(z.number().int().min(1).max(32)).min(1).max(32),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const input = z
  .object({
    basePath: z.string().min(1).max(240),
    title: z.string().min(1).max(300),
    conclusion: z.string().min(1).max(2000).optional(),
    docxPath: z.string().min(1).max(240).optional(),
    xlsxPath: z.string().min(1).max(240).optional(),
    scope: z.string().min(1).max(2000),
    purpose: z.enum(["research", "compliance"]).default("compliance"),
    rows: z.array(row).min(1).max(32),
    overwrite: z.boolean().optional(),
  })
  .strict();
export type EvidenceDeliveryInput = z.infer<typeof input>;
export function parseEvidenceDelivery(value: unknown): EvidenceDeliveryInput {
  const result = input.safeParse(value);
  if (!result.success)
    throw new Error(
      "OFFICE_DELIVERY_INPUT_INVALID " +
        result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")
          .slice(0, 900),
    );
  if (/\.(xlsx|docx|pdf|pptx)$/i.test(result.data.basePath))
    throw new Error("OFFICE_DELIVERY_BASE_PATH_WITHOUT_EXTENSION_REQUIRED");
  if (result.data.rows.reduce((count, item) => count + (item.requirement ? 2 : 1), 0) > 32)
    throw new Error(
      "OFFICE_DELIVERY_REFERENCE_LIMIT_32: at most 32 source-only rows or 16 rows with paired requirements; select the findings needed for this scope.",
    );
  for (const [key, extension] of [
    ["docxPath", ".docx"],
    ["xlsxPath", ".xlsx"],
  ] as const) {
    if (result.data[key] && !result.data[key]!.toLowerCase().endsWith(extension))
      throw new Error("OFFICE_DELIVERY_PATH_FORMAT_MISMATCH");
  }
  result.data.rows.forEach((item) => {
    if (
      item.metric?.calculation &&
      (item.metric.value != null ||
        item.metric.calculation.rows.some((index) => index > result.data.rows.length) ||
        (item.metric.calculation.operation !== "sum" && item.metric.calculation.rows.length !== 2))
    )
      throw new Error("OFFICE_DELIVERY_CALCULATION_INVALID");
  });
  return result.data;
}
export function deliveryReferences(value: EvidenceDeliveryInput) {
  return value.rows.flatMap((item) =>
    item.requirement ? [item.source, item.requirement] : [item.source],
  );
}
export function buildEvidenceDeliverables(
  value: EvidenceDeliveryInput,
  sources: VerifiedSourceEvidence[],
): { dataSha256: string; files: Array<{ path: string; content: GenerateOfficeArtifactInput }> } {
  if (sources.length !== deliveryReferences(value).length)
    throw new Error("OFFICE_DELIVERY_SOURCE_COUNT_MISMATCH");
  const catalog = buildOfficeSources(sources);
  let cursor = 0;
  const findings = value.rows.map((item) => {
    const source = catalog.numbers[cursor++],
      requirement = item.requirement ? catalog.numbers[cursor++] : undefined;
    return {
      topic: item.topic,
      source,
      requirement,
      assessment:
        value.purpose === "research" ? "原文声明" : requirement ? item.assessment : "证据不足",
      analysis: item.analysis,
      missing: item.missing,
      metric: item.metric as OfficeMetric | undefined,
    };
  });
  const report: OfficeReport = {
    purpose: value.purpose,
    scope: value.scope,
    conclusion:
      value.conclusion ||
      `已整理 ${findings.length} 项资料记录。${value.purpose === "research" ? "以下对比以引用原文及其适用条件为限。" : `其中 ${findings.filter((item) => item.assessment === "证据不足").length} 项证据不足，需补充依据后判断。`}`,
    findings,
  };
  const dataSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        report,
        sources: sources.map(({ kind, locator, quote }) => ({ kind, locator, quote })),
      }),
    )
    .digest("hex");
  const content = {
    title: value.title,
    report,
    sources: catalog.entries,
    provenance: { ...catalog.provenance, dataSha256 },
  };
  return {
    dataSha256,
    files: [
      { path: value.docxPath || value.basePath + ".docx", content: { ...content, format: "docx" } },
      { path: value.xlsxPath || value.basePath + ".xlsx", content: { ...content, format: "xlsx" } },
    ],
  };
}

const referenceSchema = {
  type: "object",
  properties: {
    ref: { type: "string", minLength: 1 },
    quote: { type: "string", minLength: 2, maxLength: 2000 },
    quoteIndex: { type: "integer", minimum: 0, maximum: 15 },
  },
  required: ["ref"],
  oneOf: [
    { required: ["quote"], not: { required: ["quoteIndex"] } },
    { required: ["quoteIndex"], not: { required: ["quote"] } },
  ],
  additionalProperties: false,
};
export const evidenceDeliveryTool = {
  name: "create_evidence_deliverables",
  description:
    'Create BOTH a real Word report and Excel comparison from ONE shared evidence dataset. Preferred for research/compliance multi-deliverable tasks. Each row needs a valid source reference. The server inserts actual quotes and a deduplicated readable reference catalog with native hyperlinks. Word uses conclusion and prose; Excel uses typed metric values and separate notes. Internal provenance is hidden, never put locator JSON/hash/URL in analysis. Provide metric {object,parameter,value:number,unit} for numeric facts; leave value null for unknowns. Optional metric.calculation {operation:sum|difference|ratio,rows:[1-based row numbers]} computes Decimal results and native formulas, never model arithmetic. Optional docxPath/xlsxPath are exact requested filenames. Use revise_office_document for narrow continuation, not full regeneration. analysis is explicitly labelled inference; never put unsourced facts in it. Requirement references are optional; without independent requirements the status is forced to insufficient evidence. Read files with read_document (not native Read) or read_web/search_knowledge first, then copy returned sourceRef and quoteIndex. File paths are not sourceRefs. This creates a NEW evidence report/table, never fills or edits a company template. Returns per-file validation and downloads; partial means an output failed, never claim completion. Use basePath WITHOUT extension. All rows require source; put data gaps in missing, not an empty ref. Set purpose:"research" for factual research (source-location status, not customer conformity); default compliance enforces independent requirements. Max 32 total references: 32 source-only rows or 16 source/requirement pairs. Minimal shape: {basePath:"report",title:"title",scope:"scope",purpose:"research",rows:[{topic:"finding",source:{ref:"returned sourceRef",quoteIndex:0},analysis:"inference",missing:"gaps"}]}. Check units/conditions/date/version before choosing assessment.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      basePath: { type: "string" },
      title: { type: "string" },
      scope: { type: "string" },
      conclusion: {
        type: "string",
        description: "Concise evidence-supported conclusion, before details.",
      },
      docxPath: {
        type: "string",
        description: "Exact requested .docx filename; otherwise basePath.docx.",
      },
      xlsxPath: {
        type: "string",
        description: "Exact requested .xlsx filename; otherwise basePath.xlsx.",
      },
      purpose: { type: "string", enum: ["research", "compliance"] },
      overwrite: { type: "boolean" },
      rows: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            topic: { type: "string" },
            source: referenceSchema,
            requirement: referenceSchema,
            assessment: { type: "string", enum: ["符合", "不符合", "部分符合", "证据不足"] },
            analysis: { type: "string" },
            missing: { type: "string" },
            metric: {
              type: "object",
              additionalProperties: false,
              properties: {
                object: { type: "string" },
                parameter: { type: "string" },
                unit: { type: "string" },
                value: { type: ["number", "null"] },
                calculation: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    operation: { type: "string", enum: ["sum", "difference", "ratio"] },
                    rows: {
                      type: "array",
                      minItems: 1,
                      maxItems: 32,
                      items: { type: "integer", minimum: 1, maximum: 32 },
                    },
                  },
                  required: ["operation", "rows"],
                },
              },
              required: ["object", "parameter", "unit"],
            },
          },
          required: ["topic", "source"],
        },
      },
    },
    required: ["basePath", "title", "scope", "rows"],
  },
};
