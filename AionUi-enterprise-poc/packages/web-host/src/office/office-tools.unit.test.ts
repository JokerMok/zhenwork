import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { EnterpriseCore } from '../enterprise-gateway.js';
import { OfficeStore } from './office-store.js';
import { enterpriseProfilePath } from '../enterprise-core.js';
import { buildEvidenceTable, ensureOfficeAssistant, startOfficeTools } from './office-tools.js';

const roots: string[] = [];
const actor = { serverId: 'rc2', userId: '17' };

type CoreFixture = {
  core: EnterpriseCore;
  close: () => Promise<void>;
  calls: Array<{ method: string; route: string; body: unknown }>;
  registered: () => { transport: { url: string; headers: { Authorization: string } } };
};

async function coreFixture(
  toggleStatus = 200,
  defaultAssistantExists = false,
  enterpriseAssistant = false
): Promise<CoreFixture> {
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  let registration: { transport: { url: string; headers: { Authorization: string } } } | undefined;
  let mcpEnabled = false;
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method || 'GET', route: req.url || '', body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/mcp/servers') {
        res.end(
          JSON.stringify({
            success: true,
            data: [
              { id: 'independent-mcp', name: 'independent-resource', enabled: true },
              { id: 'disabled-mcp', name: 'disabled-resource', enabled: false },
              ...(registration ? [{ id: 'office-mcp', enabled: mcpEnabled, ...registration }] : []),
            ],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/mcp/servers') {
        registration = body;
        res.end(JSON.stringify({ success: true, data: { id: 'office-mcp', enabled: false } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/mcp/servers/office-mcp') {
        res.end(JSON.stringify({success:true,data:registration}));return;
      }
      if (req.method === 'POST' && req.url === '/api/mcp/servers/office-mcp/toggle') {
        res.statusCode = toggleStatus;
        if (toggleStatus === 200) mcpEnabled = true;
        res.end(JSON.stringify(toggleStatus === 200 ? { success: true, data: { enabled: true } } : { success: false }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/assistants') {
        res.end(
          JSON.stringify({
            success: true,
            data: [
              { id: 'aionrs-catalog', agent_id: 'agent-1', agent: { type: 'aionrs' } },
              ...(defaultAssistantExists
                ? [{ id: 'zhenwork-general-office', agent_id: 'agent-1', agent: { type: 'aionrs' } }]
                : []),
              ...(enterpriseAssistant ? [{ id: 'rc2-11111111-1111-4111-8111-111111111111', agent_id: 'agent-1' }] : []),
            ],
          })
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/api/skills') {
        res.end(
          JSON.stringify({ success: true, data: [{ name: 'officecli' }, { name: 'finance-reimbursement-filler' }] })
        );
        return;
      }
      if (req.url === '/api/assistants/rc2-11111111-1111-4111-8111-111111111111') {
        res.end(
          JSON.stringify({ success: true, data: { defaults: { model: { mode: 'fixed', value: 'enterprise-model' }, skills: { mode: 'fixed', value: ['finance'] }, mcps: { mode: 'fixed', value: ['independent-mcp'] } } } })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/assistants') {
        res.end(JSON.stringify({ success: true, data: { id: 'zhenwork-general-office' } }));
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/assistants/zhenwork-general-office') {
        res.end(JSON.stringify({ success: true, data: { id: 'zhenwork-general-office' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/skills/assistant-rule/write') {
        res.end(JSON.stringify({ success: true, data: { ok: true } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/settings/client') {
        res.end(JSON.stringify({ success: true, data: {} }));
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/settings/client') {
        res.end(JSON.stringify({ success: true, data: body }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false }));
    })().catch(() => {
      res.statusCode = 500;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    core: { port, localToken: 'core-token', stop: async () => {} },
    calls,
    registered: () => registration!,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'office-tools-'));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('builds evidence table rows from verified source text and locator', () => {
  const table = buildEvidenceTable(
    [{
      topic: '标签',
      claim: '支持识别',
      status: '待核查',
      independentRequirement: '未提供',
      acceptanceEvidence: '未提供',
      followUp: '现场核验',
      ref: 'source-1',
      quote: '模型误抄的原文',
    }],
    [{
      ref: 'source-1',
      kind: 'knowledge',
      quote: '扫码',
      locator: { documentId: 'doc-1', version: 3, location: '第 4 页' },
    }]
  );

  expect(table.name).toBe('证据核查表');
  expect(table.rows[0]).toEqual([
    1,
    '标签',
    '支持识别',
    '待核查',
    '未提供',
    '未提供',
    '现场核验',
    'S1',
  ]);
  expect(JSON.stringify(table)).not.toContain('模型误抄的原文');
});

test('appends bounded custom evidence columns without replacing protected source cells', () => {
  const base = {
    topic: '标签',
    claim: '支持识别',
    status: '待核查',
    independentRequirement: '未提供',
    acceptanceEvidence: '未提供',
    followUp: '现场核验',
    ref: 'source-1',
    quoteIndex: 0,
  };
  const sources = [
    { ref: 'source-1', kind: 'knowledge' as const, quote: '真实原文一', locator: { location: '第 1 页' } },
    { ref: 'source-2', kind: 'knowledge' as const, quote: '真实原文二', locator: { location: '第 2 页' } },
  ];
  const table = buildEvidenceTable(
    [
      { ...base, 后续验证责任: '需用户指定责任人', 置信度: 0.8, 已复核: true },
      { ...base, ref: 'source-2', 备注: null },
    ],
    sources
  );

  expect(table.headers.slice(0, 8)).toEqual([
    '编号', '主题', '结论/声明', '状态', '独立要求', '验收证据', '后续事项', '来源',
  ]);
  expect(table.headers.slice(8)).toEqual(['后续验证责任', '置信度', '已复核', '备注']);
  expect(table.rows[0].slice(7)).toEqual([
    'S1',
    '需用户指定责任人', 0.8, 'true', '',
  ]);
  expect(table.rows[1].slice(7)).toEqual([
    'S2',
    '', '', '', null,
  ]);
});

test('rejects unsupported, excessive and protected custom evidence columns', () => {
  const row = (extra: Record<string, unknown>) => ({
    topic: '标签', claim: '声明', status: '待核查', independentRequirement: '未提供',
    acceptanceEvidence: '未提供', followUp: '核验', ref: 'source-1', quoteIndex: 0, ...extra,
  });
  const source = [{ ref: 'source-1', kind: 'knowledge' as const, quote: '真实原文', locator: {} }];

  expect(() => buildEvidenceTable([row({ 嵌套: { value: 1 } })] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_VALUE_INVALID');
  expect(() => buildEvidenceTable([row({ 列表: ['x'] })] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_VALUE_INVALID');
  expect(() => buildEvidenceTable([row({ [String('列').repeat(121)]: 'x' })] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_COLUMN_NAME_LIMIT_120');
  expect(() => buildEvidenceTable([row({ 超长值: 'x'.repeat(8001) })] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_VALUE_LIMIT_8000');
  expect(() => buildEvidenceTable([row(Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`列${index}`, index])))] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_COLUMN_LIMIT_12');
  expect(() => buildEvidenceTable([row({ 原文摘录: '伪造覆盖' })] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_COLUMN_PROTECTED');
  expect(() => buildEvidenceTable([row({ constructor: 'unsafe' })] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_COLUMN_FORBIDDEN');
  expect(() => buildEvidenceTable([row(JSON.parse('{"__proto__":"unsafe"}') as Record<string, unknown>)] as never, source))
    .toThrow('OFFICE_EVIDENCE_CUSTOM_COLUMN_FORBIDDEN');
});

test('advertises bounded custom scalar evidence columns in the tool schema', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  fixture.core.workspaceRoot = path.join(root, 'workspace');
  const office = await startOfficeTools(actor, fixture.core, root, async () => ({ me: async () => ({ userId: actor.userId }) }) as never);
  const registration = fixture.registered();
  try {
    const response = await fetch(registration.transport.url.replace('/mcp', '/conversations/c1/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: registration.transport.headers.Authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const listed = await response.json() as { result: { tools: Array<{ name: string; inputSchema: Record<string, any> }> } };
    const createSchema = listed.result.tools.find((tool) => tool.name === 'create_office_document')?.inputSchema.properties;
    const evidenceRowsSchema = createSchema.evidenceRows.items;
    const exactlyOne = [
      { required: ['quote'], not: { required: ['quoteIndex'] } },
      { required: ['quoteIndex'], not: { required: ['quote'] } },
    ];
    expect(createSchema.citations.items.oneOf).toEqual(exactlyOne);
    expect(evidenceRowsSchema.oneOf).toEqual(exactlyOne);
    expect(evidenceRowsSchema.additionalProperties).toMatchObject({ type: ['string', 'number', 'boolean', 'null'], maxLength: 8000 });
    expect(evidenceRowsSchema.propertyNames).toMatchObject({ minLength: 1, maxLength: 120 });
  } finally {
    await office.stop();
    await fixture.close();
  }
});

test('reports safe row and field details for invalid evidence rows through MCP', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  fixture.core.workspaceRoot = path.join(root, 'workspace');
  await mkdir(fixture.core.workspaceRoot, { recursive: true });
  const office = await startOfficeTools(actor, fixture.core, root, async () => ({
    me: async () => ({ userId: actor.userId }),
  }) as never);
  const registration = fixture.registered();
  const call = async (evidenceRows: unknown) => (await (await fetch(
    registration.transport.url.replace('/mcp', '/conversations/c1/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: registration.transport.headers.Authorization },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'create_office_document', arguments: { path: 'report.xlsx', format: 'xlsx', evidenceRows } },
      }),
    }
  )).json()) as { error: { message: string } };
  const validRow = {
    topic: 'Source claim', claim: 'Supplier states support', status: 'To confirm',
    independentRequirement: 'Missing', acceptanceEvidence: 'Missing', followUp: 'Verify independently',
    ref: 'source-1', quoteIndex: 0,
  };
  try {
    const emptyRef = await call([
      validRow,
      { ...validRow, ref: 'source-2' },
      { ...validRow, ref: 'source-3' },
      { ...validRow, ref: '' },
    ]);
    expect(emptyRef.error.message).toBe('OFFICE_EVIDENCE_ROW_INVALID row=4 field=ref reason=empty');

    const nonObject = await call([validRow, null]);
    expect(nonObject.error.message).toBe('OFFICE_ARGUMENT_INVALID arguments.evidenceRows[1]: expected object');

    const wrongType = await call([{ ...validRow, claim: 42 }]);
    expect(wrongType.error.message).toBe('OFFICE_ARGUMENT_INVALID arguments.evidenceRows[0].claim: expected string');

    const tooLong = await call([{ ...validRow, followUp: 'x'.repeat(8001) }]);
    expect(tooLong.error.message).toBe('OFFICE_EVIDENCE_ROW_INVALID row=1 field=followUp reason=too_long');
  } finally {
    await office.stop();
    await fixture.close();
  }
});

test('structured manifests use actor workspace, explicit overwrite and truthful download links', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  fixture.core.workspaceRoot = path.join(root, 'workspace');
  vi.spyOn(OfficeStore.prototype, 'files').mockResolvedValue({ files: [{ path: 'data.json' }] } as never);
  const upload = vi.spyOn(OfficeStore.prototype, 'upload').mockResolvedValue();
  const client = { me: async () => ({ userId: actor.userId }) };
  const office = await startOfficeTools(actor, fixture.core, root, async () => client as never, 'https://workspace.example');
  const registration = fixture.registered();
  const call = async (args: unknown) => (await (await fetch(
    registration.transport.url.replace('/mcp', '/conversations/c1/mcp'), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: registration.transport.headers.Authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_workspace_json', arguments: args } }),
    })).json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
  try {
    expect((await call({ path: 'data.json', data: { amount: '12.30' } })).error?.message).toBe('OUTPUT_EXISTS_CONFIRM_OVERWRITE_OR_USE_NEW_NAME');
    expect((await call({ path: 'data.xlsx', data: [] })).error?.message).toBe('WORKSPACE_JSON_OBJECT_OR_ARRAY_REQUIRED');
    expect((await call({ path: 'data.json', data: '{"amount":12}' })).error?.message).toBe('OFFICE_ARGUMENT_INVALID arguments.data: expected object|array');
    expect(upload).not.toHaveBeenCalled();
    expect((await call({ path: 'data.json', data: {}, overwrite: 'yes' })).error?.message).toBe('OFFICE_BOOLEAN_ARGUMENT_INVALID');
    const result = await call({ path: 'data.json', data: { amount: '12.30' }, overwrite: 'True' });
    expect(JSON.parse(result.result!.content[0].text).downloadUrl).toBe('https://workspace.example/enterprise/files/download?path=data.json');
    expect(upload).toHaveBeenCalledWith(fixture.core.workspaceRoot, 'data.json', Buffer.from('{\n  "amount": "12.30"\n}\n'), true);
  } finally { await office.stop(); await fixture.close(); }
});

test('pre-conversation uploads resolve inside the current actor tree, never a different actor upload root', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  fixture.core.workspaceRoot = path.join(root, 'workspace');
  const read = vi.spyOn(OfficeStore.prototype, 'download').mockRejectedValue(new Error('read probe'));
  const client = { me: async () => ({ userId: actor.userId }) };
  const office = await startOfficeTools(actor, fixture.core, root, async () => client as never);
  const registration = fixture.registered();
  const call = async (file: string) => fetch(registration.transport.url.replace('/mcp', '/conversations/c1/mcp'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: registration.transport.headers.Authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_document', arguments: { path: file } } }),
  }).then(response => response.json());
  try {
    const uploads = path.join(enterpriseProfilePath(root, actor), 'runtime-temp', 'aionui');
    await call(path.join(uploads, 'general', 'receipt.pdf'));
    expect(read).toHaveBeenLastCalledWith(uploads, path.join('general', 'receipt.pdf'));
    const foreign = path.join(enterpriseProfilePath(root, { ...actor, userId: '18' }), 'runtime-temp', 'aionui', 'general', 'receipt.pdf');
    await call(foreign);
    expect(read).toHaveBeenLastCalledWith(fixture.core.workspaceRoot, path.relative(fixture.core.workspaceRoot, foreign));
    expect(path.relative(fixture.core.workspaceRoot, foreign).startsWith('..')).toBe(true);
  } finally { await office.stop(); await fixture.close(); }
});

test('registers and enables the employee MCP, then configures the default office assistant', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  const office = await startOfficeTools(actor, fixture.core, root, async () => {
    throw new Error('unused');
  });
  try {
    await ensureOfficeAssistant(fixture.core, office.mcpId, { code: 'rc2-model-1', name: 'Model One' });
    expect(office.mcpId).toBe('office-mcp');
    expect(fixture.calls.some((call) => call.route === '/api/mcp/servers/office-mcp/toggle')).toBe(true);
    const assistant = fixture.calls.find((call) => call.method === 'POST' && call.route === '/api/assistants')
      ?.body as {
      id: string;
      defaults: {
        model: { value: string };
        skills: { mode: string; value?: string[] };
        mcps: { mode: string; value?: string[] };
      };
    };
    expect(assistant.id).toBe('zhenwork-general-office');
    expect(assistant.defaults.model.value).toBe('rc2-model-1');
    expect(assistant.defaults.skills).toEqual({
      mode: 'fixed',
      value: ['officecli', 'finance-reimbursement-filler'],
    });
    expect(assistant.defaults.mcps).toEqual({
      mode: 'fixed',
      value: ['independent-mcp', 'office-mcp'],
    });
    expect(fixture.calls.find((call) => call.route === '/api/skills/assistant-rule/write')?.body).toMatchObject({
      assistant_id: 'zhenwork-general-office',
    });
    expect(fixture.calls.find((call) => call.method === 'PUT' && call.route === '/api/settings/client')?.body).toEqual({
      'guid.lastAssistantId': 'zhenwork-general-office',
    });
  } finally {
    await office.stop();
    await fixture.close();
  }
});

test('tool calls stay conversation-bound, actor-scoped, and release no result after authorization expires', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  const other = { serverId: 'rc2', userId: '18' };
  await (
    await OfficeStore.create(root, actor)
  ).remember({ scope: 'project', projectId: 'shared-name', content: 'actor 17' });
  await (
    await OfficeStore.create(root, other)
  ).remember({ scope: 'project', projectId: 'shared-name', content: 'actor 18' });
  let active = true;
  let releaseResources!: () => void;
  let resourcesStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resourcesStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResources = resolve;
  });
  const conversations: string[] = [];
  const client = {
    me: async () => {
      if (!active) throw new Error('authorization expired');
      return { userId: '17' };
    },
    resources: async () => {
      resourcesStarted();
      await released;
      return [{ id: 'never-release-this-result' }];
    },
    authorizedResource: async () => ({}),
  };
  const office = await startOfficeTools(actor, fixture.core, root, async (conversationId) => {
    conversations.push(conversationId);
    return client as never;
  });
  const registration = fixture.registered();
  const authorization = registration.transport.headers.Authorization;
  const rpc = (route: string, message: unknown) =>
    fetch(registration.transport.url.replace('/mcp', route), {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
  try {
    const preferences = (await (
      await rpc('/conversations/c1/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_preferences', arguments: { projectId: 'shared-name' } },
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(preferences.result.content[0].text)).toMatchObject([{ content: 'actor 17' }]);
    expect(conversations).toEqual(['c1']);

    const unbound = (await (
      await rpc('/mcp', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_knowledge', arguments: {} },
      })
    ).json()) as { error: { message: string } };
    expect(unbound.error.message).toBe('CONVERSATION_REQUIRED');

    const request = rpc('/conversations/c2/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_knowledge', arguments: {} },
    });
    await started;
    active = false;
    releaseResources();
    const expired = (await (await request).json()) as { error: { message: string } };
    expect(expired.error.message).toBe('authorization expired');
    expect(JSON.stringify(expired)).not.toContain('never-release-this-result');
    expect(conversations).toEqual(['c1', 'c2']);
  } finally {
    await office.stop();
    await fixture.close();
  }
});

test('refreshes an existing default assistant with the complete current authorization set', async () => {
  const fixture = await coreFixture(200, true);
  const root = await profileRoot();
  const office = await startOfficeTools(actor, fixture.core, root, async () => {
    throw new Error('unused');
  });
  try {
    await ensureOfficeAssistant(fixture.core, office.mcpId, { code: 'rc2-model-1', name: 'Model One' });
    const update = fixture.calls.find(
      (call) => call.method === 'PUT' && call.route === '/api/assistants/zhenwork-general-office'
    )?.body as {
      defaults: { skills: unknown; mcps: unknown };
    };
    expect(update.defaults).toEqual({
      model: { mode: 'fixed', value: 'rc2-model-1' },
      skills: { mode: 'fixed', value: ['officecli', 'finance-reimbursement-filler'] },
      mcps: { mode: 'fixed', value: ['independent-mcp', 'office-mcp'] },
    });
  } finally {
    await office.stop();
    await fixture.close();
  }
});

test('does not report an office MCP as ready when Core fails to enable it', async () => {
  const fixture = await coreFixture(500);
  const root = await profileRoot();
  try {
    await expect(
      startOfficeTools(actor, fixture.core, root, async () => {
        throw new Error('unused');
      })
    ).rejects.toThrow('OFFICE_TOOLS_REGISTRATION_FAILED');
  } finally {
    await fixture.close();
  }
});

test('refuses to configure the default assistant when its Office MCP is absent', async () => {
  const fixture = await coreFixture();
  try {
    await expect(
      ensureOfficeAssistant(fixture.core, 'missing-office-mcp', { code: 'rc2-model-1', name: 'Model One' })
    ).rejects.toThrow('OFFICE_MCP_UNAVAILABLE');
  } finally {
    await fixture.close();
  }
});

test('refreshes MCP transport without deleting saved conversation and job bindings', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  try {
    const first = await startOfficeTools(actor, fixture.core, root, async () => {
      throw new Error('unused');
    });
    await first.stop();
    const next = await startOfficeTools(actor, fixture.core, root, async () => {
      throw new Error('unused');
    });
    try {
      expect(next.mcpId).toBe(first.mcpId);
      expect(fixture.calls.some((call) => call.method === 'DELETE')).toBe(false);
    } finally {
      await next.stop();
    }
  } finally {
    await fixture.close();
  }
});

test('enterprise assistants retain their tools and receive the authorized knowledge/office MCP', async () => {
  const fixture = await coreFixture(200, false, true);
  const root = await profileRoot();
  const office = await startOfficeTools(actor, fixture.core, root, async () => {
    throw new Error('unused');
  });
  try {
    await ensureOfficeAssistant(fixture.core, office.mcpId, { code: 'rc2-model', name: 'Model' });
    expect(
      fixture.calls.find(
        (call) => call.method === 'PUT' && call.route.endsWith('rc2-11111111-1111-4111-8111-111111111111')
      )?.body
    ).toEqual({ defaults: { model: { mode: 'fixed', value: 'enterprise-model' }, skills: { mode: 'fixed', value: ['finance'] }, mcps: { mode: 'fixed', value: ['independent-mcp', 'office-mcp'] } } });
  } finally {
    await office.stop();
    await fixture.close();
  }
});

test('knowledge search resolves permitted bases and output context without invented identifiers', async () => {
  const fixture = await coreFixture();
  const root = await profileRoot();
  fixture.core.workspaceRoot = path.join(root, 'workspace');
  vi.spyOn(OfficeStore.prototype, 'files').mockResolvedValue({ files: [] } as never);
  const baseId = '11111111-1111-4111-8111-111111111111';
  const checked: string[] = [];
  let allowed = true;
  const preview = vi.fn(async () => ({ response: new Response('{}'), body: { code: 200, data: { sha256: 'source-sha' } } }));
  const client = {
    me: async () => ({ userId: actor.userId }),
    resources: async (type: string) => type === 'KNOWLEDGE' ? [{ id: baseId, name: 'Company evidence', version: 3 }] : [],
    authorizedResource: async (id: string) => { checked.push(id); if (!allowed) throw new Error('resource revoked'); },
    knowledgeSearch: async (id: string, query: string) => ({ citations: [{ baseId: id, documentId: baseId, sha256: 'source-sha', content: 'Original source claim only, no acceptance evidence.', version: 3, query, locationLabel: '第 4 页' }] }),
    request: preview,
  };
  const office = await startOfficeTools(actor, fixture.core, root, async () => client as never, 'https://workspace.example');
  const registration = fixture.registered();
  const call = async (name: string, args: unknown) => (await (await fetch(
    registration.transport.url.replace('/mcp', '/conversations/c1/mcp'), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: registration.transport.headers.Authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })).json()) as { result: { content: Array<{text: string}> } };
  try {
    const context = JSON.parse((await call('office_context', {})).result.content[0].text);
    expect(context.workspaceRoot).toBe(fixture.core.workspaceRoot);
    expect(context.downloadOrigin).toBe('https://workspace.example');
    // A native Read may have happened outside MCP. A failed attempt to cite
    // its filename must still prevent silently dropping all citations.
    const invented = await call('verify_source_quotes', { citations: [{ ref: 'uploaded-file.txt', quoteIndex: 0 }] }) as unknown as { error: { message: string } };
    expect(invented.error.message).toContain('read_document');
    const noSources = await call('create_office_document', { path: 'unsourced.docx', format: 'docx', paragraphs: ['Not verified'] }) as unknown as { error: { message: string } };
    expect(noSources.error.message).toContain('SOURCE_BASED_REPORT_REQUIRES_CITATIONS');
    const found = JSON.parse((await call('search_knowledge', { query: 'requirements' })).result.content[0].text);
    expect(found.searchedBases).toBe(1);
    expect(found.results[0].citations[0]).toMatchObject({ baseId, version: 3 });
    expect(found.results[0].citations[0].sourceUrl).toContain('/#/workspace?section=knowledge&documentId=');
    expect(checked).toEqual([baseId]);
    const ref = found.results[0].citations[0].sourceRef;
    expect(found.results[0].citations[0].quoteOptions[0]).toEqual({ index: 0, quote: 'Original source claim only, no acceptance evidence.' });
    const bypass = await call('create_office_document', { path: 'report.docx', format: 'docx', sourceBased: 'True', paragraphs: ['No source should be fabricated.'] }) as unknown as { error: { message: string } };
    expect(bypass.error.message).toContain('SOURCE_BASED_REPORT_REQUIRES_CITATIONS_USE_SOURCE_REF_AND_QUOTE_INDEX');
    const omitted = await call('create_office_document', { path: 'report.docx', format: 'docx', paragraphs: ['No source should be fabricated.'] }) as unknown as { error: { message: string } };
    expect(omitted.error.message).toBe(bypass.error.message);
    const indexed = JSON.parse((await call('verify_source_quotes', { citations: [{ ref, quoteIndex: '0' }] })).result.content[0].text);
    expect(indexed.sources[0].quote).toBe('Original source claim only, no acceptance evidence.');
    const evidence = JSON.parse((await call('verify_source_quotes', { citations: [{ ref, quote: 'Original source claim only' }] })).result.content[0].text);
    expect(evidence.sources[0].locator).toMatchObject({ baseId, documentId: baseId, version: 3, location: '第 4 页' });
    expect(preview).toHaveBeenCalledWith(`/ai/knowledge/documents/${baseId}/versions/3`);
    const evidenceRow = {
      topic: 'Source claim', claim: 'Supplier states support', status: 'To confirm',
      independentRequirement: 'Missing', acceptanceEvidence: 'Missing', followUp: 'Verify independently',
      ref, quoteIndex: 0,
    };
    const wrongFormat = await call('create_office_document', { path: 'report.docx', format: 'docx', evidenceRows: [evidenceRow] }) as unknown as { error: { message: string } };
    expect(wrongFormat.error.message).toBe('OFFICE_EVIDENCE_ROWS_XLSX_ONLY');
    allowed = false;
    const denied = await call('verify_source_quotes', { citations: [{ ref, quote: 'Original source claim only' }] }) as unknown as { error: { message: string } };
    expect(denied.error.message).toBe('resource revoked');
    const deniedCreate = await call('create_office_document', { path: 'report.xlsx', format: 'xlsx', evidenceRows: [evidenceRow] }) as unknown as { error: { message: string } };
    expect(deniedCreate.error.message).toBe('resource revoked');
    allowed = true;
    await (await OfficeStore.create(root, actor)).selectKnowledge('c1', { baseIds: [], documents: [] });
    const excluded = (await call('search_knowledge', {
      query: 'requirements',
      baseId,
    })) as unknown as { error: { message: string } };
    expect(excluded.error.message).toBe('KNOWLEDGE_OUTSIDE_SELECTED_SCOPE');
    const staleCitation = (await call('verify_source_quotes', {
      citations: [{ ref, quoteIndex: 0 }],
    })) as unknown as { error: { message: string } };
    expect(staleCitation.error.message).toBe('SOURCE_OUTSIDE_SELECTED_KNOWLEDGE');

  } finally { await office.stop(); await fixture.close(); }
});

test('shared enterprise calculators are discoverable and executed under current employee authorization', async () => {
  const fixture=await coreFixture();const root=await profileRoot();fixture.core.workspaceRoot=path.join(root,'workspace');
  const resourceId='11111111-1111-4111-8111-111111111111';let allowed=true;
  const request=vi.fn(async()=>({response:new Response('{}',{status:allowed?200:403}),body:allowed?{code:200,data:{value:'20.75',rounding:'HALF_UP'}}:{code:403}}));
  const client={me:async()=>({userId:actor.userId}),resources:async(type:string)=>type==='TOOL'?[{id:resourceId,name:'Shared calculator',version:1}]:[],authorizedResource:async()=>({config:{toolType:'CALCULATOR'}}),request};
  const office=await startOfficeTools(actor,fixture.core,root,async()=>client as never,'https://workspace.example');const registration=fixture.registered();
  const call=async(name:string,args:unknown)=>await(await fetch(registration.transport.url.replace('/mcp','/conversations/c1/mcp'),{method:'POST',headers:{'content-type':'application/json',authorization:registration.transport.headers.Authorization},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json();
  try{
    const context=JSON.parse((await call('office_context',{})).result.content[0].text);expect(context.enterpriseCalculators).toEqual([{id:resourceId,name:'Shared calculator',version:1}]);
    expect(await office.trustedConfirmation({description:'MCP rc2-enterprise-zhenwork-office-tools/calculate_enterprise_tool: {}'})).toBe(true);
    expect(await office.trustedConfirmation({description:'exec wants to use: ExecCommand'})).toBe(false);
    const args={resourceId,operation:'add',a:'12.35',b:'8.40'};const result=JSON.parse((await call('calculate_enterprise_tool',args)).result.content[0].text);expect(result.value).toBe('20.75');
    expect(request).toHaveBeenCalledWith(`/ai/tools/${resourceId}/calculate`,expect.objectContaining({method:'POST',body:JSON.stringify({operation:'add',a:'12.35',b:'8.40'})}));
    allowed=false;expect((await call('calculate_enterprise_tool',args)).error.message).toContain('UNAVAILABLE');
    const count=request.mock.calls.length;expect((await call('calculate_enterprise_tool',{...args,resourceId:'../../other'})).error.message).toContain('ID_INVALID');expect(request.mock.calls.length).toBe(count);
  }finally{await office.stop();await fixture.close()}
});
