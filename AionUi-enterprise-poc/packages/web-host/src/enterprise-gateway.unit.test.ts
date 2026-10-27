import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import http from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { startEnterpriseGateway } from './enterprise-gateway.js';

let tempDir = '';
let port = 0;
let stop = async () => {};
let reconcileAuthorization = async () => {};
const allowed = new Map([
  ['1', true],
  ['2', true],
]);
const started: string[] = [];
const stopped: string[] = [];
const invalidate = new Map<string, () => void>();
const clientPrefs = new Map<string, Record<string, unknown>>();
const pinnedConversations = new Map<string, boolean>([['1', true]]);
const conversationNames = new Map<string, string>();
let lastDirRoot = '';
const edgeToken = 'fixed-edge-token-for-enterprise-unit-tests';
let lastLoginClient: { ipAddress: string; userAgent: string } | undefined;
let publicBrandValue: unknown = { productName: 'ZhenWork', companyName: '示例企业',
  loginTitle: '欢迎使用ZhenWork', loginSubtitle: '使用企业账号继续', primaryColor: '#2563eb' };

function request(
  method: string,
  url: string,
  cookie?: string,
  payload?: unknown,
  origin = 'https://workspace.example',
  extraHeaders: Record<string, string> = {}
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; bytes: Buffer }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers: {
          host: 'workspace.example',
          ...(origin ? { origin } : {}),
          ...(cookie ? { cookie } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
          'x-aion-enterprise-local-token': 'browser-forged',
          'x-zhenwork-edge-token': edgeToken,
          'x-zhenwork-client-ip': '203.0.113.10',
          'x-zhenwork-client-user-agent': 'Mozilla/5.0 Unit Chrome/120',
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString(), bytes: Buffer.concat(chunks) })
        );
      }
    );
    req.once('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'enterprise-gateway-'));
  await writeFile(path.join(tempDir, 'index.html'), '<html><head></head><body><h1>Workspace</h1></body></html>');
  await mkdir(path.join(tempDir, 'workspace-1'));
  await mkdir(path.join(tempDir, 'workspace-2'));
  await mkdir(path.join(tempDir, 'outside'));
  await writeFile(path.join(tempDir, 'workspace-1', 'own.txt'), 'own');
  await symlink(path.join(tempDir, 'index.html'), path.join(tempDir, 'workspace-1', 'outside-file'));
  await symlink(path.join(tempDir, 'outside'), path.join(tempDir, 'workspace-1', 'outside-directory'));
  const gateway = await startEnterpriseGateway({
    staticDir: tempDir,
    publicOrigin: 'https://workspace.example',
    port: 0,
    trustedProxyToken: edgeToken,
    publicBrand: async () => publicBrandValue,
    login: async (username, password, client) => {
      lastLoginClient = client;
      if (username === 'reset' && password === 'test') {
        const error = new Error('Password change required');
        Object.assign(error, { code: 'PASSWORD_CHANGE_REQUIRED' });
        throw error;
      }
      if (password !== 'test' || !['1', '2'].includes(username)) throw new Error('Invalid login');
      return {
        actor: { serverId: 'rc2', userId: username },
        username: `employee-${username}`,
        brand: async () => ({ productName: `Workspace ${username}`, primaryColor: '#123abc',
          logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=', internalToken: 'never-expose' }),
        validate: async () => allowed.get(username) === true,
        close: async () => {},
      };
    },
    changePassword: async (username, oldPassword) => {
      if (username !== 'reset' || oldPassword !== 'test') throw new Error('Invalid credential');
    },
    resume: async (rc2Cookie) => {
      if (rc2Cookie !== '__Host-workspace-rc2=valid-desktop-session') throw new Error('Invalid RC2 cookie');
      return { actor: { serverId: 'rc2', userId: '2' }, validate: async () => allowed.get('2') === true,
        close: async () => {} };
    },
    startCore: async (actor) => {
      started.push(actor.userId);
      const token = `core-token-${actor.userId}`;
      const core = http.createServer((req, res) => {
        if (req.url === '/api/fs/dir') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            lastDirRoot = (JSON.parse(Buffer.concat(chunks).toString()) as { root: string }).root;
            const folder = path.join(tempDir, `workspace-${actor.userId}`);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ success: true, data: [
              { name: 'own.txt', full_path: path.join(folder, 'own.txt'), is_dir: false },
              { name: 'outside-file', full_path: path.join(folder, 'outside-file'), is_dir: false },
              { name: 'outside-directory', full_path: path.join(folder, 'outside-directory'), is_dir: true },
            ] }));
          });
          return;
        }
        if (req.url?.startsWith('/api/settings/client')) {
          const current = clientPrefs.get(actor.userId) || { 'tools.speechToText': {
            provider: 'openai', openai: { api_key: 'speech-secret', model: 'gpt-4o-transcribe' },
          }, 'google.config': { proxy: 'http://user:proxy-secret@127.0.0.1:9999' },
          'mcp.config': [{ id: 'private-mcp', transport: { type: 'http',
            url: 'https://mcp.example/?token=hidden', headers: { Authorization: 'Bearer hidden' } } }] };
          if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
              const saved = { ...current, ...JSON.parse(Buffer.concat(chunks).toString()) };
              clientPrefs.set(actor.userId, saved);
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ success: true, data: saved }));
            });
          } else {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ success: true, data: current }));
          }
          return;
        }
        if (req.url === '/api/providers/bad-response') {
          res.setHeader('content-type', 'text/plain');
          res.end('sk-secret-in-unexpected-format');
          return;
        }
        if (req.url === '/api/providers') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, data: [{ id: 'own', api_key: 'sk-secret-a,sk-secret-b',
            base_url: 'https://url-user:url-secret@example.test/v1?key=query-secret',
            bedrock_config: { access_key_id: 'AKIASECRET', secret_access_key: 'aws-secret' } },
          { id: 'public', api_key: 'public-key-secret', base_url: 'https://api.example.test/v1' }] }));
          return;
        }
        const conversationId = actor.userId === '1' ? 'a1b2c3d4' : '11111111-1111-4111-8111-111111111111';
        if (req.url === '/api/sidebar?limit=1&win=pinned%3A100') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, data: { groups: pinnedConversations.get(actor.userId) ? [
            { scope: { type: 'pinned' }, items: [{ type: 'conversation', conversation: { id: conversationId } }],
              has_more: false },
          ] : [] } }));
          return;
        }
        if (req.url === `/api/order/pinned/conversation/${conversationId}` && ['PUT', 'DELETE'].includes(req.method || '')) {
          pinnedConversations.set(actor.userId, req.method === 'PUT');
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true }));
          return;
        }
        if (req.url === `/api/conversations/${conversationId}` && req.method === 'PATCH') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            conversationNames.set(actor.userId, (JSON.parse(Buffer.concat(chunks).toString()) as { name: string }).name);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          });
          return;
        }
        if (req.url === '/api/conversations?limit=100' ||
          req.url === `/api/conversations?limit=100&cursor=${conversationId}`) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, data: { items: req.url.includes('cursor=') ? [] : [
            { id: conversationId, name: conversationNames.get(actor.userId) || `Chat ${actor.userId}`,
              modified_at: 1234, status: 'finished', extra: { workspace: '/private/path' },
              runtime: { state: 'waiting_confirmation', pending_confirmations: 2, is_processing: false, private_path: '/private/runtime' } },
          ], has_more: !req.url.includes('cursor=') } }));
          return;
        }
        if (req.url?.startsWith('/api/messages/search?')) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, data: { items: [
            { message_id: 'message-1', message_created_at: 4567, preview_text: 'private answer',
              conversation: { id: conversationId, name: `Chat ${actor.userId}`,
                extra: { workspace: '/private/path' } } },
          ], has_more: false } }));
          return;
        }
        if (req.url === '/api/mcp/servers') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, data: [{ id: 'mcp-a', name: 'Private MCP',
            original_json: '{"token":"hidden"}', transport: { type: 'http',
              url: 'https://example.test/mcp?key=hidden', headers: { Authorization: 'Bearer hidden' } } }] }));
          return;
        }
        if (req.url?.startsWith('/api/mcp/servers/')) {
          res.setHeader('content-type', 'application/json');
          if (req.url !== '/api/mcp/servers/mcp-a') { res.writeHead(404); res.end('{}'); return; }
          res.end(JSON.stringify({ success: true, data: { id: 'mcp-a', name: 'Private MCP', transport: {
            type: 'http', url: 'https://example.test/mcp?key=hidden', headers: { Authorization: 'Bearer hidden' },
          } } }));
          return;
        }
        if (req.url === '/api/mcp/test-connection') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const tested = JSON.parse(Buffer.concat(chunks).toString());
            const success = tested.transport.url === 'https://example.test/mcp?key=hidden' &&
              tested.transport.headers.Authorization === 'Bearer hidden';
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ success: true, data: { success, tools: [{ name: 'read' }] } }));
          });
          return;
        }
        if (req.url === '/api/hold') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('open');
          return;
        }
        res.setHeader('set-cookie', 'core-secret=never-expose');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            actor: actor.userId,
            token: req.headers['x-aion-enterprise-local-token'],
            cookie: req.headers.cookie || null,
          })
        );
      });
      const wsServer = new WebSocketServer({ noServer: true });
      core.on('upgrade', (req, socket, head) => {
        if (req.headers['x-aion-enterprise-local-token'] !== token) {
          socket.destroy();
          return;
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => ws.send(actor.userId));
      });
      await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
      const invalidated = new Promise<void>((resolve) => invalidate.set(actor.userId, resolve));
      return {
        port: (core.address() as { port: number }).port,
        localToken: token,
        workspaceRoot: path.join(tempDir, `workspace-${actor.userId}`),
        invalidated,
        stop: async () => {
          stopped.push(actor.userId);
          for (const ws of wsServer.clients) ws.terminate();
          await new Promise<void>((resolve) => core.close(() => resolve()));
          wsServer.close();
        },
      };
    },
  });
  port = gateway.port;
  stop = gateway.stop;
  reconcileAuthorization = gateway.reconcileAuthorization;
});

