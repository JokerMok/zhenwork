import { expect, test } from 'vitest';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enterpriseProfilePath } from './enterprise-core.js';
import { enterpriseManagedResourcePath, syncEnterpriseWebResources } from './enterprise-resource-runtime.js';
import type { Rc2GatewayClient } from './enterprise-rc2-login.mjs';

test('all authorized assistant Skill and MCP dependencies reach only that employee Core', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enterprise-resources-'));
  const actor = { serverId: 'rc2', userId: '42' };
  const profile = enterpriseProfilePath(root, actor);
  await mkdir(profile, { recursive: true });
  const assistantId = '11111111-1111-4111-8111-111111111111';
  const skillId = '22222222-2222-4222-8222-222222222222';
  const secondSkillId = '33333333-3333-4333-8333-333333333333';
  const firstMcpId = '44444444-4444-4444-8444-444444444444';
  const secondMcpId = '55555555-5555-4555-8555-555555555555';
  const writes: Array<{ route: string; body: Record<string, unknown> }> = [];
  const core = http.createServer(async (req, res) => {
    if (req.headers['x-aion-enterprise-local-token'] !== 'local-secret') {
      res.writeHead(401).end(); return;
    }
    const raw: Buffer[] = [];
    for await (const chunk of req) raw.push(chunk);
    const body = raw.length ? JSON.parse(Buffer.concat(raw).toString()) as Record<string, unknown> : {};
    writes.push({ route: req.url || '', body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/mcp/servers' && req.method === 'GET') res.end(JSON.stringify({ success: true, data: [] }));
    else if (req.url === '/api/skills') res.end(JSON.stringify({ success: true, data: [] }));
    else if (req.url === '/api/assistants' && req.method === 'GET')
      res.end(JSON.stringify({ success: true, data: [{ agent: { type: 'aionrs' }, agent_id: 'agent-1' }] }));
    else if (req.url === '/api/skills/import') {
      const source = await readFile(path.join(String(body.skill_path), 'SKILL.md'), 'utf8');
      const name = /^name: ([a-z0-9-]+)$/m.exec(source)?.[1];
      res.end(JSON.stringify({ success: true, data: { skill_name: name } }));
    }
    else if (req.url === '/api/mcp/servers' && req.method === 'POST') res.end(JSON.stringify({ success: true,
      data: { id: `mcp-${body.name}`, name: body.name, enabled: true } }));
    else if (req.url === '/api/assistants' && req.method === 'POST')
      res.end(JSON.stringify({ success: true, data: { id: body.id } }));
    else res.end(JSON.stringify({ success: true, data: {} }));
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
  const port = (core.address() as { port: number }).port;
  const client = {
    resources: async () => [{ id: assistantId, name: 'Test assistant', source: 'enterprise', version: 2 }],
    authorizedResource: async (id: string) => id === assistantId
      ? { version: 2, config: { modelId: 'model-1', instruction: 'Use the Skills and MCPs.',
        skillIds: [skillId, secondSkillId], mcpIds: [firstMcpId, secondMcpId] } }
      : id === skillId || id === secondSkillId
        ? { version: 3, config: { manifest: { name: 'safe-skill' },
          source: `---\nname: safe-skill\n---\n${id === skillId ? 'Use safely.' : 'Use differently.'}` } }
        : { version: 4, config: {} },
    readyMcpConnection: async (id: string) => ({ id: `connection-${id}` }),
    authorizedMcpConnection: async () => ({ enabled: true }),
  } as unknown as Rc2GatewayClient;
  try {
    const synced = await syncEnterpriseWebResources(actor, { port, localToken: 'local-secret', stop: async () => {} },
      root, { id: 'model-1', code: 'model-code' }, async () => client, async () => client);
    const manifest = JSON.parse(await readFile(await enterpriseManagedResourcePath(root, actor), 'utf8'));
    const skillNames = [skillId, secondSkillId].map((id) => `safe-skill-${id.replaceAll('-', '')}`);
    expect(manifest.skills).toEqual(skillNames);
    expect(manifest.mcpIds).toHaveLength(2);
    expect(manifest.assistantIds).toEqual([`rc2-${assistantId}`]);
    expect(writes.some(({ route, body }) => route === '/api/assistants' && body.id === `rc2-${assistantId}`)).toBe(true);
    const assistant = writes.find(({ route, body }) => route === '/api/assistants' && body.id === `rc2-${assistantId}`)!.body;
    expect(assistant.custom_skill_names).toEqual(skillNames);
    expect((assistant.defaults as { mcps: { value: string[] } }).mcps.value).toHaveLength(2);
    expect(writes.some(({ route }) => route === '/api/skills/assistant-rule/write')).toBe(true);
    await synced.stop();
    expect((await readdir(profile)).some((entry) => entry.startsWith('rc2-stage-'))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('host resource control directory refuses a symlink into an employee profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enterprise-control-link-'));
  const actor = { serverId: 'rc2', userId: '42' };
  const profile = enterpriseProfilePath(root, actor);
  await mkdir(profile, { recursive: true });
  try {
    await symlink(profile, path.join(root, 'control'));
    await expect(enterpriseManagedResourcePath(root, actor)).rejects.toThrow('control directory invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});
