import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { generateOfficeArtifact } from "../generate.js";
import { buildEvidenceDeliverables, parseEvidenceDelivery } from "./index.js";
import { buildOfficeSources } from "./presentation.js";
import { inspectOfficeStructure, reviseOfficeDocument } from "./revision.js";

const python = process.env.ZHENWORK_TEST_OFFICE_PYTHON;
const integration = python ? test : test.skip;
const run = promisify(execFile);
const source = {
  ref: "trusted-ref",
  kind: "knowledge" as const,
  quote: "甲材料12.50元，乙材料7.35元。此为功能测试合成资料。",
  locator: {
    documentId: "private-document-identity",
    sha256: "private-hash",
    version: 4,
    title: "采购需求功能样例",
    location: "第 2 节",
    sourceUrl:
      "https://workspace.example/#/workspace?section=knowledge&documentId=11111111-1111-4111-8111-111111111111&version=4&chunk=1",
  },
};
const args = parseEvidenceDelivery({
  basePath: "supply",
  title: "采购记录对比",
  scope: "明确标注合成数据，仅验证通用生成和续改。",
  conclusion: "两项原文金额及其程序合计如下；未提供报价有效期。",
  purpose: "research",
  rows: [
    {
      topic: "甲材料",
      source: { ref: "trusted-ref", quoteIndex: 0 },
      metric: { object: "采购计划", parameter: "甲材料金额", unit: "元", value: 12.5 },
      analysis: "等待采购确认",
      missing: "报价有效期待提供",
    },
    {
      topic: "乙材料",
      source: { ref: "trusted-ref", quoteIndex: 0 },
      metric: { object: "采购计划", parameter: "乙材料金额", unit: "元", value: 7.35 },
    },
    {
      topic: "两项合计",
      source: { ref: "trusted-ref", quoteIndex: 0 },
      metric: {
        object: "采购计划",
        parameter: "金额合计",
        unit: "元",
        calculation: { operation: "sum", rows: [1, 2] },
      },
    },
  ],
});
let docx: Buffer, xlsx: Buffer;
beforeAll(async () => {
  if (!python) return;
  process.env.ZHENWORK_OFFICE_PYTHON = python;
  const built = buildEvidenceDeliverables(args, [source, source, source]);
  docx = await generateOfficeArtifact(built.files[0].content);
  xlsx = await generateOfficeArtifact(built.files[1].content);
});
async function inspectZip(bytes: Buffer, format: string) {
  const script = `import io,json,sys,zipfile,xml.etree.ElementTree as E,base64\nb=base64.b64decode(sys.argv[1]);z=zipfile.ZipFile(io.BytesIO(b));fmt=sys.argv[2]\nparts=['word/document.xml'] if fmt=='docx' else [n for n in z.namelist() if n.startswith('xl/worksheets/') and n.endswith('.xml')]\ntext=''.join(''.join(t.text or '' for t in E.fromstring(z.read(n)).iter() if t.tag.endswith('}t')) for n in parts)\nrels=[E.fromstring(z.read(n)) for n in z.namelist() if n.endswith('.rels')]\nlinks=[r.get('Target') for root in rels for r in root if r.get('Type','').endswith('/hyperlink')]\nout={'text':text,'links':links,'provenance':z.read('customXml/zhenwork-provenance.xml').decode(),'crc':z.testzip()}\nif fmt=='xlsx':\n import openpyxl\n w=openpyxl.load_workbook(io.BytesIO(b),data_only=False);v=openpyxl.load_workbook(io.BytesIO(b),data_only=True);s=w['参数对比'];out['cells']=[{'cell':c.coordinate,'type':c.data_type,'value':c.value,'cache':v['参数对比'][c.coordinate].value} for row in s for c in row if c.column==4];out['frozen']=s.freeze_panes;out['printArea']=str(s.print_area)\nprint(json.dumps(out,ensure_ascii=False))`;
  return JSON.parse((await run(python!, ["-c", script, bytes.toString("base64"), format])).stdout);
}

