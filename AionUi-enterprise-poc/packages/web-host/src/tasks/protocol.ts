import type { EnterpriseActor } from "../enterprise-gateway.js";
import { TaskStore } from "./store.js";
import { currentAttempt, digest, type TaskArtifact, TaskError } from "./types.js";
import { randomUUID } from "node:crypto";

export const taskCheckpointTool = {
  name: "task_checkpoint",
  description:
    "Persist real task progress. Use waiting_input with an explicit question when required information is missing, waiting_confirmation before ambiguous/external write/send, and completed only after real results and required artifacts are verified. No thoughts or invented percentages. Then stop the turn when waiting. State is checked against actual runtime, tools and files.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["running", "waiting_input", "waiting_confirmation", "completed"],
      },
      summary: { type: "string", minLength: 1, maxLength: 1200 },
      question: { type: "string", maxLength: 2000 },
      requiredArtifacts: { type: "array", maxItems: 16, items: { type: "string", maxLength: 300 } },
    },
    required: ["state", "summary"],
    additionalProperties: false,
  },
};

export async function checkpoint(
  root: string,
  actor: EnterpriseActor,
  conversation: string,
  args: Record<string, unknown>,
  expectedAttemptId?: string,
): Promise<unknown> {
  const store = await TaskStore.create(root, actor),
    task = await store.get(conversation),
    attempt = currentAttempt(task);
  if (attempt.state !== "running" || (expectedAttemptId && attempt.id !== expectedAttemptId))
    throw new TaskError(409, "TASK_NOT_EXECUTING");
  if (
    ["waiting_input", "waiting_confirmation"].includes(String(args.state)) &&
    (typeof args.question !== "string" || !args.question.trim())
  )
    throw new TaskError(400, "TASK_WAITING_QUESTION_REQUIRED");
  await store.mutate(conversation, attempt.id, (a) => {
    if (a.state !== "running") return;
    a.progress = String(args.summary).slice(0, 1200);
    if (args.state === "waiting_input" || args.state === "waiting_confirmation") {
      a.stopReason = args.state;
      a.question = String(args.question).slice(0, 2000);
    }
    if (args.state === "completed") a.terminalReported = true;
    if (Array.isArray(args.requiredArtifacts))
      for (const p of args.requiredArtifacts) {
        if (typeof p === "string" && !a.artifacts.some((f) => f.path === p))
          a.artifacts.push({ path: p, sha256: "", valid: false });
      }
  });
  return {
    saved: true,
    waiting: ["waiting_input", "waiting_confirmation"].includes(String(args.state)),
    instruction:
      args.state === "completed"
        ? "Completion will be checked against actual results and required files."
        : "If waiting, the server displays the saved question and ends this turn. Do not make another model or tool request.",
  };
}

