import { z } from 'zod';
import type { OfficeSource, OfficeReport, OfficeProvenance } from '../delivery/presentation.js';

const text = z.string().max(2000);
const decimal = z.string().regex(/^-?\d{1,15}(?:\.\d{1,9})?$/);
export const chartSchema = z
  .object({
    type: z.enum(['column', 'line', 'pie']),
    title: z.string().max(160),
    categories: z.array(z.string().max(80)).min(1).max(12),
    series: z
      .array(z.object({ name: z.string().max(80), values: z.array(decimal).min(1).max(12) }).strict())
      .min(1)
      .max(4),
    numberFormat: z.string().max(40).default('0.###'),
    dataKey: z.string().max(120).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.series.some((s) => s.values.length !== c.categories.length) || (c.type === 'pie' && c.series.length !== 1))
      ctx.addIssue({ code: 'custom', message: 'Chart category/series mismatch' });
    if (
      c.type === 'pie' &&
      (c.series[0].values.some((v) => Number(v) < 0) || !c.series[0].values.some((v) => Number(v) > 0))
    )
      ctx.addIssue({ code: 'custom', message: 'Pie chart requires nonnegative values and a positive total' });
  });
export const slideSchema = z
  .object({
    title: z.string().max(160),
    layout: z.enum(['cover', 'section', 'content', 'conclusion', 'sources']).optional(),
    subtitle: z.string().max(250).optional(),
    paragraphs: z.array(z.string().max(600)).max(6).optional(),
    bullets: z.array(z.string().max(240)).max(6).optional(),
    metrics: z
      .array(
        z.object({ label: z.string().max(60), value: z.string().max(80), unit: z.string().max(30).optional() }).strict()
      )
      .max(4)
      .optional(),
    table: z
      .object({
        headers: z.array(z.string().max(80)).min(1).max(6),
        rows: z.array(z.array(z.union([text, z.number().finite(), z.null()])).max(6)).max(8),
      })
      .strict()
      .optional(),
    chart: chartSchema.optional(),
    images: z
      .array(z.object({ content: z.string().max(1400000), caption: z.string().max(150).optional() }).strict())
      .max(2)
      .optional(),
    sourceIds: z.array(z.string().max(20)).max(32).optional(),
    notes: z.string().max(12000).optional(),
    protected: z.boolean().optional(),
  })
  .strict()
  .superRefine((slide, ctx) => {
    if (slide.table?.rows.some((row) => row.length !== slide.table!.headers.length))
      ctx.addIssue({ code: 'custom', message: 'Table column count mismatch' });
    if (
      slide.images?.length &&
      (slide.chart || slide.table || slide.metrics?.length || slide.paragraphs?.length || slide.bullets?.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Image pages require their own layout' });
    if (slide.chart && (slide.table || slide.metrics?.length || slide.paragraphs?.length || slide.bullets?.length))
      ctx.addIssue({ code: 'custom', message: 'Chart pages require their own layout' });
    if (slide.table && slide.metrics?.length)
      ctx.addIssue({ code: 'custom', message: 'Metric/table mixed layout is unsupported' });
  });
export type PresentationSlide = z.infer<typeof slideSchema>;
export type PresentationChart = z.infer<typeof chartSchema>;
export const themeSchema = z
  .object({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(40),
    primary: z
      .string()
      .regex(/^[A-Fa-f0-9]{6}$/)
      .default('19384D'),
    accent: z
      .string()
      .regex(/^[A-Fa-f0-9]{6}$/)
      .default('087F8C'),
    font: z.string().min(1).max(80).default('Noto Sans CJK SC'),
    titleSize: z.number().int().min(24).max(36).default(30),
    bodySize: z.number().int().min(16).max(22).default(20),
    default: z.boolean().default(false),
    templatePath: z.string().max(200).optional(),
    logoPath: z.string().max(200).optional(),
  })
  .strict();
export type PresentationTheme = z.infer<typeof themeSchema> & {
  resourceId?: string;
  resourceVersion?: number;
  sha256?: string;
  template?: string;
  logo?: string;
};
export const DEFAULT_THEME: PresentationTheme = themeSchema.parse({
  name: 'ZhenWork 企业简洁',
  version: '1.0.0',
  default: true,
});
export type PresentationResult = {
  id: string;
  resultHash: string;
  kind: 'evidence' | 'analysis';
  title: string;
  slides: PresentationSlide[];
  sources: OfficeSource[];
  provenance: OfficeProvenance;
  dependencies: Array<{ id: string; type: 'TOOL' | 'KNOWLEDGE' | 'SKILL' }>;
  sourceFiles: Array<{ path: string; versionId?: string; sha256: string }>;
  relatedFiles: Array<{ path: string; versionId: string; sha256: string; version: number }>;
  report?: OfficeReport;
  origin: {
    conversation?: string;
    taskId?: string;
    round?: number;
    attempt?: number;
    attemptId?: string;
    createdAt: string;
    analysisId?: string;
    originalDataSha256?: string;
  };
};
