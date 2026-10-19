import { expect, test } from 'vitest';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnterpriseModelRuntime } from './enterprise-model-runtime.js';
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
