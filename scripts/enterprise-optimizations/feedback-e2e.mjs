const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = ['correct', 'data_calculation', 'citation', 'tool', 'artifact', 'other'];
const TASK_STATE_LABELS = { completed: '已完成', partial: '部分完成' };
const STATUS_LABELS = { IN_PROGRESS: '处理中', RESOLVED: '待复核' };

function requireValue(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

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

function adminResponsePath(response) {
  const value = responsePath(response);
  return value.startsWith('/api/ai/') ? value.slice('/api'.length) : value;
}

function envelopeData(value) {
  return value && typeof value === 'object' && 'data' in value ? value.data : value;
}

async function responseJson(response, operation) {
  if (!response.ok()) throw new Error(`${operation} failed with HTTP ${response.status()}`);
  const value = await response.json().catch(() => null);
  const data = envelopeData(value);
  if (!data || typeof data !== 'object') throw new Error(`${operation} returned an invalid response`);
  return data;
}

async function openEmployeeFeedback(page, task, openEmployeeTask) {
  const taskId = requireValue(task.taskId, 'taskId', 100);
  if (!TASK_ID.test(taskId)) throw new Error('taskId has an unsupported format');
  if (!['completed', 'partial'].includes(task.state)) throw new Error('task state must be completed or partial');
  if (!CATEGORIES.includes(task.category)) throw new Error('feedback category is invalid');
  requireValue(task.note, 'feedback note', 500);

  await openEmployeeTask(page, taskId);
  const open = page.getByTestId('task-feedback-open');
  await open.waitFor({ state: 'visible' });
  await open.click();

  const form = page.getByTestId('task-feedback-form');
  await form.waitFor({ state: 'visible' });
  await form.locator('.arco-select').first().click();
  const option = page.locator('.arco-select-popup:visible .arco-select-option').nth(CATEGORIES.indexOf(task.category));
  await option.waitFor({ state: 'visible' });
  await option.click();
  await form.locator('textarea').fill(task.note.trim());

  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      responsePath(response) === `/enterprise/tasks/${taskId}/feedback`
  );
  await form.locator('button.arco-btn-primary').click();
  const response = await submitted;
  const record = await responseJson(response, `employee feedback for ${taskId}`);
  const posted = response.request().postDataJSON();
  if (!UUID.test(String(posted?.attemptId || ''))) throw new Error('feedback request did not carry the real attemptId');
  if (record.task_id !== taskId || record.attempt_id !== posted.attemptId || record.category !== task.category) {
    throw new Error('feedback receipt is not bound to the submitted task attempt');
  }
  await page.getByTestId('task-feedback-status').waitFor({ state: 'visible' });
  return { taskId, state: task.state, attemptId: posted.attemptId, feedbackId: record.id };
}

async function openAdminCase(page, taskId) {
  const row = page.getByRole('row').filter({ hasText: taskId }).first();
  await row.waitFor({ state: 'visible' });
  const detailResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && /^\/ai\/admin\/feedback\/[0-9a-f-]{36}$/i.test(adminResponsePath(response))
  );
  await row.getByRole('button', { name: '查看' }).click();
  const response = await detailResponse;
  const detail = await responseJson(response, `admin feedback detail for ${taskId}`);
  if (detail.task_id !== taskId || !UUID.test(String(detail.id || ''))) {
    throw new Error('admin detail is not bound to the requested task');
  }
  const dialog = page.getByRole('dialog', { name: '反馈处理' });
  await dialog.waitFor({ state: 'visible' });
  return { dialog, detail, response };
}

function formItem(dialog, label) {
  return dialog.locator('.el-form-item').filter({ hasText: label }).first();
}

async function fillField(dialog, label, value) {
  await formItem(dialog, label).locator('textarea, input').first().fill(value);
}

async function selectStatus(page, dialog, status) {
  await formItem(dialog, '处理状态').locator('.el-select').click();
  const option = page.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter({
    hasText: STATUS_LABELS[status],
  });
  await option.first().click();
}

async function saveAdminCase(page, dialog, feedbackId) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && adminResponsePath(response) === `/ai/admin/feedback/${feedbackId}`
  );
  await dialog.getByRole('button', { name: '保存处理记录' }).click();
  const response = await saved;
  return { response, detail: await responseJson(response, 'save admin feedback') };
}

function forwardedAuthHeaders(response) {
  return response.request().allHeaders().then((source) => {
    const result = {};
    for (const name of ['authorization', 'clientid', 'satoken', 'tenant-id', 'x-tenant-id']) {
      if (source[name]) result[name] = source[name];
    }
    return result;
  });
}

