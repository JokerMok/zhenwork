import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requirePage(page, name) {
  if (!page || typeof page.locator !== 'function' || typeof page.waitForResponse !== 'function') {
    throw new Error(`${name} must be an authenticated Playwright Page`);
  }
}

function responsePath(response) {
  try {
    return new URL(response.url()).pathname;
  } catch {
    return '';
  }
}

function envelopeData(value) {
  return value && typeof value === 'object' && 'data' in value ? value.data : value;
}

async function responseData(response, operation) {
  if (!response.ok()) throw new Error(`${operation} failed with HTTP ${response.status()}`);
  const value = await response.json().catch(() => null);
  const data = envelopeData(value);
  if (!data || typeof data !== 'object') throw new Error(`${operation} returned an invalid response`);
  return data;
}

async function selectElementPlus(page, select, label) {
  const wrapper = select.locator('xpath=ancestor-or-self::div[contains(@class,"el-select__wrapper")][1]');
  await wrapper.click();
  const option = page.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter({ hasText: label });
  await option.first().waitFor({ state: 'visible' });
  await option.first().click();
}

async function openResourcePage(page) {
  const current = new URL(page.url());
  if (!['http:', 'https:'].includes(current.protocol)) {
    throw new Error('adminPage must already be authenticated on the target origin');
  }
  await page.goto(new URL('/admin/workspace-resources/resources', current.origin).toString());
  await page.getByRole('heading', { name: 'AI 资源管理', exact: true }).waitFor({ state: 'visible' });
}

async function createKnowledgeBase(adminPage, name) {
  const type = adminPage.getByRole('combobox', { name: '资源类型' });
  await selectElementPlus(adminPage, type, '知识库');
  await adminPage.getByRole('button', { name: '新建企业知识库', exact: true }).click();
  const editor = adminPage.getByRole('dialog').filter({ hasText: '新建企业知识库' }).first();
  await editor.waitFor({ state: 'visible' });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByLabel('说明', { exact: true }).fill('受控模拟资料，仅用于 T006-B 检索端到端验证。');
  const created = adminPage.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/ai\/resources$/.test(responsePath(response))
  );
  await editor.getByRole('button', { name: '保存企业资源', exact: true }).click();
  const resource = await responseData(await created, 'create controlled knowledge base');
  assert.match(String(resource.id || ''), UUID, 'knowledge base response did not contain a UUID');
  await editor.waitFor({ state: 'hidden' });
  const row = adminPage.locator('.el-table__row').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible' });
  return { resource, row };
}

async function uploadDocument(adminPage, dialog, baseId, file, document) {
  const input = document
    ? dialog.locator('.el-table__row').filter({ hasText: document.filename }).locator('input[type="file"]')
    : dialog.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached' });
  const uploaded = adminPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      responsePath(response).endsWith(`/ai/knowledge/${baseId}/documents`)
  );
  await input.setInputFiles({ name: file.filename, mimeType: 'text/markdown', buffer: Buffer.from(file.content) });
  const result = await responseData(await uploaded, `upload ${file.filename}`);
  assert.match(String(result.id || ''), UUID, 'document upload response did not contain a UUID');
  if (document) {
    assert.equal(result.id, document.id, 'new version was uploaded as a different document');
    assert.equal(result.version, document.version + 1, 'new document version did not increment');
  } else {
    assert.equal(result.version, 1, 'first upload did not create version 1');
  }
  return { id: result.id, version: result.version, filename: file.filename };
}

