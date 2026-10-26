import { createHash } from "node:crypto";
export type TaskState =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_confirmation"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "cancelling"
  | "interrupted";
export type TaskArtifact = {
  path: string;
  sha256: string;
  versionId?: string;
  downloadUrl?: string;
  previewUrl?: string;
  valid: boolean;
};
export type TaskStep = {
  id: string;
  tool: string;
  digest: string;
  target?: string;
  state: "running" | "completed" | "failed";
  at: number;
  summary: string;
  result?: unknown;
  artifacts?: TaskArtifact[];
};
export type TaskAttempt = {
  id: string;
  requestId: string;
  payloadHash: string;
  round: number;
  attempt: number;
  jobId: string;
  state: TaskState;
  phase: "authorizing" | "queued" | "preparing" | "dispatching" | "executing" | "settled";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  assistant?: { id: string; name: string };
  payload: Record<string, unknown>;
  turnId?: string;
  messageId?: string;
  reason?: string;
  progress?: string;
  question?: string;
  confirmation?: Record<string, unknown>;
  steps: TaskStep[];
  artifacts: TaskArtifact[];
  requiredFormats: string[];
  requiresToolEvidence: boolean;
  resumeContext?: {
    action: string;
    requestHash?: string;
    priorState: TaskState;
    retryOnly: boolean;
    question?: string;
    protectedFiles: TaskArtifact[];
    externalOutcome?: string;
    approvalFingerprint?: string;
    approvedKind?: string;
  };
  terminalReported?: boolean;
  stopReason?: "waiting_input" | "waiting_confirmation";
  retryOf?: string;
  scope?: unknown;
  approval?: { fingerprint: string; used: boolean };
};
export type TaskRecord = { id: string; title: string; updatedAt: number; attempts: TaskAttempt[] };
export const activeStates = new Set<TaskState>(["queued", "running", "cancelling"]);
export const digest = (value: unknown): string =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_k, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    )
    .digest("hex");
export const currentAttempt = (task: TaskRecord): TaskAttempt =>
  task.attempts[task.attempts.length - 1];
export function requiredFormats(content: string): string[] {
  const clauses = content
    .split(/[。；;\n]/)
    .filter(
      (c) =>
        !/(?:不要|无需|不必|do not|don't|no need to).{0,12}(?:生成|制作|输出|修改|generate|create|edit)/i.test(
          c,
        ),
    );
  content = clauses.join("\n");
  if (
    !/生成|制作|交付|输出|修改|编辑|调整|generate|create|produce|revise|modify|edit/i.test(content)
  )
    return [];
  return [
    ...(/word|docx|文档报告/i.test(content) ? ["docx"] : []),
    ...(/excel|xlsx|电子表格/i.test(content) ? ["xlsx"] : []),
  ];
}
export function requiresToolEvidence(content: string, files: unknown): boolean {
  if (requiredFormats(content).length || (Array.isArray(files) && files.length)) return true;
  content = content
    .split(/(?:[。；;,，\n]|但(?:是)?|\bbut\b)/i)
    .filter((c) => !/^\s*(?:不要|无需|不必|不|勿|禁止|do not|don't|without|never)/i.test(c))
    .join("\n");
  if (/^(?:请问)?(?:什么是|如何理解|为什么|请解释|解释|what is|explain|why)/i.test(content.trim()))
    return false;
  return /核对|计算|检索|搜索|查询|对比|分析|修改|编辑|执行|运行|提交|发送|生成文件|execute|run|submit|send|generate|create|modify|calculate|search|query|compare|analyse|analyze/i.test(
    content,
  );
}
export class TaskError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function publicTask(task: TaskRecord, summary = false): unknown {
  return {
    ...task,
    attempts: (summary ? [currentAttempt(task)] : task.attempts).map(
      ({
        payload: _payload,
        approval: _approval,
        resumeContext: _context,
        confirmation,
        steps,
        ...a
      }) => ({
        ...a,
        requiresExternalReview:
          !!_approval?.used && !["read", "info", "search"].includes(_context?.approvedKind || ""),
        ...(summary
          ? {}
          : {
              inputs: {
                content: String(_payload.content),
                files: _payload.files,
              },
            }),
        canApprove: !confirmation || typeof confirmation.fingerprint === "string",
        confirmation: confirmation
          ? {
              title: confirmation.title,
              description: confirmation.description,
              questions: confirmation.questions,
              proposal: confirmation.proposal,
            }
          : undefined,
        steps: summary ? [] : steps.map(({ result: _result, ...s }) => s),
      }),
    ),
  };
}
