import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { prepareEnterpriseProfile } from '../enterprise-core.js';
import type { EnterpriseActor } from '../enterprise-gateway.js';
import { TaskRunner } from './runner.js';
import { TaskStore } from './store.js';
import { recordTool, checkpoint } from './protocol.js';
import { enterpriseManagedResourcePath } from '../enterprise-resource-runtime.js';
import { currentAttempt } from './types.js';
import { saveEmployeePreferences } from '../read-model/preferences.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(trusted = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'task-runner-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const actor = { serverId: 'rc2', userId: '17' },
    { profile } = await prepareEnterpriseProfile(root, actor);
  execFileSync('python3', [
    '-c',
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(\"CREATE TABLE conversations(id,user_id,archived_at);INSERT INTO conversations VALUES('aabbccdd','system_default_user',NULL);\");c.commit()",
    path.join(profile, 'aionui-backend.db'),
  ]);
  let sends = 0,
    stops = 0;
  let processing = false;
  let coreGate: Promise<void> = Promise.resolve();
  let releaseCore = () => {};
  let authorized = true;
  let pendingApproval = false;
  let pendingCallId = 'office-call';
  let pendingCommandType = 'exec';
  let pendingAction = 'ExecCommand';
  let runtimeTurnId = 'turn1';
  let loseConfirmationResponse = false;
  const confirmations: Array<{ callId: string; data: unknown; input: Record<string, unknown> }> = [];
  const confirmationRequests: string[] = [];
  let approvalData: unknown;
  let nativeToolError = false;
  let answerText = 'Actual answer';
  let proposalInput: Record<string, unknown> = { command: 'printf harmless' };
  let confirmationReads = 0;
  let additionalPending: Array<{
    callId: string;
    action: string;
    commandType: string;
    input: Record<string, unknown>;
  }> = [];
  const pendingCalls = () => [
    ...additionalPending,
    ...(pendingApproval
      ? [{ callId: pendingCallId, action: pendingAction, commandType: pendingCommandType, input: proposalInput }]
      : []),
  ];
  const server = http.createServer(async (req, res) => {
    let data = {};
    for await (const b of req) data = { ...data, ...JSON.parse(String(b)) };
    let body: unknown = {};
    if (req.url?.endsWith('/messages') && req.method === 'POST') {
      sends++;
      processing = true;
      body = { msg_id: 'msg1', turn_id: runtimeTurnId };
    } else if (req.url?.endsWith('/confirmations')) {
      confirmationReads++;
      body = pendingCalls().map((call) => ({
        call_id: call.callId,
        action: call.action,
        command_type: call.commandType,
        description: 'Execute: same prefix',
        options: [{ value: 'proceed_once' }],
      }));
    } else if (req.url?.endsWith('/confirm')) {
      approvalData = (data as { data?: unknown }).data;
      const callId = decodeURIComponent(req.url.split('/').at(-2) || '');
      confirmationRequests.push(callId);
      // Native confirmation is one-shot and returns success even if the call
      // no longer exists. Only a live matching invocation can have an effect.
      const pending = pendingCalls().find((call) => call.callId === callId);
      if (pending) {
        confirmations.push({ callId, data: approvalData, input: structuredClone(pending.input) });
        if (callId === pendingCallId) pendingApproval = false;
        additionalPending = additionalPending.filter((call) => call.callId !== callId);
      }
      if (loseConfirmationResponse) {
        loseConfirmationResponse = false;
        req.socket.destroy();
        return;
      }
    } else if (req.url?.includes('/messages?')) {
      if (!req.url.includes('anchor_message_id=msg1')) {
        if (pendingCalls().length) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              data: {
                items: pendingCalls().map((call) => ({
                  type: 'tool_call',
                  content: {
                    call_id: `aionrs-${call.callId}`,
                    name: call.action,
                    args: call.input,
                  },
                })),
              },
            })
          );
          return;
        }
        res.writeHead(400);
        res.end(JSON.stringify({ success: false }));
        return;
      }
      body = {
        items: [
          {
            id: 'msg1',
            msg_id: 'msg1',
            position: 'right',
            type: 'text',
            content: { content: 'Work' },
          },
          ...(nativeToolError
            ? [
                {
                  type: 'tool_call',
                  status: 'error',
                  content: { name: 'read_document', args: { path: 'source.txt' } },
                },
              ]
            : []),
          {
            position: 'left',
            type: 'text',
            status: 'finish',
            backend_turn_id: 'turn1',
            content: { content: answerText },
          },
        ],
      };
    } else if (req.url?.endsWith('/cancel')) {
      stops++;
      processing = false;
      pendingApproval = false;
      additionalPending = [];
    } else
      body = {
        runtime: {
          state: processing ? 'running' : 'idle',
          turn_id: runtimeTurnId,
          is_processing: processing,
          pending_confirmations: pendingCalls().length,
        },
      };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: body }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const core = {
    port: (server.address() as { port: number }).port,
    localToken: 'test',
    stop: async () => {},
    workspaceRoot: path.join(profile, 'workspace'),
  };
  const grants = new Set<string>();
  const dependencies = {
    root,
    origin: 'https://employee.test',
    queueLimit: 2,
    core: async (_actor: EnterpriseActor) => {
      await coreGate;
      return core;
    },
    peek: async () => core,
    cancelPreparation: async () => {
      releaseCore();
    },
    issue: async (_a: EnterpriseActor, j: string) => {
      grants.add(j);
    },
    check: async (_a: EnterpriseActor, j: string) => authorized && grants.has(j),
    revoke: async (_a: EnterpriseActor, j: string) => {
      grants.delete(j);
    },
    bind: () => {},
    actors: async () => [actor],
    trustedConfirmation: async () => trusted,
  };
  const createRunner = () => {
    const created = new TaskRunner(dependencies);
    cleanups.push(() => created.stop());
    return created;
  };
  const runner = createRunner();
  const store = await TaskStore.create(root, actor);
  return {
    core,
    root,
    actor,
    store,
    runner,
    createRunner,
    grants,
    blockCore: () => {
      coreGate = new Promise<void>((r) => {
        releaseCore = r;
      });
    },
    releaseCore: () => releaseCore(),
    finish: () => {
      processing = false;
    },
    revoke: () => {
      authorized = false;
    },
    approval: (callId = 'office-call', commandType = 'exec', action = 'ExecCommand') => {
      pendingApproval = true;
      pendingCallId = callId;
      pendingCommandType = commandType;
      pendingAction = action;
    },
    forgetApproval: () => {
      pendingApproval = false;
      additionalPending = [];
    },
    prependApproval: (callId: string, input: Record<string, unknown>) => {
      additionalPending.unshift({ callId, input, action: 'ExecCommand', commandType: 'exec' });
    },
    runtimeTurn: (turnId: string) => {
      runtimeTurnId = turnId;
    },
    loseConfirmationResponse: () => {
      loseConfirmationResponse = true;
    },
    confirmations: () => confirmations,
    confirmationRequests: () => confirmationRequests,
    confirmationReads: () => confirmationReads,
    approvalData: () => approvalData,
    nativeToolError: () => {
      nativeToolError = true;
    },
    proposal: (input: Record<string, unknown>) => {
      proposalInput = input;
    },
    reply: (text: string) => {
      answerText = text;
    },
    counts: () => ({ sends, stops }),
  };
}

