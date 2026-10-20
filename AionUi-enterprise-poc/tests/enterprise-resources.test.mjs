import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rc2Client, assertLoadedResourceVersion } from '../packages/desktop/src/process/services/enterprise/rc2Client.mjs';
import { EnterpriseMcpProxy } from '../packages/desktop/src/process/services/enterprise/mcpProxy.mjs';
import { syncEnterpriseResources } from '../packages/desktop/src/process/services/enterprise/resourceSync.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('RC2 resource requires published USE and a READY connection', async () => {
  let resourceActions = ['VIEW'];
  const client = new Rc2Client('http://127.0.0.1:3589', 'https://example.test', async (url) =>
    new Response(JSON.stringify({ code: 200, data: url.includes('/connections?')
      ? [{ id: 'connection-1', enabled: true, status: 'READY' }]
      : { resourceType: 'SKILL', version: 1, publishedVersion: 1, actions: resourceActions } })));
  client.cookie = '__Host-workspace-rc2=fixed';
  await assert.rejects(client.authorizedResource('skill-1', 'SKILL'));
  resourceActions = ['VIEW', 'USE'];
  assert.equal((await client.authorizedResource('skill-1', 'SKILL')).resourceType, 'SKILL');
  assert.equal((await client.authorizedMcpConnection('connection-1', 'resource-1')).status, 'READY');
  await assert.rejects(client.authorizedMcpConnection('other', 'resource-1'));
});

test('newly published enterprise MCP resolves its READY connection without package pointers', async () => {
  const client = new Rc2Client('https://rc2.example', 'https://rc2.example', async (url) => {
    assert.match(url, /resourceId=resource-new/);
    return new Response(JSON.stringify({ code: 200, data: [
      { id: 'personal-unready', scope: 'PERSONAL', enabled: true, status: 'ERROR' },
      { id: 'enterprise-ready', scope: 'ENTERPRISE', enabled: true, status: 'READY' },
    ] }));
  });
  assert.equal((await client.readyMcpConnection('resource-new')).id, 'enterprise-ready');
});

test('a newly published Skill version invalidates the loaded local rules', () => {
  assert.doesNotThrow(() => assertLoadedResourceVersion({ version: 2 }, 2));
  assert.throws(() => assertLoadedResourceVersion({ version: 3 }, 2), /version changed/);
});

