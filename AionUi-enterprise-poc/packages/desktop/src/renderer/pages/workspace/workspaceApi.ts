import { isEnterpriseWeb } from '@/renderer/utils/platform';

type Rc2Envelope<T> = { code?: unknown; msg?: unknown; data?: T };

type WorkspaceErrorFallback = 'load' | 'action';
type WorkspaceErrorTranslationKey =
  | 'workspace.errors.authentication'
  | 'workspace.errors.forbidden'
  | 'workspace.errors.noModel'
  | 'workspace.errors.noCapability'
  | 'workspace.errors.prepareFailed'
  | `workspace.errors.${WorkspaceErrorFallback}`;

export class WorkspaceApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.code = code;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch((): null => null);
}

const normalizedErrorCode = (code: unknown): string =>
  String(code ?? '')
    .trim()
    .toUpperCase();

export function enterpriseLoginRedirectPath(code: unknown, hostedEnterpriseWeb = isEnterpriseWeb()): string | null {
  if (!hostedEnterpriseWeb) return null;
  const normalized = normalizedErrorCode(code);
  return normalized === '401' ||
    normalized === 'HTTP_401' ||
    normalized === 'UNAUTHENTICATED' ||
    normalized === 'SESSION_REVOKED' || normalized === 'AUTHENTICATION_REQUIRED'
    ? '/enterprise/login'
    : null;
}

export function redirectEnterpriseLoginIfNeeded(code: unknown): boolean {
  const target = enterpriseLoginRedirectPath(code);
  if (!target || typeof window === 'undefined') return false;
  if (window.location.pathname !== target) window.location.replace(target);
  return true;
}

export function workspaceErrorTranslationKey(
  code: unknown,
  fallback: WorkspaceErrorFallback
): WorkspaceErrorTranslationKey {
  const normalized = normalizedErrorCode(code);
  if (
    normalized === '401' ||
    normalized === 'HTTP_401' ||
    normalized === 'UNAUTHENTICATED' ||
    normalized === 'SESSION_REVOKED' || normalized === 'AUTHENTICATION_REQUIRED'
  )
    return 'workspace.errors.authentication';
  if (
    normalized === '403' ||
    normalized === 'HTTP_403' ||
    normalized === 'FORBIDDEN' ||
    normalized === 'PERMISSION_DENIED' ||
    normalized === 'PERMISSIONDENIED' ||
    normalized === 'ACCESS_DENIED' || normalized === 'CAPABILITY_FORBIDDEN'
  )
    return 'workspace.errors.forbidden';
  if (normalized === 'CORE_UNAVAILABLE' || normalized === 'CORE_CAPACITY') return 'workspace.errors.prepareFailed';
  if (normalized === 'NO_AVAILABLE_CAPABILITY') return 'workspace.errors.noCapability';
  if (normalized === 'MODELUNAVAILABLE' || normalized === 'MODEL_UNAVAILABLE' || normalized === 'NO_AVAILABLE_MODEL' || normalized === 'DEFAULT_MODEL_UNAVAILABLE')
    return 'workspace.errors.noModel';
  return `workspace.errors.${fallback}`;
}

export function unwrapRc2Response<T>(value: unknown): T {
  if (!value || typeof value !== 'object') return value as T;
  const envelope = value as Rc2Envelope<T>;
  if (typeof envelope.code === 'number') {
    if (envelope.code !== 200) {
      redirectEnterpriseLoginIfNeeded(envelope.code);
      throw new WorkspaceApiError(
        String(envelope.code),
        typeof envelope.msg === 'string' ? envelope.msg : 'Request failed'
      );
    }
    return envelope.data as T;
  }
  return value as T;
}

export async function enterpriseControl<T>(path: string, init?: RequestInit): Promise<T> {
  if (!path.startsWith('/ai/')) throw new WorkspaceApiError('INVALID_PATH', 'Invalid enterprise control path');
  const response = await fetch(`/enterprise/control${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: init?.body instanceof FormData ? init.headers : { 'content-type': 'application/json', ...init?.headers },
  });
  const value = await parseJson(response);
  if (!response.ok) {
    redirectEnterpriseLoginIfNeeded(response.status);
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    throw new WorkspaceApiError(
      typeof record.error === 'string' ? record.error : `HTTP_${response.status}`,
      typeof record.message === 'string' ? record.message : response.statusText
    );
  }
  return unwrapRc2Response<T>(value);
}

export async function enterpriseRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!path.startsWith('/enterprise/')) throw new WorkspaceApiError('INVALID_PATH', 'Invalid enterprise path');
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  const value = await parseJson(response);
  if (!response.ok) {
    redirectEnterpriseLoginIfNeeded(response.status);
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    throw new WorkspaceApiError(
      typeof record.error === 'string' ? record.error : `HTTP_${response.status}`,
      typeof record.message === 'string' ? record.message : response.statusText
    );
  }
  return value as T;
}

export async function uploadWorkspaceFiles(
  files: File[],
  paths: string[] = []
): Promise<{ uploaded: string[]; failed: Array<{ path: string; error: string }> }> {
  if (!files.length || (paths.length > 0 && paths.length !== files.length)) {
    throw new WorkspaceApiError('INVALID_UPLOAD', 'Invalid workspace file upload');
  }
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  form.append('paths', JSON.stringify(paths));
  const response = await fetch('/enterprise/files/upload', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    body: form,
  });
  const value = await parseJson(response);
  if (!response.ok) {
    redirectEnterpriseLoginIfNeeded(response.status);
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    throw new WorkspaceApiError(
      typeof record.error === 'string' ? record.error : `HTTP_${response.status}`,
      typeof record.message === 'string' ? record.message : response.statusText
    );
  }
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    uploaded: Array.isArray(record.uploaded)
      ? record.uploaded.filter((item): item is string => typeof item === 'string')
      : [],
    failed: Array.isArray(record.failed)
      ? record.failed.filter(
          (item): item is { path: string; error: string } =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as { path?: unknown }).path === 'string' &&
            typeof (item as { error?: unknown }).error === 'string'
        )
      : [],
  };
}

export function workspaceErrorCode(error: unknown): string {
  if (error instanceof WorkspaceApiError) return error.code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(error.message)) return error.message;
  return 'REQUEST_FAILED';
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