async function receiptFixture(content: string) {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content, request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  const bytes = execFileSync('python3', [
    '-c',
    'import io,zipfile,sys;b=io.BytesIO();z=zipfile.ZipFile(b,"w");z.writestr("[Content_Types].xml","<Types/>");z.writestr("xl/workbook.xml","<workbook/>");z.close();sys.stdout.buffer.write(b.getvalue())',
  ]);
  const receipt = {
    path: '真实成果.xlsx',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    versionId: randomUUID(),
    version: 1,
    validation: { valid: true },
  };
  const directory = path.join(path.dirname(await enterpriseManagedResourcePath(f.root, f.actor)), 'office');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'index.json'),
    JSON.stringify({
      files: {
        [receipt.path]: [
          {
            id: receipt.versionId,
            sha256: receipt.sha256,
            byteSize: bytes.length,
            createdAt: new Date().toISOString(),
          },
        ],
      },
      memories: [],
    })
  );
  const blob = path.join(directory, receipt.versionId + '.bin');
  await writeFile(blob, bytes);
  return { ...f, receipt, blob };
}

test('model-spelled paths cannot replace a generated pinned artifact or turn it into a missing file', async () => {
  const f = await receiptFixture('给我Excel结果和简短总结');
  await recordTool(f.root, f.actor, 'aabbccdd', 'create_office_document', {}, f.receipt);
  await checkpoint(f.root, f.actor, 'aabbccdd', {
    state: 'completed',
    summary: '已生成名字写错.xlsx',
    requiredArtifacts: ['名字写错.xlsx'],
  });
  f.reply('已生成名字写错.xlsx，[下载](https://employee.test/enterprise/files/download?path=名字写错.xlsx)');
  f.finish();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 5000 })
    .toBe('completed');
  expect(currentAttempt(await f.store.get('aabbccdd')).artifacts).toEqual([
    expect.objectContaining({ path: f.receipt.path, versionId: f.receipt.versionId, sha256: f.receipt.sha256 }),
  ]);
});

