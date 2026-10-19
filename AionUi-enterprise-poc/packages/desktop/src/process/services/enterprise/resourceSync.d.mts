export function syncEnterpriseResources(
  corePort: number | { port: number; host?: string },
  localToken: string,
  config?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch
): Promise<{ skillName?: string; mcpId?: string; mcpName?: string; assistantCount?: number }>;
