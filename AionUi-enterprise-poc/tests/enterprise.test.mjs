import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Rc2Client, normalizeEnterpriseBrand } from '../packages/desktop/src/process/services/enterprise/rc2Client.mjs';
import { prepareProfile } from '../packages/desktop/src/process/services/enterprise/profile.mjs';
import {
  forgetRememberedAccount,
  listRememberedAccountNames,
  listRememberedAccounts,
  normalizeServer,
  readPilotResourcePointers,
  readRememberedPassword,
  readServerConfig,
  saveRememberedAccount,
  saveServerConfig,
} from '../packages/desktop/src/process/services/enterprise/serverConfig.mjs';
import {
  EnterpriseLifecycle,
  classifyEnterpriseError,
} from '../packages/desktop/src/process/services/enterprise/lifecycle.mjs';
import { verifyCoreLocalGate } from '../packages/desktop/src/process/services/enterprise/coreGateProbe.mjs';

const accounts = new Map([
  ['alpha', { password: 'stub-alpha', id: '101', active: true }],
  ['beta', { password: 'stub-beta', id: '202', active: true }],
]);
const sessions = new Map();
let nextSession = 0;
const token = 'fixed-stub-local-capability';

test('employee brand loads from RC2 with a bounded published logo', async () => {
  const id = 'cb532e4e-91b8-4634-a2bb-92ab9ec48808';
  const routes = [];
  const client = new Rc2Client('https://rc2.example.test', undefined, async (url) => {
    routes.push(new URL(url).pathname);
    if (url.endsWith(`/ai/brand/assets/${id}`))
      return new Response(Buffer.from('89504e470d0a1a0a00000000', 'hex'), {
        headers: { 'content-type': 'image/png', 'content-length': '12' },
      });
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          productName: 'ZhenWork',
          companyName: '示例企业',
          loginTitle: '欢迎使用ZhenWork',
          loginSubtitle: '使用企业账号继续',
          primaryColor: '#2563eb',
          logoAssetId: id,
          version: 16,
        },
      })
    );
  });
  const brand = await client.branding();
  assert.equal(brand.productName, 'ZhenWork');
  assert.equal(brand.loginTitle, '欢迎使用ZhenWork');
  assert.equal(brand.logoDataUrl, 'data:image/png;base64,iVBORw0KGgoAAAAA');
  assert.deepEqual(routes, ['/ai/brand', `/ai/brand/assets/${id}`]);
  assert.equal(normalizeEnterpriseBrand({ productName: ' ', logoAssetId: id }), null);
  assert.equal(
    normalizeEnterpriseBrand({ productName: 'Work', primaryColor: 'red', logoAssetId: 'https://bad.test' }).logoAssetId,
    ''
  );
});

