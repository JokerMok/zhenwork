import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EnterpriseActor, EnterpriseCore } from "../enterprise-gateway.js";
import { enterpriseCoreBase } from "../enterprise-core-address.js";
import { OfficeStore } from "../office/office-store.js";
import { inspectArtifact } from "../office/artifact.js";
import { readProfile } from "../read-model/profile.js";
import { TaskStore } from "./store.js";
import {
  activeStates,
  currentAttempt,
  digest,
  publicTask,
  TaskError,
  type TaskAttempt,
  type TaskRecord,
} from "./types.js";

type Dependencies = {
  root: string;
  origin: string;
  queueLimit: number;
  core(actor: EnterpriseActor): Promise<EnterpriseCore>;
  prepare?(actor: EnterpriseActor): Promise<{ state: string } | void>;
  cancelPreparation(actor: EnterpriseActor): Promise<void>;
  peek(actor: EnterpriseActor): Promise<EnterpriseCore | undefined>;
  issue(actor: EnterpriseActor, job: string): Promise<void>;
  check(actor: EnterpriseActor, job: string): Promise<boolean>;
  revoke(actor: EnterpriseActor, job: string): Promise<void>;
  bind(actor: EnterpriseActor, conversation: string, job?: string, expectedJobId?: string): void;
  actors(): Promise<EnterpriseActor[]>;
  trustedConfirmation(
    actor: EnterpriseActor,
    confirmation: Record<string, unknown>,
  ): Promise<boolean>;
};
type Runtime = {
  state: string;
  turn_id?: string;
  is_processing: boolean;
  pending_confirmations: number;
  can_send_message?: boolean;
};
const actorKey = (actor: EnterpriseActor): string => JSON.stringify(actor);
const safeError = (e: unknown): string =>
  e instanceof TaskError ? e.message : "TASK_EXECUTION_UNAVAILABLE";