test('anonymous login page uses only safe public RC2 brand fields and a nonce CSP', async () => {
  publicBrandValue = { productName: '<script>alert(1)</script>', companyName: '示例企业',
    loginTitle: '登录 <b>工作台</b>', loginSubtitle: '使用企业账号继续',
    primaryColor: 'red; background:url(evil)', logoDataUrl: 'javascript:alert(1)',
    supportText: '请联系管理员', copyright: '企业内部使用' };
  try {
    const page = await request('GET', '/enterprise/login');
    expect(page.status).toBe(200);
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).toContain('登录 &lt;b&gt;工作台&lt;/b&gt;');
    expect(page.body).toContain('示例企业');
    expect(page.body).toContain('请联系管理员');
    expect(page.body).not.toContain('javascript:alert(1)');
    expect(page.body).toContain('--brand:#2563eb');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+';/);
    expect(page.headers['content-security-policy']).not.toContain('unsafe-inline');
    const english = await request('GET', '/enterprise/login', undefined, undefined,
      'https://workspace.example', { 'accept-language': 'en-US,en;q=0.9' });
    expect(english.body).toContain('<html lang="en">');
    expect(english.body).toContain('Enterprise account');
  } finally {
    publicBrandValue = { productName: 'ZhenWork', primaryColor: '#2563eb' };
  }
});

test('login accepts metadata only from the authenticated loopback proxy boundary', async () => {
  lastLoginClient = undefined;
  const forwarded = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' },
    'https://workspace.example', {
      'x-forwarded-for': '198.51.100.99',
      'x-zhenwork-client-ip': '2001:db8::25',
      'x-zhenwork-client-user-agent': 'Mozilla/5.0 Test Safari/18',
    });
  expect(forwarded.status).toBe(200);
  expect(lastLoginClient).toEqual({ ipAddress: '2001:db8::25', userAgent: 'Mozilla/5.0 Test Safari/18' });

  lastLoginClient = undefined;
  expect((await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' },
    'https://workspace.example', { 'x-zhenwork-edge-token': 'browser-forged-edge-token' })).status).toBe(401);
  expect(lastLoginClient).toBeUndefined();
  expect((await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' },
    'https://workspace.example', { 'x-zhenwork-edge-token': 'é'.repeat(edgeToken.length) })).status).toBe(401);
  expect((await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' },
    'https://workspace.example', { 'x-zhenwork-client-ip': '203.0.113.10, 127.0.0.1' })).status).toBe(401);
});

test('enterprise brand is available only to its authenticated session and exposes display fields only', async () => {
  allowed.set('1', true);
  expect((await request('GET', '/enterprise/brand')).status).toBe(401);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const brand = await request('GET', '/enterprise/brand', cookie);
  expect(brand.status).toBe(200);
  expect(JSON.parse(brand.body)).toEqual({ adminUrl: null, productName: 'Workspace 1', primaryColor: '#123abc',
    logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  expect(brand.body).not.toContain('never-expose');
  expect((await request('POST', '/enterprise/logout', cookie)).status).toBe(200);
  expect((await request('GET', '/enterprise/brand', cookie)).status).toBe(401);
});

test('hosted directory picker stays inside the actor workspace and hides symlinks leaving it', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  expect(cookie).toBeTruthy();
  const workspace = path.join(tempDir, 'workspace-1');
  const own = await request('POST', '/api/fs/dir', cookie, { dir: workspace, root: '/' });
  expect(own.status).toBe(200);
  expect(lastDirRoot).toBe(workspace);
  expect(JSON.parse(own.body).data.map((entry: { name: string }) => entry.name)).toEqual(['own.txt']);
  expect((await request('POST', '/api/fs/dir', cookie, { dir: tempDir, root: tempDir })).status).toBe(403);
  expect((await request('POST', '/api/fs/dir', cookie,
    { dir: path.join(tempDir, 'workspace-2'), root: workspace })).status).toBe(403);
  expect((await request('POST', '/api/fs/dir', cookie,
    { dir: path.join(workspace, 'outside-directory'), root: workspace })).status).toBe(403);
  expect((await request('POST', '/enterprise/logout', cookie)).status).toBe(200);
});

test('WebSocket is bound to the RC2 session and closes on revocation', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  expect(cookie).toBeTruthy();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: 'https://workspace.example',
    headers: { host: 'workspace.example', cookie },
  });
  const message = await new Promise<string>((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('error', reject);
  });
  expect(message).toBe('1');
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
  allowed.set('1', false);
  await reconcileAuthorization();
  expect((await request('GET', '/api/system/info', cookie)).status).toBe(401);
  await closed;
});

test('revocation also terminates an in-flight HTTP response', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  expect(cookie).toBeTruthy();
  let releaseOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const closed = new Promise<void>((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/hold',
      headers: { host: 'workspace.example', origin: 'https://workspace.example', cookie } }, (res) => {
      res.once('data', () => releaseOpen());
      res.once('close', resolve);
      res.once('error', (error: NodeJS.ErrnoException) => {
        if (error.message === 'aborted' || error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
    });
    req.once('error', reject);
  });
  await opened;
  allowed.set('1', false);
  expect((await request('GET', '/api/system/info', cookie)).status).toBe(401);
  await closed;
});

test('provider responses expose key state without returning stored credentials', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const response = await request('GET', '/api/providers', cookie);
  expect(response.status).toBe(200);
  expect(response.body).not.toContain('sk-secret');
  expect(response.body).not.toContain('aws-secret');
  expect(response.body).not.toContain('AKIASECRET');
  expect(response.body).not.toContain('url-secret');
  expect(response.body).not.toContain('query-secret');
  expect(JSON.parse(response.body).data[0]).toMatchObject({ api_key: '', api_key_configured: true,
    api_key_count: 2, base_url: '', base_url_configured: true,
    bedrock_config: { access_key_id: '', access_key_id_configured: true,
      secret_access_key: '', secret_access_key_configured: true } });
  expect(JSON.parse(response.body).data[1]).toMatchObject({ base_url: 'https://api.example.test/v1' });
  const saved = await request('POST', '/api/providers', cookie, { base_url: 'https://api.example.test/v1' });
  expect(saved.status).toBe(200);
  expect(saved.body).not.toContain('url-secret');
  expect(saved.body).not.toContain('query-secret');
});