test('remembered enterprise credentials stay encrypted and scoped to RC2 server identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aion-remembered-test-'));
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: (bytes) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  try {
    await saveRememberedAccount(root, 'rc2-a', '101', 'alpha', 'private-test-password', encryption);
    await saveRememberedAccount(root, 'rc2-a', '202', 'beta', 'other-test-password', encryption);
    const stored = await readFile(path.join(root, 'supervisor', 'remembered-accounts.json'), 'utf8');
    assert.doesNotMatch(stored, /private-test-password|other-test-password/);
    assert.deepEqual(await listRememberedAccounts(root, 'rc2-a', encryption), ['alpha', 'beta']);
    assert.deepEqual(await listRememberedAccounts(root, 'rc2-b', encryption), []);
    assert.equal(await readRememberedPassword(root, 'rc2-b', 'alpha', encryption), null);
    assert.equal(await readRememberedPassword(root, 'rc2-a', 'alpha', encryption), 'private-test-password');
    await saveRememberedAccount(root, 'rc2-a', '101', 'alpha', 'new-test-password', encryption);
    assert.equal(await readRememberedPassword(root, 'rc2-a', 'alpha', encryption), 'new-test-password');
    await forgetRememberedAccount(root, 'rc2-a', 'alpha');
    assert.equal(await readRememberedPassword(root, 'rc2-a', 'alpha', encryption), null);
    assert.equal(await readRememberedPassword(root, 'rc2-a', 'beta', encryption), 'other-test-password');
    const unavailable = { isEncryptionAvailable: () => false };
    await assert.rejects(saveRememberedAccount(root, 'rc2-a', '101', 'alpha', 'secret', unavailable), /unavailable/);
    assert.deepEqual(await listRememberedAccounts(root, 'rc2-a', unavailable), []);
    assert.deepEqual(await listRememberedAccountNames(root, 'rc2-a'), ['beta']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer server settings are separate, stable and reject insecure remote URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aion-server-test-'));
  try {
    assert.deepEqual(await readServerConfig(root, {}), { baseUrl: '', origin: '', serverId: '' });
    const a = normalizeServer('https://rc2.example.test', 'https://work.example.test');
    assert.equal(a.serverId, normalizeServer('https://rc2.example.test').serverId);
    assert.notEqual(a.serverId, normalizeServer('https://other.example.test').serverId);
    assert.throws(() => normalizeServer('http://remote.example.test'), /HTTPS/);
    assert.throws(() => normalizeServer('https://user:pass@rc2.example.test'), /origin URL/);
    await saveServerConfig(root, a);
    const loaded = await readServerConfig(root, {});
    assert.deepEqual(loaded, a);
    const pointers = await readPilotResourcePointers(path.resolve('resources/enterprise/pilot.json'));
    assert.match(pointers.skillId, /^[0-9a-f-]{36}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function stubServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (status, data) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && req.headers.origin !== `http://127.0.0.1:${server.address().port}`)
      return send(403, { code: 403, msg: 'OriginDenied' });
    if (req.url === '/ai/bootstrap')
      return send(200, {
        code: 200,
        data: { clientId: 'stub-client', protocolVersion: 2, serverId: 'rc2-stub-server' },
      });
    if (req.url === '/auth/login' && req.method === 'POST') {
      let input;
      try {
        input = JSON.parse(
          await new Promise((resolve) => {
            let body = '';
            req.on('data', (part) => (body += part));
            req.on('end', () => resolve(body));
          })
        );
      } catch {
        return send(400, { code: 400 });
      }
      const account = accounts.get(input.username);
      if (
        input.clientId !== 'stub-client' ||
        input.grantType !== 'password' ||
        !account?.active ||
        account.password !== input.password
      )
        return send(401, { code: 401 });
      const sid = `stub-${++nextSession}`;
      sessions.set(sid, account);
      res.setHeader('Set-Cookie', `__Host-workspace-rc2=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/`);
      return send(200, { code: 200, data: { access_token: 'cookie-session' } });
    }
    const sid = /__Host-workspace-rc2=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (req.url === '/ai/me') {
      if (req.headers.clientid !== 'stub-client') return send(401, { code: 401 });
      const actor = sessions.get(sid);
      return actor?.active
        ? send(200, { code: 200, data: { userId: actor.id, mustChangePassword: false } })
        : send(401, { code: 401 });
    }
    if (req.url === '/auth/logout' && req.method === 'POST') {
      if (req.headers.clientid !== 'stub-client') return send(401, { code: 401 });
      sessions.delete(sid);
      res.setHeader('Set-Cookie', '__Host-workspace-rc2=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/');
      return send(200, { code: 200 });
    }
    if (req.headers['x-aion-enterprise-local-token'] !== token) return send(401, { code: 401 });
    return send(200, { ok: true });
  });
  server.on('upgrade', (req, socket) => {
    if (req.headers['x-aion-enterprise-local-token'] !== token)
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    else socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('RC2 cookie contract, stable IDs, disable, logout and A/B profile isolation', async () => {
  const server = stubServer();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aion-enterprise-test-'));
  try {
    const base = await listen(server);
    const a = new Rc2Client(base);
    const b = new Rc2Client(base);
    await assert.rejects(
      new Rc2Client(base, 'https://wrong-origin.example').login({ username: 'alpha', password: 'stub-alpha' }),
      /ORIGIN/
    );
    const actorA = await a.login({ username: 'alpha', password: 'stub-alpha' });
    const actorB = await b.login({ username: 'beta', password: 'stub-beta' });
    assert.equal(actorA.userId, '101');
    assert.equal(actorB.userId, '202');
    assert.equal(actorA.serverId, 'rc2-stub-server');
    assert.match(a.cookie, /^__Host-workspace-rc2=/);
    assert.notEqual(a.cookie, 'cookie-session');
    const profileA = await prepareProfile(root, actorA.serverId, actorA.userId);
    const profileB = await prepareProfile(root, actorB.serverId, actorB.userId);
    assert.notEqual(profileA.dir, profileB.dir);
    assert.notEqual(profileA.localToken, profileB.localToken);
    assert.notEqual((await prepareProfile(root, 'other-server', actorA.userId)).dir, profileA.dir);
    assert.equal((await prepareProfile(root, actorA.serverId, actorA.userId)).dir, profileA.dir);
    accounts.get('alpha').active = false;
    await assert.rejects(a.me(), /revoked|disabled/);
    assert.equal((await b.me()).userId, '202');
    await b.logout();
    assert.equal(b.cookie, '');
    await assert.rejects(b.me(), /No RC2 session/);
  } finally {
    accounts.get('alpha').active = true;
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects incompatible servers and distinguishes certificate failures', async () => {
  const legacy = new Rc2Client(
    'https://legacy.example.test',
    undefined,
    async () =>
      new Response(JSON.stringify({ code: 200, data: { clientId: 'old', protocolVersion: 1 } }), {
        headers: { 'content-type': 'application/json' },
      })
  );
  await assert.rejects(legacy.bootstrap(), /VERSION/);
  const expired = new Rc2Client('https://expired.example.test', undefined, async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
  });
  await assert.rejects(expired.bootstrap(), /CERTIFICATE/);
  const unreachable = new Rc2Client('https://offline.example.test', undefined, async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(unreachable.bootstrap(), /CONNECTION/);
});

test('bootstrap replaces a saved stale Origin with the server required Origin', async () => {
  const client = new Rc2Client(
    'http://127.0.0.1:3589',
    'https://expired-tunnel.example',
    async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            clientId: 'pilot-client',
            protocolVersion: 2,
            serverId: 'rc2-stable-pilot',
            requiredOrigin: 'http://127.0.0.1:3589',
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  );
  const bootstrap = await client.bootstrap();
  assert.equal(bootstrap.serverId, 'rc2-stable-pilot');
  assert.equal(client.origin, 'http://127.0.0.1:3589');
  const unsafe = new Rc2Client(
    'https://rc2.example',
    undefined,
    async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            clientId: 'pilot-client',
            protocolVersion: 2,
            serverId: 'rc2-stable-pilot',
            requiredOrigin: 'http://private.example',
          },
        })
      )
  );
  await assert.rejects(unsafe.bootstrap(), /VERSION/);
});