function updatePayload(detail, status) {
  return {
    status,
    badcaseDescription: detail.badcase_description,
    rootCause: detail.root_cause,
    causeEvidence: detail.cause_evidence,
    expectedResult: detail.expected_result,
    resolution: detail.resolution,
    expectedVersion: detail.record_version,
  };
}

async function directAdminPatch(page, sourceResponse, feedbackId, payload) {
  const headers = await forwardedAuthHeaders(sourceResponse);
  const prefix = responsePath(sourceResponse).startsWith('/api/ai/') ? '/api' : '';
  return page.request.patch(new URL(`${prefix}/ai/admin/feedback/${feedbackId}`, sourceResponse.url()).toString(), {
    headers,
    data: payload,
    failOnStatusCode: false,
  });
}

async function verifyOtherEmployeeIsolation(page, task) {
  const result = await page.evaluate(
    async ({ taskId, attemptId }) => {
      const response = await fetch(
        `/enterprise/tasks/${encodeURIComponent(taskId)}/feedback?attemptId=${encodeURIComponent(attemptId)}`,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      return { status: response.status };
    },
    task
  );
  if (result.status !== 404) {
    throw new Error(`other employee feedback isolation failed with HTTP ${result.status}`);
  }
}

/**
 * Phase 1: submit real completed/partial task feedback, resolve one case, and prove it cannot close without recheck.
 * The caller owns navigation because deployed Web/Admin routes differ between release environments.
 */
export async function prepareFeedbackE2E({
  employeePage,
  adminPage,
  auditorPage,
  otherEmployeePage,
  tasks,
  caseTaskId,
  analysis,
  openEmployeeTask,
  openAdminFeedback,
}) {
  for (const [page, name] of [
    [employeePage, 'employeePage'],
    [adminPage, 'adminPage'],
    [auditorPage, 'auditorPage'],
    [otherEmployeePage, 'otherEmployeePage'],
  ]) requirePage(page, name);
  if (typeof openEmployeeTask !== 'function' || typeof openAdminFeedback !== 'function') {
    throw new Error('openEmployeeTask and openAdminFeedback callbacks are required');
  }
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 2 ||
      tasks.filter((item) => item.state === 'completed').length !== 1 ||
      tasks.filter((item) => item.state === 'partial').length > 1 ||
      tasks.some((item) => !['completed', 'partial'].includes(item.state))) {
    throw new Error('tasks must contain one real completed task and may contain one existing partial task');
  }
  const fields = {
    badcaseDescription: requireValue(analysis?.badcaseDescription, 'badcaseDescription'),
    rootCause: requireValue(analysis?.rootCause, 'rootCause'),
    causeEvidence: requireValue(analysis?.causeEvidence, 'causeEvidence', 1000),
    expectedResult: requireValue(analysis?.expectedResult, 'expectedResult'),
    resolution: requireValue(analysis?.resolution, 'resolution'),
  };

  const submitted = [];
  for (const task of tasks) submitted.push(await openEmployeeFeedback(employeePage, task, openEmployeeTask));
  const lifecycleTaskId = caseTaskId || submitted.find((item) => item.state === 'completed')?.taskId;
  const selected = submitted.find((item) => item.taskId === lifecycleTaskId);
  if (!selected) throw new Error('caseTaskId must identify one of the submitted tasks');

  await openAdminFeedback(adminPage);
  for (const item of submitted) {
    const row = adminPage.getByRole('row').filter({ hasText: item.taskId }).first();
    await row.waitFor({ state: 'visible' });
    if (!(await row.innerText()).includes(TASK_STATE_LABELS[item.state])) {
      throw new Error(`admin list did not preserve the real ${item.state} task state`);
    }
  }
  let adminCase = await openAdminCase(adminPage, selected.taskId);
  if (adminCase.detail.id !== selected.feedbackId) throw new Error('admin opened a different feedback record');
  for (const [label, value] of [
    ['Badcase 描述', fields.badcaseDescription],
    ['人工确认原因', fields.rootCause],
    ['原因证据引用', fields.causeEvidence],
    ['预期结果', fields.expectedResult],
    ['处理结果', fields.resolution],
  ]) await fillField(adminCase.dialog, label, value);
  await selectStatus(adminPage, adminCase.dialog, 'IN_PROGRESS');
  let saved = await saveAdminCase(adminPage, adminCase.dialog, selected.feedbackId);
  if (saved.detail.status !== 'IN_PROGRESS') throw new Error('feedback did not enter IN_PROGRESS');
  await selectStatus(adminPage, adminCase.dialog, 'RESOLVED');
  saved = await saveAdminCase(adminPage, adminCase.dialog, selected.feedbackId);
  if (saved.detail.status !== 'RESOLVED') throw new Error('feedback did not enter RESOLVED');

  const close = adminCase.dialog.getByRole('button', { name: '复核通过并关闭' });
  if (!(await close.isDisabled())) throw new Error('close action became available without a current PASSED recheck');
  const rejectedClose = await directAdminPatch(
    adminPage,
    saved.response,
    selected.feedbackId,
    updatePayload(saved.detail, 'CLOSED')
  );
  if (rejectedClose.status() !== 409) {
    throw new Error(`server allowed close without recheck (HTTP ${rejectedClose.status()})`);
  }

  await adminCase.dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await openAdminFeedback(auditorPage);
  const auditorCase = await openAdminCase(auditorPage, selected.taskId);
  if (await auditorCase.dialog.locator('.case-form').count()) throw new Error('read-only auditor can see write controls');
  const auditorWrite = await directAdminPatch(
    auditorPage,
    auditorCase.response,
    selected.feedbackId,
    updatePayload(auditorCase.detail, auditorCase.detail.status)
  );
  if (auditorWrite.status() !== 403) throw new Error(`read-only auditor write was not forbidden (HTTP ${auditorWrite.status()})`);
  await auditorCase.dialog.getByRole('button', { name: '关闭', exact: true }).click();

  for (const item of submitted) await verifyOtherEmployeeIsolation(otherEmployeePage, item);
  return {
    caseTaskId: selected.taskId,
    feedbackId: selected.feedbackId,
    resolutionRevision: saved.detail.resolution_revision,
    tasks: submitted,
  };
}