async function waitForIndexed(dialog, document, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    await dialog.getByRole('button', { name: '刷新索引状态', exact: true }).click();
    const row = dialog.locator('.el-table__row').filter({ hasText: document.filename }).first();
    if (await row.count()) {
      last = await row.innerText();
      const cells = row.locator('td');
      if (
        (await cells.nth(1).innerText()).trim() === String(document.version) &&
        (await cells.nth(2).innerText()).trim() === String(document.version) &&
        (await cells.nth(3).innerText()).includes('可使用')
      ) return row;
      if (last.includes('失败')) throw new Error(`knowledge indexing failed: ${last}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`knowledge version ${document.version} was not indexed within ${timeout} ms: ${last}`);
}

function diagnosticField(section, label) {
  return section.locator('.el-form-item').filter({ has: section.page().getByText(label, { exact: true }) }).first();
}

async function runDiagnostic(section, query, expectedOutcome) {
  await diagnosticField(section, '查询').locator('input').fill(query);
  const response = section.page().waitForResponse(
    (item) => item.request().method() === 'POST' && /\/ai\/knowledge\/[0-9a-f-]{36}\/retrieval-diagnostics$/i.test(responsePath(item))
  );
  await section.getByRole('button', { name: '运行诊断', exact: true }).click();
  const result = await responseData(await response, `diagnose ${expectedOutcome}`);
  assert.equal(result.outcome, expectedOutcome, `diagnostic API returned ${result.outcome}`);
  const summary = section.locator('.summary');
  await summary.waitFor({ state: 'visible' });
  const label = { HIT: '已命中', NO_HIT: '无命中', NOT_INDEXED: '未建立可用索引' }[expectedOutcome];
  assert.ok((await summary.innerText()).includes(label), `diagnostic UI did not render ${label}`);
  return result;
}

async function selectVersionScope(section, documentId, version) {
  await selectElementPlus(section.page(), diagnosticField(section, '范围').getByRole('combobox'), '指定文档版本');
  await diagnosticField(section, '文档 ID').locator('input').fill(documentId);
  await diagnosticField(section, '版本').locator('input').fill(String(version));
}

async function verifyHitAndSource(section, query, marker, document, version) {
  await selectVersionScope(section, document.id, version);
  const result = await runDiagnostic(section, query, 'HIT');
  assert.equal(result.scope.mode, 'VERSION_HISTORY');
  assert.equal(result.scope.documentId, document.id);
  assert.equal(result.scope.version, version);
  assert.ok(result.candidates.some((item) => item.version === version && item.content.includes(marker)));

  const candidate = section.locator('article.candidate').filter({ hasText: marker }).first();
  await candidate.waitFor({ state: 'visible' });
  const opened = section.page().waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      responsePath(response).endsWith(`/ai/knowledge/documents/${document.id}/versions/${version}`)
  );
  await candidate.getByRole('button', { name: '查看授权原文', exact: true }).click();
  const source = await responseData(await opened, `open source v${version}`);
  assert.equal(source.version, version);
  assert.ok(source.content.includes(marker), `source v${version} did not contain its marker`);
  const sourceDialog = section.page().getByRole('dialog').filter({ hasText: marker }).last();
  await sourceDialog.waitFor({ state: 'visible' });
  assert.ok((await sourceDialog.innerText()).includes(marker));
  await sourceDialog.locator('.el-dialog__headerbtn').click();
  await sourceDialog.waitFor({ state: 'hidden' });
  return result;
}

async function employeeRequest(employeePage, route, init) {
  return employeePage.evaluate(
    async ({ route, init }) => {
      const response = await fetch(route, { ...init, credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => null);
      return { status: response.status, code: body?.code, error: body?.error };
    },
    { route, init }
  );
}

function assertDenied(result, operation) {
  const denied = [403, 404].includes(result.status) || [403, 404].includes(result.code);
  assert.ok(denied, `${operation} was not denied (HTTP ${result.status}, code ${result.code ?? 'none'})`);
}

/**
 * Creates a uniquely marked knowledge fixture in the caller's isolated environment and exercises the real
 * Admin diagnostics component. Both pages must already be authenticated; this helper never reads credentials.
 */
export async function runRetrievalE2E({ adminPage, employeePage }) {
  requirePage(adminPage, 'adminPage');
  requirePage(employeePage, 'employeePage');

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixture = {
    name: `T006-B 受控检索 ${suffix}`,
    v1: `BQA_V1_${suffix}`,
    v2: `BQA_V2_${suffix}`,
    absent: `ZXQNOHIT${randomUUID().replaceAll('-', '')}`,
  };
  const files = {
    v1: {
      filename: `t006-b-${suffix}-v1.md`,
      content: `# T006-B 受控模拟文档\n\n版本一检索口令：${fixture.v1}\n\n本文档为隔离 B 的测试资料，不代表任何真实企业事实。\n`,
    },
    v2: {
      filename: `t006-b-${suffix}-v2.md`,
      content: `# T006-B 受控模拟文档\n\n版本二检索口令：${fixture.v2}\n\n版本二已替代当前索引；历史版本一仍只可通过指定版本诊断。\n`,
    },
  };

  await openResourcePage(adminPage);
  const { resource, row } = await createKnowledgeBase(adminPage, fixture.name);
  await row.getByRole('button', { name: '文档', exact: true }).click();
  const documentsDialog = adminPage.getByRole('dialog', { name: '企业知识文档' });
  await documentsDialog.waitFor({ state: 'visible' });

  const v1 = await uploadDocument(adminPage, documentsDialog, resource.id, files.v1);
  await waitForIndexed(documentsDialog, v1);
  const v2 = await uploadDocument(adminPage, documentsDialog, resource.id, files.v2, v1);
  await waitForIndexed(documentsDialog, v2);

  const diagnostics = documentsDialog.locator('section.diagnostics');
  await diagnostics.waitFor({ state: 'visible' });
  const current = await runDiagnostic(diagnostics, fixture.v2, 'HIT');
  assert.equal(current.scope.mode, 'CURRENT_INDEXED');
  assert.ok(current.candidates.some((item) => item.version === 2 && item.content.includes(fixture.v2)));

  const noHit = await runDiagnostic(diagnostics, fixture.absent, 'NO_HIT');
  assert.equal(noHit.summary.matchedCandidates, 0);
  assert.equal(await diagnostics.locator('article.candidate').count(), 0);

  const historyV1 = await verifyHitAndSource(diagnostics, fixture.v1, fixture.v1, v2, 1);
  const historyV2 = await verifyHitAndSource(diagnostics, fixture.v2, fixture.v2, v2, 2);
  assert.equal(historyV1.scope.versions[0].reason, 'HISTORY_INDEXED');
  assert.equal(historyV2.scope.versions[0].reason, 'CURRENT_INDEXED');

  const deniedDiagnostic = await employeeRequest(
    employeePage,
    `/enterprise/control/ai/knowledge/${resource.id}/retrieval-diagnostics`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: fixture.v2 }) }
  );
  assertDenied(deniedDiagnostic, 'employee retrieval diagnostics');
  const deniedSource = await employeeRequest(
    employeePage,
    `/enterprise/control/ai/knowledge/documents/${v2.id}/versions/1`,
    { method: 'GET' }
  );
  assertDenied(deniedSource, 'employee source preview');

  return {
    status: 'PASS',
    knowledgeBaseId: resource.id,
    documentId: v2.id,
    versions: [1, 2],
    outcomes: { current: current.outcome, noHit: noHit.outcome, historyV1: historyV1.outcome, historyV2: historyV2.outcome },
    employeeDenied: { diagnostics: deniedDiagnostic.code || deniedDiagnostic.status, source: deniedSource.code || deniedSource.status },
  };
}

export default runRetrievalE2E;