test('local HTTP, preview and WebSocket reject requests without the local capability', async () => {
  const server = stubServer();
  try {
    const base = await listen(server);
    assert.equal((await fetch(`${base}/api/conversations`)).status, 401);
    assert.equal((await fetch(`${base}/api/assets/preview`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/conversations`, { headers: { 'x-aion-enterprise-local-token': token } })).status,
      200
    );
    await verifyCoreLocalGate(server.address().port, token);
    await assert.rejects(verifyCoreLocalGate(server.address().port, 'wrong-token'), /rejects/);
    const port = server.address().port;
    const probe = (header = '') =>
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        let response = '';
        socket.on('connect', () =>
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${header}\r\n`
          )
        );
        socket.on('data', (part) => (response += part));
        socket.on('end', () => resolve(response));
      });
    assert.match(await probe(), /401 Unauthorized/);
    assert.match(await probe(`x-aion-enterprise-local-token: ${token}\r\n`), /101 Switching Protocols/);
  } finally {
    server.close();
  }
});

test('worker replacement waits for old process exit', async () => {
  const children = [];
  const lifecycle = new EnterpriseLifecycle({
    executable: 'electron',
    appEntry: 'index.js',
    spawnImpl: (_exe, _args, options) => {
      const child = new EventEmitter();
      child.pid = 44000 + children.length;
      child.exitCode = null;
      child.env = options.env;
      child.send = (message) => {
        if (message.type === 'enterprise:stop')
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit('exit', 0);
          });
      };
      children.push(child);
      return child;
    },
  });
  lifecycle.start({
    profileDir: '/profile-a',
    localToken: 'token-a',
    identity: { userId: '101', username: 'employee-a', serverId: 'rc2-pilot', serverUrl: 'https://rc2.example' },
    skill: { path: '/profile-a/skill-v2', name: 'enterprise-succinct', id: 'skill-resource', version: 2 },
    mcp: { port: 32124, key: 'local-key', resourceId: 'mcp-resource', version: 3 },
  });
  assert.throws(() => lifecycle.start({ profileDir: '/profile-b', localToken: 'token-b' }), /still running/);
  await lifecycle.stop();
  assert.equal(lifecycle.worker, null);
  lifecycle.start({ profileDir: '/profile-b', localToken: 'token-b' });
  assert.equal(children[0].env.AION_ENTERPRISE_PROFILE_DIR, '/profile-a');
  assert.equal(children[0].env.AION_ENTERPRISE_SKILL_ID, 'skill-resource');
  assert.equal(children[0].env.AION_ENTERPRISE_SKILL_VERSION, '2');
  assert.equal(children[0].env.AION_ENTERPRISE_MCP_RESOURCE_ID, 'mcp-resource');
  assert.equal(children[0].env.AION_ENTERPRISE_MCP_VERSION, '3');
  assert.equal(children[0].env.AION_ENTERPRISE_USER_ID, '101');
  assert.equal(children[0].env.AION_ENTERPRISE_SERVER_URL, 'https://rc2.example');
  assert.equal(children[1].env.AION_ENTERPRISE_PROFILE_DIR, '/profile-b');
  await lifecycle.stop();
});