test('MCP server responses never return stored transport credentials', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const response = await request('GET', '/api/mcp/servers', cookie);
  expect(response.status).toBe(200);
  expect(response.body).not.toContain('hidden');
  expect(JSON.parse(response.body).data[0]).toMatchObject({ id: 'mcp-a', original_json: '',
    transport: { type: 'http', url: '', headers: {}, credentials_configured: true } });
});

test('MCP probe resolves redacted credentials only within this actor Core', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const servers = JSON.parse((await request('GET', '/api/mcp/servers', cookie)).body).data;
  const tested = await request('POST', '/api/mcp/test-connection', cookie, servers[0]);
  expect(tested.status).toBe(200);
  expect(JSON.parse(tested.body).data.success).toBe(true);
  expect(tested.body).not.toContain('hidden');
  expect((await request('POST', '/api/mcp/test-connection', cookie, {
    ...servers[0], id: 'other-profile-server',
  })).status).toBe(404);
  expect((await request('POST', '/api/mcp/test-connection', cookie, {
    ...servers[0], id: '../mcp-a',
  })).status).toBe(400);
});

test('client preferences withhold saved keys and preserve them through ordinary web edits', async () => {
  allowed.set('1', true);
  clientPrefs.delete('1');
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const first = await request('GET', '/api/settings/client?keys=tools.speechToText,mcp.config,google.config', cookie);
  expect(first.status).toBe(200);
  expect(first.body).not.toContain('speech-secret');
  expect(first.body).not.toContain('Bearer hidden');
  expect(first.body).not.toContain('token=hidden');
  expect(first.body).not.toContain('proxy-secret');
  expect(JSON.parse(first.body).data['google.config']).toEqual({ proxy: '', proxy_configured: true });
  expect(JSON.parse(first.body).data['tools.speechToText'].openai)
    .toMatchObject({ api_key: '', api_key_configured: true });
  const changed = await request('PUT', '/api/settings/client', cookie, { 'google.config': {
    proxy: '', proxy_configured: true,
  }, 'tools.speechToText': {
    provider: 'openai', openai: { api_key: '', api_key_configured: true, model: 'whisper-1' },
  } });
  expect(changed.status).toBe(200);
  const changedPrefs = clientPrefs.get('1');
  expect(changedPrefs).toBeDefined();
  expect((changedPrefs!['tools.speechToText'] as { openai: { api_key: string; model: string } }).openai)
    .toMatchObject({ api_key: 'speech-secret', model: 'whisper-1' });
  expect(changed.body).not.toContain('speech-secret');
  expect(changed.body).not.toContain('Bearer hidden');
  expect(changed.body).not.toContain('token=hidden');
  expect(changed.body).not.toContain('proxy-secret');
  expect(changedPrefs!['google.config']).toEqual({ proxy: 'http://user:proxy-secret@127.0.0.1:9999' });
  expect(JSON.parse(changed.body).data['tools.speechToText'].openai)
    .toMatchObject({ api_key: '', api_key_configured: true });
  const cleared = await request('PUT', '/api/settings/client', cookie, { 'tools.speechToText': {
    provider: 'openai', openai: { api_key: '', api_key_configured: false, model: 'whisper-1' },
  } });
  expect(cleared.status).toBe(200);
  const clearedPrefs = clientPrefs.get('1');
  expect(clearedPrefs).toBeDefined();
  expect((clearedPrefs!['tools.speechToText'] as { openai: { api_key: string } }).openai.api_key).toBe('');
});

test('a credential route never forwards an unexpected Core response format', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const response = await request('GET', '/api/providers/bad-response', cookie);
  expect(response.status).toBe(502);
  expect(response.body).not.toContain('sk-secret-in-unexpected-format');
});

test('conversation catalog derives origin and key from the authenticated actor and Core', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const response = await request('GET', '/enterprise/conversations', cookie);
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).items).toEqual([{ key: 'enterprise_web:rc2:1:a1b2c3d4',
    id: 'a1b2c3d4', source: 'enterprise_web', name: 'Chat 1',
    modified_at: 1234, status: 'finished', runtime: { state: 'waiting_confirmation', pending_confirmations: 2, is_processing: false }, pinned: true }]);
  expect(JSON.parse(response.body).next_cursor).toBe('a1b2c3d4');
  const next = await request('GET', '/enterprise/conversations?cursor=a1b2c3d4', cookie);
  expect(JSON.parse(next.body)).toEqual({ items: [], next_cursor: null });
  expect(response.body).not.toContain('/private/path');
  expect(response.body).not.toContain('/private/runtime');
});

test('web conversation changes stay in the authenticated actor Core and update catalog state', async () => {
  allowed.set('1', true);
  allowed.set('2', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  expect((await request('PATCH', '/api/conversations/a1b2c3d4', cookie,
    { name: 'Renamed', name_source: 'user' })).status).toBe(200);
  expect((await request('DELETE', '/api/order/pinned/conversation/a1b2c3d4', cookie)).status).toBe(200);
  const catalog = await request('GET', '/enterprise/conversations', cookie);
  expect(JSON.parse(catalog.body).items[0]).toMatchObject({ name: 'Renamed', pinned: false });
  const other = await request('POST', '/enterprise/login', undefined, { username: '2', password: 'test' });
  const otherCookie = other.headers['set-cookie']?.[0].split(';')[0];
  expect(JSON.parse((await request('GET', '/enterprise/conversations', otherCookie)).body).items[0])
    .toMatchObject({ name: 'Chat 2', pinned: false });
  expect((await request('PATCH', '/api/conversations/a1b2c3d4', cookie,
    { name: 'Forbidden' }, 'https://wrong.example')).status).toBe(403);
});

test('desktop session exchange is tied to a validated RC2 cookie, not an actor supplied by the caller', async () => {
  allowed.set('2', true);
  expect((await request('POST', '/enterprise/desktop-session', undefined, undefined,
    'https://workspace.example', { 'x-aion-rc2-session': 'forged' })).status).toBe(401);
  const exchange = await request('POST', '/enterprise/desktop-session', undefined, undefined,
    'https://workspace.example', { 'x-aion-rc2-session': '__Host-workspace-rc2=valid-desktop-session' });
  expect(exchange.status).toBe(200);
  expect(JSON.parse(exchange.body).actor).toEqual({ serverId: 'rc2', userId: '2' });
  const cookie = exchange.headers['set-cookie']?.[0].split(';')[0];
  const list = await request('GET', '/enterprise/conversations', cookie);
  expect(JSON.parse(list.body).items[0].key).toBe('enterprise_web:rc2:2:11111111-1111-4111-8111-111111111111');
});

test('web search returns actor-derived source metadata without server paths', async () => {
  allowed.set('2', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '2', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const result = await request('GET', '/enterprise/search?keyword=private&page=1', cookie);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body).items[0]).toMatchObject({
    key: 'enterprise_web:rc2:2:11111111-1111-4111-8111-111111111111', source: 'enterprise_web',
    conversation_id: '11111111-1111-4111-8111-111111111111', preview_text: 'private answer',
  });
  expect(result.body).not.toContain('/private/path');
  expect((await request('GET', '/enterprise/search?keyword=&page=1', cookie)).status).toBe(400);
});