/** Only Host-owned receipts, never model prose, record successful steps. */
export async function recordTool(
  root: string,
  actor: EnterpriseActor,
  conversation: string,
  tool: string,
  args: unknown,
  result: unknown,
  error?: string,
  expectedAttemptId?: string,
  stepId?: string,
): Promise<void> {
  const store = await TaskStore.create(root, actor);
  let task;
  try {
    task = await store.get(conversation);
  } catch {
    return;
  }
  const attempt = currentAttempt(task);
  if (attempt.state !== "running" || (expectedAttemptId && attempt.id !== expectedAttemptId))
    return;
  const collect = (v: unknown): TaskArtifact[] => {
    if (!v || typeof v !== "object") return [];
    if (Array.isArray(v)) return v.flatMap(collect);
    const o = v as Record<string, unknown>;
    const receipt =
      typeof o.path === "string" && typeof o.sha256 === "string" && /^[a-f0-9]{64}$/.test(o.sha256)
        ? [
            {
              path: o.path,
              sha256: o.sha256,
              version: typeof o.version === "number" ? o.version : undefined,
              versionId: typeof o.versionId === "string" ? o.versionId : undefined,
              downloadUrl: typeof o.downloadUrl === "string" ? o.downloadUrl : undefined,
              previewUrl: typeof o.previewUrl === "string" ? o.previewUrl : undefined,
              valid: !!o.validation && (o.validation as { valid?: boolean }).valid === true,
            },
          ]
        : [];
    return [
      ...receipt,
      ...Object.values(o)
        .filter((x) => x && typeof x === "object")
        .flatMap(collect),
    ];
  };
  const artifactTools = new Set([
    "create_office_document",
    "create_evidence_deliverables",
    "revise_office_document",
    "edit_workbook_column",
    "validate_artifact",
    "write_workspace_text",
    "write_text_file",
  ]);
  const artifacts = artifactTools.has(tool) ? collect(result) : [];
  const input = args as Record<string, unknown>;
  const target = String(
    input?.path ||
      input?.basePath ||
      input?.baseName ||
      input?.basename ||
      input?.baseId ||
      input?.query ||
      "",
  );
  const partial =
    result && typeof result === "object" && (result as { status?: string }).status === "partial";
  if (partial && !error) error = "PARTIAL_OUTPUT";
  await store.mutate(conversation, attempt.id, (a) => {
    if (a.state !== "running") return;
    const existing = stepId ? a.steps.find((s) => s.id === stepId) : undefined;
    if (!existing && a.steps.length >= 200) throw new TaskError(409, "TASK_STEP_CAPACITY");
    const d = digest({ tool, args });
    if (!error)
      for (const prior of a.steps)
        if (
          prior.tool === tool &&
          prior.state === "failed" &&
          (prior.target === target || (!prior.target && /^OFFICE_ARGUMENT_/.test(prior.summary)))
        )
          prior.summary = "Recovered by a later successful call";
    const step = {
      id: existing?.id || `${a.id}:${a.steps.length + 1}`,
      tool,
      digest: d,
      target,
      result: artifacts.length && JSON.stringify(result).length < 64000 ? result : undefined,
      state: error ? ("failed" as const) : ("completed" as const),
      at: Date.now(),
      summary: error?.slice(0, 500) || tool,
      artifacts,
    };
    if (existing) Object.assign(existing, step);
    else a.steps.push(step);
    for (const f of artifacts) {
      const i = a.artifacts.findIndex((x) => x.path === f.path);
      if (i < 0) a.artifacts.push(f);
      else a.artifacts[i] = f;
    }
    if (tool !== "task_checkpoint") a.progress = error ? "TOOL_FAILED" : tool;
  });
}

/** Records an actual received tool operation before the operation starts, not a proposed model plan. */
export async function beginTool(
  root: string,
  actor: EnterpriseActor,
  conversation: string,
  tool: string,
  args: unknown,
  expectedAttemptId?: string,
): Promise<string | undefined> {
  const store = await TaskStore.create(root, actor);
  let task;
  try {
    task = await store.get(conversation);
  } catch {
    return;
  }
  const a = currentAttempt(task);
  if (a.state !== "running" || (expectedAttemptId && a.id !== expectedAttemptId)) return;
  const id = randomUUID();
  await store.mutate(conversation, a.id, (x) => {
    if (x.state !== "running") throw new TaskError(409, "TASK_NOT_EXECUTING");
    if (x.steps.length >= 200) throw new TaskError(409, "TASK_STEP_CAPACITY");
    x.steps.push({
      id,
      tool,
      digest: digest({ tool, args }),
      state: "running",
      at: Date.now(),
      summary: tool,
    });
    x.progress = tool;
  });
  return id;
}

