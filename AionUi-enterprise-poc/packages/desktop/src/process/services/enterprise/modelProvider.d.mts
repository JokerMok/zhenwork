export function syncEnterpriseModelProvider(
  corePort: number | { port: number; host?: string },
  localToken: string,
  config?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch
): Promise<{ providerId: string; model: string }>;

export function removeEnterpriseModelProvider(
  corePort: number | { port: number; host?: string },
  localToken: string,
  fetchImpl?: typeof fetch
): Promise<boolean>;