test.each([
  ['生成Excel，不生成Word', 'completed'],
  ['生成Excel和Word', 'partial'],
])('required formats decide completion when an unrequested format fails: %s', async (content, expected) => {
  const f = await receiptFixture(content);
  await recordTool(
    f.root,
    f.actor,
    'aabbccdd',
    'create_evidence_deliverables',
    {},
    {
      status: 'partial',
      outputs: [
        { ...f.receipt, status: 'complete' },
        { path: '真实成果.docx', status: 'failed', error: 'GENERATION_FAILED' },
      ],
    }
  );
  f.finish();
  await expect.poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 5000 }).toBe(expected);
});

test('a genuinely missing pinned file remains partial despite a completed model checkpoint', async () => {
  const f = await receiptFixture('生成Excel');
  await recordTool(f.root, f.actor, 'aabbccdd', 'create_office_document', {}, f.receipt);
  await checkpoint(f.root, f.actor, 'aabbccdd', {
    state: 'completed',
    summary: '已完成',
    requiredArtifacts: [{ versionId: f.receipt.versionId }],
  });
  await unlink(f.blob);
  f.finish();
  await expect.poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 5000 }).toBe('partial');
  expect(currentAttempt(await f.store.get('aabbccdd')).reason).toBe('REQUIRED_ARTIFACTS_MISSING');
}, 12000);
test('a queued attempt preserves its preference version and never returns its private instructions', async () => {
  const f = await fixture();
  f.blockCore();
  const preferences = {
    enabled: true,
    style: 'direct',
    detail: 'brief',
    language: 'en-US',
    instructions: 'private stylistic marker',
  };
  await saveEmployeePreferences(f.root, f.actor, { ...preferences, expectedVersion: 0 });
  const payload = { content: 'Reply with one sentence.', request_id: randomUUID() };
  const accepted = await f.runner.accept(f.actor, 'aabbccdd', payload);
  expect(accepted.receipt).toMatchObject({ preference_version: 1 });
  await saveEmployeePreferences(f.root, f.actor, { ...preferences, enabled: false, expectedVersion: 1 });
  const repeated = await f.runner.accept(f.actor, 'aabbccdd', payload);
  expect(repeated.receipt).toMatchObject({ preference_version: 1 });
  f.releaseCore();
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  expect(currentAttempt(await f.store.get('aabbccdd')).preferences).toMatchObject({ version: 1, enabled: true });
  expect(JSON.stringify(await f.runner.detail(f.actor, 'aabbccdd'))).not.toContain(preferences.instructions);
});

