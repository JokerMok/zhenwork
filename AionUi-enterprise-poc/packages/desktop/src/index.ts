/** Enterprise bootstrap. The supervisor never starts AionCore. */
if (process.env.AION_ENTERPRISE_ROLE === 'worker') {
  if (!process.env.AION_ENTERPRISE_PROFILE_DIR || !process.connected) {
    throw new Error('Enterprise worker requires a profile and supervisor IPC');
  }
  const timeout = setTimeout(() => { throw new Error('Enterprise worker bootstrap timed out'); }, 10_000);
  process.once('message', (message: unknown) => {
    clearTimeout(timeout);
    const value = message as { type?: string; localToken?: string;
      modelProxyKey?: string; mcpProxyKey?: string };
    if (value?.type !== 'enterprise:bootstrap' || !value.localToken) {
      throw new Error('Enterprise worker bootstrap invalid');
    }
    void import('./process/services/enterprise/workerSecrets').then(({ installEnterpriseWorkerSecrets }) => {
      installEnterpriseWorkerSecrets({ localToken: value.localToken!,
        ...(value.modelProxyKey ? { modelProxyKey: value.modelProxyKey } : {}),
        ...(value.mcpProxyKey ? { mcpProxyKey: value.mcpProxyKey } : {}) });
      return import('./appMain');
    });
  });
  process.send?.({ type: 'enterprise:bootstrap-request' });
} else {
  process.env.AION_ENTERPRISE_ROLE = 'supervisor';
  void import('./process/services/enterprise/supervisor');
}
