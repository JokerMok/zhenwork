import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEnterpriseDockerCoreStarter } from '../packages/web-host/src/enterprise-docker-core.ts';
import { acquireEnterpriseDockerSupervisor } from '../packages/web-host/src/enterprise-docker-supervisor.ts';
import { enterpriseProfilePath } from '../packages/web-host/src/enterprise-core.ts';

const root = await mkdtemp('/tmp/aionui-personal-mcp-agent-');
const actor = { serverId: 'smoke', userId: '999004' };
const image = (name: string) => execFileSync('docker', ['image', 'inspect', name, '--format', '{{.Id}}'],
  { encoding: 'utf8' }).trim();
const upstreamProxyPort = process.env.AION_SMOKE_UPSTREAM_PROXY_PORT
  ? Number(process.env.AION_SMOKE_UPSTREAM_PROXY_PORT) : undefined;
const mcpRuntime = process.env.AION_SMOKE_MCP_RUNTIME || 'node';
if (mcpRuntime !== 'node' && mcpRuntime !== 'python' && mcpRuntime !== 'http') {
  throw new Error('AION_SMOKE_MCP_RUNTIME must be node, python or http');
}
if (upstreamProxyPort !== undefined && (!Number.isInteger(upstreamProxyPort) ||
    upstreamProxyPort < 1 || upstreamProxyPort > 65535)) throw new Error('Invalid smoke upstream proxy port');
