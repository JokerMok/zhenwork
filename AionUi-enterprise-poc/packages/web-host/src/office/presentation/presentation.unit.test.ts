import { beforeAll, expect, test } from 'vitest';
import { generateOfficeArtifact } from '../generate.js';
import { presentationPython } from './index.js';
import { evidencePresentation } from './build.js';
import type { OfficeReport } from '../delivery/presentation.js';
import { inspectOfficeStructure, reviseOfficeDocument } from '../delivery/revision.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const python = process.env.ZHENWORK_TEST_OFFICE_PYTHON;
const integration = python ? test : test.skip;
beforeAll(() => {
  if (python) process.env.ZHENWORK_OFFICE_PYTHON = python;
});

integration('stores native editable charts with exact result values and embedded workbooks', async () => {
  const bytes = await generateOfficeArtifact({
    format: 'pptx',
    slides: [
      { title: '合成月报', layout: 'cover' },
      {
        title: '分析概要',
        metrics: [
          { label: '总重量', value: '2150.000', unit: 'kg' },
          { label: '有效记录', value: '3', unit: '条' },
        ],
      },
      {
        title: '来源结构',
        chart: {
          type: 'column',
          title: '来源重量（kg）',
          categories: ['A车间', 'B车间'],
          series: [{ name: '重量', values: ['1350.000', '800.000'] }],
          numberFormat: '0.000',
          dataKey: 'bySource',
        },
      },
      { title: '核查结果', table: { headers: ['条款', '结论'], rows: [['Q03', '部分符合，遮蔽条件待确认']] } },
    ],
    provenance: { schemaVersion: 1, sources: [], dataSha256: '1'.repeat(64) },
  });
  const saved = await presentationPython(bytes.length ? 'inspect' : 'template', bytes);
  expect(saved.slideCount).toBe(4);
  expect([saved.nativeCharts, saved.nativeTables]).toEqual([1, 1]);
  expect(JSON.stringify(saved)).toContain('1350.0');
});
integration('rejects a text overflow instead of publishing clipped business facts', async () => {
  await expect(
    generateOfficeArtifact({
      format: 'pptx',
      slides: [{ title: '内容', paragraphs: Array(6).fill('长文本'.repeat(190)) }],
    })
  ).rejects.toThrow('PPT_TEXT_OVERFLOW');
});
test('keeps Q03 conditional and excludes version context from formal conformity statistics', () => {
  const report: OfficeReport = {
    purpose: 'compliance',
    scope: '合成验收',
    conclusion: '待核现场遮蔽',
    findings: ['符合', '不符合', '部分符合', '不符合', '证据不足'].map((assessment, i) => ({
      topic: 'Q0' + (i + 1),
      source: 'S1',
      assessment,
      analysis: i === 2 ? '仅有遮蔽室外；现场遮蔽未确认' : '合成资料',
      missing: '待确认',
    })),
  };
  report.findings.push({
    topic: '版本差异',
    rowType: 'context',
    source: 'S1',
    assessment: '背景说明',
    analysis: 'v1/v2',
    missing: '',
  });
  const result = evidencePresentation('资料核查', report, [], { schemaVersion: 1, sources: [] });
  expect(result.slides[1].metrics?.map((x) => x.value)).toEqual(['5', '1', '20']);
  expect(JSON.stringify(result.slides)).toContain('现场遮蔽未确认');
});
integration('rejects native table contents that cannot fit the requested page', async () => {
  await expect(
    generateOfficeArtifact({
      format: 'pptx',
      slides: [
        {
          title: '参数',
          table: { headers: ['参数', '内容'], rows: Array.from({ length: 8 }, () => ['参数', '内容'.repeat(250)]) },
        },
      ],
    })
  ).rejects.toThrow('PPT_TABLE_OVERFLOW');
});

const resultId = '4'.repeat(64);
const fixtureSlides = [
  { title: '月报', layout: 'cover' as const },
  { title: '分析概要', metrics: [{ label: '总量', value: '2150.000', unit: 'kg' }] },
  {
    title: '来源结构',
    chart: {
      type: 'column' as const,
      title: '来源重量',
      categories: ['A', 'B'],
      series: [{ name: 'kg', values: ['1350.000', '800.000'] }],
      numberFormat: '0.000',
      dataKey: 'bySource',
    },
  },
];
let fixture: Promise<Buffer> | undefined;
const deck = () =>
  (fixture ||= generateOfficeArtifact({
    format: 'pptx',
    slides: fixtureSlides,
    provenance: {
      schemaVersion: 1,
      sources: [],
      businessResult: { id: resultId, resultHash: resultId, kind: 'analysis', origin: {}, relatedFiles: [] },
    },
  }));
