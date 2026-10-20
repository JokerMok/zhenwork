import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { acquireEnterpriseDockerSupervisor, createEnterpriseDockerCoreStarter, createEnterpriseModelRuntime,
  createRc2GatewayLogin, createRc2GatewayResume, createRc2GatewayPasswordChange, createRc2GatewayPublicBrand,
  startEnterpriseGateway } from '@aionui/web-host';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const optionalLimit = (name: string, min: number, max: number): number | undefined => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
};

export async function startEnterpriseWebFromEnvironment() {
  const publicOrigin = required('AION_ENTERPRISE_WEB_PUBLIC_ORIGIN');
  const rc2Url = required('AION_ENTERPRISE_WEB_RC2_URL');
  if (new URL(rc2Url).protocol !== 'https:') throw new Error('RC2 requires HTTPS');
  if (new URL(rc2Url).origin === new URL(publicOrigin).origin) {
    throw new Error('Enterprise web needs a dedicated HTTPS origin');
  }
  const staticDir = path.resolve(required('AION_ENTERPRISE_WEB_STATIC_DIR'));
  if (!(await stat(staticDir)).isDirectory()) throw new Error('Web assets directory is missing');
  const port = Number(required('AION_ENTERPRISE_WEB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
  const profileRoot = required('AION_ENTERPRISE_WEB_PROFILE_ROOT');
  const tokenFile = required('AION_ENTERPRISE_WEB_RC2_SERVICE_TOKEN_FILE');
  const tokenEntry = await lstat(tokenFile);
  if (!tokenEntry.isFile() || tokenEntry.isSymbolicLink() || (tokenEntry.mode & 0o077) !== 0 ||
      (process.getuid && tokenEntry.uid !== process.getuid())) {
    throw new Error('RC2 service token file must be private and owned by the web host');
  }
  const serviceToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(serviceToken)) throw new Error('Invalid RC2 service token');
  const gatewayImage = required('AION_ENTERPRISE_WEB_DOCKER_GATEWAY_IMAGE');
  const supervisor = await acquireEnterpriseDockerSupervisor(profileRoot, gatewayImage);
  try {
  const upstreamProxyPort = process.env.AION_ENTERPRISE_WEB_UPSTREAM_PROXY_PORT
    ? Number(process.env.AION_ENTERPRISE_WEB_UPSTREAM_PROXY_PORT) : undefined;
  let runtime: ReturnType<typeof createEnterpriseModelRuntime> | undefined;
  const startCore = createEnterpriseDockerCoreStarter({ profileRoot, supervisor,
    appVersion: required('AION_ENTERPRISE_WEB_APP_VERSION'),
    coreImage: required('AION_ENTERPRISE_WEB_DOCKER_CORE_IMAGE'), gatewayImage, upstreamProxyPort,
    authorizeCronJob: async (actor, jobId) => runtime ? runtime.authorizeCronJob(actor, jobId) : false });
  runtime = createEnterpriseModelRuntime(createRc2GatewayLogin(rc2Url, publicOrigin), startCore,
    { profileRoot, publicOrigin, rc2Resume: createRc2GatewayResume(rc2Url, publicOrigin),
      background: { rc2Url, serviceToken } });
  const gateway = await startEnterpriseGateway({ staticDir, publicOrigin, port,
    maxSessions: optionalLimit('AION_ENTERPRISE_WEB_MAX_SESSIONS', 1, 1000),
    maxCores: optionalLimit('AION_ENTERPRISE_WEB_MAX_CORES', 1, 200),
    maxStartingCores: optionalLimit('AION_ENTERPRISE_WEB_MAX_STARTING_CORES', 1, 32),
    maxQueuedCoreStarts: optionalLimit('AION_ENTERPRISE_WEB_MAX_QUEUED_CORE_STARTS', 0, 200),
    coreStartWaitMs: optionalLimit('AION_ENTERPRISE_WEB_CORE_START_WAIT_MS', 1000, 300_000),
    coreIdleMs: optionalLimit('AION_ENTERPRISE_WEB_CORE_IDLE_MS', 0, 86_400_000),
    publicBrand: createRc2GatewayPublicBrand(rc2Url, publicOrigin),
    changePassword: createRc2GatewayPasswordChange(rc2Url, publicOrigin),
    login: runtime.login, resume: runtime.resume, startCore: runtime.startCore,
    profileRoot, controlRequest: runtime.controlRequest,
    refreshResources: runtime.refreshResources,
    syncCronGrant: runtime.syncCronGrant, hasBackgroundJobs: runtime.hasBackgroundJobs,
    authorizeBackground: runtime.authorizeBackground,
    backgroundDue: runtime.backgroundDue,
    reconcileCronJobs: runtime.reconcileCronJobs });
  try {
    for (const actor of await runtime.backgroundActors()) await gateway.startBackgroundCore(actor);
    await gateway.reconcileAuthorization();
  } catch (error) {
    await gateway.stop();
    throw error;
  }
  let stopping = false;
  let retrying: Promise<void> | null = null;
  const retry = setInterval(() => {
    if (stopping || retrying) return;
    console.info('[Enterprise Web] capacity:', gateway.capacity());
    retrying = (async () => {
      for (const actor of await runtime.backgroundActors()) {
        if (stopping) return;
        await gateway.startBackgroundCore(actor);
      }
      if (!stopping) await gateway.reconcileAuthorization();
    })().catch(async (error) => {
      console.error('[Enterprise Web] background Core recovery deferred:', error);
      if (!stopping) await gateway.reconcileAuthorization().catch(() => {});
    }).finally(() => { retrying = null; });
  }, 60_000);
  retry.unref();
  return { ...gateway, stop: async () => {
    stopping = true;
    clearInterval(retry);
    await retrying;
    try { await gateway.stop(); } finally { await supervisor.close(); }
  } };
  } catch (error) {
    await supervisor.close();
    throw error;
  }
}

export function runEnterpriseWeb(): void {
  startEnterpriseWebFromEnvironment().then((gateway) => {
    console.info(`[Enterprise Web] gateway listening on 127.0.0.1:${gateway.port}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void gateway.stop().then(() => { process.exitCode = 0; }).catch((error) => {
        console.error('[Enterprise Web] stop failed:', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((error) => {
    console.error('[Enterprise Web] startup failed:', error);
    process.exitCode = 1;
  });
}
