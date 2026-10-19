import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

type Ready = { webOrigin: string; createdId: string; releaseFile: string };

const child = spawn(path.resolve('node_modules/.bin/tsx'), ['scripts/smoke-enterprise-web-cli.mts'], {
  env: { ...process.env, AION_SMOKE_UI_HOLD: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let pending = '';
let readyResolve!: (value: Ready) => void;
let readyReject!: (error: Error) => void;
const ready = new Promise<Ready>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const onData = (chunk: Buffer) => {
  output = (output + chunk.toString()).slice(-8000);
  pending += chunk.toString();
  let newline = pending.indexOf('\n');
  while (newline !== -1) {
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (line.startsWith('UI_READY ')) {
      try { readyResolve(JSON.parse(line.slice('UI_READY '.length)) as Ready); }
      catch (error) { readyReject(error as Error); }
    }
    newline = pending.indexOf('\n');
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); });
child.once('error', readyReject);
child.once('exit', (code) => readyReject(new Error(`Web CLI smoke exited early (${code}): ${output}`)));

let marker: Ready | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let readinessTimer: ReturnType<typeof setTimeout> | null = null;
try {
  marker = await Promise.race([ready, new Promise<never>((_, reject) => {
    readinessTimer = setTimeout(() => reject(new Error(`Web CLI smoke readiness timed out: ${output}`)), 90_000);
  })]);
  if (readinessTimer) clearTimeout(readinessTimer);
  const chrome = process.env.AION_SMOKE_CHROME ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${marker.webOrigin}/enterprise/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('企业账号').fill('demo');
  await page.getByLabel('密码').fill('demo');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('Web source marker for actor A').first().waitFor({ timeout: 30_000 });
  const cookies = await context.cookies(marker.webOrigin);
  const session = cookies.find((cookie) => cookie.name === '__Host-aion-enterprise-web');
  if (!session?.httpOnly || !session.secure) throw new Error('Browser session cookie is not private');
  await page.goto(`${marker.webOrigin}/#/conversation/${marker.createdId}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('在企业服务器工作空间中执行').waitFor({ timeout: 30_000 });
  const api = await page.evaluate(async () => ({
    core: (await fetch('/api/system/info')).status,
    catalog: (await fetch('/enterprise/conversations')).status,
  }));
  if (api.core !== 200 || api.catalog !== 200 || pageErrors.length) {
    throw new Error(`Browser conversation failed: ${JSON.stringify({ api, pageErrors })}`);
  }
  const modelConversation = await page.evaluate(async () => {
    const response = await fetch('/api/conversations', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'aionrs', name: 'Browser enterprise model smoke',
        model: { provider_id: 'rc2-enterprise-model', model: 'smoke-model' }, extra: {} }) });
    return { status: response.status, body: await response.json() };
  });
  const modelId = modelConversation.body?.data?.id;
  if (modelConversation.status !== 201 || typeof modelId !== 'string') {
    throw new Error(`Browser model conversation creation failed: ${JSON.stringify(modelConversation)}`);
  }
  await page.goto(`${marker.webOrigin}/#/conversation/${modelId}`, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea:visible').first();
  try { await composer.waitFor({ timeout: 30_000 }); }
  catch (error) {
    const diagnostics = await page.evaluate(async (id) => ({
      body: document.body.innerText.slice(-2500),
      textareas: Array.from(document.querySelectorAll('textarea')).map((item) => ({
        placeholder: item.placeholder, hidden: item.offsetParent === null,
      })),
      conversation: await fetch(`/api/conversations/${id}`).then(async (r) => ({ status: r.status, body: await r.text() })),
    }), modelId);
    throw new Error(`Browser composer missing: ${JSON.stringify({ error: String(error), diagnostics, pageErrors })}`);
  }
  await composer.fill('Reply with the synthetic enterprise marker.');
  await composer.press('Enter');
  try {
    await page.getByText('Synthetic enterprise reply from RC2.').waitFor({ timeout: 60_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async (id) => ({
      messages: await fetch(`/api/conversations/${id}/messages`).then(async (r) => ({ status: r.status, body: await r.text() })),
      body: document.body.innerText.slice(-1800),
    }), modelId);
    throw new Error(`Browser model reply missing: ${JSON.stringify({ error: String(error), diagnostics, pageErrors })}`);
  }
  const persisted = await page.evaluate(async (id) => {
    const response = await fetch(`/api/conversations/${id}/messages`);
    return { status: response.status, body: await response.json() };
  }, modelId);
  const replyPersisted = persisted.status === 200 &&
    persisted.body?.data?.items?.some((item: { content?: { content?: string } }) =>
      item.content?.content === 'Synthetic enterprise reply from RC2.');
  if (!replyPersisted || pageErrors.length) {
    throw new Error(`Browser model reply was not persisted: ${JSON.stringify({ persisted, pageErrors })}`);
  }
  await page.getByRole('button', { name: '检索会话' }).first().click();
  await page.getByPlaceholder('搜索消息内容...').fill('synthetic enterprise marker');
  const searchResult = page.locator('.conversation-search-modal__result').first();
  await searchResult.waitFor({ timeout: 30_000 });
  const searchResultText = await searchResult.innerText();
  if (!searchResultText.includes('Browser enterprise model smoke') ||
      !searchResultText.toLowerCase().includes('synthetic enterprise marker')) {
    throw new Error(`Browser history search result mismatch: ${JSON.stringify({ searchResultText, pageErrors })}`);
  }
  await searchResult.click();
  await page.getByPlaceholder('搜索消息内容...').waitFor({ state: 'hidden', timeout: 10_000 });
  if (!page.url().endsWith(`/#/conversation/${modelId}`) || pageErrors.length) {
    throw new Error(`Browser history search did not open the matching conversation: ${JSON.stringify({
      url: page.url(), pageErrors,
    })}`);
  }
  const secondContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const secondPage = await secondContext.newPage();
  secondPage.on('pageerror', (error) => pageErrors.push(String(error)));
  await secondPage.goto(`${marker.webOrigin}/enterprise/login`, { waitUntil: 'domcontentloaded' });
  await secondPage.getByLabel('企业账号').fill('demo');
  await secondPage.getByLabel('密码').fill('demo');
  await secondPage.getByRole('button', { name: '登录' }).click();
  await secondPage.getByText('Web source marker for actor A').first().waitFor({ timeout: 30_000 });
  await secondPage.goto(`${marker.webOrigin}/#/conversation/${modelId}`, { waitUntil: 'domcontentloaded' });
  await secondPage.getByText('Synthetic enterprise reply from RC2.').first().waitFor({ timeout: 30_000 });
  const secondComposer = secondPage.locator('textarea:visible').first();
  await secondComposer.fill('Continue from the earlier browser reply.');
  await secondComposer.press('Enter');
  await secondPage.waitForFunction(async (id) => {
    const result = await fetch(`/api/conversations/${id}/messages`).then((response) => response.json());
    return result.data?.items?.filter((item: { content?: { content?: string }; position?: string }) =>
      item.position === 'left' && item.content?.content === 'Synthetic enterprise reply from RC2.').length >= 2;
  }, modelId, { timeout: 60_000 });
  await secondPage.getByText('Synthetic enterprise reply from RC2.').nth(1).waitFor({ timeout: 30_000 });
  if (pageErrors.length) {
    throw new Error(`Second browser did not render continued reply: ${JSON.stringify({ pageErrors })}`);
  }
  await secondComposer.fill('Check read-only tools without approval.');
  await secondComposer.press('Enter');
  try { await secondPage.getByText('Synthetic read-only tools completed.').waitFor({ timeout: 60_000 }); }
  catch (error) {
    throw new Error(`Read-only tools did not finish without approval: ${JSON.stringify({
      error: String(error), body: (await secondPage.locator('body').innerText()).slice(-2200), pageErrors,
    })}`);
  }
  if (await secondPage.getByTestId('message-permission-option-proceed_once').count()) {
    throw new Error('Read-only tools left a permission card');
  }
  await secondComposer.fill('Create a review file for browser approval.');
  await secondComposer.press('Enter');
  const approveOnce = secondPage.getByTestId('message-permission-option-proceed_once');
  try { await approveOnce.waitFor({ timeout: 30_000 }); }
  catch (error) {
    throw new Error(`Browser write approval did not appear: ${JSON.stringify({
      error: String(error), body: (await secondPage.locator('body').innerText()).slice(-2200), pageErrors,
    })}`);
  }
  await approveOnce.click();
  await secondPage.getByText('Synthetic approval file created.').waitFor({ timeout: 60_000 });
  const reviewLink = secondPage.getByRole('button', { name: 'synthetic-review.txt' });
  try { await reviewLink.click({ timeout: 15_000 }); }
  catch (error) {
    throw new Error(`Browser file preview action missing: ${JSON.stringify({
      error: String(error), fileLinks: await secondPage.locator('[data-local-file-path]').allTextContents(),
      body: (await secondPage.locator('body').innerText()).slice(-1800), pageErrors,
    })}`);
  }
  await secondPage.locator('span[title="synthetic-review.txt"]').waitFor({ timeout: 30_000 });
  await secondPage.getByText('Synthetic browser approved artifact.').waitFor({ timeout: 30_000 });
  const reviewedFile = await secondPage.evaluate(async () => {
    const info = await fetch('/api/system/info').then((response) => response.json());
    const workspace = info.data?.work_dir as string;
    const path = `${workspace}/synthetic-review.txt`;
    const read = await fetch('/api/fs/read', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, workspace }) });
    const readBody = await read.json();
    const download = await fetch(`/api/fs/stream?kind=local&path=${encodeURIComponent(path)}`);
    return { readStatus: read.status, readContent: readBody.data,
      downloadStatus: download.status, downloadContent: await download.text() };
  });
  if (reviewedFile.readStatus !== 200 || reviewedFile.readContent !== 'Synthetic browser approved artifact.' ||
      reviewedFile.downloadStatus !== 200 || reviewedFile.downloadContent !== reviewedFile.readContent || pageErrors.length) {
    throw new Error(`Browser approval artifact unavailable: ${JSON.stringify({ reviewedFile, pageErrors })}`);
  }
  await secondComposer.fill('Start a slow browser task for cancellation.');
  await secondComposer.press('Enter');
  const slowStartDeadline = Date.now() + 15_000;
  while (!output.includes('SLOW_MODEL_STARTED') && Date.now() < slowStartDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!output.includes('SLOW_MODEL_STARTED')) throw new Error('Slow model request did not start');
  const cancelResponse = secondPage.waitForResponse((response) =>
    response.url().includes(`/api/conversations/${modelId}/cancel`), { timeout: 15_000 });
  const stopButton = secondPage.locator('.sendbox-stop-button');
  await stopButton.waitFor({ timeout: 15_000 });
  await stopButton.click();
  const stopped = await cancelResponse;
  const stopBody = await stopped.json();
  const requestedTurnId = stopped.request().postDataJSON()?.turn_id;
  if (stopped.status() !== 200 || !requestedTurnId || stopBody.data?.runtime?.turn_id !== requestedTurnId ||
      stopBody.data.runtime.state !== 'cancelling') {
    throw new Error(`Browser stop was not accepted by Core: ${JSON.stringify({
      status: stopped.status(), requestedTurnId, runtime: stopBody.data?.runtime, pageErrors,
    })}`);
  }
  const cancelDeadline = Date.now() + 12_000;
  while (!output.includes('SLOW_MODEL_ABORTED') && Date.now() < cancelDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!output.includes('SLOW_MODEL_ABORTED') || pageErrors.length) {
    throw new Error(`Browser stop did not abort model stream: ${JSON.stringify({
      modelAborted: output.includes('SLOW_MODEL_ABORTED'), modelCompleted: output.includes('SLOW_MODEL_COMPLETED'),
      requestedTurnId, pageErrors,
      body: (await secondPage.locator('body').innerText()).slice(-1600),
    })}`);
  }
  await secondPage.waitForFunction(async (id) => {
    const response = await fetch(`/api/conversations/${id}`);
    const body = await response.json();
    return response.ok && body.data?.runtime?.state === 'idle' && body.data.runtime.can_send_message === true;
  }, modelId, { timeout: 10_000 });
  await page.goto(`${marker.webOrigin}/#/guid`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('team-create-btn').click();
  await page.getByTestId('team-create-agent-option-aionui-assistant').click();
  await page.getByTestId('team-create-agent-option-aionui-assistant').click();
  await page.getByTestId('team-create-name-input').fill('Synthetic browser team');
  await page.getByRole('button', { name: '确认创建' }).click();
  await page.waitForURL(/#\/team\//, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const teamPage = await page.locator('body').innerText();
  if (teamPage.includes('未能启动') || teamPage.includes('Agent runtime failed to start') || pageErrors.length) {
    throw new Error(`Browser team runtime failed: ${JSON.stringify({ teamPage: teamPage.slice(-2500), pageErrors })}`);
  }
  const teamId = page.url().split('/').at(-1);
  const teamState = await page.evaluate(async (id) => {
    const response = await fetch(`/api/teams/${id}`);
    return { status: response.status, body: await response.json() };
  }, teamId);
  const members = teamState.body?.data?.assistants as Array<{
    slot_id: string; role: string; conversation_id: string; status?: string;
  }> | undefined;
  const teammate = members?.find((member) => member.role === 'teammate');
  const leader = members?.find((member) => member.role === 'lead');
  if (teamState.status !== 200 || members?.length !== 2 || !leader?.slot_id ||
      !teammate?.slot_id || !teammate.conversation_id || teammate.conversation_id === leader.conversation_id) {
    throw new Error(`Browser team did not retain two members: ${JSON.stringify(teamState)}`);
  }
  {
    const config = await page.evaluate(async (id) => {
      const response = await fetch(`/api/conversations/${id}`);
      const body = await response.json();
      const extra = body.data?.extra || {};
      return { status: response.status, keys: Object.keys(extra),
        teamMcp: Boolean(extra.team_mcp_stdio_config),
        teamTokenVisible: typeof extra.team_mcp_stdio_config?.token === 'string',
        sessionMcpCount: extra.session_mcp_servers?.length ?? 0 };
    }, leader.conversation_id);
    if (config.status !== 200 || config.teamMcp || config.teamTokenVisible || config.sessionMcpCount) {
      throw new Error(`Team conversation API exposed runtime MCP credentials: ${JSON.stringify(config)}`);
    }
    if (process.env.AION_SMOKE_TRACE_TEAM === '1') {
      console.log(`TEAM_CONFIG_TRACE ${JSON.stringify(config)}`);
    }
  }
  const teamComposer = page.locator('textarea:visible').first();
  await teamComposer.waitFor({ timeout: 30_000 });
  await teamComposer.fill('Reply with the synthetic enterprise marker.');
  await teamComposer.press('Enter');
  try {
    await page.getByText('Synthetic enterprise reply from RC2.').first().waitFor({ timeout: 60_000 });
  } catch (error) {
    throw new Error(`Browser team did not answer: ${JSON.stringify({
      error: String(error), teamPage: (await page.locator('body').innerText()).slice(-3000), pageErrors,
    })}`);
  }
  await page.getByTestId(`team-tab-${teammate.slot_id}`).click();
  const teammateComposer = page.locator('textarea:visible').first();
  await teammateComposer.waitFor({ timeout: 30_000 });
  await teammateComposer.fill('Teammate, reply with the synthetic enterprise marker.');
  await teammateComposer.press('Enter');
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/api/conversations/${id}/messages`);
    const body = await response.json();
    return response.ok && body.data?.items?.some((item: { content?: { content?: string } }) =>
      item.content?.content === 'Synthetic enterprise reply from RC2.');
  }, teammate.conversation_id, { timeout: 60_000 });
  await page.getByTestId(`team-tab-${leader.slot_id}`).click();
  const leaderComposer = page.locator('textarea:visible').first();
  await leaderComposer.fill('Discover team tools for delegation, then report the result.');
  await leaderComposer.press('Enter');
  await page.getByText('Synthetic enterprise reply from RC2.').nth(1).waitFor({ timeout: 60_000 });
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/api/conversations/${id}/messages`);
    const body = await response.json();
    const items = body.data?.items as Array<{ content?: { content?: string } }> | undefined;
    return response.ok && (items?.filter((item) =>
      item.content?.content === 'Synthetic enterprise reply from RC2.').length ?? 0) >= 2;
  }, teammate.conversation_id, { timeout: 60_000 });
  await page.goto(`${marker.webOrigin}/#/scheduled`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByText('手动创建').click();
  await page.getByPlaceholder('输入任务名称').fill('Synthetic browser scheduled task');
  await page.getByTestId('cron-assistant-select').click();
  await page.getByText('AionUi管家').last().click();
  await page.getByPlaceholder('助手触发时执行的指令').fill('Reply with the synthetic enterprise marker.');
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(300);
  const cronAfterSave = await page.locator('body').innerText();
  try {
    await page.getByText('Synthetic browser scheduled task').first().waitFor({ timeout: 10_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      page: document.body.innerText.slice(-3200),
      jobs: await fetch('/api/cron/jobs').then(async (response) => ({ status: response.status, body: await response.text() })),
    }));
    throw new Error(`Browser scheduled task not shown: ${JSON.stringify({
      error: String(error), diagnostics, cronAfterSave: cronAfterSave.slice(-1800), pageErrors,
    })}`);
  }
  const scheduled = await page.evaluate(async () => {
    const response = await fetch('/api/cron/jobs');
    return { status: response.status, body: await response.json() };
  });
  const job = scheduled.body?.data?.find?.((item: { name?: string }) =>
    item.name === 'Synthetic browser scheduled task');
  if (scheduled.status !== 200 || !job?.id || pageErrors.length) {
    throw new Error(`Browser scheduled task missing: ${JSON.stringify({ scheduled, pageErrors })}`);
  }
  await page.goto(`${marker.webOrigin}/#/scheduled/${job.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '立即执行' }).click();
  try {
    await page.waitForFunction(async (id) => {
      const response = await fetch(`/api/cron/jobs/${id}`);
      const body = await response.json();
      return response.ok && body.data?.state?.run_count >= 1 && body.data.state.last_status === 'ok';
    }, job.id, { timeout: 60_000 });
  } catch (error) {
    const current = await page.evaluate(async (id) => {
      const response = await fetch(`/api/cron/jobs/${id}`);
      return { status: response.status, body: await response.json(), page: document.body.innerText.slice(-2500) };
    }, job.id);
    throw new Error(`Browser scheduled task did not run: ${JSON.stringify({ error: String(error), current, pageErrors })}`);
  }
  const jobConversations = await page.evaluate(async (id) => {
    const response = await fetch(`/api/cron/jobs/${id}/conversations`);
    return { status: response.status, body: await response.json() };
  }, job.id);
  if (!jobConversations.body?.data?.[0]?.id) {
    await page.waitForFunction(async (id) => {
      const response = await fetch(`/api/cron/jobs/${id}/conversations`);
      const body = await response.json();
      return response.ok && typeof body.data?.[0]?.id === 'string';
    }, job.id, { timeout: 30_000 });
  }
  const settledJobConversations = await page.evaluate(async (id) => {
    const response = await fetch(`/api/cron/jobs/${id}/conversations`);
    return { status: response.status, body: await response.json() };
  }, job.id);
  const jobConversationId = settledJobConversations.body?.data?.[0]?.id;
  if (jobConversations.status !== 200 || typeof jobConversationId !== 'string') {
    throw new Error(`Browser scheduled task result missing: ${JSON.stringify(settledJobConversations)}`);
  }
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/api/conversations/${id}/messages`);
    const body = await response.json();
    return response.ok && body.data?.items?.some((item: { content?: { content?: string } }) =>
      item.content?.content === 'Synthetic enterprise reply from RC2.');
  }, jobConversationId, { timeout: 30_000 });
  const managed = await page.evaluate(async (id) => {
    const renamed = await fetch(`/api/conversations/${id}`, { method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Managed web conversation', name_source: 'user' }) });
    const pinned = await fetch(`/api/order/pinned/conversation/${id}`, { method: 'PUT' });
    const catalog = await fetch('/enterprise/conversations').then((response) => response.json());
    const listed = catalog.items?.find((item: { id?: string }) => item.id === id);
    const archived = await fetch(`/api/sidebar/conversation/${id}/archive`, { method: 'POST' });
    const archivedCatalog = await fetch('/enterprise/conversations').then((response) => response.json());
    const absent = !archivedCatalog.items?.some((item: { id?: string }) => item.id === id);
    const restored = await fetch(`/api/sidebar/conversation/${id}/unarchive`, { method: 'POST' });
    const removed = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    return { renamed: renamed.status, pinned: pinned.status, listed, archived: archived.status,
      absent, restored: restored.status, removed: removed.status };
  }, modelId);
  if (managed.renamed !== 200 || managed.pinned !== 200 || managed.listed?.name !== 'Managed web conversation' ||
      managed.listed?.pinned !== true || managed.archived !== 200 || !managed.absent ||
      managed.restored !== 200 || managed.removed !== 200 || pageErrors.length) {
    throw new Error(`Browser web conversation management failed: ${JSON.stringify({ managed, pageErrors })}`);
  }
  if (process.env.AION_SMOKE_TRACE_TEAM === '1') {
    for (const line of output.split('\n').filter((entry) => entry.startsWith('TEAM_MODEL_TRACE '))) console.log(line);
  }
  console.log(JSON.stringify({ result: 'PASS', conversationId: marker.createdId,
    httpsOrigin: marker.webOrigin, sourceShown: true, serverWorkspaceShown: true,
    httpOnlySession: true, core: api.core, catalog: api.catalog,
    browserModelReply: true, replyPersisted: true, browserHistorySearch: true, secondBrowserContinued: true,
    browserReadonlyNoApproval: true, browserApprovalFilePreviewDownload: true,
    browserCancelAbortedModel: true,
    browserTeamStarted: true, browserTeamReply: true, browserSecondMemberReply: true,
    browserTeamDelegatedReply: true,
    browserScheduledTaskCreated: true,
    browserScheduledTaskRan: true, browserScheduledReplyPersisted: true,
    browserConversationManaged: true, pageErrors: 0 }));
} finally {
  if (readinessTimer) clearTimeout(readinessTimer);
  await browser?.close().catch(() => {});
  if (marker) await writeFile(marker.releaseFile, 'release\n').catch(() => {});
  if (child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([exited, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 30_000); })]);
    if (timeout) clearTimeout(timeout);
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  if (child.exitCode !== 0) throw new Error(`Web CLI smoke failed (${child.exitCode}): ${output}`);
}
