import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup } from './chatLib';
import { getAcpImagePath } from './acpToolCallOutput';

export type NormalizedToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'canceled';

export interface NormalizedToolCall {
  key: string;
  name: string;
  status: NormalizedToolStatus;
  description?: string;
  input?: string;
  output?: string;
  truncated?: boolean;
  messageId?: string;
  conversationId?: string;
  imagePath?: string;
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

// ===== tool_group → NormalizedToolCall[] =====

function normalizeToolGroupStatus(status: string): NormalizedToolStatus {
  switch (status) {
    case 'Success':
      return 'completed';
    case 'Error':
      return 'error';
    case 'Canceled':
      return 'canceled';
    case 'Pending':
      return 'pending';
    case 'Executing':
    case 'Confirming':
    default:
      return 'running';
  }
}

const getResultDisplayText = (
  result_display: IMessageToolGroup['content'][0]['result_display']
): string | undefined => {
  if (!result_display) return undefined;
  if (typeof result_display === 'string') return result_display;
  if ('file_diff' in result_display) return result_display.file_diff;
  if ('img_url' in result_display) return result_display.relative_path || result_display.img_url;
  return undefined;
};

export function normalizeToolGroup(message: IMessageToolGroup): NormalizedToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.map(({ name, call_id, description, confirmationDetails, status, result_display }) => {
    let desc = typeof description === 'string' ? description.slice(0, 100) : '';
    const type = confirmationDetails?.type;
    if (type === 'edit') desc = confirmationDetails.file_name;
    if (type === 'exec') desc = confirmationDetails.command;
    if (type === 'info') desc = confirmationDetails.urls?.join(';') || confirmationDetails.title;
    if (type === 'mcp') desc = confirmationDetails.server_name + ':' + confirmationDetails.tool_name;

    let input: string | undefined;
    if (confirmationDetails) {
      const { title: _title, type: _type, ...rest } = confirmationDetails;
      if (Object.keys(rest).length) input = formatValue(rest);
    } else if (description) {
      input = description;
    }

    return {
      key: call_id,
      name,
      status: normalizeToolGroupStatus(status),
      description: desc,
      input,
      output: getResultDisplayText(result_display),
    };
  });
}

// ===== acp_tool_call → NormalizedToolCall =====

function normalizeAcpStatus(status: string): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    case 'in_progress':
      return 'running';
    case 'pending':
    default:
      return 'pending';
  }
}

