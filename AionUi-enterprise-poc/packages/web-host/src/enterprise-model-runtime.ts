import type { EnterpriseActor, EnterpriseCore, EnterpriseGatewayOptions } from './enterprise-gateway.js';
import { EnterpriseModelProxy } from '../../desktop/src/process/services/enterprise/modelProxy.mjs';
import { removeEnterpriseModelProvider, syncEnterpriseModelProvider } from '../../desktop/src/process/services/enterprise/modelProvider.mjs';
import type { Rc2GatewayClient, Rc2GatewayLogin } from './enterprise-rc2-login.mjs';
import { syncEnterpriseWebResources } from './enterprise-resource-runtime.js';
import { EnterpriseBackgroundGrants } from './enterprise-background-grants.js';
import { verifyBackgroundService } from './enterprise-background-client.js';
import { enterpriseCoreBase, enterpriseProxyBindHost, enterpriseProxyHost } from './enterprise-core-address.js';

function key(actor: EnterpriseActor): string {
  return `${actor.serverId}:${actor.userId}`;
}

/** Shares a per-employee Core across web sessions while retaining each RC2 cookie server-side. */
export function createEnterpriseModelRuntime(
  rc2Login: (username: string, password: string) => Promise<Rc2GatewayLogin>,
  startIsolatedCore: (actor: EnterpriseActor) => Promise<EnterpriseCore>,
  options: { profileRoot?: string; rc2Resume?: (cookie: string) => Promise<Rc2GatewayLogin>;
    background?: { rc2Url: string; serviceToken: string } } = {}
): Pick<EnterpriseGatewayOptions, 'login' | 'startCore' | 'resume' | 'authorizeBackground'> & {
  syncCronGrant: (actor: EnterpriseActor, jobId: string, enabled: boolean) => Promise<void>;
  hasBackgroundJobs: (actor: EnterpriseActor) => boolean;
  authorizeCronJob: (actor: EnterpriseActor, jobId: string) => Promise<boolean>;
  backgroundActors: () => Promise<EnterpriseActor[]>;
  reconcileCronJobs: (actor: EnterpriseActor) => Promise<void>;
} {
  const clients = new Map<string, Set<Rc2GatewayClient>>();
  const grants = new Map<string, EnterpriseBackgroundGrants>();
  const runningCores = new Map<string, EnterpriseCore>();
  const auditBackground = async (actor: EnterpriseActor, store: EnterpriseBackgroundGrants): Promise<boolean> => {
    const status = await store.inspect();
    const core = runningCores.get(key(actor));
    if (core) {
      for (const revoked of status.revoked) {
        await store.disableRevoked(revoked.jobId, revoked.grantId, async () => {
          const response = await fetch(`${enterpriseCoreBase(core)}/api/cron/jobs/${revoked.jobId}`, {
            method: 'PUT', headers: { 'content-type': 'application/json',
              'x-aion-enterprise-local-token': core.localToken },
            body: JSON.stringify({ enabled: false }), signal: AbortSignal.timeout(5_000),
          });
          if (response.status !== 404) {
            if (!response.ok || Number(response.headers.get('content-length') || 0) > 10_000)
              throw new Error('Revoked background job could not be disabled');
            const raw = await response.text();
            if (raw.length > 10_000) throw new Error('Revoked background job response invalid');
            const body = JSON.parse(raw) as { success?: boolean; data?: { enabled?: boolean } };
            if (body.success !== true || body.data?.enabled !== false)
              throw new Error('Revoked background job could not be disabled');
          }
          const running = await fetch(`${enterpriseCoreBase(core)}/api/cron/internal/active-job/${revoked.jobId}`, {
            headers: { 'x-aion-enterprise-local-token': core.localToken, 'x-aionui-internal': '1' },
            signal: AbortSignal.timeout(5_000),
          });
          if (!running.ok || Number(running.headers.get('content-length') || 0) > 10_000)
            throw new Error('Revoked background run state unavailable');
          const runningRaw = await running.text();
          if (runningRaw.length > 10_000) throw new Error('Revoked background run state invalid');
          const runningBody = JSON.parse(runningRaw) as { success?: boolean; data?: { active?: boolean } };
          if (runningBody.success !== true || typeof runningBody.data?.active !== 'boolean')
            throw new Error('Revoked background run state invalid');
          if (runningBody.data.active) throw new Error('Revoked background job is still running');
        });
      }
    }
    return status.valid.length > 0;
  };
  const activeClient = async (actor: EnterpriseActor): Promise<Rc2GatewayClient> => {
    for (const client of clients.get(key(actor)) || []) {
      try {
        if ((await client.me()).userId === actor.userId) return client;
      } catch { /* revoked session; try another active device */ }
    }
    const store = grants.get(key(actor));
    if (store) return store.client();
    throw new Error('No active RC2 session for employee');
  };
  const relayClient = async (actor: EnterpriseActor, conversationId?: string): Promise<Rc2GatewayClient> => {
    // Persisted conversation metadata is editable. Only the Core cron
    // executor's in-memory running-turn map may select a job grant.
    const core = runningCores.get(key(actor));
    if (!conversationId || !/^[A-Za-z0-9_-]{1,100}$/.test(conversationId) || !core) {
      throw new Error('Enterprise conversation unavailable');
    }
    const running = await fetch(`${enterpriseCoreBase(core)}/api/cron/internal/active-conversation/${conversationId}`, {
      headers: { 'x-aion-enterprise-local-token': core.localToken, 'x-aionui-internal': '1' },
      signal: AbortSignal.timeout(5_000),
    });
    if (running.status !== 404) {
      if (!running.ok || Number(running.headers.get('content-length') || 0) > 10_000) {
        throw new Error('Active enterprise task unavailable');
      }
      const raw = await running.text();
      if (raw.length > 10_000) throw new Error('Active enterprise task response invalid');
      const reply = JSON.parse(raw) as { success?: boolean; data?: { job_id?: unknown } };
      const jobId = reply.data?.job_id;
      if (reply.success !== true || typeof jobId !== 'string' || !/^cron_[A-Za-z0-9_-]{8,80}$/.test(jobId)) {
        throw new Error('Active enterprise task response invalid');
      }
      const store = grants.get(key(actor));
      if (!store) throw new Error('Active enterprise task grant unavailable');
      return store.clientFor(jobId);
    }
    for (const candidate of clients.get(key(actor)) || []) {
      try { if ((await candidate.me()).userId === actor.userId) return candidate; }
      catch { /* A revoked device cannot authorize this call. */ }
    }
    throw new Error('No active RC2 session for conversation');
  };
  const interactiveClient = async (actor: EnterpriseActor): Promise<Rc2GatewayClient> => {
    for (const client of clients.get(key(actor)) || []) {
      try { if ((await client.me()).userId === actor.userId) return client; }
      catch { /* try another signed-in device */ }
    }
    throw new Error('Employee session required to change scheduled jobs');
  };
  const register = async (session: Rc2GatewayLogin) => {
    const actorKey = key(session.actor);
    let group = clients.get(actorKey);
    if (!group) { group = new Set(); clients.set(actorKey, group); }
    group.add(session.client);
    return { actor: session.actor, username: session.username, validate: session.validate,
      brand: session.brand,
      close: async () => {
        group!.delete(session.client);
        if (group!.size === 0 && clients.get(actorKey) === group) clients.delete(actorKey);
        await session.close();
      } };
  };
  return {
    login: async (username, password) => register(await rc2Login(username, password)),
    resume: options.rc2Resume ? async (cookie) => register(await options.rc2Resume!(cookie)) : undefined,
    hasBackgroundJobs: (actor) => grants.get(key(actor))?.hasJobs() === true,
    authorizeCronJob: async (actor, jobId) => {
      const store = grants.get(key(actor));
      if (!store) return false;
      try { await store.clientFor(jobId); return true; }
      catch { return false; }
    },
    authorizeBackground: async (actor) => {
      const store = grants.get(key(actor));
      if (!store?.hasJobs()) return false;
      try { return await auditBackground(actor, store); }
      catch { return false; }
    },
    backgroundActors: async () => {
      if (!options.background || !options.profileRoot) return [];
      await verifyBackgroundService(options.background.rc2Url, options.background.serviceToken);
      const actors = await EnterpriseBackgroundGrants.discoverActors(options.profileRoot,
        options.background.rc2Url, options.background.serviceToken);
      for (const actor of actors) {
        if (grants.has(key(actor))) continue;
        const store = new EnterpriseBackgroundGrants(options.profileRoot, actor,
          options.background.rc2Url, options.background.serviceToken);
        await store.load();
        grants.set(key(actor), store);
      }
      return actors;
    },
    reconcileCronJobs: async (actor) => {
      const store = grants.get(key(actor));
      const core = runningCores.get(key(actor));
      if (!store || !core) return;
      const issuer = await interactiveClient(actor);
      if (!('request' in issuer) || typeof issuer.request !== 'function')
        throw new Error('RC2 grant issuer unavailable');
      const response = await fetch(`${enterpriseCoreBase(core)}/api/cron/jobs`, {
        headers: { 'x-aion-enterprise-local-token': core.localToken },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 1_000_000)
        throw new Error('Core cron catalog unavailable');
      const raw = await response.text();
      if (raw.length > 1_000_000) throw new Error('Core cron catalog too large');
      const body = JSON.parse(raw) as { success?: boolean; data?: Array<{ id?: string; enabled?: boolean }> };
      if (!body.success || !Array.isArray(body.data) || body.data.length > 100)
        throw new Error('Core cron catalog invalid');
      const enabled = new Set(body.data.filter((job) => job.enabled === true &&
        typeof job.id === 'string' && /^cron_[A-Za-z0-9_-]{8,80}$/.test(job.id)).map((job) => job.id!));
      const client = issuer as Parameters<EnterpriseBackgroundGrants['issue']>[0];
      for (const jobId of enabled) if (!store.jobIds().includes(jobId)) await store.issue(client, jobId);
      for (const jobId of store.jobIds()) if (!enabled.has(jobId)) await store.revoke(client, jobId);
    },
    syncCronGrant: async (actor, jobId, enabled) => {
      const store = grants.get(key(actor));
      if (!store) throw new Error('Background grant store unavailable');
      const issuer = await interactiveClient(actor);
      if (!('request' in issuer) || typeof issuer.request !== 'function')
        throw new Error('RC2 grant issuer unavailable');
      const client = issuer as Parameters<EnterpriseBackgroundGrants['issue']>[0];
      if (enabled) {
        if (!store.jobIds().includes(jobId)) await store.issue(client, jobId);
      } else await store.revoke(client, jobId);
    },
    startCore: async (actor) => {
      const client = await activeClient(actor);
      const models = await client.availableModels();
      const model = models.find((item) => item.streaming && item.id && item.code && item.name);
      let store: EnterpriseBackgroundGrants | null = null;
      let core: EnterpriseCore | undefined;
      try {
        if (options.background) {
          if (!options.profileRoot) throw new Error('Background grants require a profile root');
          store = new EnterpriseBackgroundGrants(options.profileRoot, actor,
            options.background.rc2Url, options.background.serviceToken);
          await store.load();
          grants.set(key(actor), store);
        }
        core = await startIsolatedCore(actor);
        runningCores.set(key(actor), core);
        if (store) await auditBackground(actor, store);
      } catch (error) {
        grants.delete(key(actor));
        runningCores.delete(key(actor));
        if (core) await core.stop().catch(() => {});
        throw error;
      }
      if (!core) throw new Error('Enterprise Core unavailable');
      const stop = async (...cleanup: Array<() => Promise<void>>) => {
        grants.delete(key(actor));
        runningCores.delete(key(actor));
        const coreResult = await Promise.allSettled([core.stop()]);
        await Promise.allSettled(cleanup.map((fn) => fn()));
        if (coreResult[0].status === 'rejected') throw coreResult[0].reason;
      };
      if (!model) {
        try {
          if (!options.profileRoot) throw new Error('Enterprise resource profile root required');
          const resources = await syncEnterpriseWebResources(actor, core, options.profileRoot, null,
            () => activeClient(actor), (conversationId) => relayClient(actor, conversationId));
          await removeEnterpriseModelProvider(core, core.localToken);
          return { ...core, invalidated: resources.invalidated, stop: () => stop(resources.stop) };
        } catch (error) {
          grants.delete(key(actor));
          runningCores.delete(key(actor));
          await core.stop();
          throw error;
        }
      }
      const proxy = new EnterpriseModelProxy({ model, requireConversationId: true, client: {
        relayModel: async (modelId, raw, signal, conversationId) => {
          try {
            const current = await relayClient(actor, conversationId);
            if (!(await current.availableModels()).some((item) => item.id === modelId)) {
              return new Response(null, { status: 403 });
            }
            return current.relayModel(modelId, raw, signal);
          } catch { return new Response(null, { status: 403 }); }
        },
      } });
      try {
        const proxyHost = enterpriseProxyHost(core);
        const { port, key: proxyKey } = await proxy.start(enterpriseProxyBindHost(core));
        await core.registerProxyPort?.(port);
        await syncEnterpriseModelProvider(core, core.localToken, {
          AION_ENTERPRISE_MODEL_PROXY_PORT: String(port), AION_ENTERPRISE_MODEL_PROXY_KEY: proxyKey,
          AION_ENTERPRISE_MODEL_PROXY_HOST: proxyHost,
          AION_ENTERPRISE_MODEL_CODE: model.code, AION_ENTERPRISE_MODEL_NAME: model.name,
        });
        const resources = options.profileRoot
          ? await syncEnterpriseWebResources(actor, core, options.profileRoot, model,
            () => activeClient(actor), (conversationId) => relayClient(actor, conversationId))
          : null;
        return { ...core, invalidated: resources?.invalidated,
          stop: () => stop(...(resources ? [resources.stop] : []), () => proxy.stop()) };
      } catch (error) {
        grants.delete(key(actor));
        runningCores.delete(key(actor));
        await core.stop().catch(() => {});
        await proxy.stop();
        throw error;
      }
    },
  };
}
