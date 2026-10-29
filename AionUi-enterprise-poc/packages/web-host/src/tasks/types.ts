import { createHash } from 'node:crypto';
export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_confirmation'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'cancelling'
  | 'interrupted';
export type TaskArtifact = {
  path: string;
  sha256: string;
  versionId?: string;
  version?: number;
  downloadUrl?: string;
  previewUrl?: string;
  valid: boolean;
};
export type TaskStep = {
  id: string;
  tool: string;
  digest: string;
  target?: string;
  state: 'running' | 'completed' | 'failed';
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
  phase: 'authorizing' | 'queued' | 'preparing' | 'dispatching' | 'executing' | 'settled';
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
    replaceRequirements?: boolean;
    priorState: TaskState;
    retryOnly: boolean;
    question?: string;
    protectedFiles: TaskArtifact[];
    externalOutcome?: string;
    approvalFingerprint?: string;
    approvedKind?: string;
  };
  terminalReported?: boolean;
  stopReason?: 'waiting_input' | 'waiting_confirmation';
  retryOf?: string;
  scope?: unknown;
  approval?: { fingerprint: string; used: boolean };
};
export type TaskRecord = { id: string; title: string; updatedAt: number; attempts: TaskAttempt[] };
export const activeStates = new Set<TaskState>(['queued', 'running', 'cancelling']);
export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_k, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v
      )
    )
    .digest('hex');
export const currentAttempt = (task: TaskRecord): TaskAttempt => task.attempts[task.attempts.length - 1];
const operationClauses = (content: string): string[] =>
  content
    .split(/(?:[。；;,，\n]|但(?:是)?|\bbut\b)/i)
    .map((c) => c.trim())
    .filter(
      (c) =>
        !/^(?:(?:请|务必|一定|暂时|暂|先|绝对|绝)\s*)?(?:不要|无需|不必|不|勿|禁止|严禁|切勿|do not|don't|no need to|without|never)/i.test(
          c
        )
    );
export function requiredFormats(content: string): string[] {
  content = operationClauses(content)
    .filter((c) => !/^(?:请问|请)?(?:什么是|如何|怎么|为什么|解释|介绍|what is|how|explain|why)/i.test(c))
    .join('\n');
  if (!/生成|制作|交付|输出|修改|编辑|调整|做成|做一份|generate|create|produce|revise|modify|edit/i.test(content))
    return [];
  return [
    ...(/word|docx|文档报告/i.test(content) ? ['docx'] : []),
    ...(/excel|xlsx|电子表格/i.test(content) ? ['xlsx'] : []),
    ...(/\bpptx?\b|powerpoint|幻灯片|演示文稿/i.test(content) ? ['pptx'] : []),
  ];
}
export function requiresToolEvidence(content: string, files: unknown): boolean {
  if (requiredFormats(content).length || (Array.isArray(files) && files.length)) return true;
  content = operationClauses(content).join('\n');
  if (/^(?:请问)?(?:什么是|如何理解|为什么|请解释|解释|what is|explain|why)/i.test(content.trim())) return false;
  // Tool evidence is an execution contract, not a keyword/topic classifier.
  // "Write an article about reviewing files" remains ordinary prose. Require
  // evidence for explicit operations; attachments and deliverables are above.
  return content
    .split('\n')
    .some((clause) =>
      /^(?:(?:请|帮我|为我|麻烦|现在|接下来|然后|先|再|直接|重新|实际|务必|用程序|使用工具|用工具)\s*)*(?:调用|核对|计算|检索|搜索|查询|修改|编辑|执行|运行|提交|发送|生成文件)\s*\S|^(?:(?:please|then|now|actually)\s+)*(?:call|execute|run|submit|send|modify|calculate|search|query)\s+\S/i.test(
        clause.trim()
      )
    );
}
export class TaskError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
export function publicTask(task: TaskRecord, summary = false): unknown {
  return {
    ...task,
    attempts: (summary ? [currentAttempt(task)] : task.attempts).map(
      ({ payload: _payload, approval: _approval, resumeContext: _context, confirmation, steps, ...a }) => ({
        ...a,
        requiresExternalReview: !!_approval?.used && !['read', 'info', 'search'].includes(_context?.approvedKind || ''),
        ...(summary
          ? {}
          : {
              inputs: {
                content: String(_payload.content),
                files: _payload.files,
              },
            }),
        canApprove: typeof confirmation?.fingerprint === 'string' && !!confirmation?.proposal,
        confirmation: confirmation
          ? {
              title: confirmation.title,
              description: confirmation.description,
              questions: confirmation.questions,
              proposal: confirmation.proposal,
            }
          : undefined,
        steps: summary ? [] : steps.map(({ result: _result, ...s }) => s),
      })
    ),
  };
}