const trusted = { id: resultId, slides: fixtureSlides };

integration('changes only the third title XML and revision metadata, preserving every other part', async () => {
  const before = await deck();
  const changed = await reviseOfficeDocument(
    'report.pptx',
    before,
    [{ kind: 'set_slide_title', slide: 3, expectedText: '来源结构', title: '车间产废重量对比' }],
    undefined,
    trusted
  );
  const run = promisify(execFile);
  const script =
    'import sys,io,zipfile,base64,json\na=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.argv[1])));b=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.argv[2])));print(json.dumps([n for n in set(a.namelist())|set(b.namelist()) if n not in a.namelist() or n not in b.namelist() or a.read(n)!=b.read(n)]))';
  const diff = JSON.parse(
    (await run(python!, ['-c', script, before.toString('base64'), changed.bytes!.toString('base64')])).stdout
  );
  expect(diff.sort()).toEqual(['customXml/zhenwork-provenance.xml', 'ppt/slides/slide3.xml']);
  expect(JSON.stringify(changed.result.after)).toContain('车间产废重量对比');
});
integration('rejects stale object text without producing replacement bytes', async () => {
  await expect(
    reviseOfficeDocument(
      'report.pptx',
      await deck(),
      [{ kind: 'set_slide_title', slide: 3, expectedText: '旧标题', title: '不应保存' }],
      undefined,
      trusted
    )
  ).rejects.toThrow('PPT_TEXT_CHANGED');
});
integration('retains native chart data when its title and display style change', async () => {
  const bytes = await deck();
  const before = await inspectOfficeStructure('report.pptx', bytes);
  const slides = before.slides as Array<{ objects: Array<{ kind: string; id: number }> }>;
  const shapeId = slides[2].objects.find((o) => o.kind === 'chart')!.id;
  const changed = await reviseOfficeDocument(
    'report.pptx',
    bytes,
    [{ kind: 'set_chart_style', slide: 3, shapeId, expectedText: '来源重量', title: '来源对比（kg）', style: 10 }],
    undefined,
    trusted
  );
  const after = changed.result.after as { slides: Array<{ objects: Array<{ kind: string; series?: unknown }> }> };
  expect(after.slides[2].objects.find((x) => x.kind === 'chart')?.series).toEqual(
    (slides[2].objects.find((x) => x.kind === 'chart') as unknown as { series: unknown }).series
  );
});
integration('inserts, reorders and deletes a narrative page while retaining the verified chart', async () => {
  let bytes = await deck();
  for (const operation of [
    { kind: 'insert_slide', position: 3, content: { title: '讨论', paragraphs: ['待核事项'] } },
    { kind: 'move_slide', slide: 3, destination: 4 },
    { kind: 'delete_slide', slide: 4 },
  ])
    bytes = (await reviseOfficeDocument('report.pptx', bytes, [operation], undefined, trusted)).bytes!;
  const after = await inspectOfficeStructure('report.pptx', bytes);
  expect(after.slideCount).toBe(3);
  expect(after.nativeCharts).toBe(1);
});
integration('refuses edits to a trusted metric and refuses chart data from a different result', async () => {
  const bytes = await deck();
  const before = await inspectOfficeStructure('report.pptx', bytes);
  const slides = before.slides as Array<{ objects: Array<{ kind: string; name: string; id: number }> }>;
  const metric = slides[1].objects.find((o) => o.name === 'zw:metric-value')!;
  await expect(
    reviseOfficeDocument(
      'report.pptx',
      bytes,
      [{ kind: 'set_slide_text', slide: 2, shapeId: metric.id, expectedText: '2150.000 kg', text: '999 kg' }],
      undefined,
      trusted
    )
  ).rejects.toThrow('PPT_BUSINESS_FACT_READ_ONLY');
  const chart = slides[2].objects.find((o) => o.kind === 'chart')!;
  await expect(
    reviseOfficeDocument(
      'report.pptx',
      bytes,
      [{ kind: 'update_chart', slide: 3, shapeId: chart.id, resultId: '5'.repeat(64), dataKey: 'bySource' }],
      undefined,
      trusted
    )
  ).rejects.toThrow('PPT_DATA_CHANGE_REGENERATE');
});