test('SPA uses RC2 identity instead of the Core WebUI login', async () => {
  allowed.set('1', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  const user = await request('GET', '/api/auth/user', cookie);
  expect(JSON.parse(user.body)).toEqual({ success: true, user: { id: '1', username: 'employee-1' } });
  const index = await request('GET', '/', cookie);
  expect(index.body).toContain('window.__AION_ENTERPRISE_WEB__=true');
  expect(index.headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
  expect((await request('POST', '/login', cookie, {})).status).toBe(404);
  expect((await request('GET', '/sw.js', cookie)).status).toBe(404);
  expect((await request('GET', '/api/cron/internal/idle-ready', cookie)).status).toBe(404);
});

afterAll(async () => {
  await stop();
  await rm(tempDir, { recursive: true, force: true });
});

test('requires enterprise login and correct Origin', async () => {
  const anonymous = await request('GET', '/');
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.location).toBe('/enterprise/login');
  for (const api of ['/enterprise/control/ai/me', '/enterprise/control/ai/models/available', '/enterprise/files', '/enterprise/memories', '/enterprise/search?keyword=test']) {
    const denied = await request('GET', api);
    expect(denied.status).toBe(401);
    expect(denied.headers.location).toBeUndefined();
    expect(JSON.parse(denied.body)).toEqual({ error: 'UNAUTHENTICATED' });
  }
  expect(
    (await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' }, 'https://evil.example'))
      .status
  ).toBe(403);
  expect((await request('POST', '/enterprise/login', undefined, { username: '1', password: 'wrong' })).status).toBe(
    401
  );
});

test('routes each actor to a separate Core without forwarding browser secrets', async () => {
  allowed.set('1', true);
  const a = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const b = await request('POST', '/enterprise/login', undefined, { username: '2', password: 'test' });
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const aCookie = a.headers['set-cookie']?.[0].split(';')[0];
  const bCookie = b.headers['set-cookie']?.[0].split(';')[0];
  expect(aCookie).toBeTruthy();
  expect(bCookie).toBeTruthy();
  const aResponse = await request('GET', '/api/system/info', aCookie);
  const bResponse = await request('GET', '/api/system/info', bCookie);
  expect(JSON.parse(aResponse.body)).toEqual({ actor: '1', token: 'core-token-1', cookie: null });
  expect(JSON.parse(bResponse.body)).toEqual({ actor: '2', token: 'core-token-2', cookie: null });
  expect(aResponse.headers['set-cookie']).toBeUndefined();
  expect(started.slice(-2)).toEqual(['1', '2']);
  allowed.set('1', false);
  expect((await request('GET', '/api/system/info', aCookie)).status).toBe(401);
  expect((await request('GET', '/api/system/info', bCookie)).status).toBe(200);
  expect(stopped).toContain('1');
});

test('revoked Core resources close all browser sessions for that actor', async () => {
  allowed.set('2', true);
  const login = await request('POST', '/enterprise/login', undefined, { username: '2', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  expect((await request('GET', '/api/system/info', cookie)).status).toBe(200);
  invalidate.get('2')?.();
  await vi.waitFor(() => expect(stopped).toContain('2'));
  expect((await request('GET', '/api/system/info', cookie)).status).toBe(401);
});

test('reports a Core cleanup failure during gateway shutdown', async () => {
  const gateway = await startEnterpriseGateway({
    staticDir: tempDir, publicOrigin: 'https://workspace.example', port: 0,
    login: async () => { throw new Error('unused'); },
    hasBackgroundJobs: () => true,
    startCore: async () => ({ port: 1, localToken: 'synthetic',
      stop: async () => { throw new Error('Docker cleanup failed'); } }),
  });
  await gateway.startBackgroundCore({ serverId: 'rc2', userId: '999' });
  await expect(gateway.stop()).rejects.toThrow('shutdown incomplete');
});

test('reserves session capacity before asynchronous RC2 login completes', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'enterprise-session-cap-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  let releaseLogin!: () => void;
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const gateway = await startEnterpriseGateway({ staticDir, publicOrigin: 'https://workspace.example',
    port: 0, maxSessions: 1,
    login: async () => { await loginGate; return { actor: { serverId: 'rc2', userId: '1' },
      validate: async () => true, close: async () => {} }; },
    startCore: async () => { throw new Error('unused'); },
  });
  const login = () => new Promise<number>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: '/enterprise/login',
      method: 'POST', headers: { host: 'workspace.example', origin: 'https://workspace.example',
        'content-type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode || 0));
    });
    req.once('error', reject);
    req.end(JSON.stringify({ username: '1', password: 'test' }));
  });
  try {
    const first = login();
    await vi.waitFor(() => expect(gateway.capacity().pendingSessions).toBe(1));
    expect(await login()).toBe(503);
    releaseLogin();
    expect(await first).toBe(200);
    expect(gateway.capacity()).toMatchObject({ sessions: 1, pendingSessions: 0 });
  } finally {
    releaseLogin();
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test('bounds simultaneous Core starts and rejects an overflowing startup queue', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'enterprise-start-cap-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  let activeStarts = 0;
  let peakStarts = 0;
  const startedActors: string[] = [];
  const gateway = await startEnterpriseGateway({
    staticDir, publicOrigin: 'https://workspace.example', port: 0,
    maxStartingCores: 1, maxQueuedCoreStarts: 1, coreStartWaitMs: 2000, coreIdleMs: 0,
    login: async (username) => ({ actor: { serverId: 'rc2', userId: username },
      validate: async () => true, close: async () => {} }),
    startCore: async (actor) => {
      startedActors.push(actor.userId);
      activeStarts += 1;
      peakStarts = Math.max(peakStarts, activeStarts);
      if (actor.userId === '1') { firstStarted(); await firstGate; }
      const core = http.createServer((_req, res) => res.end(JSON.stringify({ actor: actor.userId })));
      await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
      activeStarts -= 1;
      return { port: (core.address() as { port: number }).port, localToken: 'private-core-token',
        stop: async () => { core.closeAllConnections();
          await new Promise<void>((resolve) => core.close(() => resolve())); } };
    },
  });
  const call = (method: string, route: string, cookie?: string, payload?: object) =>
    new Promise<{ status: number; cookie?: string; body: string; retryAfter?: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method,
        headers: { host: 'workspace.example', origin: 'https://workspace.example',
          ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } },
      (res) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0,
          cookie: res.headers['set-cookie']?.[0].split(';')[0],
          body: Buffer.concat(chunks).toString(), retryAfter: res.headers['retry-after'] })); });
      req.once('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  try {
    const cookies = await Promise.all(['1', '2', '3'].map(async (id) =>
      (await call('POST', '/enterprise/login', undefined, { username: id, password: 'test' })).cookie!));
    const first = call('GET', '/api/system/info', cookies[0]);
    await firstStart;
    const second = call('GET', '/api/system/info', cookies[1]);
    await vi.waitFor(() => expect(gateway.capacity()).toMatchObject({ starting: 1, queuedStarts: 1 }));
    expect(await call('GET', '/api/system/info', cookies[2])).toMatchObject({
      status: 503, body: '{"error":"CORE_CAPACITY"}', retryAfter: '5',
    });
    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(startedActors).toEqual(['1', '2']);
    expect(peakStarts).toBe(1);
  } finally {
    releaseFirst();
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test('coalesces concurrent session checks without skipping RC2 validation', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'enterprise-validation-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  let releaseValidation!: () => void;
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  let validations = 0;
  const gateway = await startEnterpriseGateway({ staticDir,
    publicOrigin: 'https://workspace.example', port: 0,
    login: async () => ({ actor: { serverId: 'rc2', userId: '1' },
      brand: async () => ({ productName: 'Workspace' }),
      validate: async () => { validations += 1; await validationGate; return true; },
      close: async () => {} }),
    startCore: async () => { throw new Error('Core not needed'); },
  });
  const call = (method: string, route: string, cookie?: string, payload?: object) =>
    new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method,
        headers: { host: 'workspace.example', origin: 'https://workspace.example',
          ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0,
        cookie: res.headers['set-cookie']?.[0].split(';')[0] })); });
      req.once('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  try {
    const cookie = (await call('POST', '/enterprise/login', undefined,
      { username: '1', password: 'test' })).cookie!;
    const checks = Array.from({ length: 12 }, () => call('GET', '/enterprise/brand', cookie));
    await vi.waitFor(() => expect(validations).toBe(1));
    releaseValidation();
    expect((await Promise.all(checks)).every((result) => result.status === 200)).toBe(true);
    expect((await call('GET', '/enterprise/brand', cookie)).status).toBe(200);
    expect(validations).toBe(2);
  } finally {
    releaseValidation();
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test('admits 20 active employees from 50 signed-in sessions without a Core startup burst', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'enterprise-employee-burst-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  let starting = 0;
  let peakStarting = 0;
  let coreStarts = 0;
  let coreStops = 0;
  const gateway = await startEnterpriseGateway({ staticDir, publicOrigin: 'https://workspace.example',
    port: 0, maxSessions: 60, maxCores: 20, maxStartingCores: 4,
    maxQueuedCoreStarts: 20, coreStartWaitMs: 2000, coreIdleMs: 5,
    login: async (username) => ({ actor: { serverId: 'rc2', userId: username },
      validate: async () => true, close: async () => {} }),
    startCore: async () => {
      starting += 1;
      peakStarting = Math.max(peakStarting, starting);
      coreStarts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const core = http.createServer((req, res) => res.end(req.url === '/api/cron/internal/idle-ready'
        ? JSON.stringify({ success: true, data: { idle: true } }) : '{}'));
      await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
      starting -= 1;
      return { port: (core.address() as { port: number }).port, localToken: 'private-core-token',
        stop: async () => { coreStops += 1; core.closeAllConnections();
          await new Promise<void>((resolve) => core.close(() => resolve())); } };
    },
  });
  const call = (method: string, route: string, cookie?: string, payload?: object) =>
    new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method,
        headers: { host: 'workspace.example', origin: 'https://workspace.example',
          ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0,
        cookie: res.headers['set-cookie']?.[0].split(';')[0] })); });
      req.once('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  try {
    const cookies = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const login = await call('POST', '/enterprise/login', undefined,
        { username: String(index + 1), password: 'test' });
      expect(login.status).toBe(200);
      return login.cookie!;
    }));
    const responses = await Promise.all(cookies.slice(0, 20).map((cookie) =>
      call('GET', '/api/system/info', cookie)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(gateway.capacity()).toMatchObject({ sessions: 50, cores: 20, queuedStarts: 0 });
    expect(coreStarts).toBe(20);
    expect(peakStarting).toBeLessThanOrEqual(4);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await call('GET', '/api/system/info', cookies[20])).status).toBe(200);
    expect(gateway.capacity()).toMatchObject({ sessions: 50, cores: 20 });
    expect(coreStarts).toBe(21);
    expect(coreStops).toBe(1);
  } finally {
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test('reclaims only a quiescent idle Core and resumes it for its existing session', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'enterprise-core-idle-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  let idleReady = false;
  let validateGate: Promise<void> | undefined;
  let validationStarted: (() => void) | undefined;
  let starts = 0;
  let stops = 0;
  let releaseHeld!: () => void;
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let idleSocket: WebSocket | undefined;
  const gateway = await startEnterpriseGateway({
    staticDir, publicOrigin: 'https://workspace.example', port: 0, coreIdleMs: 5,
    login: async () => ({ actor: { serverId: 'rc2', userId: '1' },
      validate: async () => { validationStarted?.(); await validateGate; return true; }, close: async () => {} }),
    startCore: async () => {
      starts += 1;
      const core = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/mcp/servers/')) {
          res.setHeader('content-type', 'application/json');
          if (req.url !== '/api/mcp/servers/mcp-a') { res.writeHead(404); res.end('{}'); return; }
          res.end(JSON.stringify({ success: true, data: { id: 'mcp-a', name: 'Private MCP', transport: {
            type: 'http', url: 'https://example.test/mcp?key=hidden', headers: { Authorization: 'Bearer hidden' },
          } } }));
          return;
        }
        if (req.url === '/api/mcp/test-connection') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const tested = JSON.parse(Buffer.concat(chunks).toString());
            const success = tested.transport.url === 'https://example.test/mcp?key=hidden' &&
              tested.transport.headers.Authorization === 'Bearer hidden';
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ success: true, data: { success, tools: [{ name: 'read' }] } }));
          });
          return;
        }
        if (req.url === '/api/hold') {
          markHeld();
          void heldGate.then(() => res.end(JSON.stringify({ success: true })));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/api/cron/internal/idle-ready'
          ? JSON.stringify({ success: true, data: { idle: idleReady &&
            req.headers['x-aionui-internal'] === '1' &&
            req.headers['x-aion-enterprise-local-token'] === 'private-core-token' } })
          : JSON.stringify({ success: true }));
      });
      const wss = new WebSocketServer({ noServer: true });
      core.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (connected) => wss.emit('connection', connected, req));
      });
      await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
      return { port: (core.address() as { port: number }).port, localToken: 'private-core-token',
        stop: async () => { stops += 1; core.closeAllConnections(); wss.close();
          await new Promise<void>((resolve) => core.close(() => resolve())); } };
    },
  });
  const call = (method: string, route: string, cookie?: string, payload?: object) =>
    new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method,
        headers: { host: 'workspace.example', origin: 'https://workspace.example',
          ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0,
        cookie: res.headers['set-cookie']?.[0].split(';')[0] })); });
      req.once('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  try {
    const cookie = (await call('POST', '/enterprise/login', undefined,
      { username: '1', password: 'test' })).cookie!;
    expect((await call('GET', '/api/system/info', cookie)).status).toBe(200);
    idleSocket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, {
      origin: 'https://workspace.example', headers: { host: 'workspace.example', cookie },
    });
    await new Promise<void>((resolve, reject) => {
      idleSocket!.once('open', resolve);
      idleSocket!.once('error', reject);
    });
    const idleClose = new Promise<number>((resolve) => idleSocket!.once('close', (code) => resolve(code)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await gateway.reapIdleCores();
    expect(stops).toBe(0);
    // A browser may disconnect while identity validation is still awaiting RC2.
    let releaseValidation!: () => void;
    validateGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    const validating = new Promise<void>(resolve => { validationStarted = resolve; });
    const abandoned = http.request({hostname:'127.0.0.1',port:gateway.port,path:'/api/system/info',headers:{host:'workspace.example',cookie}});
    abandoned.on('error', () => {});abandoned.end();await validating;
    const disconnected = new Promise<void>(resolve => abandoned.once('close', resolve));abandoned.destroy();await disconnected;
    await new Promise(resolve => setTimeout(resolve,5));releaseValidation();validateGate=undefined;validationStarted=undefined;
    await new Promise(resolve => setTimeout(resolve,10));
    idleReady = true;
    const activeRequest = call('GET', '/api/hold', cookie);
    await held;
    await gateway.reapIdleCores();
    expect(stops).toBe(0);
    releaseHeld();
    expect((await activeRequest).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await gateway.reapIdleCores();
    expect(stops).toBe(1);
    expect(await idleClose).toBe(4001);
    expect(gateway.capacity().cores).toBe(0);
    expect((await call('GET', '/api/system/info', cookie)).status).toBe(200);
    expect(starts).toBe(2);
  } finally {
    releaseHeld();
    idleSocket?.terminate();
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});


test('reset password credentials require setup without granting a web identity or Core', async () => {
  const before = started.length;
  const result = await request('POST', '/enterprise/login', undefined, { username: 'reset', password: 'test' });
  expect([result.status, JSON.parse(result.body).error]).toEqual([409, 'PASSWORD_CHANGE_REQUIRED']);
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(started.length).toBe(before);
});

test('password setup reauthenticates the old password before changing it', async () => {
  const result = await request('POST', '/enterprise/password', undefined, { username: 'reset', password: 'wrong', newPassword: 'Abcd1234' });
  expect(result.status).toBe(401);
});

test('password setup accepts eight mixed letters and digits without issuing a web session', async () => {
  const result = await request('POST', '/enterprise/password', undefined, { username: 'reset', password: 'test', newPassword: 'Abcd1234' });
  expect(result.status).toBe(200);
  expect(result.headers['set-cookie']).toBeUndefined();
});

test('password setup refuses weak format and foreign origins', async () => {
  const payload = { username: 'reset', password: 'test', newPassword: '12345678' };
  expect((await request('POST', '/enterprise/password', undefined, payload)).status).toBe(400);
  expect((await request('POST', '/enterprise/password', undefined, { ...payload, newPassword: 'Abcd1234' }, 'https://foreign.invalid')).status).toBe(403);
});

test('a second employee gets a bounded preparation page instead of a blank SPA at Core capacity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enterprise-ready-'));
  await writeFile(path.join(dir, 'index.html'), '<html><head></head><body>Workspace</body></html>');
  const gateway = await startEnterpriseGateway({ staticDir: dir, publicOrigin: 'https://workspace.example', port: 0,
    maxCores: 1, coreIdleMs: 0,
    login: async username => ({ actor: { serverId: 'rc2', userId: username }, validate: async () => true, close: async () => {} }),
    startCore: async () => ({ port: 9, localToken: 'local-test', stop: async () => {} }),
  });
  const call = (method: string, route: string, cookie?: string, payload?: object) => new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method,
      headers: { host: 'workspace.example', origin: 'https://workspace.example', ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks: Buffer[] = [];res.on('data', c => chunks.push(c));res.on('end', () => resolve({ status: res.statusCode || 0, cookie: res.headers['set-cookie']?.[0].split(';')[0], body: Buffer.concat(chunks).toString() }));
    });req.once('error', reject);req.end(payload ? JSON.stringify(payload) : undefined);
  });
  try {
    expect((await call('GET', '/enterprise/ready')).status).toBe(401);
    const first = (await call('POST', '/enterprise/login', undefined, { username: '1', password: 'test' })).cookie;
    const second = (await call('POST', '/enterprise/login', undefined, { username: '2', password: 'test' })).cookie;
    expect((await call('GET', '/enterprise/ready', first)).status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await call('GET', '/enterprise/ready', first)).status).toBe(200);
    const page = await call('GET', '/', second);expect(page.status).toBe(200);expect(page.body).toContain('data-enterprise-readiness');expect(page.body).toContain('180000');
    expect(page.body).toContain('<title>ZhenWork');expect(page.body).toContain('data:image/svg+xml');
    const queued = await call('GET', '/enterprise/ready', second);
    expect(queued.status).toBe(202);expect(JSON.parse(queued.body).phase).toBe('queued');
    await call('POST', '/enterprise/logout', first, {});
    expect([200, 202]).toContain((await call('GET', '/enterprise/ready', second)).status);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await call('GET', '/enterprise/ready', second)).status).toBe(200);
    const bootstrap = (await call('GET', '/', second)).body;
    expect(bootstrap).toContain('window.__AION_ENTERPRISE_WEB__=true');
    expect(bootstrap).toContain('<title>ZhenWork</title>');expect(bootstrap).toContain('data:image/svg+xml');
  } finally { await gateway.stop();await rm(dir, { recursive: true, force: true }); }
});