test('accepted execution survives the absence of any browser and duplicates do not dispatch twice', async () => {
  const f = await fixture(),
    request_id = randomUUID();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'A normal question', request_id });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'A normal question', request_id });
  f.finish();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('completed');
  expect(f.counts().sends).toBe(1);
});
test('a saved waiting checkpoint is safely cancelled before releasing its grant and never auto approved', async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Need data', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  const a = currentAttempt(await f.store.get('aabbccdd'));
  await f.store.mutate('aabbccdd', a.id, (x) => {
    x.stopReason = 'waiting_input';
    x.question = 'Upload the missing quote';
  });
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 8000 })
    .toBe('waiting_input');
  await expect.poll(() => f.grants.size, { timeout: 3000 }).toBe(0);
  expect(f.counts().stops).toBeGreaterThan(0);
  expect(currentAttempt(await f.store.get('aabbccdd')).question).toBe('Upload the missing quote');
});
test('runtime idle without required files is not treated as task completion', async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', {
    content: 'Generate Word and Excel',
    request_id: randomUUID(),
  });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.finish();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('interrupted');
  expect(currentAttempt(await f.store.get('aabbccdd')).reason).toBe('REQUIRED_ARTIFACTS_MISSING');
});
test('service stop persists interrupted state; recovery never blindly replays a sent attempt', async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  await f.runner.stop();
  expect(currentAttempt(await f.store.get('aabbccdd')).state).toBe('interrupted');
  expect(f.counts().sends).toBe(1);
});

test('cancelled durable queue entry never sends to the native executor', async () => {
  const f = await fixture();
  f.blockCore();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Queued work', request_id: randomUUID() });
  const a = currentAttempt(await f.store.get('aabbccdd'));
  await f.runner.action(f.actor, 'aabbccdd', 'cancel', { attemptId: a.id });
  await f.runner.tick();
  expect(currentAttempt(await f.store.get('aabbccdd')).state).toBe('cancelled');
  expect(f.counts().sends).toBe(0);
  await expect.poll(() => f.grants.size, { timeout: 3000 }).toBe(0);
});
test('admission returns a stable cancellation identity while native startup is pending', async () => {
  const f = await fixture();
  f.blockCore();
  const accepted = await f.runner.accept(f.actor, 'aabbccdd', {
    content: 'A normal question',
    request_id: randomUUID(),
  });
  const attempt = currentAttempt(await f.store.get('aabbccdd'));
  expect(accepted.receipt).toMatchObject({ turn_id: attempt.id, runtime: { turn_id: null } });
  expect(attempt.turnId).toBeUndefined();
  await f.runner.action(f.actor, 'aabbccdd', 'cancel', { attemptId: attempt.id });
});
test('revocation cancels real executor state instead of retaining a valid browser session as authority', async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.revoke();
  await f.runner.tick();
  await expect.poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 8000 }).toBe('failed');
  expect(f.counts().stops).toBeGreaterThan(0);
  expect(currentAttempt(await f.store.get('aabbccdd')).reason).toBe('TASK_AUTHORIZATION_REVOKED');
});

test('trusted Office approval uses the native object-valued confirmation contract', async () => {
  const f = await fixture(true);
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.approval();
  await f.runner.tick();
  await expect.poll(() => f.approvalData(), { timeout: 5000 }).toEqual({ value: 'proceed_once' });
});
test('completion reads the accepted row anchor using native cursors, never a raw ID as after', async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Hello', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.finish();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('completed');
});

