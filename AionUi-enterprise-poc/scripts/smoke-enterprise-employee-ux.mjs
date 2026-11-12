import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const renderer = path.resolve(process.argv[2] || 'out/renderer');
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
const staticServer = http.createServer(async (request, response) => {
  try {
    const route = new URL(request.url, 'http://localhost').pathname;
    const filename = path.resolve(renderer, '.' + (route === '/' ? '/index.html' : route));
    if (!filename.startsWith(renderer + path.sep)) throw new Error('Outside renderer');
    const bytes = await readFile(filename);
    response.setHeader('Content-Type', mimeTypes[path.extname(filename)] || 'application/octet-stream');
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

const date = '2026-11-12T00:00:00Z';
const filePath = 'outputs/stock-weekly.xlsx';
const artifacts = [1, 2].map((version) => ({
  path: filePath,
  valid: true,
  sha256: String(version).repeat(64),
  versionId: 'stock-v' + version,
  version,
  previewUrl: '/#/workspace?section=files&previewPath=' + encodeURIComponent(filePath) + '&fileVersion=stock-v' + version,
}));
const tasks = Array.from({ length: 20 }, (_, i) => {
  const number = i + 1;
  return {
    id: 'badc' + String(number).padStart(4, '0'),
    title: '库存周报 ' + number,
    updatedAt: Date.parse(date),
    attempts: [{
      id: 'attempt-' + number,
      state: 'partial',
      phase: 'finished',
      steps: [],
      artifacts: number === 20 ? artifacts : number === 19 ? [{
        path: 'outputs/other.txt', valid: true, sha256: '3'.repeat(64), version: 1,
      }] : [],
    }],
  };
});
const files = [...Array.from({ length: 20 }, (_, i) => ({
  path: 'outputs/other-' + i + '.txt', name: '任务附件 ' + i + '.txt',
  byteSize: 16, modifiedAt: date, kind: 'generated', versions: [],
})), {
  path: filePath, name: 'stock-weekly.xlsx', byteSize: 320, modifiedAt: date, kind: 'generated',
  currentVersionId: 'stock-v2',
  versions: artifacts.map(({ versionId, sha256 }) => ({ id: versionId, sha256, createdAt: date, byteSize: 320 })),
}];
const previews = [];
let account = 'employee-a';
const preferences = new Map();
const saved = [];
let pollCount = 0;
const initialPreferences = { version: 1, enabled: true, style: '', detail: '', language: '', instructions: '' };

async function stubApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const json = (value, status = 200) => route.fulfill({ status, json: value });
  const method = request.method();
  if (url.pathname === '/api/auth/user') return json({ success: true, user: { id: account, username: account } });
  if (url.pathname === '/enterprise/brand') return json({ productName: 'ZhenWork' });
  if (url.pathname === '/enterprise/conversations') return json({ items: [] });
  if (url.pathname === '/enterprise/tasks') {
    pollCount += 1;
    return json({ items: tasks });
  }
  if (url.pathname.startsWith('/enterprise/tasks/')) {
    const task = tasks.find((item) => item.id === url.pathname.split('/').at(-1));
    return task ? json(task) : json({ error: 'TASK_NOT_FOUND' }, 404);
  }
  if (url.pathname === '/enterprise/files') return json({ files, workspaceRoot: '/fixture/workspace' });
  if (url.pathname === '/enterprise/files/preview') {
    const name = url.searchParams.get('path');
    const version = url.searchParams.get('version');
    previews.push({ name, version });
    if (name !== filePath || !artifacts.some((item) => item.versionId === version)) {
      return json({ error: 'FORBIDDEN' }, 403);
    }
    return json({
      format: 'xlsx',
      sourceSha256: artifacts.find((item) => item.versionId === version).sha256,
      sourceName: 'stock-weekly.xlsx',
      sheets: ['库存'], sheet: '库存', widths: [160],
      rows: [{ number: 1, cells: [{
        reference: 'A1', column: 1, text: version === 'stock-v1' ? '固定历史版本一' : '固定版本二',
        colSpan: 1, rowSpan: 1, style: {},
      }] }],
      start: 0, rowCount: 1, columnCount: 1, nextStart: null,
    });
  }
  if (url.pathname === '/enterprise/preferences') {
    const current = preferences.get(account) || initialPreferences;
    if (method === 'GET') return json(current);
    assert.equal(method, 'PUT');
    const { expectedVersion, ...draft } = request.postDataJSON();
    assert.equal(expectedVersion, current.version);
    const value = { ...draft, version: expectedVersion + 1 };
    preferences.set(account, value);
    saved.push({ account, instructions: value.instructions });
    return json(value);
  }
  if (url.pathname === '/enterprise/self-profile') {
    return json({ id: account, username: account, nickname: account });
  }
  if (url.pathname === '/enterprise/ready') return json({ ready: true, phase: 'ready' });
  if (url.pathname.startsWith('/enterprise/') || url.pathname.startsWith('/api/')) {
    return method === 'GET' ? json({ success: true, data: [], items: [] }) : json({ error: 'FIXTURE_WRITE_DENIED' }, 403);
  }
  return route.continue();
}

const taskUrl = '/#/workspace?section=tasks';
const settingsUrl = '/#/settings/personalization';
const listScroller = '.overflow-y-auto.bg-bg-1';
const readScroll = (page) => page.locator(listScroller).filter({ has: page.getByRole('tab', { name: '任务', exact: true }) })
  .evaluate((element) => element.scrollTop);
const detail = (page) => page.locator('#workspace-task-detail-title');
const assertTitleInView = async (page, name) => {
  await detail(page).filter({ hasText: name }).waitFor();
  const metrics = await detail(page).evaluate((heading) => {
    const rect = heading.getBoundingClientRect();
    const pane = heading.closest('.overflow-y-auto.bg-bg-1').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, min: pane.top, max: pane.bottom, focused: document.activeElement === heading };
  });
  assert.ok(metrics.top >= metrics.min && metrics.bottom <= metrics.max, JSON.stringify(metrics));
  assert.equal(metrics.focused, true);
  return Math.round(metrics.top);
};
const taskButton = (page, number) => page.locator('.arco-list-item')
  .filter({ has: page.getByText('库存周报 ' + number, { exact: true }) }).getByRole('button', { name: '任务详情' });
const clickTab = (page, name) => page.getByRole('tab', { name, exact: true }).click();

let browser;
let page;
try {
  await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + staticServer.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AION_SMOKE_CHROME });
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, locale: 'zh-CN' });
  await context.addInitScript(() => {
    window.__AION_ENTERPRISE_WEB__ = true;
    localStorage.setItem('i18nextLng', 'zh-CN');
  });
  await context.route('**/*', stubApi);
  page = await context.newPage();
  page.setDefaultTimeout(9000);
  const url = (fragment) => origin + fragment;

  await page.goto(url(taskUrl));
  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '部分完成', exact: true }).click();
  const rowA = taskButton(page, 20);
  await rowA.scrollIntoViewIfNeeded();
  const originalTop = await readScroll(page);
  assert.ok(originalTop > 500, 'Fixture must actually scroll a long list');
  await rowA.click();
  await page.waitForURL(/task=badc0020/);
  const openedTop = await assertTitleInView(page, '库存周报 20');
  const card = page.getByTestId('task-work');
  await card.getByText('部分完成', { exact: true }).waitFor();
  await card.getByText('stock-weekly.xlsx · v1', { exact: true }).waitFor();

  await taskButton(page, 19).click();
  await page.waitForURL(/task=badc0019/);
  await assertTitleInView(page, '库存周报 19');
  await card.getByText('other.txt · v1', { exact: true }).waitFor();
  assert.equal(await card.getByText('stock-weekly.xlsx · v1', { exact: true }).count(), 0);
  await page.goBack();
  await page.waitForURL(/task=badc0020/);
  await assertTitleInView(page, '库存周报 20');
  const pollStart = pollCount;
  await card.getByRole('button', { name: '继续任务' }).focus();
  const scrollBeforePoll = await readScroll(page);
  await new Promise((resolve) => setTimeout(resolve, 5300));
  assert.ok(pollCount > pollStart);
  assert.equal(await readScroll(page), scrollBeforePoll);
  assert.equal(await card.getByRole('button', { name: '继续任务' }).evaluate((item) => document.activeElement === item), true);
  await page.locator('section[aria-labelledby="workspace-task-detail-title"]').getByRole('button', { name: '关闭' }).click();
  await page.waitForURL((value) => !value.hash.includes('task='));
  await detail(page).waitFor({ state: 'hidden' });
  assert.ok(Math.abs(await readScroll(page) - originalTop) <= 2, 'Closing must restore the filtered list position');
  assert.equal(await rowA.evaluate((item) => document.activeElement === item), true);
  assert.ok((await page.getByRole('combobox', { name: '状态' }).locator('..').innerText()).includes('部分完成'));
  await page.goBack();
  await page.waitForURL(/task=badc0020/);
  await assertTitleInView(page, '库存周报 20');
  await page.goForward();
  await page.waitForURL((value) => !value.hash.includes('task='));
  await detail(page).waitFor({ state: 'hidden' });
  await rowA.click();
  await page.waitForURL(/task=badc0020/);
  console.log(JSON.stringify({ scenario: 'UX-01', originalListScrollTop: originalTop, detailViewportTop: openedTop,
    switchBackForward: true, focusAndFilterRestored: true, pollingKeptPosition: true }));

  const previewAction = card.getByRole('button', { name: '预览 · stock-weekly.xlsx · v1', exact: true });
  await previewAction.click();
  await page.waitForURL(/section=tasks&task=badc0020.*fileVersion=stock-v1/);
  const drawer = page.getByRole('dialog', { name: 'stock-weekly.xlsx' });
  await drawer.getByText('固定历史版本一', { exact: true }).waitFor();
  assert.deepEqual(previews.at(-1), { name: filePath, version: 'stock-v1' });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForURL((value) => value.hash.includes('task=badc0020') && !value.hash.includes('previewPath'));
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(await detail(page).innerText(), '库存周报 20');

  await clickTab(page, '文件');
  await page.getByRole('combobox', { name: '文件', exact: true }).click();
  await page.getByRole('option', { name: '生成文件', exact: true }).click();
  const fileRow = page.locator('.arco-list-item').filter({ has: page.getByText('stock-weekly.xlsx', { exact: true }) });
  await fileRow.getByRole('button', { name: '预览', exact: true }).scrollIntoViewIfNeeded();
  const fileScroll = await readScroll(page);
  await fileRow.getByRole('button', { name: '预览', exact: true }).click();
  await drawer.getByText('固定版本二', { exact: true }).waitFor();
  assert.deepEqual(previews.at(-1), { name: filePath, version: 'stock-v2' });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(await readScroll(page), fileScroll);
  assert.ok((await page.getByRole('combobox', { name: '文件', exact: true }).locator('..').innerText()).includes('生成文件'));

  const denied = 'other-employee-private.xlsx';
  const beforeDenied = previews.length;
  await page.goto(url(taskUrl + '&task=badc0020&previewPath=' + denied + '&fileVersion=private-v1'));
  const unavailable = page.getByRole('dialog', { name: '预览', exact: true });
  await unavailable.getByText(/FILE_NOT_FOUND/).waitFor();
  assert.equal(previews.length, beforeDenied, 'A path outside the authorized file list must not be fetched');
  await unavailable.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForURL((value) => value.hash.includes('task=badc0020') && !value.hash.includes('previewPath'));
  console.log(JSON.stringify({ scenario: 'UX-02', taskSourcePreserved: true, fileSourcePreserved: true,
    fixedVersions: ['stock-v1', 'stock-v2'], fileListScrollTop: fileScroll, unauthorizedLinkRejected: true }));

  await page.goto(url(settingsUrl));
  const instructions = page.getByRole('textbox', { name: '自定义指令', exact: true });
  const draftText = '当前账号的本地草稿';
  await instructions.fill(draftText);
  await page.getByText('有未保存的修改').waitFor();
  await page.getByText('办公工作台', { exact: true }).first().click();
  await page.waitForURL(/#\/workspace/);
  await page.goBack();
  await instructions.waitFor();
  assert.equal(await instructions.inputValue(), draftText);
  await page.reload();
  await instructions.waitFor();
  assert.equal(await instructions.inputValue(), draftText);
  assert.deepEqual(saved, []);
  await page.getByRole('button', { name: '放弃更改', exact: true }).click();
  assert.equal(await instructions.inputValue(), '');
  assert.deepEqual(saved, []);

  await instructions.fill('只在点击保存后写入');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已保存').waitFor();
  assert.deepEqual(saved, [{ account: 'employee-a', instructions: '只在点击保存后写入' }]);
  await instructions.fill('另一账号不能看见');
  account = 'employee-b';
  await page.reload();
  await instructions.waitFor();
  assert.equal(await instructions.inputValue(), '');
  assert.equal(saved.length, 1);
  console.log(JSON.stringify({ scenario: 'UX-03', navigationAndReloadRestored: true, discardDidNotWrite: true,
    explicitSaveCount: saved.length, secondAccountIsolated: true }));
} catch (error) {
  console.error(JSON.stringify({
    url: page?.url(),
    body: await page?.locator('body').innerText({ timeout: 2000 }).then(text => text.slice(-900)).catch(() => undefined),
  }));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => staticServer.close(resolve));
}
