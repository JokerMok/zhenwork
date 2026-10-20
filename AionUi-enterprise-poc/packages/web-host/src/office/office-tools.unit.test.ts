import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { EnterpriseCore } from '../enterprise-gateway.js';
import { OfficeStore } from './office-store.js';
import { ensureOfficeAssistant, startOfficeTools } from './office-tools.js';

const roots: string[] = [];
const actor = { serverId: 'rc2', userId: '17' };

type CoreFixture = {
  core: EnterpriseCore;
  close: () => Promise<void>;
  calls: Array<{ method: string; route: string; body: unknown }>;
  registered: () => { transport: { url: string; headers: { Authorization: string } } };
};

async function coreFixture(toggleStatus = 200, defaultAssistantExists = false): Promise<CoreFixture> {
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  let registration: { transport: { url: string; headers: { Authorization: string } } } | undefined;
  let mcpEnabled = false;
  const server = http.createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method || 'GET', route: req.url || '', body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/mcp/servers') {
      res.end(JSON.stringify({ success: true, data: [
        { id: 'independent-mcp', name: 'independent-resource', enabled: true },
        { id: 'disabled-mcp', name: 'disabled-resource', enabled: false },
        ...(registration ? [{ id: 'office-mcp', enabled: mcpEnabled, ...registration }] : []),
      ] }));return;
    }
    if (req.method === 'POST' && req.url === '/api/mcp/servers') {
      registration = body;
      res.end(JSON.stringify({ success: true, data: { id: 'office-mcp', enabled: false } }));return;
    }
    if (req.method === 'POST' && req.url === '/api/mcp/servers/office-mcp/toggle') {
      res.statusCode = toggleStatus;
      if (toggleStatus === 200) mcpEnabled = true;
      res.end(JSON.stringify(toggleStatus === 200 ? { success: true, data: { enabled: true } } : { success: false }));return;
    }
    if (req.method === 'GET' && req.url === '/api/assistants') {
      res.end(JSON.stringify({ success: true, data: [
        { id: 'aionrs-catalog', agent_id: 'agent-1', agent: { type: 'aionrs' } },
        ...(defaultAssistantExists
          ? [{ id: 'zhenwork-general-office', agent_id: 'agent-1', agent: { type: 'aionrs' } }]
          : []),
      ] }));return;
    }
    if (req.method === 'GET' && req.url === '/api/skills') {
      res.end(JSON.stringify({ success: true, data: [
        { name: 'officecli' }, { name: 'finance-reimbursement-filler' },
      ] }));return;
    }
    if (req.method === 'POST' && req.url === '/api/assistants') {
      res.end(JSON.stringify({ success: true, data: { id: 'zhenwork-general-office' } }));return;
    }
    if (req.method === 'PUT' && req.url === '/api/assistants/zhenwork-general-office') {
      res.end(JSON.stringify({ success: true, data: { id: 'zhenwork-general-office' } }));return;
    }
    if (req.method === 'POST' && req.url === '/api/skills/assistant-rule/write') {
      res.end(JSON.stringify({ success: true, data: { ok: true } }));return;
    }
    if (req.method === 'GET' && req.url === '/api/settings/client') {
      res.end(JSON.stringify({ success: true, data: {} }));return;
    }
    if (req.method === 'PUT' && req.url === '/api/settings/client') {
      res.end(JSON.stringify({ success: true, data: body }));return;
    }
    res.statusCode = 404;res.end(JSON.stringify({ success: false }));
  })().catch(() => { res.statusCode = 500;res.end('{}'); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    core: { port, localToken: 'core-token', stop: async () => {} }, calls,
    registered: () => registration!,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'office-tools-'));
  roots.push(root);await mkdir(root, { recursive: true });return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('registers and enables the employee MCP, then configures the default office assistant', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  const office = await startOfficeTools(actor, fixture.core, root, async () => { throw new Error('unused'); });
  try {
    await ensureOfficeAssistant(fixture.core, office.mcpId, { code: 'rc2-model-1', name: 'Model One' });
    expect(office.mcpId).toBe('office-mcp');
    expect(fixture.calls.some((call) => call.route === '/api/mcp/servers/office-mcp/toggle')).toBe(true);
    const assistant = fixture.calls.find((call) => call.method === 'POST' && call.route === '/api/assistants')?.body as {
      id: string; defaults: { model: { value: string }; skills: { mode: string; value?: string[] };
        mcps: { mode: string; value?: string[] } };
    };
    expect(assistant.id).toBe('zhenwork-general-office');
    expect(assistant.defaults.model.value).toBe('rc2-model-1');
    expect(assistant.defaults.skills).toEqual({
      mode: 'fixed', value: ['officecli', 'finance-reimbursement-filler'],
    });
    expect(assistant.defaults.mcps).toEqual({
      mode: 'fixed', value: ['independent-mcp', 'office-mcp'],
    });
    expect(fixture.calls.find((call) => call.route === '/api/skills/assistant-rule/write')?.body).toMatchObject({
      assistant_id: 'zhenwork-general-office',
    });
    expect(fixture.calls.find((call) => call.method === 'PUT' && call.route === '/api/settings/client')?.body).toEqual({
      'guid.lastAssistantId': 'zhenwork-general-office',
    });
  } finally { await office.stop();await fixture.close(); }
});