/** A retry cannot rewrite an already verified successful Office output. Reuse its actual current receipt. */
export async function reusableOutput(
  root: string,
  actor: EnterpriseActor,
  conversation: string,
  tool: string,
  args: Record<string, unknown>,
  check: (path: string, sha: string) => Promise<boolean>,
): Promise<unknown | undefined> {
  if (
    ![
      "create_office_document",
      "revise_office_document",
      "edit_workbook_column",
      "create_evidence_deliverables",
    ].includes(tool)
  )
    return;
  const store = await TaskStore.create(root, actor);
  let task;
  try {
    task = await store.get(conversation);
  } catch {
    return;
  }
  const attempt = currentAttempt(task);
  if (!attempt.retryOf) return;
  const prior = task.attempts.find((a) => a.id === attempt.retryOf);
  if (!prior) return;
  const target = typeof args.path === "string" ? args.path : undefined;
  const protectedFile = target
    ? prior.artifacts.find((f) => f.path === target && f.valid)
    : undefined;
  if (
    tool === "create_evidence_deliverables" &&
    args.overwrite === true &&
    prior.artifacts.some((f) => f.valid)
  )
    throw new TaskError(409, "TASK_RETRY_MUST_PRESERVE_SUCCESSFUL_ARTIFACT");
  if (!protectedFile) return;
  if (!(await check(protectedFile.path, protectedFile.sha256)))
    throw new TaskError(409, "TASK_SUCCESSFUL_ARTIFACT_CHANGED_REVIEW_REQUIRED");
  const step = [...prior.steps]
    .reverse()
    .find(
      (s) => s.state === "completed" && s.result && s.artifacts?.some((f) => f.path === target),
    );
  if (!step?.result) throw new TaskError(409, "TASK_RETRY_MUST_PRESERVE_SUCCESSFUL_ARTIFACT");
  return {
    ...(step.result as Record<string, unknown>),
    reused: true,
    unchanged: true,
    note: "Verified successful output retained. Retry only unfinished outputs.",
  };
}

/** Accepted scope is immutable for a running round; UI changes select only the next round's scope. */
export async function currentTaskScope(
  root: string,
  actor: EnterpriseActor,
  conversation: string,
): Promise<{
  active: boolean;
  attemptId?: string;
  jobId?: string;
  scope?: import("../office/office-store.js").KnowledgeScope;
  state?: string;
  waiting?: string;
}> {
  const store = await TaskStore.create(root, actor);
  try {
    const a = currentAttempt(await store.get(conversation));
    return {
      active: a.state === "running",
      attemptId: a.id,
      jobId: a.jobId,
      scope: a.scope as import("../office/office-store.js").KnowledgeScope | undefined,
      state: a.state,
      waiting: a.stopReason,
    };
  } catch (error) {
    if (error instanceof TaskError && error.status === 404) return { active: false };
    throw error;
  }
}

/** Execution context is exposed through an authenticated tool, never inserted into the employee's message. */
export async function taskOfficeContext(
  root: string,
  actor: EnterpriseActor,
  conversation: string,
): Promise<unknown> {
  const store = await TaskStore.create(root, actor);
  let task;
  try {
    task = await store.get(conversation);
  } catch {
    return null;
  }
  const a = currentAttempt(task),
    prior = task.attempts.at(-2),
    context = a.resumeContext;
  return {
    round: a.round,
    attempt: a.attempt,
    requiredFormats: a.requiredFormats,
    previousState: context?.priorState || prior?.state,
    pendingIssue: context?.question || prior?.question || prior?.reason,
    retryOnly: !!a.retryOf,
    requirementsReplaced: context?.replaceRequirements === true,
    verifiedPriorOutputs: context?.protectedFiles || prior?.artifacts.filter((f) => f.valid) || [],
    employeeDecision: context?.action,
    externalOutcome: context?.externalOutcome,
    instruction:
      context?.externalOutcome === "applied"
        ? "The employee verified the prior operation was already applied. Do NOT replay it. Continue only unfinished work."
        : context?.externalOutcome === "not_applied"
          ? "The employee verified the prior operation was not applied. Use the normal current permission/confirmation flow if needed."
          : "Check existing outputs before writes. Preserve successful outputs during retries. Unknown external write outcomes require manual verification, never blind replay.",
  };
}
