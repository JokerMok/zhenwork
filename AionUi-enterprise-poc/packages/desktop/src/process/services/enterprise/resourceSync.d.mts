export function syncEnterpriseResources(
  corePort: number | { port: number; host?: string },
  localToken: string,
  config?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
  hooks?: { removeRevokedSkill?: (name: string) => Promise<void> }
): Promise<{
  skillName?: string;
  mcpId?: string;
  mcpName?: string;
  assistantCount?: number;
  assistantIds?: string[];
  issues: Array<{ type: 'SKILL' | 'MCP' | 'ASSISTANT'; id: string; code: string }>;
}>;