const buildParamSummary = (kind: string, rawInput?: Record<string, unknown>): string | undefined => {
  if (!rawInput) return undefined;

  if (kind === 'read' || kind === 'edit') {
    return (rawInput.file_path as string) || (rawInput.path as string) || (rawInput.file_name as string);
  }
  if (kind === 'execute') {
    return rawInput.command as string;
  }
  if (kind === 'search' || kind === 'grep') {
    const parts: string[] = [];
    if (rawInput.pattern) parts.push(`"${rawInput.pattern}"`);
    if (rawInput.path) parts.push(`in ${rawInput.path}`);
    else if (rawInput.glob) parts.push(`in ${rawInput.glob}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (kind === 'glob') {
    const parts: string[] = [];
    if (rawInput.pattern) parts.push(`${rawInput.pattern}`);
    if (rawInput.path) parts.push(`in ${rawInput.path}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (kind === 'write') {
    return (rawInput.file_path as string) || (rawInput.path as string);
  }

  for (const key of ['file_path', 'command', 'path', 'pattern', 'query', 'url']) {
    if (rawInput[key] && typeof rawInput[key] === 'string') return rawInput[key] as string;
  }
  return undefined;
};

type AcpToolCallUpdateCompat = IMessageAcpToolCall['content']['update'] & {
  session_update?: string;
  raw_input?: Record<string, unknown>;
};

type AcpToolCallContentCompat = IMessageAcpToolCall['content'] & {
  _compact?: {
    truncated?: boolean;
    original_size?: number;
    preview_chars?: number;
  };
  update?: AcpToolCallUpdateCompat;
};

export function normalizeAcpToolCall(message: IMessageAcpToolCall): NormalizedToolCall | undefined {
  const content = message.content as AcpToolCallContentCompat | undefined;
  const update = content?.update;
  if (!update) return undefined;

  const rawInput = update.rawInput ?? update.raw_input;
  const input = rawInput ? formatValue(rawInput) : undefined;

  let output: string | undefined;
  if (Array.isArray(update.content) && update.content.length) {
    output = update.content
      .map((item) => {
        if (typeof item !== 'object' || item === null) return '';
        if (item.type === 'content' && item.content?.text) return item.content.text;
        if (item.type === 'diff' && 'path' in item) return `[diff] ${item.path}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  const keyParam = buildParamSummary(update.kind, rawInput);

  return {
    key: update.tool_call_id,
    name: update.title,
    status: normalizeAcpStatus(update.status),
    description: keyParam || (rawInput?.command as string) || update.kind,
    input,
    output,
    truncated: content?._compact?.truncated === true,
    messageId: message.id,
    conversationId: message.conversation_id,
    imagePath: getAcpImagePath(update),
  };
}

// ===== tool_call → NormalizedToolCall =====

function normalizeToolCallStatus(status?: string): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'running':
      return 'running';
    case 'canceled':
      return 'canceled';
    default:
      return 'pending';
  }
}

export function normalizeToolCall(message: IMessageToolCall): NormalizedToolCall | undefined {
  const { call_id, name, status, input, output, args, description } = message.content;
  if (!call_id) return undefined;

  const displayInput = input
    ? formatValue(input)
    : args && Object.keys(args).length > 0
      ? formatValue(args)
      : undefined;

  return {
    key: call_id,
    name,
    status: normalizeToolCallStatus(status),
    description: description || undefined,
    input: displayInput,
    output,
  };
}

// ===== Unified entry =====

export type ToolMessage = IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall;

export function normalizeToolMessages(messages: ToolMessage[]): NormalizedToolCall[] {
  // Streaming updates and a refreshed history can briefly contain the same call.
  // Keep its first position, freshest details and terminal result, never count it twice.
  const calls = new Map<string, NormalizedToolCall>();
  for (const message of messages) {
    const items =
      message.type === 'tool_group'
        ? normalizeToolGroup(message)
        : message.type === 'acp_tool_call'
          ? [normalizeAcpToolCall(message)]
          : message.type === 'tool_call'
            ? [normalizeToolCall(message)]
            : [];
    for (const item of items) {
      if (!item) continue;
      const previous = calls.get(item.key);
      const terminal = (value: NormalizedToolCall) => ['completed', 'error', 'canceled'].includes(value.status);
      if (previous && terminal(previous) && !terminal(item)) continue;
      calls.set(item.key, { ...previous, ...item });
    }
  }
  return [...calls.values()];
}

export function hasRunningToolMessages(messages: ToolMessage[]): boolean {
  return normalizeToolMessages(messages).some((item) => item.status === 'running');
}

/** Only server tool receipts establish deliverables; chat prose is not a receipt. */
type WorkbookCheck = { sheet: string; scope: string; currency: string; total: string; matched: boolean };
export type ToolDeliveryReceipt = {
  checks?: WorkbookCheck[];
  sha256?: string;
  path: string;
  status: 'complete' | 'failed';
  error?: string;
  version?: number;
  versionId?: string;
  headingCount?: number;
  tableCount?: number;
  sheetCount?: number;
  addedHeadings?: string[];
};
// Legacy transcripts have no TaskWork receipt list. Only the Host Office tools that issue
// artifacts may supply fallback cards. Remote search results and chat text cannot create one.
const legacyDeliveryTools = new Set([
  'create_business_presentation',
  'run_enterprise_method',
  'generate_waste_report',
  'create_office_document',
  'create_evidence_deliverables',
  'revise_office_document',
  'edit_workbook_column',
  'validate_artifact',
  'write_workspace_text',
  'write_text_file',
]);

export function toolDeliveryReceipts(tools: NormalizedToolCall[]): ToolDeliveryReceipt[] {
  const files = new Map<string, ToolDeliveryReceipt>();
  const audits = new Map<string, Map<string, WorkbookCheck>>();
  for (const tool of tools) {
    if (!tool.output) continue;
    try {
      let value = JSON.parse(tool.output);
      if (Array.isArray(value?.content)) {
        const text = value.content.find((item: { type?: string; text?: string }) => item.type === 'text')?.text;
        if (text) value = JSON.parse(text);
      }
      if (tool.name === 'audit_workbook' && tool.status === 'completed') {
        const scope = value?.totalCell || (Array.isArray(value?.amountRanges) ? value.amountRanges.join(', ') : '');
        if (
          typeof value?.path !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.sha256 || '') ||
          typeof value.sheet !== 'string' ||
          typeof scope !== 'string' ||
          !scope ||
          typeof value.total !== 'string' ||
          !/^-?\d+\.\d{2}$/.test(value.total) ||
          !/^[A-Z]{3}$/.test(value.currency || '') ||
          !['matched', 'mismatch'].includes(value.status)
        )
          continue;
        const fileKey = JSON.stringify([value.path, value.sha256]);
        const checks = audits.get(fileKey) ?? new Map<string, WorkbookCheck>();
        checks.set(JSON.stringify([value.sheet, scope]), {
          sheet: value.sheet,
          scope,
          currency: value.currency,
          total: value.total,
          matched: value.status === 'matched',
        });
        audits.set(fileKey, checks);
        continue;
      }
      if (!legacyDeliveryTools.has(tool.name) || !['completed', 'error'].includes(tool.status)) continue;
      const outputs = Array.isArray(value?.outputs)
        ? value.outputs
        : value?.downloadUrl && value?.path
          ? [
              {
                ...value,
                status:
                  value.valid === false || value.validation?.valid === false || tool.status === 'error'
                    ? 'failed'
                    : 'complete',
              },
            ]
          : [];
      for (const output of outputs) {
        if (!output || typeof output !== 'object') continue;
        const item =
          output.valid === false || output.validation?.valid === false ? { ...output, status: 'failed' } : output;
        if (
          typeof item.path !== 'string' ||
          !item.path ||
          item.path.length > 1024 ||
          item.path.startsWith('/') ||
          item.path.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..') ||
          !['complete', 'failed'].includes(item.status)
        )
          continue;
        // A completed receipt must include the checked current artifact digest.
        if (item.status === 'complete' && !/^[a-f0-9]{64}$/.test(item.sha256 || '')) continue;
        const versionId = /^[a-f0-9-]{36}$/i.test(item.versionId || '') ? item.versionId : undefined;
        if (item.status === 'complete') files.delete(JSON.stringify([item.path, 'failed']));
        files.set(JSON.stringify([item.path, versionId || item.sha256 || item.status]), {
          ...(/^[a-f0-9]{64}$/.test(item.sha256 || '') ? { sha256: String(item.sha256) } : {}),
          path: item.path,
          status: item.status,
          ...(Number.isInteger(item.version) && item.version > 0 ? { version: item.version } : {}),
          ...(/^[a-f0-9-]{36}$/i.test(item.versionId || '') ? { versionId: item.versionId } : {}),
          ...(Number.isInteger(item.inspection?.headingCount) ? { headingCount: item.inspection.headingCount } : {}),
          ...(Array.isArray(item.inspection?.tables) ? { tableCount: item.inspection.tables.length } : {}),
          ...(Number.isInteger(item.inspection?.sheetCount) ? { sheetCount: item.inspection.sheetCount } : {}),
          ...(Array.isArray(item.changes)
            ? {
                addedHeadings: item.changes
                  .filter(
                    (change: { kind?: string; actualHeading?: unknown }) =>
                      change.kind === 'append_section' && typeof change.actualHeading === 'string'
                  )
                  .map((change: { actualHeading: string }) => change.actualHeading.slice(0, 300))
                  .slice(0, 32),
              }
            : {}),
          ...(item.error ? { error: String(item.error).slice(0, 200) } : {}),
        });
      }
    } catch {
      /* Ordinary tool output is not a delivery receipt. */
    }
  }
  return [...files.values()].map((file) => {
    const checks =
      file.status === 'complete' && file.sha256 ? audits.get(JSON.stringify([file.path, file.sha256])) : undefined;
    return checks?.size ? { ...file, checks: [...checks.values()] } : file;
  });
}
