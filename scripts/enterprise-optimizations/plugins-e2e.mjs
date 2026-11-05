import assert from 'node:assert/strict';

/**
 * Public, pre-existing MIT source used by the real GitHub maintenance dialog.
 * The directory contains only package paths accepted by WorkspaceSkillPackage.
 */
export const PINNED_GITHUB_SKILL = Object.freeze({
  repository: 'marcusrbrown/systematic',
  ref: 'd8aceb94aa24c66283ce3da2b68157bd9f32be00',
  path: 'skills/test-driven-development',
  license: 'MIT',
});

const ADMIN_RESOURCES_PATH = '/admin/workspace-resources/resources';
const ADMIN_API = '/api';
const WAIT_STEP_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function routePath(response) {
  return new URL(response.url()).pathname;
}

function responseFor(page, path, method = 'GET', timeout = 60_000) {
  return page.waitForResponse((response) =>
    routePath(response) === path && response.request().method() === method, { timeout });
}

function unwrapEnvelope(body, label) {
  assert(body && typeof body === 'object', `${label}: expected a JSON object`);
  assert.equal(body.code, 200, `${label}: backend envelope code ${body.code}`);
  return body.data;
}

async function responseData(response, label) {
  const body = await response.json();
  assert(response.ok(), `${label}: HTTP ${response.status()} ${JSON.stringify(body)}`);
  return unwrapEnvelope(body, label);
}

