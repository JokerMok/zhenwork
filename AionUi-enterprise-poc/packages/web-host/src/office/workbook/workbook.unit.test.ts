import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import yauzl from 'yauzl';
import { auditWorkbook, editWorkbookColumn, inspectWorkbook } from './index.js';

const fixture = Buffer.from(
  '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',
  'base64'
);

const formulaFixture = Buffer.from(
  'UEsDBBQAAAAIADxIVV0cdPw42AAAAPYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2RvU4DMQzHX+WUtWpcGDqgXhfKCgy8gJvz9aLLl2K3XN++uVAYUIGFyUr+Hz9L3rydE3EzeRe4VYNIegBgM5BH1jFRKEofs0cpz3yAhGbEA8H9arUGE4NQkKXMHWq72VGPRyfN01S+2cbQqkyOVfP4YZxZrcKUnDUoRYdT6L5RlleCLsnq4cEmXhSDgpuEWfkZcM29nChn21Hzilme0RcXTA7eYx73MY7695IbW8a+t4a6aI6+RDSnTNjxQCTe6Tq1RxsWf/OrmaGOu39e5Kv/cw+o595eAFBLAwQUAAAACAA8SFVd/luGcooAAADwAAAACwAAAF9yZWxzLy5yZWxzjc8xDsIwDAXQq1Q+QF0YGFDaiaUr4gImddqqTRw5QZTbk7EgBkbrf70vmyuvlGcJaZpjqja/htTClHM8IyY7sadUS+RQEifqKZdTR4xkFxoZj01zQt0b0Jm9WfVDC9oPB6hur8j/2OLcbPki9uE55B8TX40ik46cW9hWfIoud5GlLihgZ/Djwe4NUEsDBBQAAAAIADxIVV03ZlT9pQAAAOoAAAAPAAAAeGwvd29ya2Jvb2sueG1sjY8xDsIwDEWvEuUAuGVgqNpOLD1GaF0StYkjJwjGzsxcgAGJO3CfCm5B1dKdybae/rN+fibuDkSduNjehULqGH0GEGqNVoUNeXQTaYmtitPJRwieUTVBI0bbwzZJdmCVcXIxZPyPg9rW1Lin+mTRxUXC2KtoyAVtfJBlPn8IvymcsljI8fr43IZxeL3vTylmUjWFTKXgzEwLV00qocxhDcPar/wCUEsDBBQAAAAIADxIVV22VKrPjgAAAPEAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHONzz0OwjAMBeCrVDlA3TIwoCYTS1fEBaLUbaI2P7KNgNsTMaAiMTBZfpa+Jw8X3KyEnNiHws0jbom18iLlBMDOY7Tc5oKpXuZM0UpdaYFi3WoXhEPXHYH2hjLD3mzGSSsap14112fBf+w8z8HhObtbxCQ/KuCeaWWPKBW1tKBo9YkY3qNvq6rADPD1oXkBUEsDBBQAAAAIADxIVV0prsPDwwAAAKUBAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1shdGxDoIwEAbgVzFMunBqW4GmdCDC5mR8gAaLGCmQtgEfX0AtxkG36/13X5qW9Y2+mVJKu7irqjaxV1rbUgCTl1IJ4zetrIekaLQSdjjqC5hWS3GellQF2/V6B0pca4+zqbcXVnCmm36hYw8N3XwskrHqOAr8MGTQcQb5K8nGpODH02GZIJqiFYNiHI2iyA3CwDkTOxNPJt743ySeSUxT/JckjiTPa4Z+RL5MMpuEpuSvGbzNLHCbGaLZj034eEBwP8MfUEsBAhQDFAAAAAgAPEhVXRx0/DjYAAAA9gEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAA8SFVd/luGcooAAADwAAAACwAAAAAAAAAAAAAAgAEJAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAA8SFVdN2ZU/aUAAADqAAAADwAAAAAAAAAAAAAAgAG8AQAAeGwvd29ya2Jvb2sueG1sUEsBAhQDFAAAAAgAPEhVXbZUqs+OAAAA8QAAABoAAAAAAAAAAAAAAIABjgIAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzUEsBAhQDFAAAAAgAPEhVXSmuw8PDAAAApQEAABgAAAAAAAAAAAAAAIABVAMAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLBQYAAAAABQAFAEUBAABNBAAAAAA=',
  'base64'
);

const namespaceAndPrintAreaFixture = Buffer.from(
  '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',
  'base64'
);

const priorPython = process.env.ZHENWORK_OFFICE_PYTHON;

beforeAll(() => {
  process.env.ZHENWORK_OFFICE_PYTHON = '/usr/bin/python3';
});

afterAll(() => {
  if (priorPython === undefined) delete process.env.ZHENWORK_OFFICE_PYTHON;
  else process.env.ZHENWORK_OFFICE_PYTHON = priorPython;
});

