import { currentTaskScope } from './tasks/protocol.js';
import type { EnterpriseResourceState, EnterpriseActor, EnterpriseClientMetadata, EnterpriseCore, EnterpriseGatewayOptions,
} from './enterprise-gateway.js';
import { EnterpriseModelProxy } from '../../desktop/src/process/services/enterprise/modelProxy.mjs';
import { removeEnterpriseModelProvider, syncEnterpriseModelProvider,
} from '../../desktop/src/process/services/enterprise/modelProvider.mjs';
import type { Rc2GatewayClient, Rc2GatewayLogin } from './enterprise-rc2-login.mjs';
import { syncEnterpriseWebResources, closeEnterpriseMcpCache, type EnterpriseMcpCache } from './enterprise-resource-runtime.js';
import type { RuntimeResourceIssue } from './enterprise-resource-runtime.js';
import { EnterpriseBackgroundGrants } from './enterprise-background-grants.js';
import { verifyBackgroundService } from './enterprise-background-client.js';
import { enterpriseCoreBase, enterpriseProxyBindHost, enterpriseProxyHost } from './enterprise-core-address.js';
import { startOfficeTools, ensureOfficeAssistant } from './office/office-tools.js';
import { OfficeStore } from './office/office-store.js';
import { watch } from 'node:fs';
import type { TaskRuntime } from './tasks/integration.js';
import { backgroundDue } from './office/background-due.js';

function key(actor: EnterpriseActor): string {
  return `${actor.serverId}:${actor.userId}`;
}