test('authorized RC2 assistant becomes a native AionCore assistant with executable rules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-assistant-'));
  const stage = path.join(dir, 'assistants.json');
  const skillDir = path.join(dir, 'enterprise-succinct');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'),
    '---\nname: enterprise-succinct\nversion: 1.0.1\n---\n读取所选资料并写 Markdown，第一行必须是有内容的一级标题。\n');
  const id = '11111111-1111-4111-8111-111111111111';
  const oldId = '22222222-2222-4222-8222-222222222222';
  const knowledgeId = '33333333-3333-4333-8333-333333333333';
  await fs.writeFile(stage, JSON.stringify([{ id, name: '固定办公助手', source: 'enterprise',
    version: 3, instruction: '只依据所选资料整理清单。',
    skillIds: ['skill-resource'], mcpIds: ['mcp-resource'],
    knowledgeBases: [{ baseId: knowledgeId, version: 7, name: '珠海固废制度' }] }]));
  const calls = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (route === '/api/assistants' && !options.method) return new Response(JSON.stringify({ success: true,
      data: [{ id: 'builtin-aionrs', agent_id: 'agent-aionrs', agent: { type: 'aionrs' } },
        { id: `rc2-${oldId}`, agent_id: 'agent-aionrs', description: '企业提供 · RC2 版本 1 · 当前账号 USE 权限' },
        { id: 'rc2-personal-lookalike', agent_id: 'agent-aionrs' }] }));
    if (route === '/api/mcp/servers' && !options.method) return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills' && !options.method) return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills/import') {
      const source = await fs.readFile(path.join(JSON.parse(options.body).skill_path, 'SKILL.md'), 'utf8');
      assert.match(source, /第一行必须是有内容的一级标题/);
      return new Response(JSON.stringify({ success: true, data: { skill_name: 'enterprise-succinct' } }));
    }
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true,
      data: { id: 'mcp-created', name: 'rc2-enterprise-catalog', enabled: true } }), { status: 201 });
    if (route === `/api/assistants/rc2-${oldId}`) return new Response(JSON.stringify({ success: true }));
    if (route === `/api/assistants/rc2-${id}` && options.method === 'PUT') {
      return new Response(JSON.stringify({ success: true, data: { id: `rc2-${id}` } }));
    }
    if (route === `/api/assistants/rc2-${id}` && !options.method) {
      return new Response(JSON.stringify({ success: true, data: { id: `rc2-${id}`, defaults: {
        model: { mode: 'fixed', value: 'fixed-model' },
        skills: { mode: 'fixed', value: ['enterprise-succinct'] },
        mcps: { mode: 'fixed', value: ['mcp-created'] },
      } } }));
    }
    if (route === '/api/assistants') return new Response(JSON.stringify({ success: true,
      data: { id: `rc2-${id}` } }), { status: 201 });
    if (route === '/api/skills/assistant-rule/write') return new Response(JSON.stringify({ success: true, data: true }));
    throw new Error(`Unexpected route ${route}`);
  };
  try {
    const result = await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_ASSISTANTS_PATH: stage,
      AION_ENTERPRISE_MODEL_CODE: 'fixed-model', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_SKILL_PATH: skillDir, AION_ENTERPRISE_SKILL_NAME: 'enterprise-succinct',
      AION_ENTERPRISE_SKILL_ID: 'skill-resource',
      AION_ENTERPRISE_MCP_PROXY_PORT: '32124', AION_ENTERPRISE_MCP_PROXY_KEY: 'local-capability',
      AION_ENTERPRISE_MCP_RESOURCE_ID: 'mcp-resource',
    }, fetchStub);
    assert.equal(result.assistantCount, 1);
    assert(calls.some((item) => item.method === 'DELETE' && item.route === `/api/assistants/rc2-${oldId}`));
    assert(!calls.some((item) => item.route === '/api/assistants/rc2-personal-lookalike'));
    assert.equal(calls.find((item) => item.route === '/api/assistants' && item.method === 'POST').body.agent_id,
      'agent-aionrs');
    assert.deepEqual(calls.find((item) => item.route === '/api/assistants' && item.method === 'POST').body.custom_skill_names,
      ['enterprise-succinct']);
    assert.deepEqual(calls.find((item) => item.route === '/api/assistants' && item.method === 'POST').body.defaults.mcps.value,
      ['mcp-created']);
    const rule = calls.find((item) => item.route === '/api/skills/assistant-rule/write').body.content;
    assert(rule.startsWith('只依据所选资料整理清单。'));
    assert.match(rule, new RegExp(`name="珠海固废制度" \\| baseId=${knowledgeId} \\| version=7`));
    assert.match(rule, /search_knowledge/);
    assert.match(rule, /原文、文档版本和位置/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('MCP loopback rejects missing capability, forwards JSON-RPC and closes on logout', async () => {
  const methods = [];
  const idempotencyKeys = [];
  const client = { relayMcp: async (_id, raw, headers) => {
    methods.push(JSON.parse(raw).method);
    if (headers['x-zhenwork-idempotency-key']) idempotencyKeys.push(headers['x-zhenwork-idempotency-key']);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  } };
  const proxy = new EnterpriseMcpProxy({ client, connectionId: 'connection-1' });
  const { port, key } = await proxy.start();
  const url = `http://127.0.0.1:${port}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  try {
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    const response = await fetch(url, { method: 'POST', body,
      headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).jsonrpc, '2.0');
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'send_mail', arguments: { subject: 'Ready' } } });
    await fetch(url, { method: 'POST', body: call, headers: { Authorization: `Bearer ${key}` } });
    await fetch(url, { method: 'POST', body: call, headers: { Authorization: `Bearer ${key}` } });
    assert.deepEqual(methods, ['tools/list', 'tools/call', 'tools/call']);
    assert.match(idempotencyKeys[0], /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  } finally { await proxy.stop(); }
  await assert.rejects(fetch(url, { method: 'POST', body }));
});

test('web MCP proxy requires a conversation route and forwards its ID', async () => {
  const conversations = [];
  const proxy = new EnterpriseMcpProxy({ connectionId: 'connection-1', requireConversationId: true,
    client: { relayMcp: async (_id, _raw, _headers, _signal, conversationId) => {
      conversations.push(conversationId);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
        { headers: { 'content-type': 'application/json' } });
    } } });
  const { port, key } = await proxy.start();
  const options = { method: 'POST', headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, options)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/conversations/a1b2c3d4/mcp`, options)).status, 200);
    assert.deepEqual(conversations, ['a1b2c3d4']);
  } finally { await proxy.stop(); }
});