async function zipParts(content: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(content, { lazyEntries: true }, (openError, archive) => {
      if (openError || !archive) {
        reject(openError || new Error('ZIP_OPEN_FAILED'));
        return;
      }
      const parts = new Map<string, Buffer>();
      archive.on('error', reject);
      archive.on('end', () => resolve(parts));
      archive.on('entry', (entry) => {
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError || new Error('ZIP_STREAM_FAILED'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            parts.set(entry.fileName, Buffer.concat(chunks));
            archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}

describe('workbook inspection and audit', () => {
  test('rejects a relative interpreter override before spawning it', async () => {
    process.env.ZHENWORK_OFFICE_PYTHON = 'python3';
    try {
      await expect(inspectWorkbook(fixture)).rejects.toThrow('WORKBOOK_PYTHON_PATH_INVALID');
    } finally {
      process.env.ZHENWORK_OFFICE_PYTHON = '/usr/bin/python3';
    }
  });

  test('returns bounded structure, title merge, print area, and dirty title cells', async () => {
    const result = await inspectWorkbook(fixture, { sheet: '明细', maxRows: 11, maxColumns: 11 });
    const sheets = result.sheets as Array<Record<string, unknown>>;
    expect(result.sheetCount).toBe(2);
    expect(sheets[0].merges).toEqual(['A1:J1']);
    expect(sheets[0].printArea).toBe("'明细'!$A$1:$K$11");
    expect(JSON.stringify(sheets[0].rows)).toContain('脏副标题');
  });

  test('adds exact XML decimals and rounds monetary output half up', async () => {
    const result = await auditWorkbook(fixture, {
      sheet: '明细',
      amountRange: 'J4:J11',
      expectedTotal: '23.25',
    });
    expect(result.exactTotal).toBe('23.256');
    expect(result.total).toBe('23.26');
    expect(result.difference).toBe('0.01');
    expect(result.detailCount).toBe(8);
  });

  test('rejects unsupported formulas instead of trusting their cached value', async () => {
    await expect(auditWorkbook(fixture, { sheet: '公式', amountRange: 'A2' })).rejects.toThrow('FORMULA_UNSUPPORTED');
  });

  test('recalculates SUM chains and reconciles an explicit workbook total cell', async () => {
    const result = await auditWorkbook(formulaFixture, {
      sheet: '报销总表',
      amountRange: 'B3:E5',
      totalCell: 'F7',
      expectedTotal: '118.63',
    });
    expect(result.exactTotal).toBe('118.63');
    expect(result.workbookTotal).toBe('118.63');
    expect(result.workbookDifference).toBe('0.00');
    expect(result.detailCount).toBe(3);
  });

  test('rejects adding formula totals to their own details and offers inspected subtotal ranges', async () => {
    await expect(auditWorkbook(formulaFixture, { sheet: '报销总表', amountRanges: ['B3:B5', 'F3:F5'], totalCell: 'F7' })).rejects.toThrow('AMOUNT_DEPENDENCY_OVERLAP');
    const inspected = await inspectWorkbook(formulaFixture, { sheet: '报销总表' });
    expect((inspected.sheets as Array<Record<string, unknown>>)[0].auditSuggestions).toContainEqual(expect.objectContaining({ amountRange: 'F3:F5', totalCell: 'F7' }));
    const audited = await auditWorkbook(formulaFixture, { sheet: '报销总表', amountRange: 'F3:F5', totalCell: 'F7' });
    expect(inspected.recommendedAudit).toMatchObject({ amountRange: 'F3:F5', totalCell: 'F7' });
    await expect(auditWorkbook(formulaFixture, { sheet: '报销总表', amountRange: 'Z100' })).rejects.toThrow('NO_NUMERIC_DETAILS_SELECTED');
    expect(audited.status).toBe('matched');
    expect(audited.detailCount).toBe(3);
  });

  test('rejects a missing workbook total cell and non-finite expected totals', async () => {
    await expect(
      auditWorkbook(formulaFixture, { sheet: '报销总表', amountRange: 'B3:E5', totalCell: 'G9' })
    ).rejects.toThrow('TOTAL_CELL_VALUE_INVALID');
    await expect(
      auditWorkbook(formulaFixture, {
        sheet: '报销总表',
        amountRange: 'B3:E5',
        expectedTotal: Number.NaN,
      })
    ).rejects.toThrow('EXPECTED_TOTAL_INVALID');
  });
});

describe('workbook column edit', () => {
  test('extends title merge and simple print area while preserving ignorable namespaces', async () => {
    const result = await editWorkbookColumn(namespaceAndPrintAreaFixture, {
      sheet: '明细',
      headerRow: 3,
      startRow: 4,
      endRow: 5,
      column: 'K',
      header: '税额',
      values: [1, 2],
    });
    const verification = result.verification as Record<string, unknown>;
    const parts = await zipParts(result.workbook!);
    const worksheet = parts.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(result.titleMergeChange).toEqual({ from: 'A1:J1', to: 'A1:K1' });
    expect(result.printAreaChange).toEqual({ from: "'明细'!$A$1:$J$5", to: "'明细'!$A$1:$K$5" });
    expect(verification.title).toBe('旧标题');
    expect(worksheet).toContain('xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"');
    expect(worksheet).toContain('mc:Ignorable="xr"');
  });

  test('edits only the requested column and returns reopened verification', async () => {
    const result = await editWorkbookColumn(fixture, {
      sheet: '明细',
      headerRow: 3,
      startRow: 4,
      endRow: 11,
      column: 'K',
      header: '税额',
      values: ['0.01', '0.02', '0.03', '0.04', '0.05', '0.06', '0.07', '0.08'],
      newTitle: '新标题',
    });
    const verification = result.verification as Record<string, unknown>;
    expect(result.titleMergeChange).toEqual({ from: 'A1:J1', to: 'A1:K1' });
    expect(verification.title).toBe('新标题');
    expect(verification.merges).toEqual(['A1:K1']);
    expect(verification.printArea).toBe("'明细'!$A$1:$K$11");
    expect((verification.targetCells as Array<Record<string, unknown>>)[0]).toMatchObject({
      cell: 'K3',
      value: '税额',
    });
    expect(verification.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('preserves every untouched OOXML part including WPS image parts', async () => {
    const result = await editWorkbookColumn(fixture, {
      sheet: '明细',
      headerRow: 3,
      startRow: 4,
      endRow: 11,
      column: 'K',
      header: '税额',
      values: [1, 2, 3, 4, 5, 6, 7, 8],
      newTitle: '新标题',
    });
    const before = await zipParts(fixture);
    const after = await zipParts(result.workbook!);
    const changedPart = 'xl/worksheets/sheet1.xml';
    const untouched = [...before.keys()].filter((name) => name !== changedPart);
    const editedSheet = after.get(changedPart)!.toString('utf8');
    expect(after.get('xl/media/image1.png')).toEqual(before.get('xl/media/image1.png'));
    expect(untouched.every((name) => after.get(name)?.equals(before.get(name)!))).toBe(true);
    expect(editedSheet).toContain('>甲<');
    expect(editedSheet).not.toContain('脏标题');
    expect(editedSheet).not.toContain('脏副标题');
  });

  test('rejects edits that would overwrite formulas', async () => {
    await expect(
      editWorkbookColumn(fixture, {
        sheet: '公式',
        headerRow: 1,
        startRow: 2,
        endRow: 2,
        column: 'A',
        header: '金额',
        values: [1],
      })
    ).rejects.toThrow('EDIT_FORMULA_OVERWRITE_UNSAFE');
  });

  test('rejects edits through an existing merged range', async () => {
    await expect(
      editWorkbookColumn(fixture, {
        sheet: '明细',
        headerRow: 1,
        startRow: 2,
        endRow: 2,
        column: 'A',
        header: '标题',
        values: ['值'],
      })
    ).rejects.toThrow('EDIT_MERGED_CELL_UNSAFE');
  });
});

test('current summary date labels are programmatically grouped; event-row count cannot replace date count', async () => {
  const dated = execFileSync('/usr/bin/python3', ['-c', String.raw`import io,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));parts={n:z.read(n) for n in z.namelist()};ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main";q=lambda n:"{"+ns+"}"+n
r=E.fromstring(parts["xl/worksheets/sheet1.xml"]);data=r.find(q("sheetData"))
for ref,value in [("A2","日期"),("A3","46273"),("A4","46279"),("A5","46282")]:
 rownum=ref[1:];row=next((x for x in data if x.get("r")==rownum),None)
 if row is None:row=E.SubElement(data,q("row"),{"r":rownum})
 old=next((c for c in row if c.get("r")==ref),None)
 if old is not None:row.remove(old)
 cell=E.SubElement(row,q("c"),{"r":ref})
 if ref=="A2":cell.set("t","inlineStr");E.SubElement(E.SubElement(cell,q("is")),q("t")).text=value
 else:E.SubElement(cell,q("v")).text=value
parts["xl/worksheets/sheet1.xml"]=E.tostring(r);out=io.BytesIO()
with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as target:
 for n,b in parts.items():target.writestr(n,b)
sys.stdout.buffer.write(out.getvalue())`], { input: formulaFixture });
  const result = await auditWorkbook(dated, { sheet: '报销总表', amountRange: 'F3:F5', totalCell: 'F7' });
  expect(result.grouping).toMatchObject({ groupCount: 3, column: 'A', displayedTotalDifference: '0.00', groups: [{key:'2026-09-08',total:'37.88'}, {key:'2026-09-14',total:'41.80'}, {key:'2026-09-17',total:'38.95'}] });
  expect(result.detailCountMeaning).toContain('not automatically invoices');
  await expect(auditWorkbook(dated, { sheet:'报销总表',amountRange:'F3:F5',groupByColumn:'Z' })).rejects.toThrow('GROUP_KEY_MISSING');
});
