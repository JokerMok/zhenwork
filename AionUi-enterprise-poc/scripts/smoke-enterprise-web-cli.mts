import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-web-cli-smoke-'));
const keyPath = path.join(root, 'rc2.key');
const certPath = path.join(root, 'rc2.crt');
const tokenPath = path.join(root, 'service.token');
const profileRoot = path.join(root, 'profiles');
await fs.mkdir(profileRoot, { mode: 0o700 });
const rootKey = createHash('sha256').update(await fs.realpath(profileRoot)).digest('hex').slice(0, 20);
const serviceToken = randomBytes(32).toString('base64url');
await fs.writeFile(tokenPath, `${serviceToken}\n`, { mode: 0o600 });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
  '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'],
{ stdio: 'ignore' });
const cert = await fs.readFile(certPath);
const key = await fs.readFile(keyPath);
const uiHold = process.env.AION_SMOKE_UI_HOLD === '1';
const accounts = new Map([['demo', { password: 'demo', userId: '91' }],
  ['beta', { password: 'beta', userId: '92' }]]);
const active = new Map([['91', true], ['92', true]]);
const sessions = new Map<string, string>();
const backgroundGrants = new Map<string, { id: string; secret: string; userId: string }>();
let loginCount = 0;
let rc2Requests = 0;
let modelRequests = 0;
let reviewFilePath: string | null = null;
let inspectionDocxPath: string | null = null;
const streamModelReply = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  let raw = '';
  for await (const part of req) raw += String(part);
  const input = JSON.parse(raw) as { model?: string; stream?: boolean;
    tools?: Array<{ function?: { name?: string } }>;
    messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }> };
  const latestUserContent = input.messages?.filter((message) => message.role === 'user').at(-1)?.content;
  const latestUserText = typeof latestUserContent === 'string'
    ? latestUserContent : JSON.stringify(latestUserContent ?? '');
  if (process.env.AION_SMOKE_TRACE_TEAM === '1') {
    console.error(`TEAM_MODEL_TRACE ${JSON.stringify({ tools: input.tools?.map((tool) => tool.function?.name),
      searchSchema: input.tools?.find((tool) => tool.function?.name === 'ToolSearch')?.function,
      roles: input.messages?.slice(-4).map((message) => message.role),
      toolResults: input.messages?.filter((message) => message.role === 'tool')
        .map((message) => JSON.stringify(message.content).slice(0, 500)) })}`);
  }
  if (input.model !== 'smoke-model' || input.stream !== true) {
    res.statusCode = 400;
    res.end(JSON.stringify({ code: 400 }));
    return;
  }
  modelRequests += 1;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const frame = (delta: Record<string, unknown>, finish_reason: string | null) =>
    res.write(`data: ${JSON.stringify({ id: `chatcmpl-web-${modelRequests}`, object: 'chat.completion.chunk',
      created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (latestUserText.includes('Discover team tools for delegation') &&
      !input.messages?.some((message) => message.role === 'tool') &&
      input.tools?.some((tool) => tool.function?.name === 'team_members')) {
    frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-team-members', type: 'function',
      function: { name: 'team_members', arguments: '{}' } }] }, null);
    frame({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
    return;
  }
  if (latestUserText.includes('Discover team tools for delegation') &&
      input.tools?.some((tool) => tool.function?.name === 'team_send_message') &&
      input.messages?.filter((message) => message.role === 'tool').length === 1) {
    const rawMembers = input.messages.find((message) => message.role === 'tool')?.content;
    const members = JSON.parse(String(rawMembers)) as Array<{ slot_id?: string; role?: string }>;
    const teammate = members.find((member) => member.role === 'teammate');
    if (!teammate?.slot_id) throw new Error('Team MCP did not return a teammate slot');
    frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-team-delegate', type: 'function',
      function: { name: 'team_send_message', arguments: JSON.stringify({ to: teammate.slot_id,
        message: 'Synthetic delegated task from lead: reply with the enterprise marker.', files: [] }) } }] }, null);
    frame({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
    return;
  }
  if (latestUserText.includes('Create a review file for browser approval')) {
    const latestUserIndex = input.messages?.findLastIndex((message) => message.role === 'user') ?? -1;
    const priorTool = input.messages?.slice(latestUserIndex + 1).some((message) => message.role === 'tool');
    if (!priorTool && reviewFilePath && input.tools?.some((tool) => tool.function?.name === 'Write')) {
      frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-browser-review-write', type: 'function',
        function: { name: 'Write', arguments: JSON.stringify({ file_path: reviewFilePath,
          content: 'Synthetic browser approved artifact.' }) } }] }, null);
      frame({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    frame({ role: 'assistant', content: priorTool && reviewFilePath
      ? `Synthetic approval file created.\n\n[synthetic-review.txt](file://${reviewFilePath})`
      : 'Review file tool unavailable.' }, null);
    frame({}, 'stop');
    res.end('data: [DONE]\n\n');
    return;
  }
  if (latestUserText.includes('Check read-only tools without approval')) {
    const latestUserIndex = input.messages?.findLastIndex((message) => message.role === 'user') ?? -1;
    const results = input.messages?.slice(latestUserIndex + 1).filter((message) => message.role === 'tool') ?? [];
    if (results.length === 0) {
      frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-browser-readonly-search', type: 'function',
        function: { name: 'ToolSearch', arguments: JSON.stringify({ query: 'ExecCommand' }) } }] }, null);
      frame({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (results.length === 1) {
      frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-browser-readonly-command', type: 'function',
        function: { name: 'ExecCommand', arguments: JSON.stringify({ cmd: 'command -v officecli' }) } }] }, null);
      frame({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (results.length === 2 && inspectionDocxPath) {
      frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-browser-readonly-docx', type: 'function',
        function: { name: 'ExecCommand', arguments: JSON.stringify({
          cmd: `python3 -I /opt/aionui/tools/read_docx.py '${inspectionDocxPath}'`,
        }) } }] }, null);
      frame({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    const commandOutput = String(results.at(-1)?.content ?? '');
    frame({ role: 'assistant', content: commandOutput.includes('Synthetic inspection marker.')
      ? 'Synthetic read-only tools completed.' : `Synthetic document inspection failed: ${commandOutput}` }, null);
    frame({}, 'stop');
    res.end('data: [DONE]\n\n');
    return;
  }
  if (latestUserText.includes('Start a slow browser task for cancellation')) {
    console.log('SLOW_MODEL_STARTED');
    frame({ role: 'assistant', content: 'Synthetic slow task is running.' }, null);
    const timer = setTimeout(() => {
      console.log('SLOW_MODEL_COMPLETED');
      frame({ content: ' Synthetic slow task completed.' }, null);
      frame({}, 'stop');
      res.end('data: [DONE]\n\n');
    }, 30_000);
    res.once('close', () => {
      clearTimeout(timer);
      if (!res.writableEnded) console.log('SLOW_MODEL_ABORTED');
    });
    return;
  }
  frame({ role: 'assistant', content: 'Synthetic enterprise reply from RC2.' }, null);
  frame({}, 'stop');
  res.end('data: [DONE]\n\n');
};
const rc2 = https.createServer({ key, cert }, async (req, res) => {
  rc2Requests += 1;
  res.setHeader('content-type', 'application/json');
  const send = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
  if (req.url === '/internal/rc2/background/health') {
    return req.headers.authorization === `Bearer ${serviceToken}`
      ? send(200, { code: 200, data: { ready: true } }) : send(401, { code: 401 });
  }
  const background = req.url?.match(/^\/internal\/rc2\/background\/grants\/([0-9a-f-]{36})(.*)$/i);
  if (background) {
    const entry = [...backgroundGrants.entries()].find(([, grant]) => grant.id === background[1]);
    if (!entry || !active.get(entry[1].userId) || req.headers.authorization !== `Bearer ${serviceToken}` ||
        req.headers['x-aion-background-secret'] !== entry[1].secret) return send(401, { code: 401 });
    const [jobId, grant] = entry;
    if (background[2] === '') return send(200, { code: 200, data: { userId: grant.userId, jobId } });
    if (background[2] === '/models/available') return send(200, { code: 200, data: [
      { id: 'synthetic-enterprise-model', code: 'smoke-model', name: 'Synthetic enterprise model', streaming: true },
    ] });
    if (background[2].startsWith('/resources?')) return send(200, { code: 200, data: [] });
    if (background[2] === '/models/synthetic-enterprise-model/chat/completions' && req.method === 'POST') {
      return streamModelReply(req, res);
    }
    return send(404, { code: 404 });
  }
  if (req.url === '/ai/bootstrap') return send(200, { code: 200, data: {
    clientId: 'synthetic-cli', serverId: 'synthetic-cli-server', protocolVersion: 2,
    requiredOrigin: 'https://workspace.example',
  } });
  if (req.url === '/auth/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const login = JSON.parse(body);
    const account = accounts.get(login.username);
    if (req.headers.origin !== 'https://workspace.example' || login.clientId !== 'synthetic-cli' ||
        !account || login.password !== account.password) return send(401, { code: 401 });
    loginCount += 1;
    const cookie = `__Host-workspace-rc2=synthetic-cli-session-${account.userId}-123456789`;
    sessions.set(cookie, account.userId);
    res.setHeader('set-cookie', `${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    return send(200, { code: 200, data: { access_token: 'cookie-session' } });
  }
  const userId = sessions.get(String(req.headers.cookie || ''));
  if (!userId || req.headers.clientid !== 'synthetic-cli') return send(401, { code: 401 });
  if (req.url === '/auth/logout' && req.method === 'POST') {
    sessions.delete(String(req.headers.cookie));
    return send(200, { code: 200 });
  }
  if (!active.get(userId)) return send(401, { code: 401 });
  const grantRoute = req.url?.match(/^\/ai\/background\/jobs\/(cron_[A-Za-z0-9_-]{8,80})\/grant$/);
  if (uiHold && grantRoute) {
    if (req.headers.authorization !== `Bearer ${serviceToken}`) return send(401, { code: 401 });
    const jobId = grantRoute[1];
    if (req.method === 'DELETE') {
      backgroundGrants.delete(jobId);
      return send(200, { code: 200, data: null });
    }
    if (req.method !== 'POST') return send(405, { code: 405 });
    const grant = { id: randomUUID(), secret: randomBytes(32).toString('hex'), userId };
    backgroundGrants.set(jobId, grant);
    return send(200, { code: 200, data: { ...grant, jobId } });
  }
  if (req.url === '/ai/me') return send(200, { code: 200, data: { userId, mustChangePassword: false } });
  if (req.url === '/ai/models/available') return send(200, { code: 200, data: uiHold
    ? [{ id: 'synthetic-enterprise-model', code: 'smoke-model', name: 'Synthetic enterprise model', streaming: true }]
    : [] });
  if (uiHold && req.url === '/ai/model-relay/synthetic-enterprise-model/chat/completions' && req.method === 'POST') {
    return streamModelReply(req, res);
  }
  if (req.url?.startsWith('/ai/resources?')) return send(200, { code: 200, data: [] });
  return send(404, { code: 404 });
});
await new Promise<void>((resolve) => rc2.listen(0, '127.0.0.1', resolve));
const rc2Port = (rc2.address() as { port: number }).port;
const reserve = http.createServer();
await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const gatewayPort = (reserve.address() as { port: number }).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
const proxyReserve = uiHold ? https.createServer({ key, cert }) : null;
if (proxyReserve) await new Promise<void>((resolve) => proxyReserve.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxyReserve?.address() as { port: number } | null)?.port;
if (proxyReserve) await new Promise<void>((resolve) => proxyReserve.close(() => resolve()));
const webOrigin = proxyPort ? `https://127.0.0.1:${proxyPort}` : 'https://workspace.example';
const webHost = new URL(webOrigin).host;
const webProxy = proxyPort ? https.createServer({ key, cert }, (req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: gatewayPort,
    path: req.url, method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
}) : null;
webProxy?.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(gatewayPort, '127.0.0.1');
  upstream.once('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`,
      ...Object.entries(req.headers).map(([name, value]) => `${name}: ${value}`), '', ''];
    upstream.write(lines.join('\r\n'));
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once('error', () => socket.destroy());
  socket.once('error', () => upstream.destroy());
});
if (webProxy) await new Promise<void>((resolve) => webProxy.listen(proxyPort!, '127.0.0.1', resolve));
const image = (name: string) => execFileSync('docker', ['image', 'inspect', name, '--format', '{{.Id}}'],
  { encoding: 'utf8' }).trim();
const coreImage = image(process.env.AION_SMOKE_CORE_IMAGE || 'aionui-enterprise-core:dev');
const gatewayImage = image(process.env.AION_SMOKE_GATEWAY_IMAGE || 'aionui-enterprise-gateway:dev');
const cli = path.resolve('packages/web-cli/dist/aionui-enterprise-web.cjs');
const child = spawn(process.execPath, [cli], { env: { ...process.env,
  NODE_EXTRA_CA_CERTS: certPath,
  AION_ENTERPRISE_WEB_PUBLIC_ORIGIN: webOrigin,
  AION_ENTERPRISE_WEB_RC2_URL: `https://127.0.0.1:${rc2Port}`,
  AION_ENTERPRISE_WEB_STATIC_DIR: path.resolve('out/renderer'),
  AION_ENTERPRISE_WEB_PORT: String(gatewayPort),
  AION_ENTERPRISE_WEB_PROFILE_ROOT: profileRoot,
  AION_ENTERPRISE_WEB_RC2_SERVICE_TOKEN_FILE: tokenPath,
  AION_ENTERPRISE_WEB_APP_VERSION: '0.2.2',
  AION_ENTERPRISE_WEB_DOCKER_CORE_IMAGE: coreImage,
  AION_ENTERPRISE_WEB_DOCKER_GATEWAY_IMAGE: gatewayImage,
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-10000); });
const call = (method: string, route: string, cookie?: string, data?: unknown,
  extraHeaders?: Record<string, string>) =>
  new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: gatewayPort, path: route, method,
      headers: { Host: webHost, Origin: webOrigin,
        ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(parts).toString(),
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    req.once('error', reject);
    req.end(data ? JSON.stringify(data) : undefined);
  });
const upload = (cookie: string, fileName: string, contents: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const boundary = `aion-smoke-${randomBytes(8).toString('hex')}`;
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: text/plain\r\n\r\n${contents}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n` +
      `smoke-upload-actor-91\r\n--${boundary}--\r\n`
    );
    const req = http.request({ hostname: '127.0.0.1', port: gatewayPort, path: '/api/fs/upload', method: 'POST',
      headers: { Host: webHost, Origin: webOrigin, Cookie: cookie,
        'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.end(payload);
  });
try {
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${logs}`);
    try { if ((await call('GET', '/enterprise/login')).status === 200) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`CLI did not listen: ${logs}`);
  const unauth = await call('GET', '/api/providers');
  const login = await call('POST', '/enterprise/login', undefined, { username: 'demo', password: 'demo' });
  if (login.status !== 200 || !login.cookie) throw new Error(`Login failed: ${login.status} ${login.body} ${logs}`);
  const secondLogin = await call('POST', '/enterprise/login', undefined, { username: 'beta', password: 'beta' });
  if (secondLogin.status !== 200 || !secondLogin.cookie || secondLogin.cookie === login.cookie)
    throw new Error(`Second login failed: ${secondLogin.status} ${logs}`);
  const rootPage = await call('GET', '/', login.cookie);
  const info = await call('GET', '/api/system/info', login.cookie);
  if (info.status !== 200) throw new Error(`Core unavailable: ${info.status} ${info.body} ${logs}`);
  const secondInfo = await call('GET', '/api/system/info', secondLogin.cookie);
  if (secondInfo.status !== 200) throw new Error(`Second Core unavailable: ${secondInfo.status} ${logs}`);
  const serverKey = createHash('sha256').update('synthetic-cli-server').digest('hex').slice(0, 24);
  const actorWorkspace = (userId: string) => path.join(profileRoot, 'profiles', serverKey, userId, 'workspace');
  reviewFilePath = path.join(actorWorkspace('91'), 'synthetic-review.txt');
  inspectionDocxPath = path.join(actorWorkspace('91'), 'synthetic-inspection.docx');
  execFileSync('python3', ['-c',
    'from zipfile import ZipFile; import sys; ZipFile(sys.argv[1], "w").writestr("word/document.xml", "<w:document xmlns:w=\\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\\"><w:body><w:p><w:r><w:t>Synthetic inspection marker.</w:t></w:r></w:p></w:body></w:document>")',
    inspectionDocxPath], { stdio: 'ignore' });
  const reportedWorkDir = (JSON.parse(info.body) as { data?: { work_dir?: string } }).data?.work_dir;
  if (reportedWorkDir !== actorWorkspace('91')) {
    throw new Error(`Core reported a different workspace path: ${String(reportedWorkDir)}`);
  }
  const aFile = path.join(actorWorkspace('91'), 'actor-a-only.txt');
  const bFile = path.join(actorWorkspace('92'), 'actor-b-only.txt');
  const hostFile = path.join(root, 'host-only-canary.txt');
  await fs.writeFile(aFile, 'actor-a-private-marker', { mode: 0o600 });
  await fs.writeFile(bFile, 'actor-b-private-marker', { mode: 0o600 });
  await fs.writeFile(hostFile, 'host-private-marker', { mode: 0o600 });
  await fs.symlink('/etc/passwd', path.join(actorWorkspace('91'), 'container-system-link'));
  const ownDirectory = await call('POST', '/api/fs/dir', login.cookie,
    { dir: actorWorkspace('91'), root: '/' });
  const otherDirectory = await call('POST', '/api/fs/dir', login.cookie,
    { dir: actorWorkspace('92'), root: actorWorkspace('92') });
  const listedNames = ownDirectory.status === 200
    ? (JSON.parse(ownDirectory.body) as { data?: Array<{ name: string }> }).data?.map((item) => item.name) : undefined;
  const directoryScope = ownDirectory.status === 200 && listedNames?.includes('actor-a-only.txt') === true &&
    !listedNames.includes('container-system-link') && otherDirectory.status === 403;
  const bypassRoutes = ['/%61pi/fs/dir', '/api/%66s/dir', '/api/fs/%64ir', '/api/fs/x/../dir', '/api//fs/dir'];
  const bypassResults = await Promise.all(bypassRoutes.map((route) =>
    call('POST', route, login.cookie, { dir: '/etc', root: '/etc' })));
  const directoryBypass = bypassResults.some((result) => result.status === 200 && result.body.includes('passwd'));
  if (!directoryScope) throw new Error(`Directory scope failed: ${JSON.stringify({
    ownDirectory: ownDirectory.status, otherDirectory: otherDirectory.status, listedNames })}`);
  if (directoryBypass) throw new Error(`Encoded directory route bypass: ${JSON.stringify(bypassResults.map((item) => item.status))}`);
  const readFileAs = (cookie: string, file: string) =>
    call('POST', '/api/fs/read', cookie, { path: file, workspace: path.dirname(file) });
  const ownA = await readFileAs(login.cookie, aFile);
  const ownB = await readFileAs(secondLogin.cookie, bFile);
  const crossA = await readFileAs(login.cookie, bFile);
  const crossB = await readFileAs(secondLogin.cookie, aFile);
  const hostOnly = await readFileAs(login.cookie, hostFile);
  const crossWrite = await call('POST', '/api/fs/write', secondLogin.cookie,
    { path: aFile, workspace: actorWorkspace('91'), data: 'cross-user-overwrite' });
  const reverseCrossWrite = await call('POST', '/api/fs/write', login.cookie,
    { path: bFile, workspace: actorWorkspace('92'), data: 'reverse-cross-user-overwrite' });
  const hostWrite = await call('POST', '/api/fs/write', login.cookie,
    { path: hostFile, workspace: root, data: 'host-overwrite' });
  const readable = (response: { body: string }) => {
    try { return (JSON.parse(response.body) as { data?: unknown }).data; }
    catch { return null; }
  };
  const fileIsolation = ownA.status === 200 && readable(ownA) === 'actor-a-private-marker' &&
    ownB.status === 200 && readable(ownB) === 'actor-b-private-marker' &&
    !crossA.body.includes('actor-b-private-marker') && !crossB.body.includes('actor-a-private-marker') &&
    !hostOnly.body.includes('host-private-marker') &&
    await fs.readFile(aFile, 'utf8') === 'actor-a-private-marker' &&
    await fs.readFile(bFile, 'utf8') === 'actor-b-private-marker' &&
    await fs.readFile(hostFile, 'utf8') === 'host-private-marker';
  if (!fileIsolation) throw new Error(`File isolation failed: ${JSON.stringify({
    ownA: ownA.status, ownB: ownB.status, crossA: crossA.status, crossB: crossB.status,
    hostOnly: hostOnly.status, crossWrite: crossWrite.status,
    reverseCrossWrite: reverseCrossWrite.status, hostWrite: hostWrite.status })}`);
  const uploaded = await upload(login.cookie, 'current-device-note.txt', 'uploaded-from-current-device');
  const uploadedPath = uploaded.status === 200
    ? (JSON.parse(uploaded.body) as { data?: string }).data : undefined;
  const streamRoute = uploadedPath
    ? `/api/fs/stream?kind=local&path=${encodeURIComponent(uploadedPath)}` : '';
  const downloaded = streamRoute ? await call('GET', streamRoute, login.cookie) : null;
  const otherDownload = streamRoute ? await call('GET', streamRoute, secondLogin.cookie) : null;
  const uploadDownload = uploaded.status === 200 && typeof uploadedPath === 'string' &&
    downloaded?.status === 200 && downloaded.body === 'uploaded-from-current-device' &&
    !otherDownload?.body.includes('uploaded-from-current-device');
  const hostUploadBeforeRestart = uploadedPath
    ? await fs.readFile(uploadedPath, 'utf8').catch((error: NodeJS.ErrnoException) => error.code) : null;
  if (!uploadDownload) throw new Error(`Upload/download failed: ${JSON.stringify({
    uploaded: uploaded.status, uploadedPath, hostUploadBeforeRestart, downloaded: downloaded?.status,
    otherDownload: otherDownload?.status })}`);
  if (hostUploadBeforeRestart !== 'uploaded-from-current-device') {
    throw new Error(`Uploaded file is not on the actor host mount (${String(hostUploadBeforeRestart)})`);
  }
  const provider = await call('POST', '/api/providers', login.cookie, {
    id: 'personal-cli-smoke', platform: 'custom', name: 'Synthetic personal',
    base_url: 'https://url-user:url-secret@example.test/v1?key=query-secret',
    api_key: 'synthetic-api-secret', models: ['smoke'],
    model_protocols: { smoke: 'openai' },
    model_settings: { smoke: { openai_api_mode: 'chat_completions' } },
    capabilities: [{ type: 'text' }],
  });
  const listed = await call('GET', '/api/providers', login.cookie);
  const secondListed = await call('GET', '/api/providers', secondLogin.cookie);
  const parsed = JSON.parse(listed.body);
  const item = parsed.data?.find((value: { id: string }) => value.id === 'personal-cli-smoke');
  const crossUserLeak = JSON.parse(secondListed.body).data?.some((value: { id: string }) => value.id === 'personal-cli-smoke');
  const safe = [provider.body, listed.body].every((body) => !body.includes('synthetic-api-secret') &&
    !body.includes('url-secret') && !body.includes('query-secret'));
  if (unauth.status !== 401 || rootPage.status !== 200 || provider.status !== 200 && provider.status !== 201 ||
      listed.status !== 200 || secondListed.status !== 200 || crossUserLeak || !safe ||
      !item?.base_url_configured || !item?.api_key_configured || loginCount !== 2)
    throw new Error(`CLI contract failed: ${JSON.stringify({ unauth: unauth.status,
      root: rootPage.status, provider: provider.status, listed: listed.status, secondListed: secondListed.status,
      crossUserLeak, item, safe, loginCount })}`);
  const createdConversation = await call('POST', '/api/conversations', login.cookie, {
    type: 'aionrs', name: 'Web source marker for actor A',
    model: { provider_id: 'personal-cli-smoke', model: 'smoke' },
    extra: {},
  });
  const createdId = (JSON.parse(createdConversation.body) as { data?: { id?: string } }).data?.id;
  if (createdConversation.status !== 201 || !createdId) {
    throw new Error(`Web conversation creation failed: ${createdConversation.status} ${createdConversation.body}`);
  }
  const catalogA = await call('GET', '/enterprise/conversations', login.cookie);
  const catalogB = await call('GET', '/enterprise/conversations', secondLogin.cookie);
  const borrowedRc2 = '__Host-workspace-rc2=synthetic-cli-session-91-123456789';
  const desktopSession = await call('POST', '/enterprise/desktop-session', undefined, undefined,
    { 'x-aion-rc2-session': borrowedRc2 });
  const desktopCatalog = desktopSession.cookie
    ? await call('GET', '/enterprise/conversations', desktopSession.cookie) : null;
  const aItems = catalogA.status === 200
    ? (JSON.parse(catalogA.body) as { items?: Array<{ id: string; key: string; source: string }> }).items : undefined;
  const bItems = catalogB.status === 200
    ? (JSON.parse(catalogB.body) as { items?: Array<{ id: string }> }).items : undefined;
  const desktopItems = desktopCatalog?.status === 200
    ? (JSON.parse(desktopCatalog.body) as { items?: Array<{ id: string; key: string; source: string }> }).items : undefined;
  const expectedKey = `enterprise_web:synthetic-cli-server:91:${createdId}`;
  const sourceCatalog = aItems?.some((entry) => entry.id === createdId && entry.key === expectedKey &&
    entry.source === 'enterprise_web') === true &&
    bItems?.every((entry) => entry.id !== createdId) === true &&
    desktopItems?.some((entry) => entry.id === createdId && entry.key === expectedKey &&
      entry.source === 'enterprise_web') === true;
  if (!sourceCatalog) throw new Error(`Web/desktop conversation catalog failed: ${JSON.stringify({
    created: createdConversation.status, catalogA: catalogA.status, catalogB: catalogB.status,
    desktopSession: desktopSession.status, desktopCatalog: desktopCatalog?.status,
    createdId, rawCoreList: (await call('GET', '/api/conversations?limit=100', login.cookie)).body.slice(0, 1500),
    aItems, bItems, desktopItems })}`);
  if (uiHold) {
    const releaseFile = path.join(root, 'ui-release');
    console.log(`UI_READY ${JSON.stringify({ rc2Url: `https://127.0.0.1:${rc2Port}`,
      webOrigin, certPath, createdId, releaseFile })}`);
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (await fs.access(releaseFile).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  active.set('91', false);
  const revoked = await call('GET', '/api/providers', login.cookie);
  const unaffected = await call('GET', '/api/providers', secondLogin.cookie);
  if (revoked.status !== 401 || unaffected.status !== 200) {
    throw new Error(`Revocation isolation failed: A=${revoked.status}, B=${unaffected.status}`);
  }
  const hostUploadAfterRevoke = await fs.readFile(uploadedPath!, 'utf8')
    .catch((error: NodeJS.ErrnoException) => error.code);
  active.set('91', true);
  const resumedLogin = await call('POST', '/enterprise/login', undefined, { username: 'demo', password: 'demo' });
  if (resumedLogin.status !== 200 || !resumedLogin.cookie) {
    throw new Error(`A could not log in after reactivation (${resumedLogin.status})`);
  }
  const hostUploadAfterLogin = await fs.readFile(uploadedPath!, 'utf8')
    .catch((error: NodeJS.ErrnoException) => error.code);
  const persistedDownload = await call('GET', streamRoute, resumedLogin.cookie);
  const uploadPersisted = persistedDownload.status === 200 &&
    persistedDownload.body === 'uploaded-from-current-device';
  if (!uploadPersisted) {
    const hostContents = await fs.readFile(uploadedPath!, 'utf8').catch((error: NodeJS.ErrnoException) => error.code);
    const coreRead = await call('POST', '/api/fs/read', resumedLogin.cookie,
      { path: uploadedPath, workspace: path.dirname(uploadedPath!) });
    const tempDirContents = await fs.readdir(path.join(actorWorkspace('91'), '..', 'tmp'))
      .catch((error: NodeJS.ErrnoException) => [error.code || 'unknown']);
    const uploadDirContents = await fs.readdir(path.dirname(uploadedPath!))
      .catch((error: NodeJS.ErrnoException) => [error.code || 'unknown']);
    throw new Error(`Uploaded file did not survive Core restart (${JSON.stringify({
      stream: persistedDownload.status, hostContents, coreRead: coreRead.status,
      coreReadBody: coreRead.body.slice(0, 400), hostUploadAfterRevoke,
      hostUploadAfterLogin, tempDirContents, uploadDirContents })})`);
  }
  console.log(JSON.stringify({ result: 'PASS', unauth: unauth.status, root: rootPage.status,
    core: info.status, secondCore: secondInfo.status, provider: provider.status, listed: listed.status,
    secretsHidden: safe, crossUserLeak: Boolean(crossUserLeak), fileIsolation, directoryScope,
    uploadDownload, uploadPersisted, uploadedPath, sourceCatalog,
    revoked: revoked.status,
    unaffected: unaffected.status, loginCount, rc2Requests, modelRequests }));
  await call('POST', '/enterprise/logout', secondLogin.cookie);
  if (desktopSession.cookie) await call('POST', '/enterprise/logout', desktopSession.cookie);
  await call('POST', '/enterprise/logout', resumedLogin.cookie);
} catch (error) {
  console.error(String(error));
  console.error(logs.slice(-4500));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
  }
  if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise<void>((resolve) => rc2.close(() => resolve()));
  if (webProxy) await new Promise<void>((resolve) => webProxy.close(() => resolve()));
  // Report an incomplete shutdown, then clean only Docker objects with this
  // disposable profile root's verified label.
  let cleanupComplete = false;
  try {
    const dockerIds = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const containers = dockerIds(['ps', '--no-trunc', '-aq', '--filter', `label=aionui.root=${rootKey}`]);
    const networks = dockerIds(['network', 'ls', '--no-trunc', '-q', '--filter', `label=aionui.root=${rootKey}`]);
    if (containers.length || networks.length) {
      console.error(`Docker cleanup incomplete: ${containers.length} containers, ${networks.length} networks`);
      process.exitCode = 1;
    }
    for (const id of containers) {
      const item = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0];
      if (item.Id !== id || item.Config?.Labels?.['aionui.root'] !== rootKey ||
          !['1', 'supervisor'].includes(item.Config?.Labels?.['aionui.enterprise'])) {
        throw new Error('Untrusted Docker container during smoke cleanup');
      }
      execFileSync('docker', ['rm', '-f', id]);
    }
    for (const id of networks) {
      const item = JSON.parse(execFileSync('docker', ['network', 'inspect', id], { encoding: 'utf8' }))[0];
      if (item.Id !== id || item.Labels?.['aionui.root'] !== rootKey ||
          item.Labels?.['aionui.enterprise'] !== '1') {
        throw new Error('Untrusted Docker network during smoke cleanup');
      }
      execFileSync('docker', ['network', 'rm', id]);
    }
    cleanupComplete = dockerIds(['ps', '--no-trunc', '-aq', '--filter', `label=aionui.root=${rootKey}`]).length === 0 &&
      dockerIds(['network', 'ls', '--no-trunc', '-q', '--filter', `label=aionui.root=${rootKey}`]).length === 0;
    if (!cleanupComplete) throw new Error('Smoke Docker objects remain after cleanup');
  } catch (error) {
    console.error('Smoke cleanup failed:', String(error));
    process.exitCode = 1;
  }
  if (cleanupComplete) await fs.rm(root, { recursive: true, force: true });
  else console.error(`Smoke profile retained for verified cleanup: ${root}`);
}