test("deduplicates source numbers and rejects credentials even in hidden provenance", () => {
  const catalog = buildOfficeSources([source, { ...source, ref: "another-ref" }]);
  expect(catalog.numbers).toEqual(["S1", "S1"]);
  expect(catalog.entries).toHaveLength(1);
  expect(() =>
    buildOfficeSources([{ ...source, locator: { url: "https://example.com?token=secret" } }]),
  ).toThrow("CREDENTIAL_URL_REJECTED");
});
integration(
  "creates readable Word body, genuine hyperlink relationships and hidden complete evidence",
  async () => {
    const info = await inspectZip(docx, "docx");
    expect(info.text).not.toContain("private-document-identity");
    expect(info.text).not.toContain("private-hash");
    expect(info.links).toContain(source.locator.sourceUrl);
    expect(info.provenance).toContain("private-document-identity");
  },
);
integration(
  "keeps Excel numeric types, native formulas and freshly calculated Decimal results",
  async () => {
    const info = await inspectZip(xlsx, "xlsx");
    const formula = info.cells.find((c: { type: string }) => c.type === "f");
    expect(formula.value).toMatch(/^=SUM\(D\d+,D\d+\)$/);
    expect(formula.cache).toBe(19.85);
    expect(
      info.cells
        .filter(
          (c: { type: string }) => c.type === "n" && (c as { value?: unknown }).value !== null,
        )
        .map((c: { value: unknown }) => c.value),
    ).toEqual([12.5, 7.35]);
    expect(info.links).toContain(source.locator.sourceUrl);
  },
);
integration(
  "adds an actual numbered Word heading and retains source links and preceding tables",
  async () => {
    const before = await inspectOfficeStructure("report.docx", docx);
    const result = await reviseOfficeDocument("report.docx", docx, [
      {
        kind: "append_section",
        heading: "核实资料清单",
        paragraphs: ["报价有效期待提供"],
        numbered: true,
      },
    ]);
    const after = await inspectOfficeStructure("report.docx", result.bytes!);
    expect(after.levelOneHeadingCount).toBe(Number(before.levelOneHeadingCount) + 1);
    expect(after.tables).toEqual(before.tables);
    expect(JSON.stringify(result.result.changes)).toContain("actualHeading");
    expect((await inspectZip(result.bytes!, "docx")).links).toEqual(
      (await inspectZip(docx, "docx")).links,
    );
  },
);
integration(
  "modifies only the requested Excel value and recalculates dependent formulas without changing source sheet",
  async () => {
    const original = await inspectZip(xlsx, "xlsx");
    const target = original.cells.find((c: { value: unknown }) => c.value === 12.5);
    const changed = await reviseOfficeDocument("report.xlsx", xlsx, [
      { kind: "set_cell", sheet: "参数对比", cell: target.cell, expected: 12.5, value: 13.25 },
    ]);
    const result = await inspectZip(changed.bytes!, "xlsx");
    expect(result.cells.find((c: { type: string }) => c.type === "f").cache).toBe(20.6);
    expect(result.links).toEqual(original.links);
    expect(result.frozen).toBe(original.frozen);
    expect(result.printArea).toBe(original.printArea);
  },
);
integration(
  "failed text/cell assumptions and quote changes do not produce a replacement artifact",
  async () => {
    await expect(
      reviseOfficeDocument("report.docx", docx, [
        { kind: "replace_text", find: "不存在的第十七节", replace: "改动", expectedOccurrences: 1 },
      ]),
    ).rejects.toThrow("REPLACEMENT_COUNT_MISMATCH");
    await expect(
      reviseOfficeDocument("report.docx", docx, [
        {
          kind: "replace_text",
          find: "甲材料12.50元",
          replace: "甲材料99元",
          expectedOccurrences: 1,
        },
      ]),
    ).rejects.toThrow("VERIFIED_SOURCE_QUOTE_CHANGED");
    await expect(
      reviseOfficeDocument("report.xlsx", xlsx, [
        {
          kind: "set_cell",
          sheet: "资料来源",
          cell: "B2",
          expected: "采购需求功能样例",
          value: "篡改",
        },
      ]),
    ).rejects.toThrow("SOURCE_CATALOG_READ_ONLY");
  },
);

integration('keeps narrative findings in notes and remaps native formula references after compacting numeric rows', async () => {
  const mixed = structuredClone(args);
  mixed.rows.unshift({ topic: '资料性质说明', source: { ref: 'trusted-ref', quoteIndex: 0 }, assessment: '证据不足', analysis: '合成资料说明不属于数值参数', missing: '' });
  mixed.rows.at(-1)!.metric!.calculation!.rows = [2, 3];
  const built = buildEvidenceDeliverables(mixed, [source, source, source, source]);
  const bytes = await generateOfficeArtifact(built.files[1].content);
  const info = await inspectZip(bytes, 'xlsx');
  expect(info.cells.filter((c: { type: string; value: unknown }) => c.type === 'n' && c.value !== null)).toHaveLength(2);
  expect(info.cells.find((c: { type: string }) => c.type === 'f').cache).toBe(19.85);
});

integration('ambiguous continuation cannot replace two paragraphs when only one location was selected', async () => {
  const bytes = await generateOfficeArtifact({ format: 'docx', title: '定位续改', paragraphs: ['重复说明', '保留中间段', '重复说明'] });
  await expect(reviseOfficeDocument('narrow.docx', bytes, [{ kind: 'replace_text', find: '重复说明', replace: '单处修改', expectedOccurrences: 1 }])).rejects.toThrow('AMBIGUOUS_TEXT');
  const revised = await reviseOfficeDocument('narrow.docx', bytes, [{ kind: 'replace_text', paragraph: 2, find: '重复说明', replace: '单处修改', expectedOccurrences: 1 }]);
  const info = await inspectOfficeStructure('narrow.docx', revised.bytes!);
  expect((info.paragraphs as Array<{text:string}>).map(p => p.text)).toEqual(['定位续改', '单处修改', '保留中间段', '重复说明']);
});

test("text lines and web excerpt offsets retain real readable source positions", () => {
  const actual = buildOfficeSources([
    { ...source, locator: { path: 'requirements.md', location: {kind: 'text_chunk', lineStart: 1, lineEnd: 9} } },
    { ...source, locator: { url: 'https://example.com/law', location: {kind: 'web_excerpt', start: 190000, end: 194000} } },
  ]);
  expect(actual.entries.map(s => s.location)).toEqual(['第 1–9 行', '网页正文字符 190000–194000']);
});
