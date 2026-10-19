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
const startDockerCore = createEnterpriseDockerCoreStarter({ profileRoot: root, appVersion: '0.2.2',
  coreImage: image(process.env.AION_SMOKE_CORE_IMAGE || 'aionui-enterprise-core:dev'), gatewayImage, supervisor });
const serviceToken = 'a'.repeat(43);
const grantIds = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'];
const secrets = ['b'.repeat(64), 'c'.repeat(64)];
const enterpriseModel = { id: '22222222-2222-4222-8222-222222222222',
  code: 'enterprise-smoke', name: 'Enterprise smoke', streaming: true };
const assistantResourceId = '44444444-4444-4444-8444-444444444444';
const mcpResourceId = '55555555-5555-4555-8555-555555555555';
const connectionId = '66666666-6666-4666-8666-666666666666';
const assistantCatalog = { id: assistantResourceId, name: 'MCP background assistant',
  source: 'enterprise', ownerType: 'ENTERPRISE', actions: ['USE'], version: 1,
  publishedVersion: 1, description: 'Synthetic MCP job' };
const resource = (id: string) => ({ id, resourceType: id === assistantResourceId ? 'ASSISTANT' : 'MCP',
  version: 1, publishedVersion: 1, actions: ['USE'],
  config: id === assistantResourceId ? { modelId: enterpriseModel.id,
    instruction: 'Call enterprise_echo once.', skillIds: [], mcpIds: [mcpResourceId] } : {} });
