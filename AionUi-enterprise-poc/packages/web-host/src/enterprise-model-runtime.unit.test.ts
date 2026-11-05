import { expect, test, vi } from 'vitest';
import * as resourceRuntime from './enterprise-resource-runtime.js';
import * as officeTools from './office/office-tools.js';
import { randomUUID } from 'node:crypto';
import { readEmployeePreferences, saveEmployeePreferences } from './read-model/preferences.js';
import { TaskStore } from './tasks/store.js';
import { currentAttempt } from './tasks/types.js';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnterpriseModelRuntime } from './enterprise-model-runtime.js';
import { startEnterpriseGateway } from './enterprise-gateway.js';
import { enterpriseProfilePath } from './enterprise-core.js';
import { enterpriseManagedResourcePath } from './enterprise-resource-runtime.js';

test('enterprise model proxy keeps serving an actor through another valid RC2 device session', async () => {
  let provider: { base_url: string; api_key: string } | null = null;
  const core = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/providers') res.end(JSON.stringify({ success: true, data: [] }));
      else if (req.method === 'POST' && req.url === '/api/providers') {
        provider = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.end(JSON.stringify({ success: true, data: { id: 'rc2-enterprise-model' } }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
  const corePort = (core.address() as { port: number }).port;
  let issued = 0;
  const session = async () => {
    const device = ++issued;
    let active = true;
    return { actor: { serverId: 'rc2', userId: '17' }, username: 'employee',
      client: {
        me: async () => { if (!active) throw new Error('revoked'); return { userId: '17' }; },
        availableModels: async () => [{ id: 'model-1', code: 'enterprise-model', name: 'Enterprise', streaming: true }],
        relayModel: async () => new Response(`data: device-${device}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
        resources: async () => [], authorizedResource: async () => null,
      },
      validate: async () => active,
      close: async () => { active = false; },
    };
  };
  const runtime = createEnterpriseModelRuntime(session,
    async () => ({ port: corePort, localToken: 'local-test-token', stop: async () => {} }),
    { rc2Resume: async (cookie) => {
      if (cookie !== 'valid-rc2-cookie') throw new Error('Invalid cookie');
      return session();
    } });
  let handle: Awaited<ReturnType<typeof runtime.startCore>> | undefined;
  try {
    const first = await runtime.login('employee', 'test');
    handle = await runtime.startCore(first.actor);
    expect(provider).not.toBeNull();
    const endpoint = (provider as unknown as { base_url: string; api_key: string });
    const relay = () => fetch(`${endpoint.base_url}/conversations/a1b2c3d4/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${endpoint.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'enterprise-model', stream: true }) });
    expect(await (await relay()).text()).toContain('device-1');
    expect((await fetch(`${endpoint.base_url}/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${endpoint.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'enterprise-model', stream: true }) })).status).toBe(404);
    const second = await runtime.resume!('valid-rc2-cookie');
    await first.close();
    expect(await (await relay()).text()).toContain('device-2');
    await second.close();
  } finally {
    await handle?.stop();
    if (provider) {
      const endpoint = provider as { base_url: string; api_key: string };
      await expect(fetch(`${endpoint.base_url}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${endpoint.api_key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'enterprise-model', stream: true }),
        signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    }
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
});

test('personal-only web Core removes prior RC2 resources and preserves personal resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enterprise-personal-only-'));
  const actor = { serverId: 'rc2', userId: '17' };
  await mkdir(enterpriseProfilePath(root, actor), { recursive: true });
  const managed = await enterpriseManagedResourcePath(root, actor);
  const assistantId = 'rc2-11111111-1111-4111-8111-111111111111';
  await writeFile(managed, JSON.stringify({ skills: ['rc2-skill'], mcpIds: ['enterprise-mcp'],
    assistantIds: [assistantId] }));
  const deleted: string[] = [];
  const core = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'DELETE') { deleted.push(req.url || ''); res.end(JSON.stringify({ success: true })); return; }
    const data = req.url === '/api/providers' ? [
      { id: 'rc2-enterprise-model', platform: 'custom', base_url: 'http://127.0.0.1:4444' },
      { id: 'personal-model', platform: 'custom', base_url: 'https://personal.example' },
    ] : req.url === '/api/mcp/servers' ? [
      { id: 'enterprise-mcp', name: 'rc2-enterprise-11111111-1111-4111-8111-111111111111',
        description: 'RC2 authorized enterprise MCP', transport: { type: 'http', url: 'http://127.0.0.1:5555/mcp' } },
      { id: 'personal-mcp', name: 'personal-mcp' },
    ] : req.url === '/api/assistants' ? [
      { id: assistantId, agent_id: 'agent-1', agent: { type: 'aionrs' } },
      { id: 'personal-assistant', agent_id: 'agent-1' },
    ] : [];
    res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
  const port = (core.address() as { port: number }).port;
  const runtime = createEnterpriseModelRuntime(async () => ({ actor, username: 'employee',
    client: { me: async () => ({ userId: '17' }), availableModels: async () => [],
      resources: async () => [], authorizedResource: async () => null },
    validate: async () => true, close: async () => {},
  }), async () => ({ port, localToken: 'local-test-token', stop: async () => {} }), { profileRoot: root });
  let handle: Awaited<ReturnType<typeof runtime.startCore>> | undefined;
  try {
    const login = await runtime.login('employee', 'secret');
    handle = await runtime.startCore(login.actor);
    expect(deleted).toEqual(expect.arrayContaining([
      `/api/assistants/${assistantId}`, '/api/skills/rc2-skill',
      '/api/mcp/servers/enterprise-mcp', '/api/providers/rc2-enterprise-model',
    ]));
    expect(deleted.some((route) => route.includes('personal'))).toBe(false);
    expect(JSON.parse(await readFile(managed, 'utf8'))).toEqual({ skills: [], mcpIds: [], assistantIds: [] });
    await login.close();
  } finally {
    await handle?.stop();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('resource refresh stays actor-scoped, defers while busy, and preserves committed control writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enterprise-refresh-'));
  const actor = { serverId: 'rc2', userId: '17' };
  const otherActor = { serverId: 'rc2', userId: '18' };
  await mkdir(enterpriseProfilePath(root, actor), { recursive: true });
  let idle = true;
  let checkFailed = false;
  let models = [
    { id: 'model-a', code: 'shared-vendor-code', name: 'Alpha', streaming: true },
    { id: 'model-b', code: 'shared-vendor-code', name: 'Beta', streaming: true },
  ];
  const providers: Array<Record<string, unknown>> = [];
  const assistants: Array<Record<string, unknown>> = [
    { id: 'aionrs-catalog', agent_id: 'agent-1', agent: { type: 'aionrs' } },
  ];
  const coreCalls: Array<{ method: string; route: string; body: Record<string, unknown> | undefined }> = [];
  let settings: Record<string, unknown> = {};
  let mcpSequence = 0;
  const mcps: Array<Record<string, unknown>> = [];
  const coreServer = http.createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    const route = req.url || '';
    coreCalls.push({ method: req.method || 'GET', route, body });
    res.setHeader('content-type', 'application/json');
    const send = (data: unknown, status = 200) => { res.statusCode = status;res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && route === '/api/providers') return send({ success: true, data: providers });
    if (req.method === 'POST' && route === '/api/providers') {
      const saved = { ...body, id: String(body?.id) };providers.push(saved);return send({ success: true, data: saved }, 201);
    }
    if (req.method === 'PUT' && route === '/api/providers/rc2-enterprise-model') {
      Object.assign(providers.find((item) => item.id === 'rc2-enterprise-model')!, body);return send({ success: true, data: { id: 'rc2-enterprise-model' } });
    }
    if (req.method === 'GET' && route === '/api/mcp/servers') return send({ success: true, data: mcps });
    if (req.method === 'POST' && route === '/api/mcp/servers') {
      const saved = { ...body, id: `mcp-${++mcpSequence}`, enabled: true };mcps.push(saved);return send({ success: true, data: saved }, 201);
    }
    if (req.method === 'DELETE' && route.startsWith('/api/mcp/servers/')) {
      const id = route.split('/').at(-1);const index = mcps.findIndex((item) => item.id === id);if (index >= 0) mcps.splice(index, 1);
      return send({ success: true, data: { ok: true } });
    }
    if (req.method === 'GET' && route === '/api/assistants') return send({ success: true, data: assistants });
    if (req.method === 'POST' && route === '/api/assistants') {
      assistants.push(body!);return send({ success: true, data: body }, 201);
    }
    if (req.method === 'GET' && route === '/api/skills') return send({ success: true, data: [] });
    if (req.method === 'PUT' && route === '/api/assistants/zhenwork-general-office') {
      Object.assign(assistants.find((item) => item.id === 'zhenwork-general-office')!, body);return send({ success: true, data: body });
    }
    if (req.method === 'POST' && route === '/api/skills/assistant-rule/write') return send({ success: true, data: { ok: true } });
    if (req.method === 'GET' && route === '/api/settings/client') return send({ success: true, data: settings });
    if (req.method === 'PUT' && route === '/api/settings/client') { settings = { ...settings, ...body };return send({ success: true, data: settings }); }
    if (req.method === 'GET' && route === '/api/cron/internal/idle-ready' && checkFailed) return send({}, 503);
    if (req.method === 'GET' && route === '/api/cron/internal/idle-ready') return send({ success: true, data: { idle } });
    return send({ success: false }, 404);
  })().catch(() => { res.statusCode = 500;res.end('{}'); }); });
  await new Promise<void>((resolve) => coreServer.listen(0, '127.0.0.1', resolve));
  const corePort = (coreServer.address() as { port: number }).port;

  let controlWrites = 0;
  const rc2Server = http.createServer((_req, res) => {
    controlWrites += 1;res.setHeader('content-type', 'application/json');res.end(JSON.stringify({ code: 200, data: { committed: true } }));
  });
  await new Promise<void>((resolve) => rc2Server.listen(0, '127.0.0.1', resolve));
  const rc2Port = (rc2Server.address() as { port: number }).port;
  const client = {
    baseUrl: `http://127.0.0.1:${rc2Port}`, cookie: 'session=actor-17', clientId: 'client-17', origin: 'https://work.example',
    me: async () => ({ userId: '17' }),
    availableModels: async () => models,
    relayModel: async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    resources: async () => [], authorizedResource: async () => null,
  };
  const runtime = createEnterpriseModelRuntime(async () => ({ actor, username: 'employee', client: client as never,
    validate: async () => true, close: async () => {},
  }), async () => ({ port: corePort, localToken: 'core-token', stop: async () => {},
    networkMode: 'container', proxyHost: 'model-gateway',
    registerProxyPort: async () => {}, unregisterProxyPort: async () => {} }), { profileRoot: root });
  let handle: Awaited<ReturnType<typeof runtime.startCore>> | undefined;
  try {
    const login = await runtime.login('employee', 'secret');
    handle = await runtime.startCore(actor);
    const createdProvider = coreCalls.find((call) => call.method === 'POST' && call.route === '/api/providers')?.body as { models: string[] };
    expect(createdProvider.models).toEqual(['rc2-model-a', 'rc2-model-b']);
    const officeMcp = coreCalls.find((call) => call.method === 'POST' && call.route === '/api/mcp/servers')?.body as {
      name: string; transport: { url: string };
    };
    expect(officeMcp.name).toBe('rc2-enterprise-zhenwork-office-tools');
    expect(officeMcp.transport.url).toMatch(/^http:\/\/model-gateway:\d+\/mcp$/);
    expect((assistants.find((item) => item.id === 'zhenwork-general-office')?.defaults as { model: { value: string } }).model.value).toBe('rc2-model-a');

    await expect(runtime.refreshResources(otherActor)).rejects.toThrow('RESOURCE_REFRESH_UNAVAILABLE');
    checkFailed = true;
    await expect(runtime.refreshResources(actor)).resolves.toEqual({ state: 'pending', reason: 'CHECK_FAILED' });
    checkFailed = false;
    idle = false;
    await expect(Promise.all([runtime.refreshResources(actor), runtime.refreshResources(actor), runtime.refreshResources(actor)])).resolves.toEqual(Array(3).fill({ state: 'pending', reason: 'TASK_ACTIVE' }));
    expect(runtime.resourceStatus?.(actor)).toEqual({ state: 'pending', reason: 'TASK_ACTIVE' });
    expect(coreCalls.filter((call) => call.method === 'PUT' && call.route === '/api/providers/rc2-enterprise-model')).toHaveLength(0);
    const committed = await runtime.controlRequest(actor, '/ai/resources/example', { method: 'POST', body: '{}' });
    expect(committed.status).toBe(200);
    expect(controlWrites).toBe(1);
    const issues = await runtime.controlRequest(actor, '/ai/resources/runtime-issues', { method: 'GET' });
    expect(issues.status).toBe(200);
    expect(await issues.json()).toEqual([]);
    expect(controlWrites).toBe(1);

    models = [
      { id: 'model-b', code: 'shared-vendor-code', name: 'Beta renamed', streaming: true },
      { id: 'model-a', code: 'shared-vendor-code', name: 'Alpha', streaming: true },
    ];
    idle = true;
    await Promise.all([runtime.refreshResources(actor), runtime.refreshResources(actor)]);
    const updates = coreCalls.filter((call) => call.method === 'PUT' && call.route === '/api/providers/rc2-enterprise-model');
    expect(updates).toHaveLength(1);
    expect(updates[0].body?.models).toEqual(['rc2-model-b', 'rc2-model-a']);
    expect((assistants.find((item) => item.id === 'zhenwork-general-office')?.defaults as { model: { value: string } }).model.value).toBe('rc2-model-b');
    expect(runtime.resourceStatus?.(actor)).toEqual({ state: 'ready' });
    await login.close();
  } finally {
    await handle?.stop();
    await new Promise<void>((resolve) => coreServer.close(() => resolve()));
    await new Promise<void>((resolve) => rc2Server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('gateway accepts one deferred update without treating an active task as a configuration failure', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'enterprise-refresh-gateway-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  const coreServer = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json');res.end('{}'); });
  await new Promise<void>((resolve) => coreServer.listen(0, '127.0.0.1', resolve));
  const corePort = (coreServer.address() as { port: number }).port;
  const gateway = await startEnterpriseGateway({
    staticDir, publicOrigin: 'https://workspace.example', port: 0,
    login: async () => ({ actor: { serverId: 'rc2', userId: '17' }, validate: async () => true, close: async () => {} }),
    startCore: async () => ({ port: corePort, localToken: 'core-token', stop: async () => {} }),
    resourceStatus: () => ({ state: 'pending', reason: 'TASK_ACTIVE' }),
    refreshResources: async () => ({ state: 'pending', reason: 'TASK_ACTIVE' }),
  });
  const request = (route: string, cookie?: string, payload?: unknown, method = 'POST') => new Promise<{
    status: number; headers: http.IncomingHttpHeaders; body: string;
  }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method, headers: {
      host: 'workspace.example', origin: 'https://workspace.example', ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    } }, (res) => { const chunks: Buffer[] = [];res.on('data', (chunk: Buffer) => chunks.push(chunk));res.on('end', () => resolve({
      status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
    })); });
    req.once('error', reject);req.end(payload ? JSON.stringify(payload) : undefined);
  });
  try {
    const login = await request('/enterprise/login', undefined, { username: 'employee', password: 'secret' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']?.[0].split(';')[0];
    const unauth = await request('/enterprise/resources/status', undefined, undefined, 'GET');
    expect(unauth.status).toBe(401);
    const status = await request('/enterprise/resources/status', cookie, undefined, 'GET');
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ state: 'pending', reason: 'TASK_ACTIVE' });
    const dormant = await request('/enterprise/resources/refresh', cookie);
    expect(JSON.parse(dormant.body)).toMatchObject({ applyOnNextStart: true });
    await request('/enterprise/ready', cookie, undefined, 'GET');
    await new Promise((resolve) => setImmediate(resolve));
    const refresh = await request('/enterprise/resources/refresh', cookie);
    expect(refresh.status).toBe(202);
    expect(JSON.parse(refresh.body)).toEqual({ ok: true, state: 'pending', reason: 'TASK_ACTIVE' });
  } finally {
    await gateway.stop();
    await new Promise<void>((resolve) => coreServer.close(() => resolve()));
    await rm(staticDir, { recursive: true, force: true });
  }
});