test('coalesces readiness polling and exposes only safe startup diagnostics before retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enterprise-ready-retry-'));
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await writeFile(path.join(dir, 'index.html'),
    '<html><head><title>AionUi</title></head><body><div id="root"></div><script src="app.js"></script></body></html>');
  let starts = 0;
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const gateway = await startEnterpriseGateway({ staticDir: dir, publicOrigin: 'https://workspace.example', port: 0,
    login: async () => ({ actor: { serverId: 'rc2', userId: '1' },
      brand: async () => ({ productName: 'Acme Workspace', primaryColor: '#123abc',
        logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
      validate: async () => true, close: async () => {} }),
    startCore: async () => {
      starts += 1;
      if (starts === 1) throw Object.assign(new Error('DEFAULT_MODEL_UNAVAILABLE'),
        { secret: 'never-expose' });
      await startGate;
      return { port: 9, localToken: 'local-test', stop: async () => {} };
    },
  });
  const call = (route: string, cookie?: string, method = 'GET', payload?: object) =>
    new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, path: route, method,
        headers: { host: 'workspace.example', origin: 'https://workspace.example',
          ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}),
          'accept-language': 'zh-TW' } }, res => {
        const chunks: Buffer[] = [];res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0,
          cookie: res.headers['set-cookie']?.[0].split(';')[0],
          body: Buffer.concat(chunks).toString() }));
      });req.once('error', reject);req.end(payload ? JSON.stringify(payload) : undefined);
    });
  try {
    const cookie = (await call('/enterprise/login', undefined, 'POST',
      { username: '1', password: 'test' })).cookie;
    const page = await call('/', cookie);
    expect(page.body).toContain('<html lang="zh-TW"');
    expect(page.body).toContain('<title>Acme Workspace · 正在準備執行環境</title>');
    expect(page.body).toContain('<link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">');
    expect(page.body).toContain('目前帳號沒有可用模型，請聯絡組織管理員檢查預設模型與授權。');
    const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(page.body)?.[1];
    expect(script).toBeTruthy();
    const elements = new Map<string, { textContent: string; hidden: boolean; disabled: boolean;
      addEventListener: () => void }>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id,
        { textContent: '', hidden: false, disabled: false, addEventListener: () => {} });
      return elements.get(id)!;
    };
    let fetches = 0;
    let resolveReady!: (value: { ok: boolean; status: number; json: () => Promise<object> }) => void;
    const readyResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<object> }>(
      (resolve) => { resolveReady = resolve; });
    const replacements: string[] = [];
    const runningPage = vm.runInNewContext(script!, {
      document: { getElementById: element },
      fetch: async () => {
        fetches += 1;
        if (fetches <= 3) throw new Error('temporary network error');
        return readyResponse;
      },
      location: { replace: (target: string) => replacements.push(target) },
      AbortSignal,
      Intl,
      Date,
      Promise,
      setTimeout: (callback: () => void) => { callback();return 0; },
    }) as Promise<void>;
    for (let turn = 0; turn < 10 && fetches < 4; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toBe(4);
    expect(element('failure').hidden).toBe(false);expect(element('progress').hidden).toBe(false);
    expect(element('reason').textContent).toBe('連線暫時中斷，正在嘗試恢復…');
    expect(element('status').textContent).toBe('正在等待可用容量');
    expect(element('trace').textContent).toContain('CONNECTION_UNAVAILABLE');
    resolveReady({ ok: true, status: 200, json: async () => ({ ready: true, phase: 'ready',
      timings: { totalMs: 4000, phaseMs: 0 }, trace: [{ phase: 'ready', atMs: 4000 }] }) });
    await runningPage;
    expect(replacements).toEqual(['/']);expect(element('failure').hidden).toBe(true);
    expect(element('status').textContent).toBe('執行環境已就緒');
    expect(element('trace').textContent).not.toContain('CONNECTION_UNAVAILABLE');

    const retryListeners: Array<() => void> = [];
    const retryElements = new Map<string, { textContent: string; hidden: boolean; disabled: boolean;
      addEventListener: (event: string, callback: () => void) => void }>();
    const retryElement = (id: string) => {
      if (!retryElements.has(id)) retryElements.set(id, { textContent: '', hidden: false, disabled: false,
        addEventListener: (_event, callback) => retryListeners.push(callback) });
      return retryElements.get(id)!;
    };
    let resolveRetry!: (value: { ok: boolean; status: number; json: () => Promise<object> }) => void;
    const retriedResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<object> }>(
      (resolve) => { resolveRetry = resolve; });
    const retryRoutes: string[] = [];
    await vm.runInNewContext(script!, {
      document: { getElementById: retryElement },
      fetch: async (route: string) => {
        retryRoutes.push(route);
        if (retryRoutes.length === 1) return { ok: false, status: 503, json: async () => ({ ready: false,
          phase: 'failed', error: 'CORE_START_FAILED', traceId: 'old-attempt',
          timings: { totalMs: 20, phaseMs: 10 }, trace: [{ phase: 'CORE_START_FAILED', atMs: 20 }] }) };
        return retriedResponse;
      },
      location: { hash: '#/guid?from=refresh', replace: (target: string) => replacements.push(target) }, AbortSignal, Intl, Date, Promise,
      setTimeout: (callback: () => void) => { callback();return 0; },
    });
    expect(retryElement('trace').textContent).toContain('CORE_START_FAILED');
    retryListeners[0]!();
    expect(retryRoutes).toEqual(['/enterprise/ready', '/enterprise/ready?retry=1']);
    expect(retryElement('trace').textContent).toBe('');expect(retryElement('reason').textContent).toBe('');
    expect(retryElement('timing').textContent).toBe('');
    expect(retryElement('status').textContent).toBe('正在等待可用容量');
    resolveRetry({ ok: true, status: 200, json: async () => ({ ready: true, phase: 'ready',
      timings: { totalMs: 5, phaseMs: 0 }, trace: [{ phase: 'ready', atMs: 5 }] }) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(replacements.at(-1)).toBe('/#/guid?from=refresh');
    expect(retryElement('failure').hidden).toBe(true);
    expect(retryElement('trace').textContent).not.toContain('CORE_START_FAILED');
    expect((await call('/enterprise/ready', cookie)).status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    const failed = await call('/enterprise/ready', cookie);
    expect(failed.status).toBe(503);expect(failed.body).toContain('DEFAULT_MODEL_UNAVAILABLE');
    expect(failed.body).not.toContain('never-expose');
    const failedData = JSON.parse(failed.body);
    expect(failedData.traceId).toMatch(/^[a-f0-9]{16}$/);
    expect(failedData.trace.at(-1).phase).toBe('DEFAULT_MODEL_UNAVAILABLE');
    const results = await Promise.all([
      call('/enterprise/ready?retry=1', cookie), call('/enterprise/ready', cookie),
    ]);
    expect(results.every((result) => result.status === 202)).toBe(true);expect(starts).toBe(2);
    releaseStart();await new Promise((resolve) => setImmediate(resolve));
    const ready = await call('/enterprise/ready', cookie);
    expect([ready.status, JSON.parse(ready.body).phase]).toEqual([200, 'ready']);
    const bootstrap = await call('/', cookie);
    expect(bootstrap.body).toContain('data-enterprise-bootstrap');
    expect(bootstrap.body).toContain('<title>Acme Workspace</title>');
    expect(bootstrap.body).toContain('執行環境已就緒');
    expect(bootstrap.body).toContain('nonce=');
    expect(bootstrap.body).toContain('data-testid="enterprise-bootstrap-error"');
    expect(bootstrap.body).toContain('data-testid="enterprise-bootstrap-retry"');
    const shellScript = /<script nonce="[^"]+" data-enterprise-bootstrap-shell>([\s\S]*?)<\/script>/.exec(
      bootstrap.body)?.[1];
    expect(shellScript).toBeTruthy();
    const bootstrapMonitor = () => {
      class ScriptElement { src = '/boot.js?token=do-not-log'; }
      class LinkElement { href = '/app.css?key=do-not-log'; }
      class ImageElement { src = '/logo.png'; }
      type Listener = (event: { target?: object; reason?: unknown }) => void;
      const listeners = new Map<string, Listener>();
      let shellPresent = true;let observerCallback = () => {};let retryCallback = () => {};
      let reloaded = 0;let disconnected = 0;let now = 0;
      const status = { textContent: '執行環境已就緒' };
      const progress = { hidden: false };
      const error = { hidden: true };
      const retry = { addEventListener: (_event: string, callback: () => void) => { retryCallback = callback; } };
      let removed = false;const shell = { remove: () => { removed = true; } };
      const root = { querySelector: () => shellPresent ? shell : null, childElementCount: 0, textContent: '' };
      const infos: unknown[][] = [];const warnings: unknown[][] = [];
      class Observer {
        constructor(callback: () => void) { observerCallback = callback; }
        observe() {}
        disconnect() { disconnected += 1; }
      }
      vm.runInNewContext(shellScript!, {
        document: { body: { appendChild: () => {} }, getElementById: (id: string) => id === 'root' ? root
          : id === 'enterprise-bootstrap-status' ? status : progress,
        querySelector: (selector: string) => selector.includes('error') ? error : retry },
        window: { addEventListener: (event: string, callback: Listener) => listeners.set(event, callback),
          removeEventListener: (event: string) => listeners.delete(event) },
        HTMLScriptElement: ScriptElement, HTMLLinkElement: LinkElement,
        MutationObserver: Observer, performance: { now: () => { now += 7;return now; } },
        location: { reload: () => { reloaded += 1; } },
        console: { info: (...args: unknown[]) => infos.push(args), warn: (...args: unknown[]) => warnings.push(args) },
        setTimeout: () => 1, clearTimeout: () => {},
      });
      return { status, progress, error, infos, warnings,
        imageError: () => listeners.get('error')?.({ target: new ImageElement() }),
        scriptError: () => listeners.get('error')?.({ target: new ScriptElement() }),
        emptyMount: () => { shellPresent = false;observerCallback();return removed; },
        mount: () => { shellPresent = false;root.childElementCount = 1;root.textContent = 'Acme Workspace';observerCallback(); },
        retry: () => retryCallback(), reloaded: () => reloaded, disconnected: () => disconnected };
    };
    const brokenShell = bootstrapMonitor();
    brokenShell.imageError();expect(brokenShell.error.hidden).toBe(true);
    brokenShell.scriptError();
    expect(brokenShell.status.textContent).toBe('頁面載入失敗，請重新載入後再試。');
    expect(brokenShell.progress.hidden).toBe(true);expect(brokenShell.error.hidden).toBe(false);
    expect(brokenShell.warnings).toHaveLength(1);expect(brokenShell.infos).toHaveLength(0);
    expect(brokenShell.warnings[0]?.[1]).toContain('"phase":"asset_failed"');
    expect(JSON.stringify(brokenShell.warnings)).not.toContain('boot.js');
    expect(JSON.stringify(brokenShell.warnings)).not.toContain('do-not-log');
    brokenShell.retry();expect(brokenShell.reloaded()).toBe(1);
    brokenShell.mount();expect(brokenShell.warnings).toHaveLength(1);
    const mountedShell = bootstrapMonitor();expect(mountedShell.emptyMount()).toBe(false);
    expect(mountedShell.infos).toHaveLength(0);mountedShell.mount();
    expect(mountedShell.error.hidden).toBe(true);expect(mountedShell.progress.hidden).toBe(false);
    expect(mountedShell.warnings).toHaveLength(0);expect(mountedShell.infos).toHaveLength(1);
    expect(mountedShell.infos[0]?.[1]).toContain('"phase":"mounted"');
    expect(mountedShell.disconnected()).toBe(1);
    const preparationWarnings = warn.mock.calls.filter(([label]) => label === '[Enterprise preparation]');
    const preparationInfos = info.mock.calls.filter(([label]) => label === '[Enterprise preparation]');
    expect(preparationWarnings).toHaveLength(1);expect(preparationInfos).toHaveLength(1);
    const failedLog = JSON.parse(String(preparationWarnings[0]?.[1]));
    const readyLog = JSON.parse(String(preparationInfos[0]?.[1]));
    expect(failedLog).toMatchObject({ event: 'enterprise_core_initialization', outcome: 'failure',
      phase: 'failed', code: 'DEFAULT_MODEL_UNAVAILABLE', traceId: failedData.traceId });
    expect(readyLog).toMatchObject({ event: 'enterprise_core_initialization', outcome: 'success',
      phase: 'ready', code: 'READY' });
    expect(failedLog.timings).toMatchObject({ totalMs: expect.any(Number), queuedMs: expect.any(Number),
      startingMs: expect.any(Number) });
    expect(JSON.stringify([...preparationWarnings, ...preparationInfos])).not.toContain('never-expose');
  } finally {
    info.mockRestore();warn.mockRestore();releaseStart();await gateway.stop();
    await rm(dir, { recursive: true, force: true });
  }
});


