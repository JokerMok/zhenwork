import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnterpriseDockerCoreStarter } from '../packages/web-host/src/enterprise-docker-core.ts';
import { acquireEnterpriseDockerSupervisor } from '../packages/web-host/src/enterprise-docker-supervisor.ts';
import { createEnterpriseModelRuntime } from '../packages/web-host/src/enterprise-model-runtime.ts';
import { startEnterpriseGateway } from '../packages/web-host/src/enterprise-gateway.ts';

const root = await mkdtemp(path.join(tmpdir(), 'enterprise-background-restart-'));
const actor = { serverId: 'synthetic', userId: '42' };
const image = (name: string) => execFileSync('docker', ['image', 'inspect', name, '--format', '{{.Id}}'],
  { encoding: 'utf8' }).trim();
const gatewayImage = image('aionui-enterprise-gateway:dev');
const supervisor = await acquireEnterpriseDockerSupervisor(root, gatewayImage);
let runtimeForAuthorization: ReturnType<typeof createEnterpriseModelRuntime> | undefined;
const startDockerCore = createEnterpriseDockerCoreStarter({ profileRoot: root, appVersion: '0.2.2',
  coreImage: image(process.env.AION_SMOKE_CORE_IMAGE || 'aionui-enterprise-core:dev'), gatewayImage, supervisor,
  authorizeCronJob: async (target, jobId) => runtimeForAuthorization
    ? runtimeForAuthorization.authorizeCronJob(target, jobId) : false });
const serviceToken = 'a'.repeat(43);
const grantIds = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'];
const secrets = ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
const enterpriseModel = { id: '22222222-2222-4222-8222-222222222222',
  code: 'enterprise-smoke', name: 'Enterprise smoke', streaming: true };