/** Shares a per-employee Core across web sessions while retaining each RC2 cookie server-side. */
export function createEnterpriseModelRuntime(
  rc2Login: (username: string, password: string, client: EnterpriseClientMetadata) => Promise<Rc2GatewayLogin>,
  startIsolatedCore: (actor: EnterpriseActor) => Promise<EnterpriseCore>,
  options: { profileRoot?: string; publicOrigin?: string; rc2Resume?: (cookie: string) => Promise<Rc2GatewayLogin>;
    background?: { rc2Url: string; serviceToken: string };
  } = {}
): Pick<EnterpriseGatewayOptions,
  | 'login' | 'startCore' | 'resume' | 'authorizeBackground' | 'controlRequest' | 'backgroundDue' | 'refreshResources' | 'resourceStatus'> &
  TaskRuntime & {
  syncCronGrant: (actor: EnterpriseActor, jobId: string, enabled: boolean) => Promise<void>;
  hasBackgroundJobs: (actor: EnterpriseActor) => boolean;
  authorizeCronJob: (actor: EnterpriseActor, jobId: string) => Promise<boolean>;
  backgroundActors: () => Promise<EnterpriseActor[]>;
  reconcileCronJobs: (actor: EnterpriseActor) => Promise<void>;
} {
  const taskBindings = new Map<string, Map<string, string>>();
  const officeTrust = new Map<string, (c: Record<string, unknown>) => Promise<boolean>>();
  const grantStore = async (actor: EnterpriseActor) => {
    let store = taskGrants.get(key(actor));
    if (!store) {
      if (!options.background || !options.profileRoot) throw new Error('Background authorization unavailable');
      store = new EnterpriseBackgroundGrants(
        options.profileRoot,
        actor,
        options.background.rc2Url,
        options.background.serviceToken,
        'task-grants.json'
      );
      await store.load();
      taskGrants.set(key(actor), store);
    }
    return store;
  };
  const clients = new Map<string, Set<Rc2GatewayClient>>();
  const taskGrants = new Map<string, EnterpriseBackgroundGrants>();
  const grants = new Map<string, EnterpriseBackgroundGrants>();
  const runningCores = new Map<string, EnterpriseCore>();
  const refreshers = new Map<string, () => Promise<EnterpriseResourceState>>();
  const resourceStates = new Map<string, EnterpriseResourceState>();
  const resourceIssues = new Map<string, RuntimeResourceIssue[]>();
  const auditBackground = async (actor: EnterpriseActor, store: EnterpriseBackgroundGrants): Promise<boolean> => {
    const status = await store.inspect();
    const core = runningCores.get(key(actor));
    if (core) {
      for (const revoked of status.revoked) {
        if (revoked.jobId.startsWith('task_')) continue;
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
    if (store?.hasJobs()) return store.client();
    const taskStore = taskGrants.get(key(actor));
    if (taskStore?.hasJobs()) return taskStore.client();
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
    const taskJob = taskBindings.get(key(actor))?.get(conversationId);
    if (taskJob) {
      const taskClient = await (await grantStore(actor)).clientFor(taskJob);
      const originalMe=taskClient.me.bind(taskClient);
      taskClient.me=async(signal?:AbortSignal)=>{
        if(taskBindings.get(key(actor))?.get(conversationId)!==taskJob)throw new Error('Task execution changed');
        if(options.profileRoot){const current=await currentTaskScope(options.profileRoot,actor,conversationId);if(!current.active||current.jobId!==taskJob)throw new Error('Task execution stopped');}
        return originalMe(signal);
      };

      if (options.profileRoot) {
        const taskState = await currentTaskScope(options.profileRoot,actor,conversationId);
        if(!taskState.active)throw new Error('Task execution is no longer active');
        if(taskState.waiting)throw new Error('Task is waiting for employee input');
        const scope = taskState.scope;
        for (const baseId of new Set([...(scope?.baseIds || []), ...(scope?.documents.map((d) => d.baseId) || [])]))
          await taskClient.authorizedResource(baseId, 'KNOWLEDGE');
      }
      const identityResponse = await fetch(`${enterpriseCoreBase(core)}/api/conversations/${conversationId}`, {
        headers: { 'x-aion-enterprise-local-token': core.localToken },
        signal: AbortSignal.timeout(5000),
      });
      if (identityResponse.ok) {
        const identity = (await identityResponse.json()) as { data?: { assistant?: { id?: string } } };
        const id = identity.data?.assistant?.id;
        if (id?.startsWith('rc2-')) await taskClient.authorizedResource(id.slice(4), 'ASSISTANT');
      } else throw new Error('Task assistant identity unavailable');
      return taskClient;
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
      },
    };
  };
  return {
    issueTaskGrant: async (actor, jobId) => {
      if (!/^task_[A-Za-z0-9_-]{8,80}$/.test(jobId)) throw new Error('Invalid task grant');
      const store = await grantStore(actor),
        issuer = await interactiveClient(actor);
      if (!('request' in issuer) || typeof issuer.request !== 'function') throw new Error('Grant issuer unavailable');
      if (!store.jobIds().includes(jobId))
        await store.issue(issuer as Parameters<EnterpriseBackgroundGrants['issue']>[0], jobId);
    },
    checkTaskGrant: async (actor, jobId) => {
      try {
        await (await grantStore(actor)).clientFor(jobId);
        return true;
      } catch {
        return false;
      }
    },
    revokeTaskGrant: async (actor, jobId) => {
      await (await grantStore(actor)).revokeStored(jobId);
    },
    bindTask: (actor, conversation, jobId, expectedJobId) => {
      let bindings = taskBindings.get(key(actor));
      if (!bindings) {
        bindings = new Map();
        taskBindings.set(key(actor), bindings);
      }
      if (jobId) bindings.set(conversation, jobId);
      else if(!expectedJobId || bindings.get(conversation)===expectedJobId) bindings.delete(conversation);
    },
    trustedTaskConfirmation: async (actor, c) => officeTrust.get(key(actor))?.(c) || false,
    taskActors: async () => {
      if (!options.background || !options.profileRoot) return [];
      const actors = await EnterpriseBackgroundGrants.discoverActors(
        options.profileRoot,
        options.background.rc2Url,
        options.background.serviceToken,
        'task-grants.json'
      );
      for (const actor of actors) await grantStore(actor);
      return actors;
    },
    resourceStatus: (actor) => resourceStates.get(key(actor)) || { state: 'ready' },
    refreshResources: async (actor) => {
      const refresh = refreshers.get(key(actor));
      if (!refresh) throw new Error('RESOURCE_REFRESH_UNAVAILABLE');
      return refresh();
    },
    backgroundDue: async (actor) => {
      const store = grants.get(key(actor));
      if (taskBindings.get(key(actor))?.size) return true;
      if (!store || !options.profileRoot) return false;
      return backgroundDue(options.profileRoot, actor, store.jobIds().filter((id) => id.startsWith('cron_'))
      );
    },
    controlRequest: async (actor, route, init) => {
      const client = (await interactiveClient(actor)) as Rc2GatewayClient & {
        baseUrl: string; cookie: string; clientId: string; origin: string;
      };
      if ((await client.me()).userId !== actor.userId) throw new Error('IDENTITY_REVOKED');
      if (route === '/ai/resources/runtime-issues' && (init.method || 'GET') === 'GET') {
        return new Response(JSON.stringify(resourceIssues.get(key(actor)) || []), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const response = await fetch(client.baseUrl + route, { ...init, redirect: 'error', headers: {
        ...init.headers, Cookie: client.cookie, clientid: client.clientId, Origin: client.origin,
      },
      });
      await client.me();
      if (response.ok && !['GET', 'HEAD', 'OPTIONS'].includes(init.method || 'GET') && /^\/ai\/(resources|mcp)/.test(route)) {
        // The write already committed. A busy Core must not turn that success into a retryable failure.
        await refreshers.get(key(actor))?.().catch((error: Error) => console.info('[Enterprise Office] resource refresh deferred:', error.message));
      }
      return response;
    },
    login: async (username, password, client) => register(await rc2Login(username, password, client)),
    resume: options.rc2Resume ? async (cookie) => register(await options.rc2Resume!(cookie)) : undefined,
    hasBackgroundJobs: (actor) => grants.get(key(actor))?.hasJobs() === true || taskGrants.get(key(actor))?.hasJobs() === true,
    authorizeCronJob: async (actor, jobId) => {
      const store = grants.get(key(actor));
      if (!store) return false;
      try { await store.clientFor(jobId); return true; }
      catch { return false; }
    },
    authorizeBackground: async (actor) => {
      const store = grants.get(key(actor));
      const taskStore = taskGrants.get(key(actor));
      try {
        if (taskStore?.hasJobs() && (await taskStore.inspect()).valid.length > 0) return true;
        if (!store?.hasJobs()) return false;
        return await auditBackground(actor, store); }
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
      for (const jobId of store.jobIds()) if (jobId.startsWith('cron_') && !enabled.has(jobId)) await store.revoke(client, jobId);
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
      const models = (await client.availableModels()).map((item) => ({ ...item, upstreamCode: item.code, code: 'rc2-' + item.id,
      }));
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
      const mcpCache: EnterpriseMcpCache = new Map();
      const stop = async (...cleanup: Array<() => Promise<void>>) => {
        officeTrust.delete(key(actor));
        runningCores.delete(key(actor));
        resourceIssues.delete(key(actor));
        const coreResult = await Promise.allSettled([core.stop()]);
        await closeEnterpriseMcpCache(core, mcpCache);
        await Promise.allSettled(cleanup.map((fn) => fn()));
        if (coreResult[0].status === 'rejected') throw coreResult[0].reason;
      };
      if (!model) {
        try {
          if (!options.profileRoot) throw new Error('Enterprise resource profile root required');
          const resources = await syncEnterpriseWebResources(actor, core, options.profileRoot, null,
            () => activeClient(actor), (conversationId) => relayClient(actor, conversationId), undefined, mcpCache);
          resourceIssues.set(key(actor), resources.issues);
          await removeEnterpriseModelProvider(core, core.localToken);
          return { ...core, invalidated: resources.invalidated, stop: () => stop(resources.stop) };
        } catch (error) {
          grants.delete(key(actor));
          runningCores.delete(key(actor));
          resourceIssues.delete(key(actor));
          await core.stop().catch(() => {});
          await closeEnterpriseMcpCache(core, mcpCache);
          throw error;
        }
      }
      const proxy = new EnterpriseModelProxy({ model, models, requireConversationId: true, client: {
        relayModel: async (modelId, raw, signal, conversationId) => {
          try {
            const current = await relayClient(actor, conversationId);
            if (!(await current.availableModels()).some((item) => item.id === modelId)) {
              return new Response(null, { status: 403 });
            }
            return current.relayModel(modelId, raw, signal, conversationId);
          } catch { return new Response(null, { status: 403 }); }
        },
      },
      });
      let office: Awaited<ReturnType<typeof startOfficeTools>> | null = null;
      let resources: Awaited<ReturnType<typeof syncEnterpriseWebResources>> | null = null;
      let stopRefreshTimer = (): void => {};
      let refreshPending = false;
      const markPending = () => { refreshPending = true;resourceStates.set(key(actor), { state: 'pending' }); };
      try {
        const proxyHost = enterpriseProxyHost(core);
        const { port, key: proxyKey } = await proxy.start(enterpriseProxyBindHost(core));
        await core.registerProxyPort?.(port);
        await syncEnterpriseModelProvider(core, core.localToken, {
          AION_ENTERPRISE_MODEL_PROXY_PORT: String(port), AION_ENTERPRISE_MODEL_PROXY_KEY: proxyKey,
          AION_ENTERPRISE_MODEL_PROXY_HOST: proxyHost,
          AION_ENTERPRISE_MODEL_CODE: model.code, AION_ENTERPRISE_MODEL_NAME: model.name,
          AION_ENTERPRISE_MODELS_JSON: JSON.stringify(models),
        });
        resources = options.profileRoot
          ? await syncEnterpriseWebResources(actor, core, options.profileRoot, { ...model, availableModels: models },
            () => activeClient(actor), (conversationId) => relayClient(actor, conversationId), markPending, mcpCache)
          : null;
        resourceIssues.set(key(actor), resources?.issues || []);
        let invalidate: () => void = () => {};
        const invalidated = new Promise<void>((resolve) => { invalidate = resolve; });
        let generation = 0, refreshing: Promise<EnterpriseResourceState> | null = null, stoppingResources = false;
        resources?.invalidated.then(() => { if (generation === 0) invalidate(); });
        resourceStates.set(key(actor), { state: 'ready' });
        const refresh = (): Promise<EnterpriseResourceState> => {
          if (stoppingResources) return Promise.reject(new Error('RESOURCE_REFRESH_UNAVAILABLE'));
          if (refreshing) return refreshing;
          // Publish the promise before any asynchronous idle check. Concurrent
          // requests and the timer must join one operation for this actor.
          refreshing = (async (): Promise<EnterpriseResourceState> => {
            let ready: { success?: boolean; data?: { idle?: boolean } };
            try {
              const response = await fetch(`${enterpriseCoreBase(core)}/api/cron/internal/idle-ready`, {
                headers: { 'x-aion-enterprise-local-token': core.localToken, 'x-aionui-internal': '1' }, signal: AbortSignal.timeout(3000),
              });
              if (!response.ok) throw new Error('RESOURCE_REFRESH_CHECK_FAILED');
              ready = (await response.json()) as typeof ready;
            } catch {
              refreshPending = true;
              const state = { state: 'pending', reason: 'CHECK_FAILED' } as const;
              resourceStates.set(key(actor), state);
              return state;
            }
            if (ready.success !== true || ready.data?.idle !== true) {
              refreshPending = true;
              const state = { state: 'pending', reason: 'TASK_ACTIVE' } as const;
              resourceStates.set(key(actor), state);
              return state;
            }
            refreshPending = false;
            resourceStates.set(key(actor), { state: 'refreshing' });
            generation += 1;
            const currentGeneration = generation;
            try {
              const available = (await (await activeClient(actor)).availableModels()).map((item) => ({ ...item, upstreamCode: item.code, code: 'rc2-' + item.id,
              }));
              const chosen = available.find((item) => item.streaming);
              if (!chosen || !options.profileRoot) throw new Error('DEFAULT_MODEL_UNAVAILABLE');
              await resources?.stop();resources = null;
              models.splice(0, models.length, ...available);
              await syncEnterpriseModelProvider(core, core.localToken, {
                AION_ENTERPRISE_MODEL_PROXY_PORT: String(port), AION_ENTERPRISE_MODEL_PROXY_KEY: proxyKey,
                AION_ENTERPRISE_MODEL_PROXY_HOST: proxyHost,
                AION_ENTERPRISE_MODEL_CODE: chosen.code, AION_ENTERPRISE_MODEL_NAME: chosen.name,
                AION_ENTERPRISE_MODELS_JSON: JSON.stringify(available),
              });
              resources = await syncEnterpriseWebResources(actor, core, options.profileRoot, { ...chosen, availableModels: available },
                () => activeClient(actor), (conversationId) => relayClient(actor, conversationId), markPending, mcpCache);
              resourceIssues.set(key(actor), resources.issues);
              resources.invalidated.then(() => { if (generation === currentGeneration) invalidate(); });
              if (office) await ensureOfficeAssistant(core, office.mcpId, chosen);
              const state = { state: refreshPending ? 'pending' : 'ready' } as EnterpriseResourceState;
              resourceStates.set(key(actor), state);
              return state;
            } catch (error) { invalidate();throw error; }
          })().finally(() => { refreshing = null; });
          return refreshing;
        };
        refreshers.set(key(actor), refresh);
        const refreshTimer = setInterval(() => { if (refreshPending && !stoppingResources) void refresh().catch(() => {}); }, 15000);
        refreshTimer.unref();
        stopRefreshTimer = () => clearInterval(refreshTimer);
        let stopHistory = (): void => {};
        if (options.profileRoot) {
          office = await startOfficeTools(actor, core, options.profileRoot, (conversationId) => relayClient(actor, conversationId), options.publicOrigin);
          officeTrust.set(key(actor), async c => (await office?.trustedConfirmation(c)) === true || (await resources?.trustedConfirmation(c)) === true);
          await ensureOfficeAssistant(core, office.mcpId, model);
          if (core.workspaceRoot) {
            const store = await OfficeStore.create(options.profileRoot, actor), workspace = core.workspaceRoot;
            await store.files(workspace);
            let pending: ReturnType<typeof setTimeout> | undefined;
            try {
              const watcher = watch(workspace, { recursive: true }, () => {
                if (pending) clearTimeout(pending);
                pending = setTimeout(() => { void store.files(workspace).catch((error: Error) => console.warn('[Enterprise Office] version snapshot deferred:', error.message)); }, 1000);
                pending.unref();
              });
              stopHistory = () => { watcher.close();if (pending) clearTimeout(pending); };
            } catch { console.warn('[Enterprise Office] automatic file watcher unavailable; versions are captured when files are listed'); }
          }
        }
        return { ...core, invalidated,
          stop: async () => { stoppingResources = true;clearInterval(refreshTimer);refreshers.delete(key(actor));stopHistory();await refreshing?.catch(() => {});resourceStates.delete(key(actor));return stop(...(resources ? [resources.stop] : []), ...(office ? [office.stop] : []), () => proxy.stop()); },
        };
      } catch (error) {
        stopRefreshTimer();
        grants.delete(key(actor));
        runningCores.delete(key(actor));
        resourceIssues.delete(key(actor));
        refreshers.delete(key(actor));
        resourceStates.delete(key(actor));
        await core.stop().catch(() => {});
        await office?.stop().catch(() => {});
        await resources?.stop().catch(() => {});
        await closeEnterpriseMcpCache(core, mcpCache);
        await proxy.stop();
        throw error;
      }
    },
  };
}