test('a retransmitted continuation returns the accepted attempt and rejects altered input', async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'First', request_id: randomUUID() });
  const old = currentAttempt(await f.store.get('aabbccdd'));
  await f.store.mutate('aabbccdd', old.id, (a) => {
    a.state = 'waiting_input';
    a.question = 'Which period?';
  });
  f.blockCore();
  const body = { attemptId: old.id, request_id: randomUUID(), content: 'October' };
  await f.runner.action(f.actor, 'aabbccdd', 'continue', body);
  const id = currentAttempt(await f.store.get('aabbccdd')).id;
  await f.runner.action(f.actor, 'aabbccdd', 'continue', body);
  expect(currentAttempt(await f.store.get('aabbccdd')).id).toBe(id);
  await expect(f.runner.action(f.actor, 'aabbccdd', 'continue', { ...body, content: 'Changed' })).rejects.toThrow(
    'TASK_ATTEMPT_CHANGED'
  );
  f.releaseCore();
});

test('only a verified later Host receipt resolves a persisted tool error; untracked errors remain failures', async () => {
  for (const recovered of [true, false]) {
    const f = await fixture();
    await f.runner.accept(f.actor, 'aabbccdd', { content: 'Hello', request_id: randomUUID() });
    await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
    f.nativeToolError();
    if (recovered) {
      await recordTool(f.root, f.actor, 'aabbccdd', 'read_document', { path: 'source.txt' }, undefined, 'READ_FAILED');
      await recordTool(
        f.root,
        f.actor,
        'aabbccdd',
        'read_document',
        { path: 'source.txt' },
        { text: 'Actual recovered source' }
      );
    }
    f.finish();
    await f.runner.tick();
    await expect
      .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
      .toBe(recovered ? 'completed' : 'failed');
  }
});

async function waitingApprovalFixture() {
  const f = await fixture();
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.approval();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('waiting_confirmation');
  const attempt = currentAttempt(await f.store.get('aabbccdd'));
  const detail = (await f.runner.detail(f.actor, 'aabbccdd')) as {
    attempts: Array<{ confirmation?: { id?: string } }>;
  };
  return {
    ...f,
    attempt,
    approvalBody: {
      attemptId: attempt.id,
      confirmationId: detail.attempts.at(-1)?.confirmation?.id,
      request_id: randomUUID(),
    },
  };
}

test('employee approval keeps the original invocation alive instead of cancelling and asking the model again', async () => {
  const f = await waitingApprovalFixture();
  expect(f.counts()).toEqual({ sends: 1, stops: 0 });
  expect(f.grants.has(f.attempt.jobId)).toBe(true);
  expect(f.approvalBody.confirmationId).toEqual(expect.any(String));
});

test('approving executes the exact pending input in the original attempt and turn without another model message', async () => {
  const f = await waitingApprovalFixture();
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  expect(f.confirmations()).toEqual([
    { callId: 'office-call', data: { value: 'proceed_once' }, input: { command: 'printf harmless' } },
  ]);
  expect(currentAttempt(await f.store.get('aabbccdd'))).toMatchObject({ id: f.attempt.id, turnId: f.attempt.turnId });
  expect(f.counts().sends).toBe(1);
});

test('explicit approval rejects changed full input even when call ID and truncated description are unchanged', async () => {
  const f = await waitingApprovalFixture();
  f.proposal({ command: 'a different action with the same description' });
  await expect(f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody)).rejects.toMatchObject({ status: 409 });
  expect(f.confirmations()).toEqual([]);
  expect(f.counts().sends).toBe(1);
});

test('duplicate simultaneous approval requests resolve once without another model turn', async () => {
  const f = await waitingApprovalFixture();
  await Promise.all([
    f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody),
    f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody),
  ]);
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  expect(f.confirmations()).toHaveLength(1);
  expect(f.confirmationRequests()).toEqual(['office-call']);
  expect(f.counts().sends).toBe(1);
});

test('declining denies the original invocation without asking the model to reconstruct it', async () => {
  const f = await waitingApprovalFixture();
  await f.runner.action(f.actor, 'aabbccdd', 'decline', f.approvalBody);
  expect(f.confirmations()).toEqual([
    { callId: 'office-call', data: { value: 'cancel' }, input: { command: 'printf harmless' } },
  ]);
  expect(currentAttempt(await f.store.get('aabbccdd')).id).toBe(f.attempt.id);
  expect(f.counts().sends).toBe(1);
});