test('worker receives Core and proxy capabilities only after IPC bootstrap', async () => {
  let workerEnv;
  let child;
  const sent = [];
  const lifecycle = new EnterpriseLifecycle({ executable: 'electron', appEntry: 'index.js',
    spawnImpl: (_exe, _args, options) => {
      workerEnv = options.env;
      child = new EventEmitter();
      child.pid = 44099;
      child.exitCode = null;
      child.connected = true;
      child.send = (message) => {
        sent.push(message);
        if (message.type === 'enterprise:stop') queueMicrotask(() => {
          child.exitCode = 0;
          child.emit('exit', 0);
        });
      };
      return child;
    } });
  const localToken = 'a'.repeat(64);
  const modelKey = 'b'.repeat(64);
  const mcpKey = 'c'.repeat(64);
  lifecycle.start({ profileDir: '/employee-profile', localToken,
    model: { port: 32123, key: modelKey, id: 'model', code: 'model', name: 'Model' },
    mcp: { port: 32124, key: mcpKey, resourceId: 'resource', version: 1 } });
  assert.equal(workerEnv.AION_ENTERPRISE_LOCAL_TOKEN, undefined);
  assert.equal(workerEnv.AION_ENTERPRISE_MODEL_PROXY_KEY, undefined);
  assert.equal(workerEnv.AION_ENTERPRISE_MCP_PROXY_KEY, undefined);
  child.emit('message', { type: 'enterprise:bootstrap-request' });
  assert.deepEqual(sent[0], { type: 'enterprise:bootstrap', localToken,
    modelProxyKey: modelKey, mcpProxyKey: mcpKey });
  child.emit('message', { type: 'enterprise:bootstrap-request' });
  assert.equal(sent.length, 1);
  await lifecycle.stop();
});

test('update pause waits for the current worker acknowledgement', async () => {
  const lifecycle = new EnterpriseLifecycle({ executable: 'electron', appEntry: 'index.js' });
  const child = new EventEmitter();
  child.connected = true;
  child.send = (message, callback) => {
    callback?.(null);
    queueMicrotask(() => child.emit('message', { type: 'enterprise:update-quiesced', nonce: 'wrong' }));
    setTimeout(() => child.emit('message', { type: 'enterprise:update-quiesced', nonce: message.nonce }), 5);
  };
  lifecycle.worker = child;
  await lifecycle.quiesceWorker(100);
  assert.equal(child.listenerCount('message'), 0);
  child.send = (_message, callback) => callback?.(null);
  await assert.rejects(lifecycle.quiesceWorker(10), /did not confirm/);
  assert.equal(child.listenerCount('message'), 0);
});

test('enterprise file errors expose safe actionable categories', () => {
  assert.equal(classifyEnterpriseError(new Error('RC2 file access denied')), 'PERMISSION');
  assert.equal(classifyEnterpriseError(new Error('Enterprise file too large')), 'FILE_TOO_LARGE');
  assert.equal(classifyEnterpriseError({ code: 'CERTIFICATE' }), 'CONNECTION');
  assert.equal(classifyEnterpriseError(new Error('Session closed')), 'SESSION_CLOSED');
});

test('real stub worker stops its old Core process before another account starts', async () => {
  const lifecycle = new EnterpriseLifecycle({
    executable: process.execPath,
    appEntry: fileURLToPath(new URL('./fixtures/worker-stub.mjs', import.meta.url)),
  });
  const worker = lifecycle.start({ profileDir: '/stub-profile-a', localToken: 'stub-token-a' });
  const corePid = await new Promise((resolve) =>
    worker.on('message', (message) => {
      if (message?.type === 'test:core-pid') resolve(message.pid);
    })
  );
  assert.ok(corePid > 0);
  await lifecycle.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(corePid, 0), { code: 'ESRCH' });
});
