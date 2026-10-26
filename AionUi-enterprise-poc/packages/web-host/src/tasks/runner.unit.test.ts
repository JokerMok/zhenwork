import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { prepareEnterpriseProfile } from "../enterprise-core.js";
import type { EnterpriseActor } from "../enterprise-gateway.js";
import { TaskRunner } from "./runner.js";
import { TaskStore } from "./store.js";
import { recordTool } from "./protocol.js";
import { currentAttempt } from "./types.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(trusted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "task-runner-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const actor = { serverId: "rc2", userId: "17" },
    { profile } = await prepareEnterpriseProfile(root, actor);
  execFileSync("python3", [
    "-c",
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(\"CREATE TABLE conversations(id,user_id,archived_at);INSERT INTO conversations VALUES('aabbccdd','system_default_user',NULL);\");c.commit()",
    path.join(profile, "aionui-backend.db"),
  ]);
  let sends = 0,
    stops = 0;
  let processing = false;
  let coreGate: Promise<void> = Promise.resolve();
  let releaseCore = () => {};
  let authorized = true;
  let pendingApproval = false;
  let approvalData: unknown;
  let nativeToolError = false;
  let proposalInput: Record<string, unknown> = { command: "printf harmless" };
  const server = http.createServer(async (req, res) => {
    let data = {};
    for await (const b of req) data = { ...data, ...JSON.parse(String(b)) };
    let body: unknown = {};
    if (req.url?.endsWith("/messages") && req.method === "POST") {
      sends++;
      processing = true;
      body = { msg_id: "msg1", turn_id: "turn1" };
    } else if (req.url?.endsWith("/confirmations")) {
      body = [
        {
          call_id: "office-call",
          action: "ExecCommand",
          command_type: "exec",
          description: "Execute: same prefix",
          options: [{ value: "proceed_once" }],
        },
      ];
    } else if (req.url?.endsWith("/office-call/confirm")) {
      approvalData = (data as { data?: unknown }).data;
      pendingApproval = false;
    } else if (req.url?.includes("/messages?")) {
      if (!req.url.includes("anchor_message_id=msg1")) {
        if (pendingApproval) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              data: {
                items: [
                  {
                    type: "tool_call",
                    content: {
                      call_id: "aionrs-office-call",
                      name: "ExecCommand",
                      args: proposalInput,
                    },
                  },
                ],
              },
            }),
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
            id: "msg1",
            msg_id: "msg1",
            position: "right",
            type: "text",
            content: { content: "Work" },
          },
          ...(nativeToolError
            ? [
                {
                  type: "tool_call",
                  status: "error",
                  content: { name: "read_document", args: { path: "source.txt" } },
                },
              ]
            : []),
          {
            position: "left",
            type: "text",
            status: "finish",
            backend_turn_id: "turn1",
            content: { content: "Actual answer" },
          },
        ],
      };
    } else if (req.url?.endsWith("/cancel")) {
      stops++;
      processing = false;
      pendingApproval = false;
    } else
      body = {
        runtime: {
          state: processing ? "running" : "idle",
          turn_id: "turn1",
          is_processing: processing,
          pending_confirmations: pendingApproval ? 1 : 0,
        },
      };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: body }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const core = {
    port: (server.address() as { port: number }).port,
    localToken: "test",
    stop: async () => {},
    workspaceRoot: path.join(profile, "workspace"),
  };
  const grants = new Set<string>();
  const runner = new TaskRunner({
    root,
    origin: "https://employee.test",
    queueLimit: 2,
    core: async () => {
      await coreGate;
      return core;
    },
    peek: async () => core,
    cancelPreparation: async () => {
      releaseCore();
    },
    issue: async (_a, j) => {
      grants.add(j);
    },
    check: async (_a, j) => authorized && grants.has(j),
    revoke: async (_a, j) => {
      grants.delete(j);
    },
    bind: () => {},
    actors: async () => [actor],
    trustedConfirmation: async () => trusted,
  });
  cleanups.push(() => runner.stop());
  const store = await TaskStore.create(root, actor);
  return {
    root,
    actor,
    store,
    runner,
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
    approval: () => {
      pendingApproval = true;
    },
    approvalData: () => approvalData,
    nativeToolError: () => {
      nativeToolError = true;
    },
    proposal: (input: Record<string, unknown>) => {
      proposalInput = input;
    },
    counts: () => ({ sends, stops }),
  };
}
test("accepted execution survives the absence of any browser and duplicates do not dispatch twice", async () => {
  const f = await fixture(),
    request_id = randomUUID();
  await f.runner.accept(f.actor, "aabbccdd", { content: "A normal question", request_id });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  await f.runner.accept(f.actor, "aabbccdd", { content: "A normal question", request_id });
  f.finish();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 6000 })
    .toBe("completed");
  expect(f.counts().sends).toBe(1);
});
test("a saved waiting checkpoint is safely cancelled before releasing its grant and never auto approved", async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, "aabbccdd", { content: "Need data", request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  const a = currentAttempt(await f.store.get("aabbccdd"));
  await f.store.mutate("aabbccdd", a.id, (x) => {
    x.stopReason = "waiting_input";
    x.question = "Upload the missing quote";
  });
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 8000 })
    .toBe("waiting_input");
  await expect.poll(() => f.grants.size, { timeout: 3000 }).toBe(0);
  expect(f.counts().stops).toBeGreaterThan(0);
  expect(currentAttempt(await f.store.get("aabbccdd")).question).toBe("Upload the missing quote");
});
test("runtime idle without required files is not treated as task completion", async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, "aabbccdd", {
    content: "Generate Word and Excel",
    request_id: randomUUID(),
  });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.finish();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 6000 })
    .toBe("interrupted");
  expect(currentAttempt(await f.store.get("aabbccdd")).reason).toBe("REQUIRED_ARTIFACTS_MISSING");
});
test("service stop persists interrupted state; recovery never blindly replays a sent attempt", async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, "aabbccdd", { content: "Work", request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  await f.runner.stop();
  expect(currentAttempt(await f.store.get("aabbccdd")).state).toBe("interrupted");
  expect(f.counts().sends).toBe(1);
});