test('approval cannot target an unspecified confirmation from a stale client', async () => {
  const f = await waitingApprovalFixture();
  const { confirmationId: _confirmationId, ...withoutConfirmation } = f.approvalBody;
  await expect(f.runner.action(f.actor, 'aabbccdd', 'approve', withoutConfirmation)).rejects.toBeInstanceOf(Error);
  expect(f.confirmations()).toEqual([]);
  expect(currentAttempt(await f.store.get('aabbccdd')).state).toBe('waiting_confirmation');
});

test('an old confirmation cannot approve a second tool call in the same attempt', async () => {
  const f = await waitingApprovalFixture();
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  f.proposal({ command: 'printf second' });
  f.approval('office-call-2');
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('waiting_confirmation');
  await expect(
    f.runner.action(f.actor, 'aabbccdd', 'approve', { ...f.approvalBody, request_id: randomUUID() })
  ).rejects.toMatchObject({ status: 409 });
  // A retry of the already accepted decision may return its receipt but must
  // never be interpreted as permission for the new call.
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  expect(f.confirmations().map((c) => c.callId)).toEqual(['office-call']);
  const detail = (await f.runner.detail(f.actor, 'aabbccdd')) as {
    attempts: Array<{ id: string; confirmation?: { id?: string } }>;
  };
  const current = detail.attempts.at(-1)!;
  await f.runner.action(f.actor, 'aabbccdd', 'approve', {
    attemptId: current.id,
    confirmationId: current.confirmation?.id,
    request_id: randomUUID(),
  });
  expect(f.confirmations().map((c) => [c.callId, c.input])).toEqual([
    ['office-call', { command: 'printf harmless' }],
    ['office-call-2', { command: 'printf second' }],
  ]);
});

test('reordered native pending calls keep the displayed approval bound to its original invocation', async () => {
  const f = await waitingApprovalFixture();
  const reads = f.confirmationReads();
  f.prependApproval('inserted-call', { command: 'printf inserted' });
  await f.runner.tick();
  // Observe two queue reads so the assertion cannot pass merely because the
  // background observation of the reordered queue has not finished yet.
  await expect.poll(() => f.confirmationReads(), { timeout: 6000 }).toBeGreaterThanOrEqual(reads + 2);
  type Detail = { attempts: Array<{ confirmation?: { id?: string } }> };
  const current = (await f.runner.detail(f.actor, 'aabbccdd')) as Detail;
  expect(current.attempts.at(-1)?.confirmation?.id).toBe(f.approvalBody.confirmationId);
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('waiting_confirmation');
  const next = (await f.runner.detail(f.actor, 'aabbccdd')) as Detail;
  const nextConfirmationId = next.attempts.at(-1)?.confirmation?.id;
  expect(nextConfirmationId).not.toBe(f.approvalBody.confirmationId);
  await f.runner.action(f.actor, 'aabbccdd', 'approve', {
    attemptId: f.attempt.id,
    confirmationId: nextConfirmationId,
    request_id: randomUUID(),
  });
  expect(f.confirmations().map((call) => call.callId)).toEqual(['office-call', 'inserted-call']);
}, 15000);

test('a lost approval response cannot replay the approved side effect or start another model turn', async () => {
  const f = await waitingApprovalFixture();
  f.loseConfirmationResponse();
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody).catch(() => undefined);
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody).catch(() => undefined);
  expect(f.confirmations()).toHaveLength(1);
  expect(f.confirmationRequests()).toEqual(['office-call']);
  expect(f.counts().sends).toBe(1);
});

