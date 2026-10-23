import { expect, test } from 'vitest';
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
    refreshResources: async () => ({ state: 'pending', reason: 'TASK_ACTIVE' }),
  });
  const request = (route: string, cookie?: string, payload?: unknown) => new Promise<{
    status: number; headers: http.IncomingHttpHeaders; body: string;
  }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method: 'POST', headers: {
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
    const refresh = await request('/enterprise/resources/refresh', cookie);
    expect(refresh.status).toBe(202);
    expect(JSON.parse(refresh.body)).toEqual({ ok: true, state: 'pending', reason: 'TASK_ACTIVE' });
  } finally {
    await gateway.stop();
    await new Promise<void>((resolve) => coreServer.close(() => resolve()));
    await rm(staticDir, { recursive: true, force: true });
  }
});