test("cancelled durable queue entry never sends to the native executor", async () => {
  const f = await fixture();
  f.blockCore();
  await f.runner.accept(f.actor, "aabbccdd", { content: "Queued work", request_id: randomUUID() });
  const a = currentAttempt(await f.store.get("aabbccdd"));
  await f.runner.action(f.actor, "aabbccdd", "cancel", { attemptId: a.id });
  await f.runner.tick();
  expect(currentAttempt(await f.store.get("aabbccdd")).state).toBe("cancelled");
  expect(f.counts().sends).toBe(0);
  await expect.poll(() => f.grants.size, { timeout: 3000 }).toBe(0);
});
test("revocation cancels real executor state instead of retaining a valid browser session as authority", async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, "aabbccdd", { content: "Work", request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.revoke();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 8000 })
    .toBe("failed");
  expect(f.counts().stops).toBeGreaterThan(0);
  expect(currentAttempt(await f.store.get("aabbccdd")).reason).toBe("TASK_AUTHORIZATION_REVOKED");
});

test("trusted Office approval uses the native object-valued confirmation contract", async () => {
  const f = await fixture(true);
  await f.runner.accept(f.actor, "aabbccdd", { content: "Work", request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.approval();
  await f.runner.tick();
  await expect.poll(() => f.approvalData(), { timeout: 5000 }).toEqual({ value: "proceed_once" });
});
test("completion reads the accepted row anchor using native cursors, never a raw ID as after", async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, "aabbccdd", { content: "Hello", request_id: randomUUID() });
  await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
  f.finish();
  await f.runner.tick();
  await expect
    .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 6000 })
    .toBe("completed");
});

test("a retransmitted continuation returns the accepted attempt and rejects altered input", async () => {
  const f = await fixture();
  await f.runner.accept(f.actor, "aabbccdd", { content: "First", request_id: randomUUID() });
  const old = currentAttempt(await f.store.get("aabbccdd"));
  await f.store.mutate("aabbccdd", old.id, (a) => {
    a.state = "waiting_input";
    a.question = "Which period?";
  });
  f.blockCore();
  const body = { attemptId: old.id, request_id: randomUUID(), content: "October" };
  await f.runner.action(f.actor, "aabbccdd", "continue", body);
  const id = currentAttempt(await f.store.get("aabbccdd")).id;
  await f.runner.action(f.actor, "aabbccdd", "continue", body);
  expect(currentAttempt(await f.store.get("aabbccdd")).id).toBe(id);
  await expect(
    f.runner.action(f.actor, "aabbccdd", "continue", { ...body, content: "Changed" }),
  ).rejects.toThrow("TASK_ATTEMPT_CHANGED");
  f.releaseCore();
});

test("only a verified later Host receipt resolves a persisted tool error; untracked errors remain failures", async () => {
  for (const recovered of [true, false]) {
    const f = await fixture();
    await f.runner.accept(f.actor, "aabbccdd", { content: "Hello", request_id: randomUUID() });
    await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
    f.nativeToolError();
    if (recovered) {
      await recordTool(
        f.root,
        f.actor,
        "aabbccdd",
        "read_document",
        { path: "source.txt" },
        undefined,
        "READ_FAILED",
      );
      await recordTool(
        f.root,
        f.actor,
        "aabbccdd",
        "read_document",
        { path: "source.txt" },
        { text: "Actual recovered source" },
      );
    }
    f.finish();
    await f.runner.tick();
    await expect
      .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 6000 })
      .toBe(recovered ? "completed" : "failed");
  }
});

test("explicit approval is bound to full tool input, not a matching truncated description", async () => {
  for (const changed of [false, true]) {
    const f = await fixture();
    await f.runner.accept(f.actor, "aabbccdd", { content: "Work", request_id: randomUUID() });
    await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(1);
    f.approval();
    await f.runner.tick();
    await expect
      .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 6000 })
      .toBe("waiting_confirmation");
    const a = currentAttempt(await f.store.get("aabbccdd"));
    expect(a.confirmation?.proposal).toContain("printf harmless");
    await f.runner.action(f.actor, "aabbccdd", "approve", {
      attemptId: a.id,
      request_id: randomUUID(),
    });
    await expect.poll(() => f.counts().sends, { timeout: 5000 }).toBe(2);
    if (changed) f.proposal({ command: "a different action with the same description" });
    f.approval();
    await f.runner.tick();
    if (changed) {
      await expect
        .poll(async () => currentAttempt(await f.store.get("aabbccdd")).state, { timeout: 6000 })
        .toBe("waiting_confirmation");
      expect(f.approvalData()).toBeUndefined();
    } else
      await expect
        .poll(() => f.approvalData(), { timeout: 5000 })
        .toEqual({ value: "proceed_once" });
  }
}, 20000);