const gatewayImage = image(process.env.AION_SMOKE_GATEWAY_IMAGE || 'aionui-enterprise-gateway:dev');
let supervisor;
let core;
let modelRequests = 0;
let modelToolCalls = 0;
let availableTools: string[] = [];
let httpMcpCalls = 0;
let httpMcpTokenExposed = false;
let httpMcpServer: http.Server | undefined;
const fakeModel = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end('{}'); return; }
  const body = JSON.parse(raw);
  modelRequests++;
  availableTools = (body.tools || []).map((tool: any) => String(tool.function?.name || ''));
  const selected = availableTools.find((name) => name.includes('personal_echo'));
  const priorTool = (body.messages || []).some((message: any) => message.role === 'tool');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: any, finish_reason: string | null) =>
    res.write(`data: ${JSON.stringify({ id: `chatcmpl-mcp-${modelRequests}`,
      object: 'chat.completion.chunk', created: 1, model: 'smoke-personal',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (selected && !priorTool && modelToolCalls === 0) {
    modelToolCalls++;
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-personal-smoke',
      type: 'function', function: { name: selected, arguments: '{}' } }] }, null);
    chunk({}, 'tool_calls');
  } else {
    chunk({ role: 'assistant', content: priorTool ? 'Personal MCP tool completed.' : 'No MCP tool available.' }, null);
    chunk({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
const modelPort = (fakeModel.address() as { port: number }).port;
try {
  supervisor = await acquireEnterpriseDockerSupervisor(root, gatewayImage);
  const start = createEnterpriseDockerCoreStarter({ profileRoot: root, appVersion: '0.2.2', supervisor,
    coreImage: image(process.env.AION_SMOKE_CORE_IMAGE || 'aionui-enterprise-core:dev'),
    gatewayImage, upstreamProxyPort });
  core = await start(actor);
  const actorKey = createHash('sha256').update(`${actor.serverId}:${actor.userId}`).digest('hex').slice(0, 16);
  const coreContainer = execFileSync('docker', ['ps', '--filter', `label=aionui.actor=${actorKey}`,
    '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n')
    .find((name) => name.endsWith('-core'));
  if (!coreContainer) throw new Error('Core container missing');
  const containerEnv = execFileSync('docker', ['inspect', coreContainer, '--format', '{{json .Config.Env}}'],
    { encoding: 'utf8' });
  if (containerEnv.includes(core.localToken) || containerEnv.includes('AION_ENTERPRISE_LOCAL_TOKEN=')) {
    throw new Error('Core local capability exposed in Docker configuration');
  }
  await core.registerProxyPort!(modelPort);
  const profile = enterpriseProfilePath(root, actor);
  const venvDir = path.join(profile, 'personal-runtime', '.venv');
  await mkdir(path.dirname(venvDir), { recursive: true });
  const python = execFileSync('docker', ['exec', coreContainer, 'python3', '--version'], { encoding: 'utf8' }).trim();
  const uvx = execFileSync('docker', ['exec', coreContainer, 'uvx', '--version'], { encoding: 'utf8' }).trim();
  execFileSync('docker', ['exec', coreContainer, 'python3', '-m', 'venv', venvDir]);
  const pip = execFileSync('docker', ['exec', coreContainer, path.join(venvDir, 'bin', 'python'),
    '-m', 'pip', '--version'], { encoding: 'utf8' }).trim();
  if (!python.startsWith('Python 3.') || !uvx.startsWith('uvx 0.') || !pip.startsWith('pip ')) {
    throw new Error('Personal Python MCP runtime unavailable');
  }
  let uvxPackageInstalled = false;
  let npmRegistryReached = false;
  if (upstreamProxyPort) {
    const packageRun = execFileSync('docker', ['exec', coreContainer,
      'uvx', '--from', 'pip==25.2', 'pip', '--version'], { encoding: 'utf8', timeout: 90_000 }).trim();
    uvxPackageInstalled = packageRun.startsWith('pip 25.2');
    if (!uvxPackageInstalled) throw new Error('Personal uvx package installation failed');
    const npmLookup = execFileSync('docker', ['exec', coreContainer, 'npm', 'view', 'npm@11.6.1',
      'version', '--fetch-timeout=15000', '--fetch-retries=0'], { encoding: 'utf8', timeout: 30_000 }).trim();
    npmRegistryReached = npmLookup === '11.6.1';
    if (!npmRegistryReached) throw new Error('Personal npm registry unavailable');
  }
  const personal = path.join(profile, 'personal-input');
  await mkdir(personal, { recursive: true });
  const marker = path.join(profile, 'workspace', 'personal-mcp-called.txt');
  const trace = path.join(profile, 'workspace', 'personal-mcp-trace.txt');
  const script = path.join(personal, mcpRuntime === 'python' ? 'personal-mcp.py' : 'personal-mcp.cjs');
  if (mcpRuntime === 'python') {
    await writeFile(script, `import json, os, pathlib, sys\ntrace = pathlib.Path(${JSON.stringify(trace)})\nmarker = pathlib.Path(${JSON.stringify(marker)})\nfor line in sys.stdin:\n    request = json.loads(line)\n    method = request.get('method', '')\n    with trace.open('a') as stream: stream.write(method + '\\n')\n    if 'id' not in request: continue\n    if method == 'initialize':\n        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'personal-mcp-smoke', 'version': '1.0.0'}}\n    elif method == 'tools/list':\n        result = {'tools': [{'name': 'personal_echo', 'description': 'Record a personal MCP call', 'inputSchema': {'type': 'object', 'properties': {}}}]}\n    elif method == 'tools/call':\n        leaked = bool(os.environ.get('AION_ENTERPRISE_LOCAL_TOKEN')) or b'AION_ENTERPRISE_LOCAL_TOKEN=' in pathlib.Path('/proc/1/environ').read_bytes() or pathlib.Path('/run/aionui/local-token').exists()\n        marker.write_text('token-leaked' if leaked else 'called')\n        result = {'content': [{'type': 'text', 'text': 'Personal MCP tool completed.'}]}\n    else:\n        result = {}\n    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)\n`);
  } else if (mcpRuntime === 'node') {
    await writeFile(script, `const fs = require('node:fs');\nconst readline = require('node:readline');\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const request = JSON.parse(line);\n  fs.appendFileSync(${JSON.stringify(trace)}, request.method + '\\n');\n  if (request.id === undefined) return;\n  let result;\n  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'personal-mcp-smoke', version: '1.0.0' } };\n  else if (request.method === 'tools/list') result = { tools: [{ name: 'personal_echo', description: 'Record a personal MCP call', inputSchema: { type: 'object', properties: {} } }] };\n  else if (request.method === 'tools/call') {\n    try { fs.writeFileSync(${JSON.stringify(marker)}, (process.env.AION_ENTERPRISE_LOCAL_TOKEN || fs.readFileSync('/proc/1/environ').toString().includes('AION_ENTERPRISE_LOCAL_TOKEN=') || fs.existsSync('/run/aionui/local-token')) ? 'token-leaked' : 'called'); }\n    catch (error) { fs.appendFileSync(${JSON.stringify(trace)}, 'write-error:' + error.code + '\\n'); }\n    result = { content: [{ type: 'text', text: 'Personal MCP tool completed.' }] };\n  } else result = {};\n  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');\n});\n`);
  }
  const base = `http://127.0.0.1:${core.port}`;
  const headers = { 'x-aion-enterprise-local-token': core.localToken, 'content-type': 'application/json' };
  const provider = await fetch(`${base}/api/providers`, { method: 'POST', headers,
    body: JSON.stringify({ id: 'personal-smoke', platform: 'custom', name: 'Personal smoke',
      base_url: `http://model-gateway:${modelPort}/v1`, api_key: 'synthetic-key', models: ['smoke-personal'],
      model_protocols: { 'smoke-personal': 'openai' },
      model_settings: { 'smoke-personal': { openai_api_mode: 'chat_completions' } },
      capabilities: [{ type: 'text' }] }) });
  if (!provider.ok) throw new Error(`Provider creation failed (${provider.status})`);
  let transport: Record<string, unknown>;
  if (mcpRuntime === 'http') {
    httpMcpServer = http.createServer(async (req, res) => {
      if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(405).end(); return; }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (core && JSON.stringify(req.headers).includes(core.localToken)) httpMcpTokenExposed = true;
      const request = JSON.parse(raw);
      await writeFile(trace, `${request.method}\n`, { flag: 'a' });
      if (request.id === undefined) { res.writeHead(202).end(); return; }
      let result;
      if (request.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'personal-mcp-smoke', version: '1.0.0' } };
      } else if (request.method === 'tools/list') {
        result = { tools: [{ name: 'personal_echo', description: 'Record a personal MCP call',
          inputSchema: { type: 'object', properties: {} } }] };
      } else if (request.method === 'tools/call') {
        httpMcpCalls++;
        await writeFile(marker, 'called');
        result = { content: [{ type: 'text', text: 'Personal MCP tool completed.' }] };
      } else result = {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
    await new Promise<void>((resolve) => httpMcpServer!.listen(0, '127.0.0.1', resolve));
    const mcpPort = (httpMcpServer.address() as { port: number }).port;
    await core.registerProxyPort!(mcpPort);
    transport = { type: 'http', url: `http://model-gateway:${mcpPort}/mcp`, headers: {} };
  } else {
    transport = { type: 'stdio', command: mcpRuntime === 'python' ? 'python3' : 'node',
      args: [script], env: {} };
  }
  const mcp = await fetch(`${base}/api/mcp/servers`, { method: 'POST', headers,
    body: JSON.stringify({ name: 'personal-mcp-smoke', transport }) });
  const mcpBody = await mcp.json() as any;
  if (!mcp.ok || !mcpBody.data?.id) throw new Error(`Personal MCP creation failed (${mcp.status})`);
  const conversation = await fetch(`${base}/api/conversations`, { method: 'POST', headers,
    body: JSON.stringify({ type: 'aionrs', name: 'Personal MCP agent smoke',
      model: { provider_id: 'personal-smoke', model: 'smoke-personal' },
      extra: { selected_mcp_server_ids: [mcpBody.data.id] } }) });
  const conversationBody = await conversation.json() as any;
  if (!conversation.ok || !conversationBody.data?.id) {
    throw new Error(`Conversation creation failed (${conversation.status})`);
  }
  const id = conversationBody.data.id;
  const sent = await fetch(`${base}/api/conversations/${id}/messages`, { method: 'POST', headers,
    body: JSON.stringify({ content: 'Call my personal MCP tool once.' }) });
  if (!sent.ok) throw new Error(`Message send failed (${sent.status})`);
  let finalAnswer = false;
  let toolCompleted = false;
  let markerContent = '';
  let approved = false;
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const messages = await (await fetch(`${base}/api/conversations/${id}/messages`, { headers })).json() as any;
    if (i % 4 === 0) {
      const confirmations = (await (await fetch(`${base}/api/conversations/${id}/confirmations`, { headers })).json() as any).data;
      const confirmation = confirmations?.find((item: any) => item.action === 'personal_echo');
      if (confirmation && !approved) {
        const decision = await fetch(`${base}/api/conversations/${id}/confirmations/${encodeURIComponent(confirmation.call_id)}/confirm`,
          { method: 'POST', headers, body: JSON.stringify({ msg_id: confirmation.id,
            data: { value: 'proceed_once' }, always_allow: false }) });
        if (!decision.ok) throw new Error(`Synthetic user confirmation failed (${decision.status})`);
        approved = true;
      }
    }
    const items = messages.data?.items || [];
    finalAnswer = items.some((item: any) => item.type === 'text' && item.position === 'left' &&
      item.content?.content === 'Personal MCP tool completed.');
    toolCompleted = items.some((item: any) => item.type === 'tool_call' && item.content?.name === 'personal_echo' &&
      item.content?.status === 'completed');
    markerContent = await readFile(marker, 'utf8').catch(() => '');
    if (finalAnswer && toolCompleted && markerContent) break;
  }
  const traceContent = await readFile(trace, 'utf8').catch(() => '');
  if (markerContent !== 'called' || !finalAnswer || !toolCompleted || !approved ||
      modelToolCalls !== 1 || modelRequests < 2 || !availableTools.includes('personal_echo') ||
      !traceContent.includes('tools/call') || (mcpRuntime === 'http' &&
        (httpMcpCalls !== 1 || httpMcpTokenExposed))) {
    throw new Error('Personal MCP agent tool call did not complete');
  }
  console.log(JSON.stringify({ result: 'PASS', modelRequests, modelToolCalls,
    python, uvx, pipAvailable: true, uvxPackageInstalled, npmRegistryReached, mcpRuntime,
    onceApproved: approved, toolCompleted, tokenExposed: false, httpMcpCalls }));
} finally {
  await core?.stop();
  await supervisor?.close();
  if (httpMcpServer) await new Promise<void>((resolve) => httpMcpServer!.close(() => resolve()));
  await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