test('an uncertain approved write requires its external outcome to be reviewed before any retry', async () => {
  const f = await waitingApprovalFixture();
  f.loseConfirmationResponse();
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody).catch(() => undefined);
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 5000 })
    .toBe('interrupted');
  await expect(
    f.runner.action(f.actor, 'aabbccdd', 'retry', {
      attemptId: f.attempt.id,
      request_id: randomUUID(),
      reviewed: true,
    })
  ).rejects.toThrow('TASK_EXTERNAL_REVIEW_REQUIRED');
  expect(f.counts().sends).toBe(1);
}, 12000);

test('cancelling an uncertain approved write cannot remove its external-outcome guard for direct messages', async () => {
  const f = await waitingApprovalFixture();
  f.loseConfirmationResponse();
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 5000 })
    .toBe('interrupted');
  await f.runner.action(f.actor, 'aabbccdd', 'cancel', { attemptId: f.attempt.id });
  expect(currentAttempt(await f.store.get('aabbccdd')).state).toBe('cancelled');
  await expect(f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() })).rejects.toThrow(
    'TASK_EXTERNAL_REVIEW_REQUIRED'
  );
}, 12000);

test('a later approved read cannot erase the external-outcome review needed for an earlier approved write', async () => {
  const f = await waitingApprovalFixture();
  await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
  f.proposal({ path: 'receipt.txt' });
  f.approval('read-call', 'read', 'ReadFile');
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 })
    .toBe('waiting_confirmation');
  const detail = (await f.runner.detail(f.actor, 'aabbccdd')) as {
    attempts: Array<{ confirmation?: { id?: string } }>;
  };
  await f.runner.action(f.actor, 'aabbccdd', 'approve', {
    attemptId: f.attempt.id,
    confirmationId: detail.attempts.at(-1)?.confirmation?.id,
    request_id: randomUUID(),
  });
  f.runtimeTurn('turn-after-crash');
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 5000 })
    .toBe('interrupted');
  await expect(
    f.runner.action(f.actor, 'aabbccdd', 'retry', {
      attemptId: f.attempt.id,
      request_id: randomUUID(),
      reviewed: true,
    })
  ).rejects.toThrow('TASK_EXTERNAL_REVIEW_REQUIRED');
}, 15000);

test.each(['retry', 'message'] as const)(
  'timeout cannot make an approved write retryable without checking its external outcome via %s',
  async (entry) => {
    const f = await waitingApprovalFixture();
    await f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody);
    await f.store.mutate('aabbccdd', f.attempt.id, (attempt) => {
      attempt.startedAt = Date.now() - 21 * 60 * 1000;
    });
    await f.runner.tick();
    await expect
      .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 8000 })
      .toBe('failed');
    const continuation =
      entry === 'retry'
        ? f.runner.action(f.actor, 'aabbccdd', 'retry', {
            attemptId: f.attempt.id,
            request_id: randomUUID(),
            reviewed: true,
          })
        : f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() });
    await expect(continuation).rejects.toThrow('TASK_EXTERNAL_REVIEW_REQUIRED');
    expect(f.counts().sends).toBe(1);
  },
  12000
);

test('a pending approval prevents another message from replacing its native invocation', async () => {
  const f = await waitingApprovalFixture();
  await expect(
    f.runner.accept(f.actor, 'aabbccdd', { content: 'Different work', request_id: randomUUID() })
  ).rejects.toThrow('TASK_BUSY');
  expect(f.counts().sends).toBe(1);
  expect(currentAttempt(await f.store.get('aabbccdd')).id).toBe(f.attempt.id);
});

test.each([
  ['cancel', 'cancelled'],
  ['revoke', 'failed'],
  ['stop', 'interrupted'],
] as const)(
  'pending approval is safely terminated by %s and releases its grant',
  async (action, expectedState) => {
    const f = await waitingApprovalFixture();
    if (action === 'cancel') await f.runner.action(f.actor, 'aabbccdd', 'cancel', { attemptId: f.attempt.id });
    else if (action === 'revoke') {
      f.revoke();
      await f.runner.tick();
    } else await f.runner.stop();
    await expect
      .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 8000 })
      .toBe(expectedState);
    expect(f.counts().stops).toBeGreaterThan(0);
    await expect.poll(() => f.grants.size, { timeout: 3000 }).toBe(0);
  },
  12000
);