test('MCP registration targets private Core and an internal model gateway', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (!options.method) return new Response(JSON.stringify({ success: true, data: [] }));
    return new Response(JSON.stringify({ success: true, data: {
      id: 'mcp-private', name: JSON.parse(options.body).name, enabled: true,
    } }), { status: 201 });
  };
  await syncEnterpriseResources({ host: '10.233.3.2', port: 32123 }, 'core-capability', {
    AION_ENTERPRISE_MCP_RESOURCE_ID: '11111111-1111-4111-8111-111111111111',
    AION_ENTERPRISE_MCP_PROXY_HOST: 'model-gateway',
    AION_ENTERPRISE_MCP_PROXY_PORT: '32124', AION_ENTERPRISE_MCP_PROXY_KEY: 'private-capability',
  }, fetchStub);
  assert(calls.every((call) => call.url.startsWith('http://10.233.3.2:32123/')));
  assert.equal(calls.find((call) => call.method === 'POST').body.transport.url,
    'http://model-gateway:32124/mcp');
});

test('Core receives a native Skill and MCP server with only a local capability', async () => {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null,
      token: options.headers['x-aion-enterprise-local-token'] });
    if (url.endsWith('/api/skills')) return new Response(JSON.stringify({ success: true, data: [] }));
    if (url.endsWith('/api/skills/import')) return new Response(JSON.stringify({ success: true,
      data: { skill_name: 'enterprise-succinct' } }));
    return new Response(JSON.stringify({ success: true,
      data: { id: 'mcp-1', name: 'rc2-enterprise-catalog', enabled: true } }), { status: 201 });
  };
  const result = await syncEnterpriseResources(32123, 'core-token', {
    AION_ENTERPRISE_SKILL_PATH: '/profile/enterprise-succinct',
    AION_ENTERPRISE_SKILL_NAME: 'enterprise-succinct',
    AION_ENTERPRISE_MCP_PROXY_PORT: '32124', AION_ENTERPRISE_MCP_PROXY_KEY: 'local-capability',
  }, fetchStub);
  assert.equal(result.skillName, 'enterprise-succinct');
  assert.equal(result.mcpId, 'mcp-1');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/api/skills', '/api/skills/import', '/api/mcp/servers']);
  assert.ok(calls.every((call) => call.token === 'core-token'));
  assert.equal(calls[2].body.transport.type, 'http');
  assert.equal(calls[2].body.transport.headers.Authorization, 'Bearer local-capability');
});