/** Dispatches durable chat attempts through the existing Gateway Core capacity queue, never a second Core pool. */
export class TaskRunner {
  private readonly actors = new Map<string, EnterpriseActor>();
  private readonly polling = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly native = new Map<string, EnterpriseCore>();
  private stopping = false;
  private ticking = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly tickWaiters: Array<() => void> = [];
  private stopPromise?: Promise<void>;
  private track(work: Promise<unknown>): void {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work)).catch(() => {});
  }
  private readonly timer: ReturnType<typeof setInterval>;
  private admission: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: Dependencies) {
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref();
  }
  private readonly registering = new Map<string, Promise<void>>();
  private lastDiscovery = 0;
  private async register(actor: EnterpriseActor): Promise<void> {
    const k = actorKey(actor);
    const pending = this.registering.get(k);
    if (pending) return pending;
    if (this.actors.has(k)) return;
    const work = (async () => {
      const store = await TaskStore.create(this.deps.root, actor);
      await store.transaction((tasks) => {
        for (const task of tasks) {
          const a = currentAttempt(task);
          if (a.state === "queued" && a.phase === "authorizing") {
            a.state = "failed";
            a.phase = "settled";
            a.reason = "BACKGROUND_AUTHORIZATION_UNAVAILABLE";
          }
          if (a.state === "running" || a.state === "cancelling") {
            a.state = "interrupted";
            a.phase = "settled";
            a.reason = "SERVICE_RESTART_REVIEW_BEFORE_RESUME";
            a.updatedAt = task.updatedAt = Date.now();
          }
        }
      });
      this.actors.set(k, actor);
    })().finally(() => this.registering.delete(k));
    this.registering.set(k, work);
    return work;
  }
  async recover(): Promise<void> {
    this.lastDiscovery = Date.now();
    for (const actor of await this.deps.actors()) {
      try {
        await this.register(actor);
        const tasks = await (await TaskStore.create(this.deps.root, actor)).list();
        for (const task of tasks)
          for (const a of task.attempts)
            if (!activeStates.has(a.state)) await this.deps.revoke(actor, a.jobId).catch(() => {});
      } catch {
        console.warn("[Enterprise tasks] actor recovery unavailable");
      }
    }
  }
  async list(actor: EnterpriseActor): Promise<unknown> {
    await this.register(actor);
    const store = await TaskStore.create(this.deps.root, actor);
    return {
      items: (await store.list())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((task) => publicTask(task, true)),
    };
  }
  async detail(actor: EnterpriseActor, id: string): Promise<unknown> {
    await this.register(actor);
    return publicTask(await (await TaskStore.create(this.deps.root, actor)).get(id));
  }
  async accept(
    actor: EnterpriseActor,
    id: string,
    payload: Record<string, unknown>,
    retry = false,
    resumeContext?: TaskAttempt["resumeContext"],
  ): Promise<{ task: unknown; receipt: unknown }> {
    const run = this.admission.then(async () => {
      if (this.stopping) throw new TaskError(503, "TASK_SERVICE_UNAVAILABLE");
      const exists = (await readProfile(this.deps.root, actor, "conversation", id)) as {
        exists?: boolean;
      };
      if (!exists.exists) throw new TaskError(404, "TASK_CONVERSATION_NOT_FOUND");
      const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
      const normalized = {
        content: payload.content,
        files: payload.files || [],
        sessions: payload.sessions || [],
        inject_skills: payload.inject_skills || [],
        contextKey: resumeContext ? digest(resumeContext) : undefined,
      };
      if (JSON.stringify(normalized).length > 128000)
        throw new TaskError(413, "TASK_INPUT_TOO_LARGE");
      await this.register(actor);
      const store = await TaskStore.create(this.deps.root, actor);
      const all = await Promise.all(
        [...this.actors.values()].map(
          async (a) =>
            (await (await TaskStore.create(this.deps.root, a)).list()).filter(
              (t) => currentAttempt(t).state === "queued",
            ).length,
        ),
      );
      // Duplicate acknowledgements still work when the admission budget is full.
      const prior = (await store.list()).find((t) => t.id === id);
      const duplicate =
        prior?.attempts.some((a) => a.requestId === requestId) ||
        (prior &&
          activeStates.has(currentAttempt(prior).state) &&
          currentAttempt(prior).payloadHash === digest(normalized));
      if (!duplicate && all.reduce((a, b) => a + b, 0) >= this.deps.queueLimit)
        throw new TaskError(429, "TASK_QUEUE_FULL");
      const accepted = await store.accept(id, requestId, normalized, retry, resumeContext?.replaceRequirements === true),
        attempt = currentAttempt(accepted.task);
      if (!accepted.duplicate) {
        try {
          await this.deps.issue(actor, attempt.jobId);
          const scope = await (await OfficeStore.create(this.deps.root, actor)).knowledgeScope(id);
          await store.mutate(id, attempt.id, (a) => {
            a.scope = scope;
            a.resumeContext = resumeContext;
            if (resumeContext?.approvalFingerprint)
              a.approval = { fingerprint: resumeContext.approvalFingerprint, used: false };
            if (a.state === "queued") a.phase = "queued";
          });
        } catch (e) {
          await store.mutate(id, attempt.id, (a) => {
            a.state = "failed";
            a.phase = "settled";
            a.reason = "BACKGROUND_AUTHORIZATION_UNAVAILABLE";
          });
          throw new TaskError(503, "BACKGROUND_AUTHORIZATION_UNAVAILABLE");
        }
      }
      void this.tick();
      const latest = await store.get(id),
        a = currentAttempt(latest);
      if (a.state === "cancelled") await this.release(actor, id, a);
      return {
        task: publicTask(latest),
        receipt: {
          msg_id: a.messageId || "",
          // Accepted work is already cancellable before the native turn exists.
          // The gateway accepts either this attempt ID or its later native ID.
          turn_id: a.turnId || a.id,
          execution_id: a.id,
          task_id: id,
          runtime: {
            state:
              a.state === "queued"
                ? "starting"
                : a.state === "running"
                  ? "running"
                  : a.state === "cancelling"
                    ? "cancelling"
                    : "idle",
            turn_id: a.turnId || null,
            is_processing: activeStates.has(a.state),
            pending_confirmations: 0,
            can_send_message: false,
            has_task: true,
            supports_midturn_delivery: false,
          },
        },
      };
    });
    this.admission = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  async action(
    actor: EnterpriseActor,
    id: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const store = await TaskStore.create(this.deps.root, actor),
      task = await store.get(id),
      a = currentAttempt(task);
    if (body.attemptId !== a.id) {
      if (
        a.requestId === body.request_id &&
        a.resumeContext?.requestHash === digest({ action, body })
      )
        return publicTask(task);
      throw new TaskError(409, "TASK_ATTEMPT_CHANGED");
    }
    if (action === "cancel") {
      await store.mutate(id, a.id, (current) => {
        if (current.state === "queued") {
          current.state = "cancelled";
          current.phase = "settled";
          current.reason = "USER_CANCELLED";
        } else if (current.state === "running") {
          current.state = "cancelling";
          current.reason = "USER_CANCEL_REQUESTED";
        } else if (
          ["waiting_input", "waiting_confirmation", "interrupted"].includes(current.state)
        ) {
          current.state = "cancelled";
          current.phase = "settled";
        }
      });
      if (a.state === "queued") await this.deps.cancelPreparation(actor);
      if (a.state === "queued" || !activeStates.has(a.state)) await this.release(actor, id, a);
      void this.tick();
      return this.detail(actor, id);
    }
    if (!["retry", "continue", "approve", "decline"].includes(action) || activeStates.has(a.state))
      throw new TaskError(409, "TASK_ACTION_NOT_AVAILABLE");
    if (a.state === "interrupted" && body.reviewed !== true)
      throw new TaskError(409, "TASK_RECOVERY_REVIEW_REQUIRED");
    if (
      a.state === "interrupted" &&
      a.approval?.used &&
      !["read", "info", "search"].includes(a.resumeContext?.approvedKind || "") &&
      !["applied", "not_applied"].includes(String(body.externalOutcome))
    )
      throw new TaskError(409, "TASK_EXTERNAL_REVIEW_REQUIRED");
    if (action === "retry" && !["partial", "failed", "interrupted"].includes(a.state))
      throw new TaskError(409, "TASK_ACTION_NOT_AVAILABLE");
    let input = typeof body.content === "string" ? body.content.trim() : "";
    if (action === "approve" || action === "decline") {
      if (a.state !== "waiting_confirmation") throw new TaskError(409, "TASK_ACTION_NOT_AVAILABLE");
      input =
        input ||
        (/^zh/i.test(String(body.language))
          ? action === "approve"
            ? "仅批准已保存的本次操作。"
            : "不批准已保存的操作。"
          : action === "approve"
            ? "Approve the saved action once."
            : "Decline the saved action.");
    }
    if (action === "approve" && (!a.confirmation || typeof a.confirmation.fingerprint !== "string"))
      throw new TaskError(409, "TASK_APPROVAL_DETAILS_UNAVAILABLE");
    if (!input && action !== "retry") throw new TaskError(400, "TASK_INPUT_REQUIRED");
    const files = body.files || [];
    return this.accept(
      actor,
      id,
      { content: input || String(a.payload.content), files, request_id: body.request_id },
      action === "retry",
      {
        action,
        requestHash: digest({ action, body }),
        replaceRequirements: body.replaceRequirements === true,
        priorState: a.state,
        retryOnly: action === "retry",
        question: a.question || a.reason,
        protectedFiles: a.artifacts.filter((f) => f.valid),
        externalOutcome:
          typeof body.externalOutcome === "string" ? body.externalOutcome : undefined,
        ...(action === "approve" && a.confirmation
          ? {
              approvalFingerprint: String(a.confirmation.fingerprint),
              approvedKind: String(a.confirmation.command_type || "unknown"),
            }
          : {}),
      },
    );
  }
  private async call<T>(core: EnterpriseCore, route: string, data?: unknown): Promise<T> {
    const r = await fetch(enterpriseCoreBase(core) + route, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "x-aion-enterprise-local-token": core.localToken,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    if (text.length > 2 * 1024 * 1024) throw new TaskError(502, "TASK_CORE_RESPONSE_LIMIT");
    const parsed = JSON.parse(text) as { success?: boolean; data: T; error?: unknown };
    if (!r.ok || parsed.success !== true) {
      console.warn(
        "[Enterprise tasks] native request rejected",
        JSON.stringify({ route: route.split("?")[0], status: r.status, success: parsed.success }),
      );
      throw new TaskError(r.status === 409 ? 409 : 502, "TASK_CORE_REQUEST_FAILED");
    }
    return parsed.data;
  }
  private async release(actor: EnterpriseActor, id: string, a: TaskAttempt): Promise<void> {
    this.deps.bind(actor, id, undefined, a.jobId);
    this.native.delete(a.id);
    await this.deps.revoke(actor, a.jobId).catch(() => {});
  }
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastDiscovery > 60000)
        await this.recover().catch(() => console.warn("[Enterprise tasks] recovery deferred"));
      for (const actor of this.actors.values()) {
        if (this.stopping) break;
        try {
          const store = await TaskStore.create(this.deps.root, actor),
            tasks = await store.list();
          const live = tasks.find((t) =>
            ["running", "cancelling"].includes(currentAttempt(t).state),
          );
          if (live) {
            const a = currentAttempt(live);
            if (!this.polling.has(a.id) && !this.starting.has(actorKey(actor))) {
              this.polling.add(a.id);
              this.track(
                this.observe(actor, live)
                  .catch(async (e) => {
                    await store.mutate(live.id, a.id, (x) => {
                      if (activeStates.has(x.state)) {
                        x.state = "interrupted";
                        x.phase = "settled";
                        x.reason = safeError(e);
                      }
                    });
                    await this.release(actor, live.id, a);
                  })
                  .catch(() =>
                    console.warn("[Enterprise tasks] interrupted state could not be recorded"),
                  )
                  .finally(() => this.polling.delete(a.id)),
              );
            }
            continue;
          }
          if (this.starting.has(actorKey(actor))) continue;
          const next = tasks
            .filter(
              (t) =>
                currentAttempt(t).state === "queued" && currentAttempt(t).phase !== "authorizing",
            )
            .sort((a, b) => currentAttempt(a).createdAt - currentAttempt(b).createdAt)[0];
          if (next) {
            this.starting.add(actorKey(actor));
            this.track(
              this.dispatch(actor, next)
                .catch(() =>
                  console.warn("[Enterprise tasks] durable dispatch could not be recorded"),
                )
                .finally(() => this.starting.delete(actorKey(actor))),
            );
          }
        } catch {
          console.warn("[Enterprise tasks] employee queue unavailable");
        }
      }
    } catch {
      console.warn("[Enterprise tasks] dispatch deferred");
    } finally {
      this.ticking = false;
      for (const resolve of this.tickWaiters.splice(0)) resolve();
    }
  }
  private async dispatch(actor: EnterpriseActor, task: TaskRecord): Promise<void> {
    const store = await TaskStore.create(this.deps.root, actor),
      a = currentAttempt(task);
    try {
      if (!(await this.deps.check(actor, a.jobId)))
        throw new TaskError(403, "TASK_AUTHORIZATION_REVOKED");
      if (Date.now() - a.createdAt > 30 * 60 * 1000)
        throw new TaskError(409, "TASK_QUEUE_WAIT_EXPIRED");
      await store.mutate(task.id, a.id, (x) => {
        if (x.state === "queued") {
          x.phase = "preparing";
          x.reason = "CORE_CAPACITY_WAIT";
        }
      });
      const core = await this.deps.core(actor);
      if (this.stopping || currentAttempt(await store.get(task.id)).state !== "queued") return;
      if (!(await this.deps.check(actor, a.jobId)))
        throw new TaskError(403, "TASK_AUTHORIZATION_REVOKED");
      const preparation = await this.deps.prepare?.(actor);
      if (preparation && preparation.state !== "ready") {
        await store.mutate(task.id, a.id, (x) => {
          if (x.state === "queued") {
            x.phase = "queued";
            x.reason = "RESOURCE_UPDATE_WAIT";
          }
        });
        return;
      }
      const office = await OfficeStore.create(this.deps.root, actor);
      // New grants and current Core configuration are resolved at dispatch; selected historical scope stays explicit.
      // Scope remains on the immutable attempt; the picker may already contain a later round's selection.
      const context = await this.call<{ assistant?: { id?: string; name?: string } }>(
        core,
        `/api/conversations/${task.id}`,
      );
      await store.mutate(task.id, a.id, (x) => {
        if (context.assistant?.id && context.assistant.name)
          x.assistant = { id: context.assistant.id, name: context.assistant.name };
      });
      this.deps.bind(actor, task.id, a.jobId);
      this.native.set(a.id, core);
      let dispatched = false;
      await store.mutate(task.id, a.id, (x) => {
        if (x.state === "queued") {
          dispatched = true;
          x.state = "running";
          x.phase = "dispatching";
          x.startedAt = Date.now();
          x.reason = undefined;
        }
      });
      if (!dispatched || this.stopping) {
        await this.release(actor, task.id, a);
        return;
      }
      const receipt = await this.call<{ msg_id: string; turn_id: string }>(
        core,
        `/api/conversations/${task.id}/messages`,
        {
          ...a.payload,
          content: String(a.payload.content),
          files: await this.resolveFiles(core, a.payload.files),
        },
      );
      if (!receipt.turn_id || !receipt.msg_id)
        throw new TaskError(502, "TASK_ACCEPTANCE_UNCERTAIN");
      await store.mutate(task.id, a.id, (x) => {
        x.turnId = receipt.turn_id;
        x.messageId = receipt.msg_id;
        x.phase = "executing";
      });
    } catch (e) {
      if (this.stopping) return; // Unsent durable work remains queued for the next supervisor.
      const latest = currentAttempt(await store.get(task.id));
      if (latest.state === "cancelled") {
        await this.release(actor, task.id, latest);
        return;
      }
      if (
        latest.state === "queued" &&
        e instanceof Error &&
        (/capacity|queued|start wait|CoreCapacity/i.test(e.message) ||
          e.constructor.name === "CoreCapacityError")
      ) {
        // The existing Core queue has a shorter wait budget than durable task admission. Retry that acquisition, never the send.
        await store.mutate(task.id, a.id, (x) => {
          x.phase = "queued";
          x.reason = "CORE_CAPACITY_WAIT";
        });
        return;
      }
      await store.mutate(task.id, a.id, (x) => {
        x.state = x.phase === "dispatching" ? "interrupted" : "failed";
        x.phase = "settled";
        x.reason = latest.phase === "dispatching" ? "TASK_ACCEPTANCE_UNCERTAIN" : safeError(e);
      });
      await this.release(actor, task.id, latest);
    }
  }
  private async resolveFiles(core: EnterpriseCore, input: unknown): Promise<unknown[]> {
    if (!Array.isArray(input) || input.length > 30)
      throw new TaskError(400, "TASK_ATTACHMENTS_INVALID");
    return input.map((file: unknown) => {
      if (!file || typeof file !== "object") throw new TaskError(400, "TASK_ATTACHMENTS_INVALID");
      const f = file as Record<string, unknown>;
      if (f.kind === "local" && typeof f.path === "string" && !path.isAbsolute(f.path)) {
        if (!core.workspaceRoot || f.path.split(/[\\/]/).includes(".."))
          throw new TaskError(403, "TASK_ATTACHMENT_DENIED");
        return { kind: "local", path: path.join(core.workspaceRoot, f.path) };
      }
      return file;
    });
  }
  private async observe(actor: EnterpriseActor, task: TaskRecord): Promise<void> {
    if (this.stopping) return;
    const store = await TaskStore.create(this.deps.root, actor);
    let a = currentAttempt(await store.get(task.id));
    const core = this.native.get(a.id) || (await this.deps.peek(actor));
    if (!core) throw new TaskError(409, "TASK_RUNTIME_INTERRUPTED");
    const authorized = await this.deps.check(actor, a.jobId);
    if (!authorized)
      await store.mutate(task.id, a.id, (x) => {
        x.state = "cancelling";
        x.reason = "TASK_AUTHORIZATION_REVOKED";
      });
    a = currentAttempt(await store.get(task.id));
    if (!a.turnId) throw new TaskError(409, "TASK_ACCEPTANCE_UNCERTAIN");
    const conv = await this.call<{ runtime: Runtime }>(core, `/api/conversations/${task.id}`),
      r = conv.runtime;
    if (!r) throw new TaskError(502, "TASK_RUNTIME_UNAVAILABLE");
    if (r.turn_id && r.turn_id !== a.turnId) throw new TaskError(409, "TASK_RUNTIME_TURN_CHANGED");
    if (a.state === "cancelling") {
      if (r.is_processing || r.pending_confirmations || r.state === "cancelling") {
        await this.call(core, `/api/conversations/${task.id}/cancel`, { turn_id: a.turnId });
        return;
      }
      await store.mutate(task.id, a.id, (x) => {
        x.state = ["TASK_EXECUTION_TIME_LIMIT", "TASK_AUTHORIZATION_REVOKED"].includes(
          x.reason || "",
        )
          ? x.artifacts.some((f) => f.valid)
            ? "partial"
            : "failed"
          : "cancelled";
        x.phase = "settled";
      });
      await this.release(actor, task.id, a);
      return;
    }
    if (a.stopReason && (r.is_processing || r.pending_confirmations || r.state === "running")) {
      await this.call(core, `/api/conversations/${task.id}/cancel`, { turn_id: a.turnId });
      return;
    }
    if (
      Date.now() - (a.startedAt || a.createdAt) > 20 * 60 * 1000 &&
      (r.is_processing || r.pending_confirmations > 0 || r.state === "running")
    ) {
      await store.mutate(task.id, a.id, (x) => {
        x.state = "cancelling";
        x.reason = "TASK_EXECUTION_TIME_LIMIT";
      });
      return;
    }
    if (r.pending_confirmations > 0) {
      const pending = await this.call<Array<Record<string, unknown>>>(
        core,
        `/api/conversations/${task.id}/confirmations`,
      );
      for (const c of pending) {
        const trusted = !c.questions && (await this.deps.trustedConfirmation(actor, c));
        let fingerprint: string | undefined, proposal: string | undefined;
        if (!trusted && !c.questions) {
          const page = await this.call<{
            items: Array<{ type?: string; content?: Record<string, unknown> }>;
          }>(core, `/api/conversations/${task.id}/messages?limit=100`);
          const call = page.items
            .map((m) => (m.type === "tool_call" ? m.content : undefined))
            .find(
              (v) =>
                v &&
                String(v.call_id).replace(/^aionrs-/, "") ===
                  String(c.call_id).replace(/^aionrs-/, ""),
            );
          const input = call?.args || call?.input;
          if (
            call?.name === c.action &&
            input &&
            typeof input === "object" &&
            JSON.stringify(input).length <= 16000
          ) {
            let redacted = false;
            proposal = JSON.stringify(
              input,
              (k, v) => {
                if (
                  /authorization|password|api[_-]?key|access[_-]?token|cookie|secret/i.test(k) ||
                  (typeof v === "string" && /Bearer\s+[A-Za-z0-9_-]{16}|sk-[A-Za-z0-9]{16}/.test(v))
                ) {
                  redacted = true;
                  return "[private]";
                }
                return v;
              },
              2,
            );
            if (!redacted) fingerprint = digest({ action: c.action, input });
          }
        }
        const approved =
          !!fingerprint &&
          !!a.approval &&
          !a.approval.used &&
          a.approval.fingerprint === fingerprint;
        if (!c.questions && (approved || trusted)) {
          if (approved)
            await store.mutate(task.id, a.id, (x) => {
              if (x.approval) x.approval.used = true;
            });
          await this.call(
            core,
            `/api/conversations/${task.id}/confirmations/${encodeURIComponent(String(c.call_id))}/confirm`,
            { msg_id: a.messageId, data: { value: "proceed_once" }, always_allow: false },
          );
        } else {
          await store.mutate(task.id, a.id, (x) => {
            x.stopReason = c.questions ? "waiting_input" : "waiting_confirmation";
            x.question = String(
              c.questions
                ? JSON.stringify(c.questions)
                : c.description || c.title || "Confirmation required",
            ).slice(0, 2000);
            x.confirmation = { ...c, fingerprint, proposal };
          });
          // Persist the unapproved request before cancelling its in-memory wait. Resume is an explicit new employee decision, never auto-approval.
          await this.call(core, `/api/conversations/${task.id}/cancel`, { turn_id: a.turnId });
          return;
        }
      }
      return;
    }
    if (
      r.is_processing ||
      ["running", "starting", "cancelling", "restarting", "waiting_confirmation"].includes(r.state)
    )
      return;
    a = currentAttempt(await store.get(task.id));
    if (a.stopReason) {
      let settled = false;
      await store.mutate(task.id, a.id, (x) => {
        if (x.state === "running") {
          x.state = x.stopReason!;
          x.phase = "settled";
          settled = true;
        }
      });
      if (settled) await this.release(actor, task.id, a);
      return;
    }
    type ObservedMessage = {
      id?: string;
      msg_id?: string;
      position?: string;
      type?: string;
      status?: string;
      content?: unknown;
    };
    type Page = { items: ObservedMessage[]; newest_cursor?: string; has_more_after?: boolean };
    let page = await this.call<Page>(
      core,
      `/api/conversations/${task.id}/messages?limit=200&anchor_message_id=${encodeURIComponent(a.messageId!)}`,
    );
    const anchor = page.items.findIndex((m) => m.id === a.messageId || m.msg_id === a.messageId);
    if (anchor < 0) throw new TaskError(409, "TASK_MESSAGE_ANCHOR_UNAVAILABLE");
    const current = page.items.slice(anchor + 1);
    for (let n = 0; page.has_more_after; n++) {
      if (n >= 5 || !page.newest_cursor) throw new TaskError(409, "TASK_MESSAGE_WINDOW_LIMIT");
      page = await this.call<Page>(
        core,
        `/api/conversations/${task.id}/messages?limit=200&after=${encodeURIComponent(page.newest_cursor)}`,
      );
      current.push(...page.items);
    }
    // `after` is an opaque cursor, never a message ID. Use the accepted row anchor,
    // then the server's cursors; backend and Host turn IDs intentionally differ.
    const answer = current.some((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content as { content?: unknown } | undefined)?.content;
      return (
        m.position === "left" &&
        m.type === "text" &&
        m.status !== "error" &&
        typeof text === "string" &&
        text.trim().length > 0
      );
    });
    const errors = current.some((m) => {
      if (m.type === "error") return true;
      if (m.status !== "error") return false;
      // A corrected tool error stays in the transcript for audit. Only a real
      // later Host receipt for this tool/target can resolve it; untracked native
      // tools and model/transport errors remain failures.
      if (m.type !== "tool_call" || !m.content || typeof m.content !== "object") return true;
      const c = m.content as {
        name?: string;
        args?: Record<string, unknown>;
        input?: Record<string, unknown>;
      };
      const args = c.args || c.input || {};
      const target = String(
        args.path ||
          args.basePath ||
          args.baseName ||
          args.basename ||
          args.baseId ||
          args.query ||
          "",
      );
      return !a.steps.some(
        (s) =>
          s.tool === c.name &&
          s.target === target &&
          s.state === "failed" &&
          s.summary === "Recovered by a later successful call",
      );
    });
    const office = await OfficeStore.create(this.deps.root, actor);
    for (const f of a.artifacts) {
      try {
        if (!core.workspaceRoot) throw new Error("workspace");
        const bytes = await office.download(core.workspaceRoot, f.path, f.versionId);
        const hash = digestBytes(bytes);
        const ext = path.extname(f.path).toLowerCase();
        if ([".docx", ".xlsx", ".pptx", ".pdf"].includes(ext)) {
          const validation = await inspectArtifact(f.path, bytes);
          if (validation.valid !== true) throw new Error("invalid");
        } else if ([".json", ".txt", ".md", ".csv"].includes(ext)) {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0") || !text.trim()) throw new Error("invalid");
          if (ext === ".json") JSON.parse(text);
        } else if (!f.valid) throw new Error("unverified format");
        if (f.sha256 && f.sha256 !== hash) throw new Error("changed");
        f.valid = true;
        f.sha256 = hash;
        if(!f.versionId) {
          const receipt = await office.captureCurrent(core.workspaceRoot, f.path, hash);
          f.versionId = receipt.versionId;
          f.version = receipt.version;
        }
        if(f.versionId && !f.version) f.version = (await office.fileReceipt(f.path,f.versionId))?.version;
        f.downloadUrl = `/enterprise/files/download?path=${encodeURIComponent(f.path)}${f.versionId ? "&version=" + f.versionId : ""}`;
        f.previewUrl = `/#/workspace?section=files&previewPath=${encodeURIComponent(f.path)}${f.versionId ? "&fileVersion=" + f.versionId : ""}`;
      } catch {
        f.valid = false;
      }
    }
    const missing = a.requiredFormats.filter(
      (ext) =>
        !a.artifacts.some((f) => f.valid && path.extname(f.path).toLowerCase() === "." + ext),
    );
    const failedSteps = a.steps.filter(
      (s) => s.state === "failed" && s.summary !== "Recovered by a later successful call",
    );
    const valid = a.artifacts.filter((f) => f.valid).length;
    const metadataTools = new Set([
      "task_checkpoint",
      "office_context",
      "read_preferences",
      "ToolSearch",
    ]);
    const toolEvidence =
      a.steps.some((s) => s.state === "completed" && !metadataTools.has(s.tool)) ||
      current.some((m) => {
        if (m.type !== "tool_call" || !m.content || typeof m.content !== "object") return false;
        const content = m.content as { status?: string; name?: string };
        return (
          content.status === "completed" &&
          typeof content.name === "string" &&
          !metadataTools.has(content.name)
        );
      });
    const complete =
      answer &&
      !errors &&
      missing.length === 0 &&
      !a.artifacts.some((f) => !f.valid) &&
      (!a.requiredFormats.length || a.terminalReported === true) &&
      failedSteps.length === 0 &&
      !a.steps.some((s) => s.state === "running") &&
      (!a.requiresToolEvidence || toolEvidence);
    if (!(await this.deps.check(actor,a.jobId))) {
      await store.mutate(task.id,a.id,x=>{
        if(x.state!=='running') return;
        x.artifacts=a.artifacts;x.state=valid?'partial':'failed';x.phase='settled';x.reason='TASK_AUTHORIZATION_REVOKED';
      });
      await this.release(actor,task.id,a);return;
    }
    let settled = false;
    await store.mutate(task.id, a.id, (x) => {
      if (x.state !== "running") return;
      settled = true;
      x.artifacts = a.artifacts;
      x.state = complete
        ? "completed"
        : valid
          ? "partial"
          : errors || failedSteps.length
            ? "failed"
            : "interrupted";
      x.phase = "settled";
      x.reason = complete
        ? undefined
        : missing.length || a.artifacts.some((f) => !f.valid)
          ? "REQUIRED_ARTIFACTS_MISSING"
          : errors
            ? "MODEL_EXECUTION_FAILED"
            : failedSteps.length
              ? "TOOL_STEPS_UNFINISHED"
              : "RESULT_REQUIRES_REVIEW";
    });
    if (settled) await this.release(actor, task.id, a);
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    clearInterval(this.timer);
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }
  private async finishStop(): Promise<void> {
    await this.admission;
    if (this.ticking) await new Promise<void>((resolve) => this.tickWaiters.push(resolve));
    await Promise.allSettled(
      [...this.actors.values()].map((actor) => this.deps.cancelPreparation(actor)),
    );
    await Promise.allSettled(this.inflight);
    for (const actor of this.actors.values())
      await (
        await TaskStore.create(this.deps.root, actor)
      ).transaction((tasks) => {
        for (const task of tasks) {
          const a = currentAttempt(task);
          if (a.state === "running" || a.state === "cancelling") {
            a.state = "interrupted";
            a.phase = "settled";
            a.reason = "SERVICE_RESTART_REVIEW_BEFORE_RESUME";
            a.updatedAt = task.updatedAt = Date.now();
          }
        }
      });
  }
}
import { createHash } from "node:crypto";
const digestBytes = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