const connection = { id: connectionId, enabled: true, status: 'READY', scope: 'ENTERPRISE' };
const modelFrames = (raw: string) => {
  const request = JSON.parse(raw);
  const tools = (request.tools || []).map((item: any) => String(item.function?.name || ''));
  const tool = tools.find((name: string) => name.includes('enterprise_echo'));
  const used = (request.messages || []).some((item: any) => item.role === 'tool');
  const chunk = (delta: unknown, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1,
      model: enterpriseModel.code, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return (tool && !used
    ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-enterprise-smoke', type: 'function',
      function: { name: tool, arguments: '{}' } }] }, null) + chunk({}, 'tool_calls')
    : chunk({ role: 'assistant', content: used ? 'Enterprise MCP tool completed.' : 'No MCP tool available.' }, null) +
      chunk({}, 'stop')) + 'data: [DONE]\n\n';
};
const jobIds: string[] = [];
const modelJobs: string[] = [];
const mcpJobs: string[] = [];
const observedTools: string[][] = [];
let modelRequests = 0;
let activeCore: Awaited<ReturnType<typeof startDockerCore>> | undefined;
const servers: http.Server[] = [];
let gateway: Awaited<ReturnType<typeof startEnterpriseGateway>> | undefined;
let liveSession: { close: () => Promise<void> } | undefined;
const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
};
const rc2Port = await listen(http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/internal/rc2/background/health' &&
      req.headers.authorization === `Bearer ${serviceToken}`) {
    res.end(JSON.stringify({ code: 200, data: { ready: true } }));
    return;
  }
  const grantIndex = grantIds.findIndex((id) => req.url?.includes(`/grants/${id}`));
  if (req.headers.authorization !== `Bearer ${serviceToken}` || grantIndex < 0 ||
      req.headers['x-aion-background-secret'] !== secrets[grantIndex] || !jobIds[grantIndex]) {
    res.statusCode = 401; res.end(JSON.stringify({ code: 401 })); return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    observedTools.push((JSON.parse(raw).tools || []).map((item: any) => String(item.function?.name || '')));
    modelRequests++;
    modelJobs.push(jobIds[grantIndex]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(modelFrames(raw));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith(`/mcp/connections/${connectionId}/relay`)) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.method === 'tools/call') mcpJobs.push(jobIds[grantIndex]);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const result = request.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'enterprise-mcp-smoke', version: '1.0.0' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'enterprise_echo', description: 'Record a job-scoped MCP call',
          inputSchema: { type: 'object', properties: {} } }] }
        : request.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'Enterprise MCP tool completed.' }] } : {};
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    return;
  }
  const data = req.url?.endsWith('/models/available') ? [enterpriseModel] :
    req.url?.includes('/resources?') ?
      (req.url.includes('type=ASSISTANT') && req.url.includes('scope=mine') && req.url.includes('page=1')
        ? [assistantCatalog] : []) :
    req.url?.endsWith(`/resources/${assistantResourceId}`) ? resource(assistantResourceId) :
    req.url?.endsWith(`/resources/${mcpResourceId}`) ? resource(mcpResourceId) :
    req.url?.includes('/mcp/connections?') ? [connection] :
    { userId: actor.userId, jobId: jobIds[grantIndex] };
  res.end(JSON.stringify({ code: 200, data }));
}));
const rc2Url = `http://127.0.0.1:${rc2Port}`;
const startCore = async () => {
  activeCore = await startDockerCore(actor);
  return activeCore;
};
const makeRuntime = () => createEnterpriseModelRuntime(async () => {
  let active = true;
  return { actor, username: 'employee', validate: async () => active,
    close: async () => { active = false; }, client: {
      me: async () => { if (!active) throw new Error('closed'); return { userId: actor.userId }; },
      availableModels: async () => [enterpriseModel],
      resources: async (type: string) => type === 'ASSISTANT' ? [assistantCatalog] : [],
      authorizedResource: async (id: string) => resource(id),
      readyMcpConnection: async () => ({ id: connectionId }),
      authorizedMcpConnection: async () => connection,
      relayMcp: async () => { throw new Error('Interactive MCP should not run after logout'); },
      relayModel: async (_id: string, raw: string) => { modelRequests++; return new Response(modelFrames(raw),
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
const makeGateway = async (runtime: ReturnType<typeof makeRuntime>) => startEnterpriseGateway({
  staticDir: path.resolve('out/renderer'), publicOrigin: 'https://workspace.example', port: 0,
  login: runtime.login, startCore: runtime.startCore, syncCronGrant: runtime.syncCronGrant,
  hasBackgroundJobs: runtime.hasBackgroundJobs, reconcileCronJobs: runtime.reconcileCronJobs,
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
  const mcpServers = await call(gateway.port, 'GET', '/api/mcp/servers', login.cookie);
  const selectedMcp = mcpServers.body.data?.find((item: any) => item.name === `rc2-enterprise-${mcpResourceId}`);
  if (mcpServers.status !== 200 || !selectedMcp?.id) throw new Error('Enterprise MCP not registered in Core');
  const extra = { mcp_server_ids: [selectedMcp.id] };
  const conversation = await call(gateway.port, 'POST', '/api/conversations', login.cookie,
    { type: 'aionrs', name: 'Background smoke',
      model: { provider_id: 'rc2-enterprise-model', model: enterpriseModel.code }, extra });
  if (conversation.status !== 201 || !conversation.body.data?.id) throw new Error('Conversation failed');
  const assistants = await call(gateway.port, 'GET', '/api/assistants', login.cookie);
  const assistant = assistants.body.data?.find((item: any) => item.id === `rc2-${assistantResourceId}`);
  if (!assistant?.id) throw new Error('Aionrs assistant unavailable');
  const agentConfig = { name: assistant.name, assistant_id: assistant.id, model_id: enterpriseModel.code,
    model: { provider_id: 'rc2-enterprise-model', model: enterpriseModel.code, use_model: enterpriseModel.code },
    mode: 'yolo' };
  const scheduled = await call(gateway.port, 'POST', '/api/cron/jobs', login.cookie,
    { name: 'After restart', schedule: { kind: 'at', at_ms: Date.now() + 15_000 },
      prompt: 'Say hello after restart.', conversation_id: conversation.body.data.id, created_by: 'user',
      execution_mode: 'existing', agent_config: agentConfig });
  if (scheduled.status !== 201 || !scheduled.body.data?.id) throw new Error(`Cron failed ${JSON.stringify(scheduled.body)}`);
  const otherConversation = await call(gateway.port, 'POST', '/api/conversations', login.cookie,
    { type: 'aionrs', name: 'Second background smoke',
      model: { provider_id: 'rc2-enterprise-model', model: enterpriseModel.code }, extra });
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
  // A second signed-in device must not displace the running job's grant.
  liveSession = await resumed.login('employee', 'synthetic');
  let runCounts: number[] = [];
  let jobStates: any[] = [];
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    jobStates = await Promise.all(jobIds.map(async (id) => {
      const response = await fetch(`http://127.0.0.1:${activeCore!.port}/api/cron/jobs/${id}`,
        { headers: { 'x-aion-enterprise-local-token': activeCore!.localToken } });
      const body = await response.json() as any;
      return { status: response.status, body };
    }));
    runCounts = jobStates.map((item) => item.body?.data?.state?.run_count || 0);
    if (jobStates.some((item) => item.status !== 200) ||
        (runCounts.every((count) => count >= 1) && new Set(mcpJobs).size === 2)) break;
  }
  console.log(JSON.stringify({ backgroundActors: actors.length, runCounts, modelRequests,
    distinctModelGrants: new Set(modelJobs).size === 2,
    mcpToolCalls: mcpJobs.length, distinctMcpGrants: new Set(mcpJobs).size === 2,
    toolsOffered: observedTools.every((tools) => tools.includes('enterprise_echo')),
    interactiveDevicePresent: Boolean(liveSession),
    logoutVerified: logout.body.backgroundTasksVerified,
    inactiveRouteDenied: (await coreLookup(true)).status === 404 }));
  if (!runCounts.every((count) => count >= 1) || modelRequests < 4 ||
      !observedTools.every((tools) => tools.includes('enterprise_echo')) ||
      new Set(modelJobs).size !== 2 || jobIds.some((id) => !modelJobs.includes(id) || !mcpJobs.includes(id))) {
    throw new Error(`Cron jobs did not use their own model and MCP grants after host restart: ${JSON.stringify(jobStates)}`);
  }
  if ((await coreLookup(true)).status !== 404) throw new Error('Background run authorization remained after completion');
} finally {
  await liveSession?.close();
  await gateway?.stop();
  await supervisor.close();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await rm(root, { recursive: true, force: true });
}