test('first managed login removes a stale enterprise MCP left before its manifest was written', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-stale-mcp-'));
  const deleted = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true,
      data: [{ id: 'old-enterprise', name: 'rc2-enterprise-catalog',
        description: 'RC2 authorized enterprise MCP',
        transport: { type: 'http', url: 'http://127.0.0.1:32124/mcp' } },
        { id: 'personal', name: 'personal-mcp' }] }));
    if (route === '/api/mcp/servers/old-enterprise' && options.method === 'DELETE') {
      deleted.push(route);
      return new Response(JSON.stringify({ success: true }));
    }
    if (route === '/api/assistants') return new Response(JSON.stringify({ success: true, data: [] }));
    throw new Error(`Unexpected route ${route}`);
  };
  try {
    await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
    }, fetchStub);
    assert.deepEqual(deleted, ['/api/mcp/servers/old-enterprise']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'enterprise-managed-resources.json'), 'utf8')),
      { skills: [], mcpIds: [], assistantIds: [] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a damaged managed manifest cannot delete a personal MCP with a different name', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-mcp-manifest-'));
  await fs.writeFile(path.join(dir, 'enterprise-managed-resources.json'),
    JSON.stringify({ skills: [], mcpIds: ['personal'] }));
  const deleted = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true,
      data: [{ id: 'personal', name: 'my-personal-mcp' }] }));
    if (route === '/api/assistants') return new Response(JSON.stringify({ success: true, data: [] }));
    if (options.method === 'DELETE') deleted.push(route);
    return new Response(JSON.stringify({ success: true }));
  };
  try {
    await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
    }, fetchStub);
    assert.deepEqual(deleted, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a personal MCP using the reserved name is not overwritten by enterprise sync', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-mcp-collision-'));
  const mutations = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    if (options.method && options.method !== 'GET') mutations.push(`${options.method} ${route}`);
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true,
      data: [{ id: 'personal', name: 'rc2-enterprise-catalog', description: 'My server',
        transport: { type: 'http', url: 'https://example.test/mcp' } }] }));
    throw new Error(`Unexpected route ${route}`);
  };
  try {
    await assert.rejects(syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_MCP_PROXY_PORT: '32124', AION_ENTERPRISE_MCP_PROXY_KEY: 'local-capability',
    }, fetchStub), /name conflicts/);
    assert.deepEqual(mutations, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('next managed login replaces v1 Skill rules with the authorized v2 source', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-skill-refresh-'));
  const skillDir = path.join(dir, 'enterprise-succinct');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'),
    '---\nname: enterprise-succinct\nversion: 1.0.1\n---\n读取所选资料，生成 Markdown 时第一行写一级标题。\n');
  await fs.writeFile(path.join(dir, 'enterprise-managed-resources.json'),
    JSON.stringify({ skills: ['enterprise-succinct'], mcpIds: [] }));
  const sequence = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    sequence.push(`${options.method || 'GET'} ${route}`);
    if (route === '/api/skills/enterprise-succinct' && options.method === 'DELETE') {
      return new Response(JSON.stringify({ success: true }));
    }
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills') return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills/import') {
      const source = await fs.readFile(path.join(JSON.parse(options.body).skill_path, 'SKILL.md'), 'utf8');
      assert.match(source, /第一行写一级标题/);
      assert.doesNotMatch(source, /不要读文件/);
      return new Response(JSON.stringify({ success: true, data: { skill_name: 'enterprise-succinct' } }));
    }
    if (route === '/api/assistants') return new Response(JSON.stringify({ success: true, data: [] }));
    throw new Error(`Unexpected route ${route}`);
  };
  try {
    const result = await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_SKILL_PATH: skillDir, AION_ENTERPRISE_SKILL_NAME: 'enterprise-succinct',
    }, fetchStub);
    assert.equal(result.skillName, 'enterprise-succinct');
    assert(sequence.includes('POST /api/skills/import'));
    assert(!sequence.includes('DELETE /api/skills/enterprise-succinct'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'enterprise-managed-resources.json'), 'utf8')),
      { skills: ['enterprise-succinct'], mcpIds: [], assistantIds: [] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('failed Skill import is isolated and revokes the stale managed Skill without stopping Core', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-sync-failure-'));
  const skillDir = path.join(dir, 'enterprise-succinct');
  await fs.mkdir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'invalid update');
  const manifest = { skills: ['enterprise-succinct'], mcpIds: [] };
  await fs.writeFile(path.join(dir, 'enterprise-managed-resources.json'), JSON.stringify(manifest));
  const mutations = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    if (options.method === 'DELETE' || options.method === 'PUT') mutations.push(route);
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills') return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills/import') return new Response(JSON.stringify({ success: true,
      data: { skill_name: '', skill_names: [], failed: [{ code: 'SKILL_INVALID_FRONTMATTER' }] } }));
    if (route === '/api/assistants') return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills/enterprise-succinct' && options.method === 'DELETE') {
      return new Response(JSON.stringify({ success: true }));
    }
    throw new Error(`Unexpected route ${route}`);
  };
  try {
    const result = await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_SKILL_PATH: skillDir, AION_ENTERPRISE_SKILL_NAME: 'enterprise-succinct',
    }, fetchStub);
    assert.deepEqual(result.issues, [{ type: 'SKILL', id: '', code: 'IMPORT_FAILED' }]);
    assert.deepEqual(mutations, ['/api/skills/enterprise-succinct']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'enterprise-managed-resources.json'), 'utf8')),
      { skills: [], mcpIds: [], assistantIds: [] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a personal Skill name conflict is isolated from the remaining RC2 resource sync', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-skill-collision-'));
  const mutations = [];
  const fetchStub = async (url, options) => {
    const route = new URL(url).pathname;
    if (options.method) mutations.push(`${options.method} ${route}`);
    if (route === '/api/mcp/servers') return new Response(JSON.stringify({ success: true, data: [] }));
    if (route === '/api/skills') return new Response(JSON.stringify({ success: true,
      data: [{ name: 'personal-skill', source: 'custom' }] }));
    if (route === '/api/assistants') return new Response(JSON.stringify({ success: true, data: [] }));
    throw new Error(`Unexpected route ${route}`);
  };
  try {
    const result = await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_SKILL_PATH: path.join(dir, 'stage', 'personal-skill'),
      AION_ENTERPRISE_SKILL_NAME: 'personal-skill', AION_ENTERPRISE_SKILL_ID: 'skill-id',
    }, fetchStub);
    assert.deepEqual(result.issues, [{ type: 'SKILL', id: 'skill-id', code: 'NAME_CONFLICT' }]);
    assert.deepEqual(mutations, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('resource bundle rejects a Skill path that escapes the employee profile through a symlink', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-resource-path-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-resource-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'SKILL.md'), 'untrusted');
    const stage = path.join(dir, 'stage');
    await fs.mkdir(stage);
    await fs.symlink(outside, path.join(stage, 'outside'));
    const bundle = path.join(stage, 'bundle.json');
    await fs.writeFile(bundle, JSON.stringify({ skills: [{
      id: '11111111-1111-4111-8111-111111111111', name: 'outside', path: path.join(stage, 'outside'), version: 1,
    }], mcps: [] }));
    await assert.rejects(syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_RESOURCES_PATH: bundle,
    }, async () => { throw new Error('Core must not be contacted'); }), /symlink forbidden/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('failed second Skill import keeps the first successful managed Skill', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-resource-rollback-'));
  try {
    const stage = path.join(dir, 'stage');
    await fs.mkdir(stage);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const skills = [];
    for (const [index, id] of ids.entries()) {
      const name = `test-skill-${index}`;
      const skillPath = path.join(stage, name);
      await fs.mkdir(skillPath);
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\n---\nTest`);
      skills.push({ id, name, path: skillPath, version: 1 });
    }
    const bundle = path.join(stage, 'bundle.json');
    await fs.writeFile(bundle, JSON.stringify({ skills, mcps: [] }));
    const calls = [];
    const fetchStub = async (url, options) => {
      const route = new URL(url).pathname;
      calls.push(`${options.method || 'GET'} ${route}`);
      if (route === '/api/mcp/servers' || route === '/api/skills') {
        return new Response(JSON.stringify({ success: true, data: [] }));
      }
      if (route === '/api/skills/import') {
        const name = path.basename(JSON.parse(options.body).skill_path);
        return new Response(JSON.stringify({ success: true, data: { skill_name: name === 'test-skill-0' ? name : '' } }));
      }
      if (route === '/api/assistants') return new Response(JSON.stringify({ success: true, data: [] }));
      throw new Error(`Unexpected route ${route}`);
    };
    const result = await syncEnterpriseResources(32123, 'core-token', {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: dir,
      AION_ENTERPRISE_RESOURCES_PATH: bundle,
    }, fetchStub);
    assert.deepEqual(result.issues, [{ type: 'SKILL', id: ids[1], code: 'IMPORT_FAILED' }]);
    assert(!calls.includes('DELETE /api/skills/test-skill-0'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'enterprise-managed-resources.json'), 'utf8')),
      { skills: ['test-skill-0'], mcpIds: [], assistantIds: [] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
