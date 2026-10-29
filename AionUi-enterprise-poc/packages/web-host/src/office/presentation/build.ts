import { createHash } from 'node:crypto';
import type { Analysis } from '../workbook/analysis/service.js';
import type { OfficeReport, OfficeSource, OfficeProvenance } from '../delivery/presentation.js';
import type { PresentationSlide, PresentationResult } from './types.js';

const chunks = <T>(rows: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LAYOUT_VERSION = 1;
const fit = (slides: PresentationSlide[]) => {
  if (slides.length > 30) throw new Error('PRESENTATION_SLIDE_LIMIT_30');
  return slides;
};
export function sourceSlides(sources: OfficeSource[]): PresentationSlide[] {
  return chunks(sources, 4).map((group, i) => ({
    title: i ? `数据口径与来源 · ${i + 1}` : '数据口径与来源',
    layout: 'sources',
    protected: true,
    paragraphs: group.map((s) => `[${s.id}] ${s.title} · ${s.version}\n${s.location}`),
    sourceIds: group.map((s) => s.id),
    notes: group
      .map((s) => `[${s.id}] ${s.url || s.originalUrl || '无可用原文链接'}\n${s.quotes.join('\n')}`)
      .join('\n\n'),
  }));
}

/** Builds display objects from the stored Decimal result, without re-reading or recalculating records. */
export function analysisPresentation(a: Analysis): PresentationResult {
  if (a.result.status !== 'validated' || !a.result.summary) throw new Error('DATA_VALIDATION_BLOCKED');
  const result = a.result,
    summary = result.summary!;
  const source: OfficeSource = {
    id: 'S1',
    title: a.source.name,
    version: '固定快照 ' + a.source.versionId.slice(0, 8),
    location: `${a.mapping.sheet}；映射 v${a.mapping.version}`,
    url: a.sourceUrl,
    quotes: [],
  };
  const slides: PresentationSlide[] = [
    {
      title: `${result.period} 产废月度汇报`,
      layout: 'cover',
      subtitle: `业务日期 · ${a.policy.name} v${a.policy.version}`,
      sourceIds: ['S1'],
    },
    {
      title: '分析概要',
      metrics: [
        { label: '产生重量', value: summary.weightKg, unit: 'kg' },
        { label: '有效记录', value: String(result.includedCount), unit: '条' },
        { label: '排除记录', value: String(result.excludedCount), unit: '条' },
      ],
      paragraphs: [`完整扫描 ${result.rowCount} 条；仅纳入已确认口径和本次统计期间的记录。`],
      protected: true,
      sourceIds: ['S1'],
    },
  ];
  for (const [title, key, type] of [
    ['产废结构', 'byCategory', 'pie'],
    ['来源结构', 'bySource', 'column'],
  ] as const) {
    const groups = summary[key];
    if (groups.length && groups.length <= 12)
      slides.push({
        title,
        chart: {
          type,
          title: `${title}（kg）`,
          categories: groups.map((x) => x.name),
          series: [{ name: '重量（kg）', values: groups.map((x) => x.weightKg) }],
          numberFormat: '0.' + '0'.repeat(a.policy.definition.precision),
          dataKey: key,
        },
        protected: true,
        sourceIds: ['S1'],
      });
    else
      for (const [i, group] of chunks(groups, 8).entries())
        slides.push({
          title: `${title}${i ? ` · ${i + 1}` : ''}`,
          table: {
            headers: ['对象', '重量（kg）', '占比（%）'],
            rows: group.map((x) => [x.name, x.weightKg, x.percent ?? '未提供']),
          },
          protected: true,
          sourceIds: ['S1'],
        });
  }
  if (summary.trend.length >= 2 && summary.trend.length <= 12)
    slides.push({
      title: '本文件范围内的产废趋势',
      chart: {
        type: 'line',
        title: '已提供期间的重量（kg）',
        categories: summary.trend.map((x) => x.month),
        series: [{ name: '重量（kg）', values: summary.trend.map((x) => x.weightKg) }],
        dataKey: 'trend',
        numberFormat: '0.' + '0'.repeat(a.policy.definition.precision),
      },
      protected: true,
      sourceIds: ['S1'],
    });
  const reasons: Record<string, string> = {
    SUMMARY_ROW: '合计/小计行，排除',
    DUPLICATE_IDENTICAL: '同编号同内容重复，仅保留首条',
    OTHER_NODE: '不在统计节点',
    OUTSIDE_PERIOD: '不在统计期间',
    CANCELLED_RECORD: '已撤销',
    REPEATED_HEADER: '重复表头',
  };
  const counts = Object.entries(result.counts).filter(([key]) => key !== 'INCLUDED');
  for (const [i, group] of chunks(counts.length ? counts : [['NONE', 0]], 7).entries())
    slides.push({
      title: `异常与数据质量${i ? ` · ${i + 1}` : ''}`,
      table: {
        headers: ['处理依据', '记录数'],
        rows: group.map(([key, value]) => [key === 'NONE' ? '未发现排除项' : reasons[key] || key, value]),
      },
      paragraphs: [`异常 ${result.invalidCount} 条；排除项不计入本期有效总量。`],
      protected: true,
      sourceIds: ['S1'],
    });
  slides.push({
    title: '结论与限制',
    layout: 'conclusion',
    protected: true,
    paragraphs: [
      `本期纳入 ${result.includedCount} 条，总重量 ${summary.weightKg} kg（${summary.weightTon} 吨）。`,
      summary.trend.length < 2
        ? '只提供一个统计期间，不生成趋势图，也不推断环比或长期变化。'
        : '趋势只涵盖本次文件的有效期间，不代表完整企业历史。',
      '缺少生产量、合同、价格、费用和清运约束，不能推导单位产废、降本或最优清运方案。',
      `口径 v${a.policy.version}；按业务日期、节点、编号和明确的换算精度处理。`,
    ],
    sourceIds: ['S1'],
  });
  slides.push(...sourceSlides([source]));
  const provenance = {
    schemaVersion: 1 as const,
    sources: [] as OfficeProvenance['sources'],
    analysisId: a.id,
    resultHash: a.resultHash,
    source: a.source,
    policy: a.policy,
    mapping: a.mapping,
  };
  return {
    id: hash({ analysisId: a.id, layoutVersion: LAYOUT_VERSION }),
    resultHash: a.resultHash,
    kind: 'analysis',
    title: `${result.period} 产废月度分析`,
    slides: fit(slides),
    sources: [source],
    provenance,
    dependencies: [{ id: a.policy.id, type: 'TOOL' }],
    sourceFiles: [{ path: a.source.path, versionId: a.source.versionId, sha256: a.source.sha256 }],
    relatedFiles: a.artifacts,
    origin: { createdAt: a.createdAt, analysisId: a.id },
  };
}

/** Formal statuses and metrics are taken verbatim from the validated shared report. */
export function evidencePresentation(
  title: string,
  report: OfficeReport,
  sources: OfficeSource[],
  provenance: OfficeProvenance
): Pick<PresentationResult, 'id' | 'resultHash' | 'kind' | 'title' | 'slides' | 'report' | 'sources' | 'provenance'> {
  const formal = report.findings.filter((x) => x.rowType !== 'context');
  const coverTitle = title.includes('选型')
    ? '产品选型汇报'
    : title.includes('核查')
      ? '资料核查汇报'
      : title.length <= 36
        ? title
        : '资料分析汇报';
  const slides: PresentationSlide[] = [
    {
      title: coverTitle,
      layout: 'cover',
      subtitle: `正式核查 ${formal.length} 项`,
      sourceIds: sources.map((x) => x.id),
      notes: title,
    },
  ];
  if (report.purpose === 'compliance') {
    const passed = formal.filter((x) => x.assessment === '符合').length;
    slides.push({
      title: '正式核查概要',
      metrics: [
        { label: '正式条款', value: String(formal.length), unit: '项' },
        { label: '完全符合', value: String(passed), unit: '项' },
        {
          label: '正式符合率',
          value: formal.length ? ((passed * 100) / formal.length).toFixed(2).replace(/\.00$/, '') : '未提供',
          unit: '%',
        },
      ],
      paragraphs: ['仅统计正式核查条款；背景资料、版本差异和部分符合不计入完全符合数。'],
      protected: true,
    });
  }
  for (const [i, group] of chunks(formal, 5).entries())
    slides.push({
      title: `核查结论${i ? ` · ${i + 1}` : ''}`,
      table: {
        headers: ['条款 / 对象', '结论'],
        rows: group.map((x) => [x.topic.length > 50 ? x.topic.slice(0, 47) + '…' : x.topic, x.assessment]),
      },
      protected: true,
      sourceIds: [...new Set(group.flatMap((x) => [x.source, ...(x.requirement ? [x.requirement] : [])]))],
      notes: group.map((x) => `${x.topic}\n${x.assessment}\n${x.analysis}\n待补：${x.missing}`).join('\n\n'),
    });
  const metrics = report.findings.filter((x) => x.metric && !x.metric.calculation);
  const objects = [...new Set(metrics.map((x) => x.metric!.object))];
  const parameters = [...new Set(metrics.map((x) => x.metric!.parameter))];
  const matrix = objects.length > 1 && objects.length <= 4 && metrics.length === objects.length * parameters.length;
  if (matrix)
    for (const [i, group] of chunks(parameters, 7).entries()) {
      slides.push({
        title: `参数对比${i ? ` · ${i + 1}` : ''}`,
        table: {
          headers: ['参数', ...objects],
          rows: group.map((parameter) => [
            parameter,
            ...objects.map((object) => {
              const metric = metrics.find(
                (x) => x.metric!.parameter === parameter && x.metric!.object === object
              )!.metric!;
              return metric.value == null ? '未提供' : String(metric.value) + (metric.unit ? ' ' + metric.unit : '');
            }),
          ]),
        },
        protected: true,
        sourceIds: [...new Set(metrics.map((x) => x.source))],
      });
    }
  else
    for (const [i, group] of chunks(metrics, 6).entries())
      slides.push({
        title: `参数与资料版本${i ? ` · ${i + 1}` : ''}`,
        table: {
          headers: ['对象', '参数', '值', '单位'],
          rows: group.map((x) => [x.metric!.object, x.metric!.parameter, x.metric!.value ?? '未提供', x.metric!.unit]),
        },
        protected: true,
        sourceIds: [...new Set(group.map((x) => x.source))],
      });
  for (const [i, group] of chunks(
    formal.filter((x) => x.assessment !== '符合'),
    1
  ).entries())
    slides.push({
      title: `条件与待核事项${i ? ` · ${i + 1}` : ''}`,
      paragraphs: group.map(
        (x) => `${x.topic}\n${x.assessment}：${x.analysis}\n待核：${x.missing || '按原条款条件核查'}`
      ),
      protected: true,
      sourceIds: [...new Set(group.map((x) => x.source))],
      notes: group.map((x) => x.analysis + '\n' + x.missing).join('\n\n'),
    });
  const statuses = ['符合', '不符合', '部分符合', '证据不足'];
  const summary =
    `正式核查 ${formal.length} 项：` +
    statuses.map((status) => `${status} ${formal.filter((x) => x.assessment === status).length} 项`).join('；') +
    '。';
  slides.push({
    title: '结论与适用范围',
    layout: 'conclusion',
    paragraphs: [summary, '以已引证的独立要求和固定资料版本为限，现场条件、认证及其他待核事项须逐项落实。'],
    notes: report.conclusion + '\n' + report.scope,
    protected: true,
    sourceIds: sources.map((x) => x.id),
  });
  slides.push(...sourceSlides(sources));
  const resultHash = hash({ title, report, sources, originalDataSha256: provenance.dataSha256 });
  return {
    id: hash({ resultHash, layoutVersion: LAYOUT_VERSION }),
    resultHash,
    kind: 'evidence',
    title,
    report,
    slides: fit(slides),
    sources,
    provenance,
  };
}

/** Checks the saved native objects, not just a ZIP signature or a matching metadata hash. */
export function verifyPresentationContent(result: PresentationResult, actual: Record<string, unknown>): void {
  type ObjectValue = {
    kind: string;
    name: string;
    text?: string;
    rows?: string[][];
    categories?: string[];
    series?: Array<{ name: string; values: string[] }>;
  };
  const slides = actual.slides as Array<{ title: string; objects: ObjectValue[]; notes: string }>;
  const canonicalDecimal = (value: string) =>
    value
      .replace(/^(-?)0+(?=\d)/, '$1')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '')
      .replace(/^-0$/, '0');
  if (!slides || slides.length !== result.slides.length) throw new Error('PPT_SAVED_SLIDE_COUNT_MISMATCH');
  result.slides.forEach((expected, index) => {
    const saved = slides[index];
    if (saved.title !== expected.title) throw new Error('PPT_SAVED_TITLE_MISMATCH');
    const texts = saved.objects.filter((x) => x.kind === 'text').map((x) => x.text || '');
    for (const metric of expected.metrics || [])
      if (!texts.includes(metric.value + ' ' + (metric.unit || ''))) throw new Error('PPT_SAVED_METRIC_MISMATCH');
    const body = texts.join('\n');
    for (const paragraph of expected.paragraphs || [])
      if (!body.includes(paragraph)) throw new Error('PPT_SAVED_CONDITION_OR_TEXT_MISSING');
    if (expected.table) {
      const table = saved.objects.find((x) => x.kind === 'table');
      const wanted = [expected.table.headers, ...expected.table.rows].map((row) =>
        row.map((value) => (value == null ? '' : String(value)))
      );
      if (JSON.stringify(table?.rows) !== JSON.stringify(wanted)) throw new Error('PPT_SAVED_TABLE_MISMATCH');
    }
    if (expected.chart) {
      const chart = saved.objects.find((x) => x.kind === 'chart');
      if (
        JSON.stringify(chart?.categories) !== JSON.stringify(expected.chart.categories) ||
        JSON.stringify(chart?.series?.map((s) => [s.name, s.values.map(canonicalDecimal)])) !==
          JSON.stringify(expected.chart.series.map((s) => [s.name, s.values.map(canonicalDecimal)]))
      )
        throw new Error('PPT_SAVED_CHART_RESULT_MISMATCH');
    }
  });
}