test('release assets negotiate precompressed bytes, remain authenticated and keep user APIs uncached', async () => {
  allowed.set('1', true);
  const asset = '/assets/startup-Abcd1234.js';
  const source = Buffer.from('console.log("startup");'.repeat(300));
  await mkdir(path.join(tempDir, 'assets'), { recursive: true });
  await writeFile(path.join(tempDir, asset), source);
  await writeFile(path.join(tempDir, asset + '.br'), brotliCompressSync(source));
  await writeFile(path.join(tempDir, asset + '.gz'), gzipSync(source));
  expect((await request('GET', asset)).status).toBe(302);
  const login = await request('POST', '/enterprise/login', undefined, { username: '1', password: 'test' });
  const cookie = login.headers['set-cookie']?.[0].split(';')[0];
  expect(login.headers['server-timing']).toMatch(/^login;dur=/);
  const br = await request('GET', asset, cookie, undefined, undefined, { 'accept-encoding': 'gzip, br' });
  expect(br.status).toBe(200);
  expect(br.headers['content-encoding']).toBe('br');
  expect(brotliDecompressSync(br.bytes)).toEqual(source);
  expect(br.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  expect(br.headers.vary).toBe('Accept-Encoding');
  expect(br.headers['content-type']).toContain('text/javascript');
  const gz = await request('GET', asset, cookie, undefined, undefined, { 'accept-encoding': 'br;q=0,gzip' });
  expect(gz.headers['content-encoding']).toBe('gzip');
  expect(gunzipSync(gz.bytes)).toEqual(source);
  const plain = await request('GET', asset, cookie, undefined, undefined, { 'accept-encoding': 'br;q=0,gzip;q=0' });
  expect(plain.headers['content-encoding']).toBeUndefined();
  expect(plain.bytes).toEqual(source);
  const unchanged = await request('GET', asset, cookie, undefined, undefined,
    { 'accept-encoding': 'br', 'if-none-match': String(br.headers.etag) });
  expect(unchanged.status).toBe(304);
  expect(unchanged.bytes.length).toBe(0);
  const head = await request('HEAD', asset, cookie, undefined, undefined, { 'accept-encoding': 'br' });
  expect(head.bytes.length).toBe(0);
  expect(head.headers['content-length']).toBe(br.headers['content-length']);
  expect((await request('GET', '/assets/missing-Abcd1234.js', cookie)).status).toBe(404);
  const api = await request('GET', '/api/settings/client', cookie);
  expect(api.headers['cache-control']).toBe('no-store');
  allowed.set('1', false);
  const revoked = await request('GET', asset, cookie, undefined, undefined,
    { 'accept-encoding': 'br', 'if-none-match': String(br.headers.etag) });
  expect(revoked.status).toBe(302);
  expect(revoked.headers['cache-control']).toBe('no-store');
  allowed.set('1', true);
});

test('Host browsing and file reads do not start a worker; idle invalidation retains identity and advances a coalesced queue', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enterprise-dormant-'));
  const root = path.join(dir, 'profiles');
  await writeFile(path.join(dir, 'index.html'), '<html><head></head><body><div id="root"></div></body></html>');
  let starts = 0;
  let stops = 0;
  const gateway = await startEnterpriseGateway({
    staticDir: dir,
    profileRoot: root,
    publicOrigin: 'https://workspace.example',
    port: 0,
    maxCores: 1,
    maxStartingCores: 1,
    maxQueuedCoreStarts: 2,
    coreIdleMs: 5,
    login: async username => ({ actor: { serverId: 'rc2', userId: username }, validate: async () => true, close: async () => {} }),
    startCore: async () => {
      starts += 1;
      const core = http.createServer((req, res) => res.end(req.url === '/api/cron/internal/idle-ready'
        ? JSON.stringify({ success: true, data: { idle: true } }) : '{}'));
      await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
      let invalidate!: () => void;
      const invalidated = new Promise<void>((resolve) => {
        invalidate = resolve;
      });
      return {
        port: (core.address() as { port: number }).port,
        localToken: 'local-test',
        invalidated,
        stop: async () => {
          stops += 1;
          invalidate();
          await new Promise<void>((resolve) => core.close(() => resolve()));
        },
      };
    },
  });
  const call = (route: string, cookie?: string, input?: object) =>
    new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: gateway.port,
          path: route,
          method: input ? 'POST' : 'GET',
          headers: {
            host: 'workspace.example',
            origin: 'https://workspace.example',
            ...(cookie ? { cookie } : {}),
            ...(input ? { 'content-type': 'application/json' } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString(),
              cookie: res.headers['set-cookie']?.[0].split(';')[0],
            })
          );
        }
      );
      req.once('error', reject);
      req.end(input ? JSON.stringify(input) : undefined);
    });
  try {
    const first = (await call('/enterprise/login', undefined, { username: '1', password: 'test' })).cookie;
    const second = (await call('/enterprise/login', undefined, { username: '2', password: 'test' })).cookie;
    for (const route of [
      '/',
      '/api/settings/client',
      '/enterprise/files',
      '/enterprise/conversations',
      '/enterprise/resources/status',
    ]) {
      expect((await call(route, first)).status).toBe(200);
    }
    expect((await call('/api/shell/check-tool-installed', first, { tool: 'python3' })).status).toBe(409);
    expect((await call('/api/conversations/11111111/runtime/ensure', first, {})).status).toBe(409);
    expect((await call('/api/excel-preview/stop', first, {})).status).toBe(200);
    expect(starts).toBe(0);
    await call('/enterprise/ready', first);
    await vi.waitFor(() => expect(gateway.capacity().cores).toBe(1));
    await Promise.all([call('/enterprise/ready', second), call('/enterprise/ready', second)]);
    expect(gateway.capacity().queuedStarts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await call('/api/system/info', first); // Passive reads do not renew the idle clock.
    await gateway.reapIdleCores();
    await vi.waitFor(() => expect(starts).toBe(2));
    expect(stops).toBe(1);
    expect((await call('/api/auth/user', first)).status).toBe(200);
  } finally { await gateway.stop();await rm(dir, { recursive: true, force: true }); }
});