test('tool calls stay conversation-bound, actor-scoped, and release no result after authorization expires', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  const other = { serverId: 'rc2', userId: '18' };
  await (await OfficeStore.create(root, actor)).remember({ scope: 'project', projectId: 'shared-name', content: 'actor 17' });
  await (await OfficeStore.create(root, other)).remember({ scope: 'project', projectId: 'shared-name', content: 'actor 18' });
  let active = true;
  let releaseResources!: () => void;
  let resourcesStarted!: () => void;
  const started = new Promise<void>((resolve) => { resourcesStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseResources = resolve; });
  const conversations: string[] = [];
  const client = {
    me: async () => { if (!active) throw new Error('authorization expired');return { userId: '17' }; },
    resources: async () => { resourcesStarted();await released;return [{ id: 'never-release-this-result' }]; },
    authorizedResource: async () => ({}),
  };
  const office = await startOfficeTools(actor, fixture.core, root, async (conversationId) => {
    conversations.push(conversationId);return client as never;
  });
  const registration = fixture.registered();
  const authorization = registration.transport.headers.Authorization;
  const rpc = (route: string, message: unknown) => fetch(registration.transport.url.replace('/mcp', route), {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  try {
    const preferences = await (await rpc('/conversations/c1/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'read_preferences', arguments: { projectId: 'shared-name' } } })).json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(preferences.result.content[0].text)).toMatchObject([{ content: 'actor 17' }]);
    expect(conversations).toEqual(['c1']);

    const unbound = await (await rpc('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_knowledge', arguments: {} } })).json() as { error: { message: string } };
    expect(unbound.error.message).toBe('CONVERSATION_REQUIRED');

    const request = rpc('/conversations/c2/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_knowledge', arguments: {} } });
    await started;active = false;releaseResources();
    const expired = await (await request).json() as { error: { message: string } };
    expect(expired.error.message).toBe('authorization expired');
    expect(JSON.stringify(expired)).not.toContain('never-release-this-result');
    expect(conversations).toEqual(['c1', 'c2']);
  } finally { await office.stop();await fixture.close(); }
});

test('refreshes an existing default assistant with the complete current authorization set', async () => {
  const fixture = await coreFixture(200, true);
  const root = await profileRoot();
  const office = await startOfficeTools(actor, fixture.core, root, async () => { throw new Error('unused'); });
  try {
    await ensureOfficeAssistant(fixture.core, office.mcpId, { code: 'rc2-model-1', name: 'Model One' });
    const update = fixture.calls.find((call) =>
      call.method === 'PUT' && call.route === '/api/assistants/zhenwork-general-office')?.body as {
      defaults: { skills: unknown; mcps: unknown };
    };
    expect(update.defaults).toEqual({
      model: { mode: 'fixed', value: 'rc2-model-1' },
      skills: { mode: 'fixed', value: ['officecli', 'finance-reimbursement-filler'] },
      mcps: { mode: 'fixed', value: ['independent-mcp', 'office-mcp'] },
    });
  } finally { await office.stop();await fixture.close(); }
});

test('does not report an office MCP as ready when Core fails to enable it', async () => {
  const fixture = await coreFixture(500);
  const root = await profileRoot();
  try {
    await expect(startOfficeTools(actor, fixture.core, root, async () => { throw new Error('unused'); }))
      .rejects.toThrow('OFFICE_TOOLS_REGISTRATION_FAILED');
  } finally { await fixture.close(); }
});

test('refuses to configure the default assistant when its Office MCP is absent', async () => {
  const fixture = await coreFixture();
  try {
    await expect(ensureOfficeAssistant(fixture.core, 'missing-office-mcp', { code: 'rc2-model-1', name: 'Model One' }))
      .rejects.toThrow('OFFICE_MCP_UNAVAILABLE');
  } finally { await fixture.close(); }
});
