import { expect, test } from 'vitest';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enterpriseProfilePath } from './enterprise-core.js';
import { enterpriseManagedResourcePath, syncEnterpriseWebResources } from './enterprise-resource-runtime.js';
import type { Rc2GatewayClient } from './enterprise-rc2-login.mjs';

test.each(['assistant dependencies', 'standalone authorization', 'mixed authorization'] as const)(
  'authorized Skills and MCPs reach only that employee Core through %s', async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), 'enterprise-resources-'));
  const actor = { serverId: 'rc2', userId: '42' };
  const profile = enterpriseProfilePath(root, actor);
  await mkdir(profile, { recursive: true });
  const assistantId = '11111111-1111-4111-8111-111111111111';
  const brokenAssistantId = '77777777-7777-4777-8777-777777777777';
  const oversizedAssistantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const skillId = '22222222-2222-4222-8222-222222222222';
  const secondSkillId = '33333333-3333-4333-8333-333333333333';
  const firstMcpId = '44444444-4444-4444-8444-444444444444';
  const secondMcpId = '55555555-5555-4555-8555-555555555555';
  const knowledgeId = '88888888-8888-4888-8888-888888888888';
  const missingKnowledgeId = '99999999-9999-4999-8999-999999999999';
  const excess = Array.from({ length: 25 }, (_, index) =>
    `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`);
  let knowledgeVersion = 5;
  const writes: Array<{ route: string; body: Record<string, unknown> }> = [];
  const assistantDetails = new Map<string, Record<string, unknown>>();
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
      if (source.includes('Use safely.')) {
        expect(await readFile(path.join(String(body.skill_path), 'scripts', 'summarize.js'), 'utf8'))
          .toBe('console.log("ready")\n');
        expect(await readFile(path.join(String(body.skill_path), 'templates', 'report.md'), 'utf8'))
          .toBe('# Report\n');
        expect(await readFile(path.join(String(body.skill_path), 'assets', 'template.xlsx')))
          .toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      }
      res.end(JSON.stringify({ success: true, data: { skill_name: name } }));
    }
    else if (req.url === '/api/mcp/servers' && req.method === 'POST') res.end(JSON.stringify({ success: true,
      data: { id: `mcp-${body.name}`, name: body.name, enabled: true } }));
    else if (req.url === '/api/assistants' && req.method === 'POST')
      {
        const id = String(body.id);
        assistantDetails.set(id, { ...body, defaults: {
          model: { mode: 'auto' }, skills: { mode: 'auto' }, mcps: { mode: 'auto' },
        } });
        res.end(JSON.stringify({ success: true, data: { id } }));
      }
    else if (req.url?.startsWith('/api/assistants/') && req.method === 'PUT') {
      const id = decodeURIComponent(req.url.slice('/api/assistants/'.length));
      assistantDetails.set(id, { ...assistantDetails.get(id), ...body });
      res.end(JSON.stringify({ success: true, data: { id } }));
    }
    else if (req.url?.startsWith('/api/assistants/') && req.method === 'GET') {
      const id = decodeURIComponent(req.url.slice('/api/assistants/'.length));
      res.end(JSON.stringify({ success: true, data: assistantDetails.get(id) }));
    }
    else res.end(JSON.stringify({ success: true, data: {} }));
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
  const port = (core.address() as { port: number }).port;
  const client = {
    resources: async (type: string) => type === 'ASSISTANT'
      ? mode === 'standalone authorization' ? []
        : [
          { id: assistantId, name: 'Test assistant', source: 'enterprise', version: 2 },
          { id: brokenAssistantId, name: 'Broken knowledge assistant', source: 'enterprise', version: 2 },
          { id: oversizedAssistantId, name: 'Oversized knowledge assistant', source: 'enterprise', version: 2 },
        ]
      : type === 'SKILL'
        ? mode === 'assistant dependencies' ? [] : [
          { id: skillId, name: 'Safe Skill', version: 3 },
          { id: secondSkillId, name: 'Safe Skill copy', version: 3 },
          ...excess.map((id) => ({ id, name: 'Invalid Skill', version: 1 })),
        ]
        : mode === 'assistant dependencies' ? [] : [
          { id: firstMcpId, name: 'First MCP', version: 4 },
          { id: secondMcpId, name: 'Second MCP', version: 4 },
          ...excess.map((id) => ({ id, name: 'Unavailable MCP', version: 1 })),
        ],
    authorizedResource: async (id: string) => {
      if (id === assistantId) return { version: 2, config: {
        modelId: 'model-2', instruction: 'Use the Skills and MCPs.',
        skillIds: [skillId, secondSkillId], mcpIds: [firstMcpId, secondMcpId], knowledgeIds: [knowledgeId],
      } };
      if (id === brokenAssistantId) return { version: 2, config: {
        modelId: 'model-2', instruction: 'This assistant is isolated.',
        skillIds: [], mcpIds: [], knowledgeIds: [missingKnowledgeId],
      } };
      if (id === oversizedAssistantId) return { version: 2, config: {
        modelId: 'model-2', instruction: 'This assistant is invalid.',
        skillIds: [], mcpIds: [], knowledgeIds: excess.slice(0, 9),
      } };
      if (id === knowledgeId) return { version: knowledgeVersion, name: 'Policy Library', config: {} };
      if (id === missingKnowledgeId) throw new Error('revoked');
      return id === skillId || id === secondSkillId
        ? { version: 3, config: { manifest: { name: 'safe-skill' },
          source: `---\nname: safe-skill\n---\n${id === skillId ? 'Use safely.' : 'Use differently.'}`,
          files: id === skillId ? [
            { path: 'requirements.txt', content: 'Pillow==11.3.0\n' },
            { path: 'scripts/summarize.js', content: 'console.log("ready")\n', executable: true },
            { path: 'templates/report.md', content: '# Report\n' },
            { path: 'assets/template.xlsx', content: 'UEsDBA==', encoding: 'base64' },
          ] : [] } }
        : { version: 4, config: {} };
    },
    readyMcpConnection: async (id: string) => {
      if (![firstMcpId, secondMcpId].includes(id)) throw new Error('not ready');
      return { id: `connection-${id}` };
    },
    authorizedMcpConnection: async () => ({ enabled: true }),
    availableModels: async () => [{ id: 'model-1' }, { id: 'model-2' }],
  } as unknown as Rc2GatewayClient;
  try {
    const synced = await syncEnterpriseWebResources(actor, { port, localToken: 'local-secret', stop: async () => {} },
      root, { id: 'model-1', code: 'model-code', availableModels: [
        { id: 'model-1', code: 'model-code' }, { id: 'model-2', code: 'assistant-model-code' },
      ] }, async () => client, async () => client);
    const manifest = JSON.parse(await readFile(await enterpriseManagedResourcePath(root, actor), 'utf8'));
    const skillNames = [skillId, secondSkillId].map((id) => `safe-skill-${id.replaceAll('-', '')}`);
    expect(manifest.skills).toEqual(skillNames);
    expect(synced.issues).toContainEqual({ type: 'SKILL', id: skillId, code: 'DEPENDENCY_UNVERIFIED' });
    expect(manifest.mcpIds).toHaveLength(2);
    const assistantExpected = mode !== 'standalone authorization';
    expect(manifest.assistantIds).toEqual(assistantExpected ? [`rc2-${assistantId}`] : []);
    if (assistantExpected) {
      expect(synced.issues).toContainEqual({
        type: 'ASSISTANT', id: brokenAssistantId, code: 'KNOWLEDGE_UNAVAILABLE',
      });
      expect(synced.issues).toContainEqual({
        type: 'ASSISTANT', id: oversizedAssistantId, code: 'INVALID_CONFIGURATION',
      });
    }
    expect(writes.some(({ route, body }) => route === '/api/assistants' && body.id === `rc2-${assistantId}`))
      .toBe(assistantExpected);
    if (assistantExpected) {
      const assistant = writes.find(({ route, body }) =>
        route === '/api/assistants' && body.id === `rc2-${assistantId}`)!.body;
      expect(assistant.custom_skill_names).toEqual(skillNames);
      expect((assistant.defaults as { mcps: { value: string[] } }).mcps.value).toHaveLength(2);
      expect((assistant.defaults as { model: { value: string } }).model.value).toBe('assistant-model-code');
      expect(writes).toContainEqual({
        route: `/api/assistants/rc2-${assistantId}`,
        body: { defaults: assistant.defaults },
      });
      const rule = writes.find(({ route }) => route === '/api/skills/assistant-rule/write')?.body as {
        content: string;
      };
      expect(rule.content).toContain(`name="Policy Library" | baseId=${knowledgeId} | version=5`);
      expect(rule.content).toContain('search_knowledge');
    }
    if (mode === 'mixed authorization') {
      knowledgeVersion = 6;
      await Promise.race([
        synced.invalidated,
        new Promise((_, reject) => setTimeout(() => reject(new Error('knowledge monitor did not invalidate')), 6500)),
      ]);
    }
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