const modelFrames = () => `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk',
  created: 1, model: enterpriseModel.code, choices: [{ index: 0,
    delta: { role: 'assistant', content: 'Background enterprise model reached.' }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk',
    created: 1, model: enterpriseModel.code, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
  'data: [DONE]\n\n';
const jobIds: string[] = [];
const modelJobs: string[] = [];
let modelRequests = 0;
let personalModelRequests = 0;
let slowPersonalModel = false;
let slowPersonalAborted = false;
let stage = 'startup';
const revokedGrants = new Set<number>();
let activeCore: Awaited<ReturnType<typeof startDockerCore>> | undefined;
const servers: http.Server[] = [];
let gateway: Awaited<ReturnType<typeof startEnterpriseGateway>> | undefined;
const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
};
const rc2Port = await listen(http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/internal/rc2/background/health' &&
      req.headers.authorization === `Bearer ${serviceToken}`) {
    res.end(JSON.stringify({ code: 200, data: { ready: true } }));
    return;
  }
  const grantIndex = grantIds.findIndex((id) => req.url?.includes(`/grants/${id}`));
  if (revokedGrants.has(grantIndex) || req.headers.authorization !== `Bearer ${serviceToken}` || grantIndex < 0 ||
      req.headers['x-aion-background-secret'] !== secrets[grantIndex] || !jobIds[grantIndex]) {
    res.statusCode = 401; res.end(JSON.stringify({ code: 401 })); return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    modelRequests++;
    modelJobs.push(jobIds[grantIndex]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(modelFrames());
    return;
  }
  const data = req.url?.endsWith('/models/available') ? [enterpriseModel] :
    req.url?.includes('/resources?') ? [] :
    { userId: actor.userId, jobId: jobIds[grantIndex] };
  res.end(JSON.stringify({ code: 200, data }));
}));
const personalModelPort = await listen(http.createServer((_req, res) => {
  personalModelRequests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (slowPersonalModel) {
    res.write(': waiting\n\n');
    const timer = setTimeout(() => res.end(modelFrames()), 20_000);
    res.once('close', () => { clearTimeout(timer); if (!res.writableEnded) slowPersonalAborted = true; });
  } else res.end(modelFrames());
}));
const rc2Url = `http://127.0.0.1:${rc2Port}`;
const startCore = async () => {
  activeCore = await startDockerCore(actor);
  return activeCore;
};
const makeRuntime = () => {
  const runtime = createEnterpriseModelRuntime(async () => {
  let active = true;
  return { actor, username: 'employee', validate: async () => active,
    close: async () => { active = false; }, client: {
      me: async () => { if (!active) throw new Error('closed'); return { userId: actor.userId }; },
      availableModels: async () => [enterpriseModel], resources: async () => [], authorizedResource: async () => null,
      relayModel: async () => { modelRequests++; return new Response(modelFrames(),
        { headers: { 'content-type': 'text/event-stream' } }); },
      request: async (route: string, init: RequestInit) => ({
        response: new Response(null, { status: 200 }), body: { code: 200,
          data: init.method === 'POST' ? (() => {
            const targetJob = route.split('/')[4];
            if (!jobIds.includes(targetJob)) jobIds.push(targetJob);
            const index = jobIds.indexOf(targetJob);
            return { id: grantIds[index], jobId: targetJob, secret: secrets[index] };
          })() : null },
      }),
    } } as any;
  }, startCore, { profileRoot: root, background: { rc2Url, serviceToken } });
  runtimeForAuthorization = runtime;
  return runtime;
};
const makeGateway = async (runtime: ReturnType<typeof makeRuntime>) => startEnterpriseGateway({
  staticDir: path.resolve('out/renderer'), publicOrigin: 'https://workspace.example', port: 0,
  login: runtime.login, startCore: runtime.startCore, syncCronGrant: runtime.syncCronGrant,
  hasBackgroundJobs: runtime.hasBackgroundJobs, authorizeBackground: runtime.authorizeBackground,
  reconcileCronJobs: runtime.reconcileCronJobs,
});
const call = (port: number, method: string, route: string, cookie?: string, data?: unknown) =>
  new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { host: 'workspace.example', origin: 'https://workspace.example',
        ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => { const raw = Buffer.concat(parts).toString();
        resolve({ status: res.statusCode || 0, body: JSON.parse(raw),
          cookie: res.headers['set-cookie']?.[0].split(';')[0] }); });
    });
    req.once('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
try {
  const runtime = makeRuntime();
  gateway = await makeGateway(runtime);
  const login = await call(gateway.port, 'POST', '/enterprise/login', undefined,
    { username: 'employee', password: 'synthetic' });
  if (login.status !== 200 || !login.cookie) throw new Error('Login failed');
  const conversation = await call(gateway.port, 'POST', '/api/conversations', login.cookie,
    { type: 'aionrs', name: 'Background smoke',
      model: { provider_id: 'rc2-enterprise-model', model: enterpriseModel.code }, extra: {} });
  if (conversation.status !== 201 || !conversation.body.data?.id) throw new Error('Conversation failed');
  const assistants = await call(gateway.port, 'GET', '/api/assistants', login.cookie);
  const assistant = assistants.body.data?.find((item: any) => item.agent?.type === 'aionrs');
  if (!assistant?.id) throw new Error('Aionrs assistant unavailable');
  const agentConfig = { name: assistant.name, assistant_id: assistant.id, model_id: enterpriseModel.code,
    model: { provider_id: 'rc2-enterprise-model', model: enterpriseModel.code, use_model: enterpriseModel.code } };
  const scheduled = await call(gateway.port, 'POST', '/api/cron/jobs', login.cookie,
    { name: 'After restart', schedule: { kind: 'at', at_ms: Date.now() + 15_000 },
      prompt: 'Say hello after restart.', conversation_id: conversation.body.data.id, created_by: 'user',
      execution_mode: 'existing', agent_config: agentConfig });
  if (scheduled.status !== 201 || !scheduled.body.data?.id) throw new Error(`Cron failed ${JSON.stringify(scheduled.body)}`);
  const otherConversation = await call(gateway.port, 'POST', '/api/conversations', login.cookie,
    { type: 'aionrs', name: 'Second background smoke',
      model: { provider_id: 'rc2-enterprise-model', model: enterpriseModel.code }, extra: {} });
  if (otherConversation.status !== 201 || !otherConversation.body.data?.id) throw new Error('Second conversation failed');
  const otherScheduled = await call(gateway.port, 'POST', '/api/cron/jobs', login.cookie,
    { name: 'Second after restart', schedule: { kind: 'at', at_ms: Date.now() + 17_000 },
      prompt: 'Say hello from second job.', conversation_id: otherConversation.body.data.id, created_by: 'user',
      execution_mode: 'existing', agent_config: agentConfig });
  if (otherScheduled.status !== 201 || !otherScheduled.body.data?.id)
    throw new Error(`Second cron failed ${JSON.stringify(otherScheduled.body)}`);
  if (jobIds.length !== 2 || jobIds[0] !== scheduled.body.data.id || jobIds[1] !== otherScheduled.body.data.id)
    throw new Error('Distinct job grants were not issued');
  const internalRoute = `/api/cron/internal/active-conversation/${conversation.body.data.id}`;
  const coreLookup = (internal: boolean) => fetch(`http://127.0.0.1:${activeCore!.port}${internalRoute}`, {
    headers: { 'x-aion-enterprise-local-token': activeCore!.localToken,
      ...(internal ? { 'x-aionui-internal': '1' } : {}) },
  });
  const blockedFromBrowser = await fetch(`http://127.0.0.1:${gateway.port}${internalRoute}`, {
    headers: { host: 'workspace.example', origin: 'https://workspace.example', cookie: login.cookie },
  });
  if ((await coreLookup(false)).status !== 403 || (await coreLookup(true)).status !== 404 ||
      blockedFromBrowser.status !== 403)
    throw new Error('Inactive background route was accessible before dispatch');
  const logout = await call(gateway.port, 'POST', '/enterprise/logout', login.cookie);
  if (logout.status !== 200 || logout.body.backgroundTasksVerified !== true)
    throw new Error(`Logout background validation failed ${JSON.stringify(logout.body)}`);
  await gateway.stop(); gateway = undefined;
  if (modelRequests !== 0) throw new Error('Cron ran before restart');
  const resumed = makeRuntime();
  gateway = await makeGateway(resumed);
  const actors = await resumed.backgroundActors();
  if (actors.length !== 1 || actors[0].userId !== actor.userId) throw new Error('Background actor not restored');
  await gateway.startBackgroundCore(actors[0]);
  let runCounts: number[] = [];
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    runCounts = await Promise.all(jobIds.map(async (id) => {
      const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${id}`,
        { headers: { 'x-aion-enterprise-local-token': activeCore!.localToken } });
      const body = await response.json() as any;
      return body.data?.state?.run_count || 0;
    }));
    if (runCounts.every((count) => count >= 1) && modelRequests >= 2) break;
  }
  console.log(JSON.stringify({ backgroundActors: actors.length, runCounts, modelRequests,
    distinctModelGrants: new Set(modelJobs).size === 2,
    logoutVerified: logout.body.backgroundTasksVerified,
    inactiveRouteDenied: (await coreLookup(true)).status === 404 }));
  if (!runCounts.every((count) => count >= 1) || modelRequests !== 2 ||
      new Set(modelJobs).size !== 2 || jobIds.some((id) => !modelJobs.includes(id)))
    throw new Error('Cron jobs did not use their own model grants after host restart');
  if ((await coreLookup(true)).status !== 404) throw new Error('Background run authorization remained after completion');
  // One-shot jobs disable themselves. Keep their grants active while testing
  // a third personal job, then revoke each grant independently.
  for (const id of jobIds) {
    const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${id}`, {
      method: 'PUT', headers: { 'x-aion-enterprise-local-token': activeCore!.localToken,
        'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, schedule: { kind: 'every', every_ms: 600_000 } }),
    });
    const updated = await response.json() as any;
    if (!response.ok || updated.data?.enabled !== true) throw new Error('Cron re-enable fixture failed');
  }
  stage = 'register-personal-model';
  await activeCore!.registerProxyPort!(personalModelPort);
  stage = 'personal-login';
  const personalLogin = await call(gateway.port, 'POST', '/enterprise/login', undefined,
    { username: 'employee', password: 'synthetic' });
  if (personalLogin.status !== 200 || !personalLogin.cookie) throw new Error('Personal login failed');
  stage = 'personal-provider';
  const personalProvider = await call(gateway.port, 'POST', '/api/providers', personalLogin.cookie,
    { id: 'personal-smoke', platform: 'custom', name: 'Personal smoke',
      base_url: `http://model-gateway:${personalModelPort}/v1`, api_key: 'synthetic-key',
      models: ['smoke-personal'], model_protocols: { 'smoke-personal': 'openai' },
      model_settings: { 'smoke-personal': { openai_api_mode: 'chat_completions' } },
      capabilities: [{ type: 'text' }] });
  if (personalProvider.status !== 201) throw new Error(`Personal provider failed ${personalProvider.status}`);
  stage = 'personal-conversation';
  const personalConversation = await call(gateway.port, 'POST', '/api/conversations', personalLogin.cookie,
    { type: 'aionrs', name: 'Personal background',
      model: { provider_id: 'personal-smoke', model: 'smoke-personal' }, extra: {} });
  if (personalConversation.status !== 201 || !personalConversation.body.data?.id)
    throw new Error('Personal background conversation failed');
  stage = 'personal-job';
  const personalJob = await call(gateway.port, 'POST', '/api/cron/jobs', personalLogin.cookie,
    { name: 'Personal after restart', schedule: { kind: 'every', every_ms: 600_000 },
      prompt: 'Reply using the personal provider.', conversation_id: personalConversation.body.data.id,
      created_by: 'user', execution_mode: 'existing', agent_config: {
        name: assistant.name, assistant_id: assistant.id, model_id: 'smoke-personal',
        model: { provider_id: 'personal-smoke', model: 'smoke-personal', use_model: 'smoke-personal' },
      } });
  if (personalJob.status !== 201 || jobIds[2] !== personalJob.body.data?.id)
    throw new Error(`Personal background job failed ${personalJob.status}`);
  stage = 'personal-logout';
  if ((await call(gateway.port, 'POST', '/enterprise/logout', personalLogin.cookie)).status !== 200)
    throw new Error('Personal logout failed');
  stage = 'personal-run';
  const personalRun = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[2]}/run`, {
    method: 'POST', headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
  });
  if (!personalRun.ok) throw new Error('Personal run-now failed');
  let personalCompleted = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[2]}`, {
      headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
    });
    const state = (await response.json() as any).data?.state;
    if (personalModelRequests > 0 && state?.run_count >= 1 && state?.last_status === 'ok') {
      personalCompleted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!personalCompleted) throw new Error('Valid personal grant did not complete its model turn');
  stage = 'personal-revoked-run';
  const personalBeforeRevocation = personalModelRequests;
  revokedGrants.add(2);
  const revokedPersonalRun = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[2]}/run`, {
    method: 'POST', headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
  });
  if (!revokedPersonalRun.ok) throw new Error('Revoked personal run-now fixture failed');
  let personalPreflightDenied = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[2]}`, {
      headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
    });
    const state = (await response.json() as any).data?.state;
    if (state?.last_error === 'Background task authorization denied') {
      personalPreflightDenied = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!personalPreflightDenied || personalModelRequests !== personalBeforeRevocation)
    throw new Error('Revoked personal job reached its model before authorization check');
  stage = 'running-personal-revocation';
  revokedGrants.delete(2);
  slowPersonalModel = true;
  const slowRun = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[2]}/run`, {
    method: 'POST', headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
  });
  if (!slowRun.ok) throw new Error('Slow personal run-now failed');
  let activePersonalRun = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/internal/active-job/${jobIds[2]}`, {
      headers: { 'x-aion-enterprise-local-token': activeCore!.localToken, 'x-aionui-internal': '1' },
    });
    const body = await response.json() as any;
    if (body.data?.active === true && personalModelRequests > personalBeforeRevocation) {
      activePersonalRun = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!activePersonalRun) throw new Error('Slow personal run was not active');
  const recoveryLogin = await call(gateway.port, 'POST', '/enterprise/login', undefined,
    { username: 'employee', password: 'synthetic' });
  if (recoveryLogin.status !== 200 || !recoveryLogin.cookie)
    throw new Error('Interactive session for background revocation failed');
  revokedGrants.add(2);
  await gateway.reconcileAuthorization();
  for (let attempt = 0; attempt < 20 && !slowPersonalAborted; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 250));
  if (!slowPersonalAborted) throw new Error('Revoked running personal job kept its model stream');
  const recoveredSession = await call(gateway.port, 'GET', '/api/system/info', recoveryLogin.cookie);
  if (recoveredSession.status !== 200)
    throw new Error('Revoking one background job invalidated a valid employee session');
  if ((await call(gateway.port, 'POST', '/enterprise/logout', recoveryLogin.cookie)).status !== 200)
    throw new Error('Interactive recovery logout failed');
  const recoveredActors = await resumed.backgroundActors();
  if (recoveredActors.length !== 1) throw new Error('Valid background grants were lost after active revocation');
  await gateway.startBackgroundCore(actor);
  slowPersonalModel = false;
  stage = 'independent-grant-revocation';
  revokedGrants.add(0);
  const deniedRun = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[0]}/run`, {
    method: 'POST', headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
  });
  if (!deniedRun.ok) throw new Error('Revoked job run-now fixture was rejected before execution');
  let preflightDenied = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${jobIds[0]}`, {
      headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
    });
    const state = (await response.json() as any).data?.state;
    if (state?.last_error === 'Background task authorization denied') {
      preflightDenied = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!preflightDenied || modelRequests !== 2)
    throw new Error('Revoked job reached the model without a Core preflight denial');
  await gateway.reconcileAuthorization();
  const jobStates = await Promise.all(jobIds.map(async (id) => {
    const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${id}`, {
      headers: { 'x-aion-enterprise-local-token': activeCore!.localToken },
    });
    return (await response.json() as any).data?.enabled;
  }));
  if (jobStates[0] !== false || jobStates[1] !== true)
    throw new Error(`Revoked job was not disabled independently: ${JSON.stringify(jobStates)}`);
  revokedGrants.add(1);
  await gateway.reconcileAuthorization();
  const stoppedAfterRevocation = await fetch(`http://127.0.0.1:${activeCore!.port}/api/system/info`, {
    headers: { 'x-aion-enterprise-local-token': activeCore!.localToken }, signal: AbortSignal.timeout(2000),
  }).then(() => false, () => true);
  if (!stoppedAfterRevocation) throw new Error('Revoked background grants left Core running');
  await gateway.startBackgroundCore(actor).then(() => {
    throw new Error('Revoked background grant restarted Core');
  }, (error: Error) => {
    if (!error.message.includes('authorization unavailable')) throw error;
  });
  console.log(JSON.stringify({ revokedJobDisabledIndependently: jobStates,
    preflightDenied, personalPreflightDenied, slowPersonalAborted,
    validSessionSurvivedBackgroundRevocation: true, personalModelRequests,
    revokedBackgroundCoreStopped: stoppedAfterRevocation }));
} catch (error) {
  console.error(`Background binding smoke failed at ${stage}: ${String(error)}`);
  throw error;
} finally {
  await gateway?.stop();
  await supervisor.close();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await rm(root, { recursive: true, force: true });
}
