import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { chromium, type Page } from 'playwright';

type Fixture = { webOrigin: string; releaseFile: string };
type Payload = { content: string; request_id: string; files: Array<{ kind: string; path: string }> };
type Task = {
  attempts: Array<{ requestId: string; state: string; inputs: { content: string; files: Payload['files'] } }>;
};

const fixture = spawn('node_modules/.bin/tsx', ['scripts/smoke-enterprise-web-cli.mts'], {
  env: { ...process.env, AION_SMOKE_UI_HOLD: '1', AION_SMOKE_UI_DRAFT: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise<number | null>((resolve) => fixture.once('exit', resolve));
const output = createInterface({ input: fixture.stdout });
let diagnostics = '';
fixture.stderr.on('data', (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-5000);
});
let marker: Fixture | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let readinessTimer: ReturnType<typeof setTimeout> | undefined;
try {
  marker = await new Promise<Fixture>((resolve, reject) => {
    readinessTimer = setTimeout(() => reject(new Error('Enterprise fixture did not become ready')), 90_000);
    fixture.once('error', reject);
    void exited.then((code) => reject(new Error(`Enterprise fixture exited (${code})`)));
    output.on('line', (line) => {
      if (line.startsWith('UI_READY ')) resolve(JSON.parse(line.slice('UI_READY '.length)));
    });
  });
  const origin = marker.webOrigin;
  browser = await chromium.launch({
    executablePath: process.env.AION_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  page = await browser.newPage({ ignoreHTTPSErrors: true, locale: 'zh-CN' });
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const login = async (account: string) => {
    await page!.goto(origin + '/enterprise/login');
    await page!.getByLabel('企业账号').fill(account);
    await page!.getByLabel('密码', { exact: true }).fill(account);
    await page!.getByRole('button', { name: '登录' }).click();
    await page!.waitForURL((url) => url.pathname !== '/enterprise/login');
    const identity = await page!.evaluate(async () => (await fetch('/api/auth/user')).json());
    assert.equal(identity.user.id, account === 'demo' ? '91' : '92');
  };
  await login('demo');

  const draft = page.getByTestId('guid-input');
  const send = page.getByTestId('guid-send-btn');
  const workspace = page.getByText('办公工作台', { exact: true }).first();
  await page.goto(origin + '/#/guid');
  await draft.fill('员工 A 的普通草稿');
  await workspace.click();
  await page.goBack();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), '员工 A 的普通草稿');
  await page.reload();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), '员工 A 的普通草稿');
  await page.getByRole('button', { name: '放弃草稿' }).click();
  assert.equal(await draft.inputValue(), '');

  const enterDraft = async (text: string, name: string) => {
    await page!.goto(origin + '/#/guid');
    await draft.fill(text);
    const chooser = page!.waitForEvent('filechooser');
    await page!.getByTestId('file-upload-btn').click();
    await page!.getByText('从设备上传', { exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('fixed attachment bytes') });
    await page!.getByText(name, { exact: true }).waitFor();
  };

  const submissions: Array<{ id: string; payload: Payload; status: number }> = [];
  let fault: 'reject' | 'lose-response' | undefined;
  await page.route('**/api/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[3];
    const payload = route.request().postDataJSON() as Payload;
    const failure = fault;
    fault = undefined;
    // Send to a missing conversation to get a real pre-admission 404.
    if (failure === 'reject') url.pathname = '/api/conversations/nonexistent-for-admission/messages';
    const response = await route.fetch({ url: url.toString() });
    submissions.push({ id, payload, status: response.status() });
    if (failure === 'lose-response') return route.abort('connectionreset');
    return route.fulfill({ response });
  });
  const readTask = (id: string) =>
    page!.evaluate(async (taskId) => {
      const result = await fetch('/enterprise/tasks/' + taskId);
      return { status: result.status, task: (await result.json()) as Task };
    }, id);
  const checkAcceptedOnce = async (index: number) => {
    const { id, payload } = submissions[index];
    const result = await readTask(id);
    assert.equal(result.status, 200);
    assert.equal(result.task.attempts.length, 1);
    assert.equal(result.task.attempts[0].requestId, payload.request_id);
    assert.deepEqual(result.task.attempts[0].inputs, { content: payload.content, files: payload.files });
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].kind, 'upload');
  };

  const firstBody = 'Reply with the fixture marker after recovering the first message.';
  await enterDraft(firstBody, 'first-message.txt');
  fault = 'reject';
  await send.click();
  const recovery = page.getByRole('region', { name: '待发消息' });
  await recovery.getByText('首条消息未受理').waitFor();
  assert.equal(submissions[0].status, 404);
  assert.equal((await readTask(submissions[0].id)).status, 404);
  await page.reload();
  await recovery.getByText(firstBody).waitFor();
  await recovery.getByText('first-message.txt').waitFor();
  assert.equal(submissions.length, 1);
  await recovery.getByRole('button', { name: '重试' }).click();
  await recovery.waitFor({ state: 'hidden' });
  assert.equal(submissions[1].status, 202);
  assert.deepEqual(submissions[0].payload, submissions[1].payload);
  await checkAcceptedOnce(1);

  const secondBody = 'Reply with the fixture marker after the acceptance response is lost.';
  await enterDraft(secondBody, 'response-lost.txt');
  fault = 'lose-response';
  const conversation = page.waitForURL(/#\/conversation\//);
  await send.click();
  await conversation;
  // Polling is enough to reconcile a missing response. No resubmission occurs.
  await recovery.waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByTestId('aionrs-model-selector').waitFor();
  assert.equal(await recovery.count(), 0);
  assert.equal(submissions.length, 3);
  assert.equal(submissions[2].status, 202);
  await checkAcceptedOnce(2);
  const repeated = await page.request.post(origin + '/api/conversations/' + submissions[2].id + '/messages', {
    headers: { Origin: origin },
    data: submissions[2].payload,
  });
  assert.equal(repeated.status(), 202);
  await checkAcceptedOnce(2);

  await page.goto(origin + '/#/guid');
  await draft.fill('员工 A 切换账号前的私有草稿');
  const oldDraft = page.url();
  const logout = await page.evaluate(async () => (await fetch('/enterprise/logout', { method: 'POST' })).status);
  assert.equal(logout, 200);
  await login('beta');
  await page.goto(oldDraft);
  await draft.waitFor();
  assert.equal(await draft.inputValue(), '');
  assert.equal(await recovery.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'PASS',
      candidate: process.env.AION_SMOKE_SHA,
      ordinaryDraft: true,
      discard: true,
      accountSwitch: true,
      rejectedStatus: 404,
      exactRetryPayload: true,
      acceptedStatus: 202,
      lostResponseReconciled: true,
      attemptsPerConversation: 1,
    })
  );
} catch (error) {
  console.error(diagnostics);
  if (page)
    console.error(
      await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .then((body) => body.slice(-1400))
        .catch(() => '')
    );
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(readinessTimer);
  await browser?.close();
  if (marker) await writeFile(marker.releaseFile, '');
  else fixture.kill('SIGTERM');
  const code = await exited;
  if (marker && code !== 0) {
    console.error(`Enterprise fixture failed (${code}): ${diagnostics}`);
    process.exitCode = 1;
  }
}
