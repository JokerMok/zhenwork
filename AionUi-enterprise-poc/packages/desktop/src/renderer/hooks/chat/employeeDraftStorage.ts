import type { ChatFileRef } from '@/common/types/chatFile';

export function employeeDraftScope(employeeId: string | number | undefined): string | undefined {
  if (employeeId == null) return;
  return encodeURIComponent(JSON.stringify([employeeId, localStorage.getItem('enterprise:session-changed')]));
}

export function readDraft<T>(key: string): T | undefined {
  try {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeDraft<T>(key: string, value: T): void {
  sessionStorage.setItem(key, JSON.stringify(value));
}

export type InitialMessage = {
  input: string;
  files: ChatFileRef[];
  executionId: string;
  phase: 'ready' | 'rejected' | 'uncertain';
};

export function initialMessageKey(scope: string, conversationId: string): string {
  return `enterprise:first-message:${scope}:${conversationId}`;
}
