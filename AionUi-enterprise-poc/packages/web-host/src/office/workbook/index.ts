import { spawn } from 'node:child_process';
import path from 'node:path';
import { WORKBOOK_PYTHON_SCRIPT } from './script.js';

const DEFAULT_PYTHON = '/opt/zhenwork-office/bin/python';
const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 35 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 20_000;

export type WorkbookInspectArgs = {
  sheet?: string;
  maxRows?: number;
  maxColumns?: number;
};

export type WorkbookAuditArgs = {
  sheet: string;
  amountRange?: string;
  amountRanges?: string[];
  totalCell?: string;
  expectedTotal?: string | number;
  groupByColumn?: string;
  groupFormat?: 'value' | 'excel-date';
  currency?: string;
};

export type WorkbookColumnEditArgs = {
  sheet: string;
  headerRow: number;
  startRow: number;
  endRow: number;
  column?: string | number;
  header: string;
  values: Array<string | number | boolean | null>;
  newTitle?: string;
};

export type WorkbookOperationResult<T extends Record<string, unknown>> = T & {
  workbook?: Buffer;
};

type Operation = 'inspect' | 'audit' | 'edit-column' | 'preview';

type PythonResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  outputBase64?: string;
  error?: { code?: string; message?: string };
};

function runWorkbookOperation<T extends Record<string, unknown>>(
  operation: Operation,
  workbook: Buffer,
  args: Record<string, unknown>
): Promise<WorkbookOperationResult<T>> {
  if (!Buffer.isBuffer(workbook) || workbook.length === 0) {
    return Promise.reject(new Error('WORKBOOK_BUFFER_REQUIRED'));
  }
  if (workbook.length > MAX_WORKBOOK_BYTES) {
    return Promise.reject(new Error('WORKBOOK_INPUT_TOO_LARGE'));
  }

  const configured = process.env.ZHENWORK_OFFICE_PYTHON?.trim();
  const python = configured || DEFAULT_PYTHON;
  if (!path.isAbsolute(python) || python.includes('\0')) {
    return Promise.reject(new Error('WORKBOOK_PYTHON_PATH_INVALID'));
  }
  const input = JSON.stringify({ operation, args, workbookBase64: workbook.toString('base64') });

  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', WORKBOOK_PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
      },
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: WorkbookOperationResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('WORKBOOK_PROCESS_TIMEOUT'));
    }, PROCESS_TIMEOUT_MS);

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === 'ENOENT' ? 'WORKBOOK_PYTHON_UNAVAILABLE' : 'WORKBOOK_PYTHON_START_FAILED'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('WORKBOOK_RESPONSE_TOO_LARGE'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      if (settled) return;
      let response: PythonResponse;
      try {
        response = JSON.parse(Buffer.concat(stdout).toString('utf8')) as PythonResponse;
      } catch {
        finish(new Error(code === null ? 'WORKBOOK_PROCESS_TERMINATED' : 'WORKBOOK_PROCESS_INVALID_RESPONSE'));
        return;
      }
      if (!response.ok || !response.result) {
        const codeText = response.error?.code || 'WORKBOOK_OPERATION_FAILED';
        finish(new Error(codeText));
        return;
      }
      const result = response.result as T;
      finish(undefined, {
        ...result,
        ...(response.outputBase64 ? { workbook: Buffer.from(response.outputBase64, 'base64') } : {}),
      });
    });
    child.stdin.on('error', () => finish(new Error('WORKBOOK_PROCESS_INPUT_FAILED')));
    child.stdin.end(input);
  });
}

/** Inspect bounded workbook structure and cell content without recalculating formulas. */
export async function inspectWorkbook(
  workbook: Buffer,
  args: WorkbookInspectArgs = {}
): Promise<WorkbookOperationResult<Record<string, unknown>>> {
  return runWorkbookOperation('inspect', workbook, args);
}

/** Audit explicit amount ranges using exact decimal arithmetic and fresh formula evaluation where supported. */
export async function auditWorkbook(
  workbook: Buffer,
  args: WorkbookAuditArgs
): Promise<WorkbookOperationResult<Record<string, unknown>>> {
  return runWorkbookOperation('audit', workbook, args);
}

/** Apply one explicit column edit and return the edited workbook plus reopened verification evidence. */
export async function editWorkbookColumn(
  workbook: Buffer,
  args: WorkbookColumnEditArgs
): Promise<WorkbookOperationResult<Record<string, unknown>>> {
  return runWorkbookOperation('edit-column', workbook, args);
}

/** Bounded read-only page with fresh supported formula values and basic formatting. */
export async function previewWorkbook(
  workbook: Buffer,
  args: { sheet?: string; start?: number } = {}
): Promise<Record<string, unknown>> {
  return runWorkbookOperation('preview', workbook, args);
}