/** Same-origin JSON request that preserves each persistent Page's real cookies/clientid. */
export async function pageJson(page, route, { method = 'GET', body, statuses = [200] } = {}) {
  const result = await page.evaluate(async ({ route: target, method: verb, body: input }) => {
    const response = await fetch(target, {
      method: verb,
      headers: input === undefined ? undefined : { 'content-type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { status: response.status, body: value };
  }, { route, method, body });
  assert(statuses.includes(result.status),
    `${method} ${route}: expected HTTP ${statuses.join('/')}, got ${result.status} ${JSON.stringify(result.body)}`);
  return result;
}

async function waitUntil(check, { timeout = 90_000, interval = WAIT_STEP_MS, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function formInput(dialog, label) {
  return dialog.locator('.el-form-item')
    .filter({ hasText: label })
    .locator('input').first();
}

async function selectSkillResourceType(page) {
  const select = page.getByRole('combobox', { name: '资源类型' });
  await select.locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")][1]').click();
  await page.getByRole('option', { name: '技能', exact: true }).click();
  await page.getByRole('button', { name: '从 GitHub 导入', exact: true }).waitFor();
}

async function openAdminResources(page) {
  const current = new URL(page.url());
  await page.goto(new URL(ADMIN_RESOURCES_PATH, current.origin).toString());
  await page.getByRole('heading', { name: 'AI 资源管理', exact: true }).waitFor();
  await selectSkillResourceType(page);
}

async function previewPinnedSource(page, dialog, source) {
  await formInput(dialog, '仓库').fill(source.repository);
  await formInput(dialog, '分支、标签或提交').fill(source.ref);
  await formInput(dialog, '技能目录').fill(source.path);

  const pending = responseFor(page, `${ADMIN_API}/ai/skills/import/github/preview`, 'POST');
  await dialog.getByRole('button', { name: '检查来源', exact: true }).click();
  const preview = await responseData(await pending, 'GitHub Skill preview');
  assert.match(preview.origin.commit, /^[0-9a-f]{40}$/, 'preview must resolve an immutable commit');
  assert.equal(preview.origin.repository, source.repository);
  assert.equal(preview.origin.path, source.path);
  assert.equal(preview.origin.license?.declared, source.license,
    'fixed GitHub source must retain its declared MIT license');
  await dialog.getByText('固定提交', { exact: true }).waitFor();
  return preview;
}

/**
 * Drives the actual SkillMaintenance.vue create path and returns the saved resource.
 */
export async function importPinnedSkillThroughAdmin(adminPage, {
  name = `T006 plugins e2e ${Date.now()}`,
  source = PINNED_GITHUB_SKILL,
} = {}) {
  await openAdminResources(adminPage);
  await adminPage.getByRole('button', { name: '从 GitHub 导入', exact: true }).click();
  const dialog = adminPage.getByRole('dialog', { name: '从 GitHub 维护技能' });
  await dialog.waitFor();
  const preview = await previewPinnedSource(adminPage, dialog, source);
  await formInput(dialog, '名称').fill(name);

  const pending = responseFor(adminPage, `${ADMIN_API}/ai/skills/import/github`, 'POST');
  await dialog.getByRole('button', { name: '导入固定提交', exact: true }).click();
  const resource = await responseData(await pending, 'GitHub Skill import');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(resource.name, name);
  assert.equal(resource.config?.origin?.commit, preview.origin.commit);
  assert.equal(resource.config?.origin?.packageSha256, preview.origin.packageSha256);
  return { resource, preview };
}

/** Drives the actual SkillMaintenance.vue update path for an existing table row. */
export async function upgradePinnedSkillThroughAdmin(adminPage, resourceName, {
  source = PINNED_GITHUB_SKILL,
} = {}) {
  await openAdminResources(adminPage);
  const row = adminPage.locator('.el-table__body tr').filter({ hasText: resourceName }).first();
  await row.waitFor();
  await row.getByRole('button', { name: '维护来源', exact: true }).click();
  const dialog = adminPage.getByRole('dialog', { name: '从 GitHub 维护技能' });
  await dialog.waitFor();
  const preview = await previewPinnedSource(adminPage, dialog, source);

  const updatePath = /\/api\/ai\/skills\/[0-9a-f-]{36}\/import\/github$/;
  const pending = adminPage.waitForResponse((response) =>
    updatePath.test(routePath(response)) && response.request().method() === 'POST', { timeout: 60_000 });
  await dialog.getByRole('button', { name: '更新为固定提交', exact: true }).click();
  const resource = await responseData(await pending, 'GitHub Skill update');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(resource.name, resourceName);
  assert.equal(resource.config?.origin?.commit, preview.origin.commit);
  return { resource, preview };
}

export async function activateSkill(adminPage, resourceId, version) {
  const result = await pageJson(adminPage, `${ADMIN_API}/ai/resources/${resourceId}/activate`, {
    method: 'POST', body: { version },
  });
  const resource = unwrapEnvelope(result.body, 'activate Skill');
  assert.equal(resource.publishedVersion, version);
  return resource;
}

export async function shareSkillWithEmployee(adminPage, resourceId, employeeUserId) {
  const result = await pageJson(adminPage, `${ADMIN_API}/ai/resources/${resourceId}/shares`, {
    method: 'POST',
    body: { subjectType: 'USER', subjectId: String(employeeUserId), actions: ['VIEW', 'USE'] },
  });
  return unwrapEnvelope(result.body, 'share Skill with employee');
}

export async function employeeIdentity(employeePage) {
  const result = await pageJson(employeePage, '/api/auth/user');
  assert.equal(result.body?.success, true, 'employee gateway identity must be active');
  assert.match(String(result.body?.user?.id || ''), /^\d+$/, 'employee user id must be present');
  return result.body.user;
}

/** Proves the employee control proxy does not grant GitHub Skill maintenance. */
export async function assertEmployeeSkillMaintenanceRejected(employeePage, source = PINNED_GITHUB_SKILL) {
  const result = await pageJson(employeePage, '/enterprise/control/ai/skills/import/github/preview', {
    method: 'POST',
    body: { repository: source.repository, ref: source.ref, path: source.path },
    statuses: [403],
  });
  assert.equal(result.status, 403);
  assert.notEqual(result.body?.code, 200);
  return result;
}

export async function refreshEmployeeCore(employeePage, { timeout = 120_000 } = {}) {
  await waitUntil(async () => {
    const ready = await pageJson(employeePage, '/enterprise/ready', { statuses: [200, 202] });
    return ready.body?.ready ? ready.body : null;
  }, { timeout, label: 'employee Core startup' });
  // Admit the actual employee Core via its existing authorized read route.
  await pageJson(employeePage, '/api/assistants');
  return waitUntil(async () => {
    const refresh = await pageJson(employeePage, '/enterprise/resources/refresh', {
      method: 'POST', statuses: [200, 202],
    });
    if (refresh.body?.applyOnNextStart) {
      throw new Error('employee Core is not running; the persistent employeePage must finish login/startup first');
    }
    if (refresh.body?.state === 'ready') return refresh.body;
    const status = await pageJson(employeePage, '/enterprise/resources/status');
    return status.body?.state === 'ready' ? status.body : null;
  }, { timeout, interval: 1_000, label: 'employee Core resource refresh' });
}

export async function currentDependencyReceipt(adminPage, resourceId) {
  const result = await pageJson(adminPage, `${ADMIN_API}/ai/skills/${resourceId}/dependency-checks`);
  return unwrapEnvelope(result.body, 'read Core dependency receipt');
}

export async function waitForDependencyReceipt(adminPage, resourceId, {
  state, version, packageSha256, timeout = 120_000,
}) {
  return waitUntil(async () => {
    const receipt = await currentDependencyReceipt(adminPage, resourceId);
    if (!receipt || receipt.state !== state || receipt.resourceVersion !== version ||
        receipt.packageSha256 !== packageSha256) return null;
    assert.match(receipt.runtimeFingerprint, /^sha256:[0-9a-f]{64}$/,
      'receipt must carry the actual Core image fingerprint');
    assert.match(receipt.receiptId, /^[0-9a-f-]{36}$/);
    return receipt;
  }, { timeout, label: `Core dependency receipt ${state} for v${version}` });
}

/**
 * Creates a new immutable version with a dependency that should not exist in
 * the Core. This uses the real admin API; dependency classification and the
 * resulting receipt still come only from the real employee Core probe.
 */
export async function addMissingDependencyVersion(adminPage, resourceId, token = Date.now().toString(36)) {
  const dependency = `zhenwork-e2e-missing-${String(token).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
  const resource = await replaceRequirementsVersion(adminPage, resourceId, `${dependency}==0.0.1\n`);
  return { resource, dependency };
}

async function replaceRequirementsVersion(adminPage, resourceId, requirements) {
  const detailResult = await pageJson(adminPage, `${ADMIN_API}/ai/resources/${resourceId}`);
  const detail = unwrapEnvelope(detailResult.body, 'read Skill before dependency update');
  const files = (detail.config?.files || []).filter((file) => file.path !== 'requirements.txt')
    .map(({ path, content, encoding, executable }) => ({ path, content, encoding, executable }));
  files.push({ path: 'requirements.txt', content: requirements, encoding: 'utf8', executable: false });
  const update = await pageJson(adminPage, `${ADMIN_API}/ai/resources/${resourceId}`, {
    method: 'PUT',
    body: {
      expectedVersion: detail.version,
      name: detail.name,
      description: detail.description || '',
      config: { source: detail.config.source, files },
    },
  });
  const resource = unwrapEnvelope(update.body, 'add missing dependency version');
  assert.equal(resource.version, detail.version + 1);
  assert.match(resource.config?.packageSha256 || '', /^[0-9a-f]{64}$/);
  return resource;
}

export async function addCompatibleDependencyVersion(adminPage, resourceId) {
  return replaceRequirementsVersion(adminPage, resourceId, 'openpyxl==3.1.5\n');
}

/** Exercise the same actually installed package against an incompatible range. */
export async function addIncompatibleDependencyVersion(adminPage, resourceId) {
  const resource = await replaceRequirementsVersion(adminPage, resourceId, 'openpyxl<1.0.0\n');
  return { resource, dependency: 'openpyxl', requested: '<1.0.0' };
}

/**
 * Complete callable QA flow. The caller owns logged-in persistent Pages.
 * No server/product source is modified by this module.
 */
export async function runPluginsE2E({ adminPage, employeePage, name, timeout = 120_000 }) {
  assert(adminPage && employeePage, 'adminPage and employeePage are required');
  const employee = await employeeIdentity(employeePage);
  await assertEmployeeSkillMaintenanceRejected(employeePage);

  const imported = await importPinnedSkillThroughAdmin(adminPage, { name });
  const id = imported.resource.id;
  const declared = await addCompatibleDependencyVersion(adminPage, id);
  const v1 = await activateSkill(adminPage, id, declared.version);
  await shareSkillWithEmployee(adminPage, id, employee.id);
  await refreshEmployeeCore(employeePage, { timeout });
  const readyV1 = await waitForDependencyReceipt(adminPage, id, {
    state: 'READY', version: v1.version, packageSha256: v1.config.packageSha256, timeout,
  });

  const missing = await addMissingDependencyVersion(adminPage, id);
  assert.equal(await currentDependencyReceipt(adminPage, id), null,
    'a new package/version must invalidate the prior Core receipt');
  const v2 = await activateSkill(adminPage, id, missing.resource.version);
  await refreshEmployeeCore(employeePage, { timeout });
  const missingV2 = await waitForDependencyReceipt(adminPage, id, {
    state: 'MISSING', version: v2.version, packageSha256: v2.config.packageSha256, timeout,
  });
  assert(missingV2.declarations.some((item) =>
    item.name === missing.dependency && item.state === 'MISSING'),
  'real Core receipt must identify the injected missing package');

  const incompatible = await addIncompatibleDependencyVersion(adminPage, id);
  assert.equal(await currentDependencyReceipt(adminPage, id), null,
    'another dependency version must invalidate the prior Core receipt');
  const v3 = await activateSkill(adminPage, id, incompatible.resource.version);
  await refreshEmployeeCore(employeePage, { timeout });
  const incompatibleV3 = await waitForDependencyReceipt(adminPage, id, {
    state: 'INCOMPATIBLE', version: v3.version, packageSha256: v3.config.packageSha256, timeout,
  });
  assert(incompatibleV3.declarations.some((item) =>
    item.name === incompatible.dependency && item.requested === incompatible.requested &&
      item.state === 'INCOMPATIBLE'),
  'real Core receipt must identify the installed openpyxl version conflict');

  const upgraded = await upgradePinnedSkillThroughAdmin(adminPage, missing.resource.name);
  assert.equal(await currentDependencyReceipt(adminPage, id), null,
    'GitHub upgrade must not reuse the receipt from the previous version/package');
  const v4 = await activateSkill(adminPage, id, upgraded.resource.version);
  await refreshEmployeeCore(employeePage, { timeout });
  // This upstream package declares no runtime dependencies, so no receipt is manufactured.
  assert.equal(await currentDependencyReceipt(adminPage, id), null);
  const readyV4 = null;

  return {
    resourceId: id,
    name: upgraded.resource.name,
    pinnedCommit: upgraded.preview.origin.commit,
    employeeUserId: String(employee.id),
    receipts: { readyV1, missingV2, incompatibleV3, readyV4 },
    missingDependency: missing.dependency,
  };
}

export default runPluginsE2E;