test('only trusted receipt callbacks attach the Host service credential', async () => {
  const seen: Array<{ route: string; service?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ route: req.url!, service: req.headers['x-zhenwork-host-service'] as string | undefined });
    res.setHeader('content-type', 'application/json');res.end(JSON.stringify({ code: 200, data: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const actor = { serverId: 'receipt-test', userId: '17' };
  const client = { baseUrl: `http://127.0.0.1:${port}`, cookie: 'session=17', clientId: 'qa', origin: 'https://work.example', me: async () => ({ userId: '17' }) };
  const runtime = createEnterpriseModelRuntime(async () => ({ actor, client: client as never, validate: async () => true, close: async () => {} }), async () => { throw Error('unused'); }, { background: { rc2Url: client.baseUrl, serviceToken: 'a'.repeat(40) } });
  const login = await runtime.login('qa', 'unused', { ipAddress: '127.0.0.1', userAgent: 'qa' });
  try {
    await runtime.taskFeedbackRequest!(actor, '/ai/me/feedback', { method: 'POST', body: '{}' });
    await runtime.controlRequest!(actor, '/ai/me/feedback', { method: 'POST', body: '{}' });
    expect(seen.map((request) => request.service)).toEqual(['Bearer ' + 'a'.repeat(40), undefined]);
    await expect(runtime.taskFeedbackRequest!(actor, '/ai/models', { method: 'POST' })).rejects.toThrow('HOST_RECEIPT_ROUTE_UNAVAILABLE');
    await expect(runtime.taskFeedbackRequest!(actor, '/ai/me/feedback', { method: 'DELETE' })).rejects.toThrow('HOST_RECEIPT_ROUTE_UNAVAILABLE');
    expect(seen).toHaveLength(2);
  } finally { await login.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('a Core without a streaming model still probes and records version-bound dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zhenwork-probe-no-model-'));
  const receipts: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = '';req.on('data', (chunk) => { body += chunk; });req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/providers') return res.end(JSON.stringify({ success: true, data: [] }));
      receipts.push(JSON.parse(body));res.end(JSON.stringify({ code: 200, data: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const actor = { serverId: 'probe-test', userId: '17' }, id = '11111111-1111-4111-a111-111111111111';
  const digest = 'a'.repeat(64), image = 'sha256:' + 'b'.repeat(64);
  const inventory = vi.fn(async () => ({ python: { openpyxl: '3.1.5' } }));
  const sync = vi.spyOn(resourceRuntime, 'syncEnterpriseWebResources').mockImplementation(async (...args) => {
    const probe = args[8]!;expect(typeof probe).toBe('function');
    await probe({ core: { port, host: '127.0.0.1', networkMode: 'container' }, skills: [] });
    return { issues: [], dependencyProbes: { [id]: { resourceId: id, resourceVersion: 2, packageSha256: digest, state: 'READY', declarations: [] } }, invalidated: new Promise<void>(() => {}), stop: async () => {}, trustedConfirmation: async () => false };
  });
  const client = { baseUrl: `http://127.0.0.1:${port}`, cookie: 'session=17', clientId: 'qa', origin: 'https://work.example', me: async () => ({ userId: '17' }), availableModels: async () => [] };
  const runtime = createEnterpriseModelRuntime(async () => ({ actor, client: client as never, validate: async () => true, close: async () => {} }), async () => ({ port, host: '127.0.0.1', networkMode: 'container', runtimeFingerprint: image, readDependencyInventory: inventory, localToken: 'local', stop: async () => {} }), { profileRoot: root, background: { rc2Url: client.baseUrl, serviceToken: 'c'.repeat(40) } });
  let core: Awaited<ReturnType<typeof runtime.startCore>> | undefined;
  try {
    await runtime.login('qa', 'unused', { ipAddress: '127.0.0.1', userAgent: 'qa' });
    core = await runtime.startCore(actor);
    expect(inventory).toHaveBeenCalledOnce();
    expect(receipts[0]).toMatchObject({ resourceVersion: 2, packageSha256: digest, runtimeFingerprint: image, state: 'READY' });
    expect(receipts[0]).not.toHaveProperty('actorUserId');
  } finally { await core?.stop();sync.mockRestore();await new Promise<void>((resolve) => server.close(() => resolve()));await rm(root, { recursive: true, force: true }); }
});

test('the authenticated relay applies one preference snapshot through selected models and background grants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zhenwork-preferences-relay-'));
  const actor = { serverId: 'rc2', userId: '17' };
  const conversation = 'a1b2c3d4';
  const cronJob = 'cron_0123456789';
  const models = [
    { id: 'model-a', code: 'default-vendor-model', name: 'Default', streaming: true },
    { id: 'model-b', code: 'chosen-vendor-model', name: 'Selected', streaming: true },
  ];
  const cronGrant = { id: randomUUID(), jobId: cronJob, userId: actor.userId, secret: 'a'.repeat(64) };
  const taskStore = await TaskStore.create(root, actor);
  const preferences = { expectedVersion: 0, enabled: true, style: 'direct', detail: 'brief', language: 'en-US', instructions: 'Use a clear heading named Controlled Context.' };
  await saveEmployeePreferences(root, actor, preferences);
  const accepted = await taskStore.accept(conversation, randomUUID(), { content: 'Reply in Chinese.' }, false, false,
    () => readEmployeePreferences(root, actor));
  const attempt = currentAttempt(accepted.task);
  const taskGrant = { ...cronGrant, id: randomUUID(), jobId: attempt.jobId };
  const control = path.dirname(await enterpriseManagedResourcePath(root, actor));
  await writeFile(path.join(control, 'background-grants.json'), JSON.stringify({ actor, grants: [cronGrant] }), { mode: 0o600 });
  await writeFile(path.join(control, 'task-grants.json'), JSON.stringify({ actor, grants: [taskGrant] }), { mode: 0o600 });

  let provider: { base_url: string; api_key: string } | undefined;
  let turnId = 'turn_12345678';
  let cronActive = false;
  let nativeReadFailure = false;
  const received: Array<{ model: string; raw: string; via: string }> = [];
  const stream = () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const route = req.url || '';
    if (route.startsWith('/internal/rc2/background/grants/')) {
      const grant = [cronGrant, taskGrant].find((entry) => route.includes(entry.id));
      if (!grant || req.headers['x-aion-background-secret'] !== grant.secret) return send({}, 403);
      if (route.endsWith('/models/available')) return send({ code: 200, data: models });
      if (route.endsWith('/chat/completions')) {
        const model = route.split('/').at(-3)!;
        received.push({ model, raw, via: grant.jobId });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
        return;
      }
      return send({ code: 200, data: { userId: actor.userId, jobId: grant.jobId } });
    }
    if (route === '/api/providers' && req.method === 'POST') {
      provider = JSON.parse(raw);
      return send({ success: true, data: { id: 'rc2-enterprise-model' } });
    }
    if (route === '/api/providers') return send({ success: true, data: [] });
    if (route === `/api/cron/internal/active-conversation/${conversation}`) {
      return cronActive ? send({ success: true, data: { job_id: cronJob } }) : send({}, 404);
    }
    if (route === `/api/conversations/${conversation}`) {
      return nativeReadFailure ? send({}, 502) : send({ success: true, data: { runtime: { turn_id: turnId } } });
    }
    return send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const sync = vi.spyOn(resourceRuntime, 'syncEnterpriseWebResources').mockResolvedValue({
    issues: [], dependencyProbes: {}, invalidated: new Promise(() => {}), stop: async () => {}, trustedConfirmation: async () => false,
  } as Awaited<ReturnType<typeof resourceRuntime.syncEnterpriseWebResources>>);
  const office = vi.spyOn(officeTools, 'startOfficeTools').mockResolvedValue({
    mcpId: 'office-test', stop: async () => {}, trustedConfirmation: async () => false,
  });
  const assistant = vi.spyOn(officeTools, 'ensureOfficeAssistant').mockResolvedValue(undefined);
  const runtime = createEnterpriseModelRuntime(async () => ({
    actor, validate: async () => true, close: async () => {}, client: {
      me: async () => ({ userId: actor.userId }), availableModels: async () => models,
      relayModel: async (model: string, raw: string) => {
        received.push({ model, raw, via: 'interactive' });
        return stream();
      },
    } as never,
  }), async () => ({ port, localToken: 'core-token', stop: async () => {} }), {
    profileRoot: root, background: { rc2Url: `http://127.0.0.1:${port}`, serviceToken: 's'.repeat(40) },
  });
  const login = await runtime.login('employee', 'fixture', { ipAddress: '127.0.0.1', userAgent: 'test' });
  let core: Awaited<ReturnType<typeof runtime.startCore>> | undefined;
  try {
    core = await runtime.startCore(actor);
    const messages = [
      { role: 'system', content: 'Use only authorized tools and required business formats.' },
      { role: 'user', content: 'Reply in Chinese.' },
    ];
    const relay = async (model: string, expectedStatus = 200) => {
      const response = await fetch(`${provider!.base_url}/conversations/${conversation}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${provider!.api_key}` },
        body: JSON.stringify({ model, stream: true, messages }),
      });
      expect(response.status).toBe(expectedStatus);
      await response.text();
      return received.at(-1)!;
    };
    const first = await relay('rc2-model-a');
    const projected = (JSON.parse(first.raw) as { messages: typeof messages }).messages;
    expect(projected[0].content).toContain('required business formats');
    expect(projected[0].content).not.toContain('Controlled Context');
    expect(projected[1].content).toContain('Controlled Context');
    expect(projected[1].content).toMatch(/Reply in Chinese\.$/);

    await saveEmployeePreferences(root, actor, { ...preferences, expectedVersion: 1, enabled: false });
    expect((await relay('rc2-model-a')).raw).toBe(first.raw);
    const callsWithSnapshot = received.length;
    nativeReadFailure = true;
    await relay('rc2-model-a', 502);
    expect(received).toHaveLength(callsWithSnapshot);
    nativeReadFailure = false;
    turnId = 'turn_87654321';
    expect((await relay('rc2-model-a')).raw).not.toContain('Controlled Context');
    nativeReadFailure = true;
    expect((await relay('rc2-model-a')).raw).not.toContain('Controlled Context');
    nativeReadFailure = false;

    await taskStore.mutate(conversation, attempt.id, (record) => { record.state = 'running'; });
    runtime.bindTask(actor, conversation, attempt.jobId);
    const selected = await relay('rc2-model-b');
    expect(selected).toMatchObject({ model: 'model-b', via: attempt.jobId });
    expect(selected.raw).toContain('Controlled Context');

    runtime.bindTask(actor, conversation, undefined, attempt.jobId);
    await taskStore.mutate(conversation, attempt.id, (record) => { record.state = 'completed'; });
    cronActive = true;
    turnId = 'turn_11223344';
    await saveEmployeePreferences(root, actor, { ...preferences, expectedVersion: 2 });
    await login.close();
    const scheduled = await relay('rc2-model-b');
    expect(scheduled).toMatchObject({ model: 'model-b', via: cronJob });
    expect(scheduled.raw).toContain('Controlled Context');
  } finally {
    await login.close();
    await core?.stop();
    assistant.mockRestore();
    office.mockRestore();
    sync.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