test('authorization is checked again when an employee approves, before the next polling interval', async () => {
  const f = await waitingApprovalFixture();
  f.revoke();
  await expect(f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody)).rejects.toBeInstanceOf(Error);
  expect(f.confirmations()).toEqual([]);
  expect(f.counts().sends).toBe(1);
});

test('cancellation racing with approval leaves no executing task or grant behind', async () => {
  const f = await waitingApprovalFixture();
  await Promise.allSettled([
    f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody),
    f.runner.action(f.actor, 'aabbccdd', 'cancel', { attemptId: f.attempt.id }),
  ]);
  await expect
    .poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 8000 })
    .toBe('cancelled');
  expect(f.counts().sends).toBe(1);
  await expect.poll(() => f.grants.size, { timeout: 3000 }).toBe(0);
}, 12000);

test('a vanished native pending invocation interrupts approval instead of pretending a successful no-op resumed it', async () => {
  const f = await waitingApprovalFixture();
  f.forgetApproval();
  await expect(f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody)).rejects.toMatchObject({ status: 409 });
  expect(f.confirmations()).toEqual([]);
  expect(currentAttempt(await f.store.get('aabbccdd')).state).toBe('interrupted');
});

test('native restart cannot apply an old confirmation to a different active turn', async () => {
  const f = await waitingApprovalFixture();
  f.runtimeTurn('turn-after-restart');
  await expect(f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody)).rejects.toMatchObject({ status: 409 });
  expect(f.confirmations()).toEqual([]);
  expect(f.counts().sends).toBe(1);
});

test('startup recovery interrupts a persisted approval wait and never reconstructs its tool call', async () => {
  const f = await waitingApprovalFixture();
  const atCrash = await f.store.get('aabbccdd');
  await f.runner.stop();
  // Restore exactly what was durable at a crash, rather than manufacturing
  // private approval fields. A restarted native process has no pending future.
  await f.store.transaction((tasks) => {
    tasks.splice(0, tasks.length, atCrash);
  });
  f.forgetApproval();
  f.finish();
  const restarted = f.createRunner();
  await restarted.recover();
  await restarted.tick();
  expect(currentAttempt(await f.store.get('aabbccdd'))).toMatchObject({
    id: f.attempt.id,
    state: 'interrupted',
  });
  expect(f.grants.size).toBe(0);
  expect(f.counts().sends).toBe(1);
});

test('employee approval cannot extend the original execution deadline', async () => {
  const f = await waitingApprovalFixture();
  await f.store.mutate('aabbccdd', f.attempt.id, (attempt) => {
    attempt.startedAt = Date.now() - 21 * 60 * 1000;
  });
  await expect(f.runner.action(f.actor, 'aabbccdd', 'approve', f.approvalBody)).rejects.toBeInstanceOf(Error);
  expect(f.confirmations()).toEqual([]);
  await expect.poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 8000 }).toBe('failed');
}, 12000);

test('execution deadline cannot be bypassed by a continuous sequence of trusted tool approvals', async () => {
  const f = await fixture(true);
  await f.runner.accept(f.actor, 'aabbccdd', { content: 'Work', request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  const a = currentAttempt(await f.store.get('aabbccdd'));
  await f.store.mutate('aabbccdd', a.id, (x) => {
    x.startedAt = Date.now() - 21 * 60 * 1000;
  });
  f.approval();
  await f.runner.tick();
  await expect.poll(async () => currentAttempt(await f.store.get('aabbccdd')).state, { timeout: 6000 }).toBe('failed');
  expect(f.approvalData()).toBeUndefined();
  expect(currentAttempt(await f.store.get('aabbccdd')).reason).toBe('TASK_EXECUTION_TIME_LIMIT');
});
