type WorkerSecrets = {
  localToken: string;
  modelProxyKey?: string;
  mcpProxyKey?: string;
};

let secrets: WorkerSecrets | null = null;

export function installEnterpriseWorkerSecrets(value: WorkerSecrets): void {
  const valid = (key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key);
  if (secrets || !valid(value.localToken) ||
      (value.modelProxyKey !== undefined && !valid(value.modelProxyKey)) ||
      (value.mcpProxyKey !== undefined && !valid(value.mcpProxyKey))) {
    throw new Error('Enterprise worker capability invalid');
  }
  secrets = { ...value };
}

export function enterpriseWorkerLocalToken(): string | undefined {
  return secrets?.localToken;
}

export function enterpriseWorkerModelProxyKey(): string | undefined {
  return secrets?.modelProxyKey;
}

export function enterpriseWorkerMcpProxyKey(): string | undefined {
  return secrets?.mcpProxyKey;
}