/**
 * Phase 2: call only after an external, actual recheck has been performed.
 * This helper never derives, invents, or silently marks recheck evidence as PASSED.
 */
export async function passRecheckAndCloseFeedbackE2E({
  adminPage,
  prepared,
  actualRecheck,
  openAdminFeedback,
}) {
  requirePage(adminPage, 'adminPage');
  if (typeof openAdminFeedback !== 'function') throw new Error('openAdminFeedback callback is required');
  if (!prepared || !TASK_ID.test(String(prepared.caseTaskId || '')) || !UUID.test(String(prepared.feedbackId || ''))) {
    throw new Error('prepared phase-1 receipt is invalid');
  }
  if (actualRecheck?.confirmedExecuted !== true) {
    throw new Error('actualRecheck.confirmedExecuted must be true after the external check has really run');
  }
  const check = {
    checkDescription: requireValue(actualRecheck.checkDescription, 'checkDescription', 500),
    expectedResult: requireValue(actualRecheck.expectedResult, 'recheck expectedResult', 1000),
    actualResult: requireValue(actualRecheck.actualResult, 'actualResult', 1000),
    evidence: requireValue(actualRecheck.evidence, 'recheck evidence', 1000),
  };

  await openAdminFeedback(adminPage);
  const adminCase = await openAdminCase(adminPage, prepared.caseTaskId);
  if (adminCase.detail.id !== prepared.feedbackId || adminCase.detail.status !== 'RESOLVED' ||
      adminCase.detail.resolution_revision !== prepared.resolutionRevision) {
    throw new Error('feedback changed after phase 1; do not attach stale recheck evidence');
  }
  for (const [label, value] of [
    ['检查项', check.checkDescription],
    ['预期', check.expectedResult],
    ['实际结果', check.actualResult],
    ['证据引用', check.evidence],
  ]) await fillField(adminCase.dialog, label, value);
  await formItem(adminCase.dialog, '结论').getByText('通过', { exact: true }).click();

  const recorded = adminPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      adminResponsePath(response) === `/ai/admin/feedback/${prepared.feedbackId}/rechecks`
  );
  await adminCase.dialog.getByRole('button', { name: '记录复核' }).click();
  const recordedResponse = await recorded;
  const rechecked = await responseJson(recordedResponse, 'record actual recheck');
  const latest = Array.isArray(rechecked.rechecks) ? rechecked.rechecks[0] : null;
  if (latest?.result !== 'PASSED' || latest?.resolution_revision !== rechecked.resolution_revision) {
    throw new Error('PASSED recheck is not bound to the current resolution revision');
  }

  const close = adminCase.dialog.getByRole('button', { name: '复核通过并关闭' });
  if (await close.isDisabled()) throw new Error('current PASSED recheck did not enable close');
  const closed = adminPage.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      adminResponsePath(response) === `/ai/admin/feedback/${prepared.feedbackId}`
  );
  await close.click();
  const closedDetail = await responseJson(await closed, 'close feedback after actual recheck');
  if (closedDetail.status !== 'CLOSED') throw new Error('feedback did not close');
  return {
    feedbackId: prepared.feedbackId,
    taskId: prepared.caseTaskId,
    status: closedDetail.status,
    recheckId: latest.id,
  };
}
