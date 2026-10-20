export type RuntimeStatusSignal = {
  state?: string | null;
  is_processing?: boolean;
  pending_confirmations?: number;
};

export type RuntimeDisplayStatus = 'preparing' | 'processing' | 'waitingUser';

export const runtimeDisplayStatus = (
  runtime: RuntimeStatusSignal | null | undefined,
  options: { warming?: boolean; preparationFailed?: boolean } = {}
): RuntimeDisplayStatus | null => {
  if (runtime?.state === 'waiting_confirmation' || (runtime?.pending_confirmations ?? 0) > 0) {
    return 'waitingUser';
  }
  if (!options.preparationFailed && (runtime?.state === 'starting' || runtime?.state === 'restarting')) {
    return 'preparing';
  }
  if (runtime?.is_processing === true || runtime?.state === 'running' || runtime?.state === 'cancelling') {
    return 'processing';
  }
  if (options.warming && !options.preparationFailed) {
    return 'preparing';
  }
  return null;
};

export const workspaceTaskDisplayStatus = (
  status: string | null | undefined,
  runtime: RuntimeStatusSignal | null | undefined
): string => {
  const explicitRuntimeStatus = runtimeDisplayStatus(runtime);
  if (explicitRuntimeStatus) return explicitRuntimeStatus;

  const normalized = status?.toLowerCase() || 'idle';
  if (normalized === 'finished' || normalized === 'completed') return 'completed';
  if (normalized === 'running') return 'processing';
  return normalized;
};