test('capacity and startup waiting do not consume the usable worker idle budget', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'enterprise-idle-budget-'));
  const worker = http.createServer((_req, res) => res.end(JSON.stringify({ success: true, data: { idle: true } })));
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  let stops = 0;
  const gateway = await startEnterpriseGateway({ staticDir: dir, publicOrigin: 'https://workspace.example', port: 0,
    coreIdleMs: 100, login: async () => ({ actor: { serverId: 'rc2', userId: '1' }, validate: async () => true, close: async () => {} }),
    startCore: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { port: (worker.address() as { port: number }).port, localToken: 'unit-local-token', stop: async () => { stops += 1; } };
    } });
  const call = (url: string, cookie?: string) => new Promise<{ data: { ready?: boolean }; cookie?: string }>((resolve, reject) => {
    const login = url === '/enterprise/login';
    const req = http.request({ host: '127.0.0.1', port: gateway.port, path: url, method: login ? 'POST' : 'GET',
      headers: { host: 'workspace.example', origin: 'https://workspace.example', ...(cookie ? { cookie } : {}),
        ...(login ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks: Buffer[] = [];res.on('data', (chunk) => chunks.push(chunk));res.on('end', () => resolve({
        data: JSON.parse(Buffer.concat(chunks).toString()), cookie: res.headers['set-cookie']?.[0].split(';')[0] }));
    });req.once('error', reject);req.end(login ? JSON.stringify({ username: '1', password: 'test' }) : undefined);
  });
  try {
    const cookie = (await call('/enterprise/login')).cookie;
    await call('/enterprise/ready', cookie);
    await vi.waitFor(async () => expect((await call('/enterprise/ready', cookie)).data.ready).toBe(true));
    await gateway.reapIdleCores();
    expect(stops).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 110));
    await gateway.reapIdleCores();
    expect(stops).toBe(1);
  } finally {
    await gateway.stop();await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
